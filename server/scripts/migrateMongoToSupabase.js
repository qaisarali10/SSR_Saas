/**
 * One-off migration: copies every collection out of the old MongoDB database
 * and into the new Supabase project, remapping every ObjectId reference to
 * the uuid Postgres now uses. Safe to re-run: users are matched by email and
 * skipped if already migrated; other rows are matched by `legacy_id` where
 * one exists.
 *
 * Usage:
 *   MONGO_URI=mongodb://... SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *     node server/scripts/migrateMongoToSupabase.js
 *
 * Password caveat: Supabase Auth hashes passwords with its own scheme and
 * offers no supported way to import an existing bcrypt hash through the
 * client library, so migrated users are created with a random temporary
 * password and immediately sent a "reset your password" email (unless
 * --no-reset-email is passed) so they can set a new one on first login.
 */
import "dotenv/config";
import crypto from "node:crypto";
import { MongoClient } from "mongodb";
import { env } from "../src/config/env.js";
import { createSupabaseAuthClient, supabaseAdmin } from "../src/services/supabaseClient.js";

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
  console.error("Set MONGO_URI to the source MongoDB connection string.");
  process.exit(1);
}

const sendResetEmails = !process.argv.includes("--no-reset-email");
const skipUsers = process.argv.includes("--skip-users");
const db = supabaseAdmin();

function oid(value) {
  return value ? String(value) : null;
}

/**
 * The Mongo database holds two different shapes of the same documents:
 *
 *   legacy (Django-era, what is actually in the database today)
 *     companies    { legacyId, name,  ... }
 *     distributors { legacyId, name, distributorId, active, area, subarea, cell, company, ... }
 *
 *   Mongoose-era (what an older revision of the app wrote)
 *     companies    { legacyId, cname, ... }
 *     distributors { legacyId, dname, did, status, area, subarea, cell, company, ... }
 *
 * Reading only one shape silently loses data -- `name` vs `dname` in particular
 * feeds a NOT NULL column, so the insert fails outright. These readers accept
 * both, preferring the Mongoose name and falling back to the legacy one.
 */
function readName(doc, ...keys) {
  for (const key of keys) {
    const value = doc[key];
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return String(value).trim();
    }
  }
  return "";
}

// `did` is the display number shown in the UI, and `active` is the legacy
// spelling of `status`. Both fall back so a mixed database still imports.
function readDid(doc) {
  const value = doc.did ?? doc.distributorId ?? doc.distributor_id;
  const n = Number(value);
  return Number.isFinite(n) ? n : 1;
}

function readStatus(doc) {
  if (doc.status !== undefined && doc.status !== null) return doc.status !== false;
  if (doc.active !== undefined && doc.active !== null) return doc.active !== false;
  return true;
}

function readText(doc, ...keys) {
  for (const key of keys) {
    const value = doc[key];
    if (value !== undefined && value !== null) return String(value);
  }
  return "";
}

async function migrateUsers(mongoDb) {
  const users = await mongoDb.collection("users").find({}).toArray();
  const idMap = new Map(); // Mongo ObjectId string -> Supabase uuid
  let created = 0;
  let skipped = 0;

  const { data: existingList, error: listError } = await db.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (listError) throw new Error(listError.message);
  const existingByEmail = new Map((existingList?.users || []).map((u) => [u.email, u.id]));

  for (const user of users) {
    const email = String(user.email || "").trim().toLowerCase();
    if (!email) continue;

    const existingId = existingByEmail.get(email);
    if (existingId) {
      idMap.set(oid(user._id), existingId);
      skipped += 1;
      continue;
    }

    const { data, error } = await db.auth.admin.createUser({
      email,
      password: crypto.randomBytes(24).toString("base64url"),
      email_confirm: Boolean(user.isVerified),
      user_metadata: { name: user.name || "" }
    });

    if (error) {
      console.error(`user ${email}: ${error.message}`);
      continue;
    }

    idMap.set(oid(user._id), data.user.id);
    await db.from("profiles").update({
      name: user.name || "",
      role: user.role === "admin" ? "admin" : "user"
    }).eq("id", data.user.id);
    created += 1;

    if (sendResetEmails) {
      const authClient = createSupabaseAuthClient();
      await authClient.auth.resetPasswordForEmail(email, {
        redirectTo: `${env.appUrl.replace(/\/$/, "")}/reset-password`
      });
    }
  }

  return { idMap, created, skipped };
}

async function migrateSimpleCollection(mongoDb, { collection, table, mapRow, idMap, legacyIdField = "legacyId" }) {
  const docs = await mongoDb.collection(collection).find({}).toArray();
  const localIdMap = new Map();
  let inserted = 0;
  let skipped = 0;

  for (const doc of docs) {
    const legacyId = doc[legacyIdField];
    if (legacyId !== undefined && legacyId !== null) {
      const { data: existing } = await db.from(table).select("id").eq("legacy_id", legacyId).maybeSingle();
      if (existing) {
        localIdMap.set(oid(doc._id), existing.id);
        skipped += 1;
        continue;
      }
    }

    const row = mapRow(doc, idMap);
    const { data, error } = await db.from(table).insert(row).select("id").single();
    if (error) {
      console.error(`${table} ${doc._id}: ${error.message}`);
      continue;
    }
    localIdMap.set(oid(doc._id), data.id);
    inserted += 1;
  }

  return { idMap: localIdMap, inserted, skipped };
}

async function run() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const mongoDb = client.db();

  try {
    console.log("Migrating users...");
    // --skip-users is for a database whose rows carry no `user` reference at
    // all. Every row then migrates with user_id NULL, which ownership.js treats
    // as shared/visible-to-everyone, so there is nothing to map and creating
    // Supabase accounts (random password + reset email each) would be noise.
    const userIds = skipUsers ? new Map() : (await migrateUsers(mongoDb)).idMap;
    if (skipUsers) console.log("  skipped (--skip-users); rows will import as shared/unowned");

    const ownerId = (doc) => (doc.user ? userIds.get(oid(doc.user)) || null : null);

    console.log("Migrating companies...");
    const companies = await migrateSimpleCollection(mongoDb, {
      collection: "companies",
      table: "companies",
      idMap: userIds,
      mapRow: (doc) => ({
        legacy_id: doc.legacyId ?? null,
        cname: readName(doc, "cname", "name"),
        created_at: doc.createdAt ?? undefined,
        updated_at: doc.updatedAt ?? undefined,
        user_id: ownerId(doc)
      })
    });
    console.log(`  companies: ${companies.inserted} inserted, ${companies.skipped} already present`);

    console.log("Migrating products...");
    const products = await migrateSimpleCollection(mongoDb, {
      collection: "products",
      table: "products",
      idMap: userIds,
      mapRow: (doc) => ({
        legacy_id: doc.legacyId ?? null,
        company_id: doc.company ? companies.idMap.get(oid(doc.company)) || null : null,
        pname: doc.pname,
        ptype: doc.ptype === "Trade" ? "Trade" : "Retail",
        user_id: ownerId(doc)
      })
    });
    console.log(`  products: ${products.inserted} inserted, ${products.skipped} already present`);

    console.log("Migrating distributors...");
    const distributors = await migrateSimpleCollection(mongoDb, {
      collection: "distributors",
      table: "distributors",
      idMap: userIds,
      mapRow: (doc) => ({
        legacy_id: doc.legacyId ?? null,
        company_id: doc.company ? companies.idMap.get(oid(doc.company)) || null : null,
        did: readDid(doc),
        dname: readName(doc, "dname", "name"),
        area: readText(doc, "area"),
        subarea: readText(doc, "subarea"),
        cell: readText(doc, "cell"),
        status: readStatus(doc),
        created_at: doc.createdAt ?? undefined,
        updated_at: doc.updatedAt ?? undefined,
        user_id: ownerId(doc)
      })
    });
    console.log(`  distributors: ${distributors.inserted} inserted, ${distributors.skipped} already present`);

    console.log("Migrating product aliases...");
    const aliases = await migrateSimpleCollection(mongoDb, {
      collection: "productaliases",
      table: "product_aliases",
      idMap: userIds,
      mapRow: (doc) => ({
        legacy_id: doc.legacyId ?? null,
        product_id: products.idMap.get(oid(doc.product)) || null,
        paname: doc.paname,
        user_id: ownerId(doc)
      })
    });
    console.log(`  product_aliases: ${aliases.inserted} inserted, ${aliases.skipped} already present`);

    console.log("Migrating product schemes...");
    const schemes = await migrateSimpleCollection(mongoDb, {
      collection: "productschemes",
      table: "product_schemes",
      idMap: userIds,
      mapRow: (doc) => ({
        legacy_id: doc.legacyId ?? null,
        product_id: products.idMap.get(oid(doc.product)) || null,
        schemeid: doc.schemeid,
        basepolicy: doc.basepolicy,
        bonuspolicy: doc.bonuspolicy,
        tp: doc.tp || 0,
        user_id: ownerId(doc)
      })
    });
    console.log(`  product_schemes: ${schemes.inserted} inserted, ${schemes.skipped} already present`);

    console.log("Migrating sales (this can take a while)...");
    const sales = await migrateSimpleCollection(mongoDb, {
      collection: "sales",
      table: "sales",
      idMap: userIds,
      mapRow: (doc) => ({
        legacy_id: doc.legacyId ?? null,
        distributor_id: distributors.idMap.get(oid(doc.distributor)) || null,
        product_id: products.idMap.get(oid(doc.product)) || null,
        alias: doc.alias,
        sqty: doc.sqty, sbonus: doc.sbonus, sprice: doc.sprice, salvalue: doc.salvalue,
        clqty: doc.clqty, clbonus: doc.clbonus, clvalue: doc.clvalue,
        pbase: doc.pbase, pbonus: doc.pbonus, tprice: doc.tprice,
        seg_base: doc.seg_base, seg_bonus: doc.seg_bonus, seg_bsunit: doc.seg_bsunit, seg_bnunit: doc.seg_bnunit,
        seg_slbase: doc.seg_slbase, seg_slbonus: doc.seg_slbonus, seg_slbsunit: doc.seg_slbsunit, seg_slbnunit: doc.seg_slbnunit,
        month: doc.month, year: doc.year, date: doc.date,
        user_id: ownerId(doc)
      })
    });
    console.log(`  sales: ${sales.inserted} inserted, ${sales.skipped} already present`);

    console.log("Migrating services...");
    const services = await migrateSimpleCollection(mongoDb, {
      collection: "services",
      table: "services",
      idMap: userIds,
      legacyIdField: "__none__",
      mapRow: (doc) => ({
        name: doc.name, category: doc.category || "Other", description: doc.description || "",
        price: doc.price || 0, status: doc.status !== false, user_id: ownerId(doc)
      })
    });
    console.log(`  services: ${services.inserted} inserted`);

    console.log("Migrating upload logs and audit logs (best-effort, no id remapping needed)...");
    const uploadLogs = await mongoDb.collection("uploadlogs").find({}).toArray();
    if (uploadLogs.length) {
      const { error } = await db.from("upload_logs").insert(uploadLogs.map((doc) => ({
        kind: doc.kind, filename: doc.filename || "", status: doc.status || "processed",
        row_count: doc.rowCount || 0, created: doc.created || 0, skipped: doc.skipped || 0,
        inserted: doc.inserted || 0, missing_count: doc.missingCount || 0,
        session_key: doc.sessionKey || "default", user_id: ownerId(doc), created_at: doc.createdAt
      })));
      if (error) console.error(`upload_logs: ${error.message}`);
    }

// audit_logs has no surrogate key in Mongo, so re-running would duplicate every
    // entry. Match on the full tuple *including* created_at: keying on
    // action/resource/resource_id alone would also swallow a genuinely distinct
    // second login by the same user, which is a real event, not a re-import.
    const auditLogs = await mongoDb.collection("auditlogs").find({}).toArray();
    let auditInserted = 0;
    if (auditLogs.length) {
      const key = (a, r, rid, at) => `${a}|${r}|${rid}|${at ? new Date(at).toISOString() : ""}`;
      const already = new Set();
      const pageSize = 200;
      const { count: existingAudit } = await db.from("audit_logs").select("*", { count: "exact", head: true });
      const totalExisting = existingAudit || 0;
      for (let offset = 0; offset < totalExisting; offset += pageSize) {
        const { data } = await db
          .from("audit_logs")
          .select("action, resource, resource_id, created_at")
          .range(offset, offset + pageSize - 1);
        for (const row of data || []) already.add(key(row.action, row.resource, row.resource_id, row.created_at));
      }

      const pending = auditLogs.filter((doc) => !already.has(key(doc.action, doc.resource, doc.resourceId || "", doc.createdAt)));
      if (pending.length) {
        const { error } = await db.from("audit_logs").insert(pending.map((doc) => ({
          user_id: doc.user ? (userIds.get(oid(doc.user)) || String(doc.user)) : "",
          action: doc.action, resource: doc.resource, resource_id: doc.resourceId || "",
          metadata: doc.metadata || {}, ip_address: doc.ipAddress || "", user_agent: doc.userAgent || "",
          status: doc.status || "success", created_at: doc.createdAt
        })));
        if (error) console.error(`audit_logs: ${error.message}`);
        else auditInserted = pending.length;
      }
    }
    console.log(`  upload_logs: ${uploadLogs.length}, audit_logs: ${auditInserted} inserted, ${auditLogs.length - auditInserted} already present`);

    if (skipUsers) {
    console.log("\nDone. --skip-users was used: no accounts were created and every imported row is shared (user_id NULL), visible to any signed-in user.");
  } else {
    console.log("\nDone. Migrated users were created with a random password" + (sendResetEmails ? " and sent a reset-password email." : " -- run with reset emails enabled or use the admin panel to set new passwords."));
  }
  } finally {
    await client.close();
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
