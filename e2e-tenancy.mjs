import fs from "node:fs";
import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const env = Object.fromEntries(
  fs.readFileSync(".env", "utf8").split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);
const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const browser = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, { auth: { persistSession: false } });

const BASE = "http://localhost:5050";
const SESSION_KEY = crypto.randomUUID();
const { csrfToken } = await (await fetch(`${BASE}/api/csrf-token`, { headers: { "x-session-key": SESSION_KEY } })).json();

async function makeUser(prefix) {
  const email = `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e4)}@example.com`;
  const password = "TenantProbe!2345";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(error.message);
  return { id: data.user.id, email, password };
}

async function login(u) {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-session-key": SESSION_KEY, "x-csrf-token": csrfToken },
    body: JSON.stringify({ username: u.email, password: u.password }),
  });
  if (!r.ok) throw new Error(`login ${r.status}: ${await r.text()}`);
  const cookie = r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  return { cookie, "x-session-key": SESSION_KEY };
}

const get = async (auth, path) => {
  const r = await fetch(`${BASE}${path}`, { headers: auth });
  return { status: r.status, body: await r.json() };
};

const userA = await makeUser("tenantA");
const userB = await makeUser("tenantB");
const stranger = await makeUser("stranger");
const authA = await login(userA);
const authB = await login(userB);
const authS = await login(stranger);

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` -- ${detail}` : ""}`);
};

try {
  // Seed private rows for A and B via direct inserts (owns user_id).
  const { data: compA } = await admin.from("companies").insert({ user_id: userA.id, cname: "ZZ Private A" }).select().single();
  const { data: compB } = await admin.from("companies").insert({ user_id: userB.id, cname: "ZZ Private B" }).select().single();
  const { data: distA } = await admin.from("distributors").insert({ user_id: userA.id, company_id: compA.id, did: 90001, dname: "ZZ Private Dist A" }).select().single();
  await admin.from("distributors").insert({ user_id: userB.id, company_id: compB.id, did: 90002, dname: "ZZ Private Dist B" });

  // The 530 imported distributors all carry legacyId; the private rows seeded
  // below do not. That is the reliable way to tell them apart over the API,
  // because listDistributors() maps rows to a client shape with no userId field.
  const SHARED = 530;

  console.log("1. shared catalogue is visible to every login");
  for (const [who, auth] of [["userA", authA], ["userB", authB], ["stranger", authS]]) {
    const d = await get(auth, "/api/distributors?limit=1000");
    const imported = (d.body || []).filter((x) => x.legacyId !== null && x.legacyId !== undefined).length;
    check(`${who} sees all ${SHARED} imported distributors`, d.status === 200 && imported === SHARED, `status ${d.status}, imported ${imported}`);
  }

  console.log("\n2. private rows stay private");
  const aCompanies = await get(authA, "/api/companies");
  const bCompanies = await get(authB, "/api/companies");
  const sCompanies = await get(authS, "/api/companies");
  const names = (r) => (r.body || []).map((c) => c.cname);
  check("A sees its own private company", names(aCompanies).includes("ZZ Private A"));
  check("A cannot see B's private company", !names(aCompanies).includes("ZZ Private B"));
  check("B sees its own private company", names(bCompanies).includes("ZZ Private B"));
  check("B cannot see A's private company", !names(bCompanies).includes("ZZ Private A"));
  check("stranger sees neither private company", !names(sCompanies).includes("ZZ Private A") && !names(sCompanies).includes("ZZ Private B"));
  check("stranger still sees the 2 shared companies", names(sCompanies).filter((n) => n === "Siza" || n === "Raazee").length === 2, names(sCompanies).join(", "));

  console.log("\n3. IDOR: fetching B's private row by id is refused");
  const idor = await get(authA, `/api/distributors/${distA.id}`);
  check("A gets 404/403 for a row owned by nobody it owns", [403, 404].includes(idor.status), `status ${idor.status}`);

  console.log("\n4. shared row is fetchable by id from any login");
  const { data: anyShared } = await admin.from("distributors").select("id").is("user_id", null).limit(1);
  for (const [who, auth] of [["A", authA], ["B", authB], ["stranger", authS]]) {
    const r = await get(auth, `/api/distributors/${anyShared[0].id}`);
    check(`${who} can GET a shared distributor by id`, r.status === 200, `status ${r.status}`);
  }

  console.log("\n5. stats reflect own + shared");
  const sA = await get(authA, "/api/stats");
  const sS = await get(authS, "/api/stats");
  check("stats 200 for A and stranger", sA.status === 200 && sS.status === 200, `${sA.status}/${sS.status}`);
  if (sA.status === 200) console.log(`        A sees ${sA.body.companies} companies, ${sA.body.distributors} distributors`);

  console.log("\n6. writes create owned (private) rows, not shared ones");
  const created = await fetch(`${BASE}/api/companies`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authS, "x-csrf-token": csrfToken },
    body: JSON.stringify({ cname: "ZZ Stranger Own Co" }),
  });
  check("stranger can create a company", created.status < 300, `status ${created.status}`);
  const { data: newRow } = await admin.from("companies").select("user_id").eq("cname", "ZZ Stranger Own Co").single();
  check("the new row is owned by its creator, not shared", newRow?.user_id === stranger.id, `user_id ${newRow?.user_id}`);
  const sAfter = await get(authS, "/api/companies");
  check("creator can see their new company", names(sAfter).includes("ZZ Stranger Own Co"));
  const aAfter = await get(authA, "/api/companies");
  check("other tenants cannot see the new company", !names(aAfter).includes("ZZ Stranger Own Co"));
} finally {
  await admin.from("companies").delete().like("cname", "ZZ %");
  await admin.from("distributors").delete().like("dname", "ZZ %");
  for (const u of [userA, userB, stranger]) await admin.auth.admin.deleteUser(u.id);
}

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);