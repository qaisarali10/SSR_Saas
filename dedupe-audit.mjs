import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";

const env = Object.fromEntries(
  fs.readFileSync(".env", "utf8").split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);
const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const { data } = await db.from("audit_logs")
  .select("id,user_id,action,resource,resource_id,status,created_at")
  .order("created_at", { ascending: true });

console.log(`total audit_logs rows: ${data.length}\n`);

// The migration ran three times before it learned to dedupe, so the 8 Mongo
// entries were inserted more than once. Group by the natural key and keep the
// earliest row of each group.
const groups = new Map();
for (const row of data) {
  const key = `${row.action}|${row.resource}|${row.resource_id}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(row);
}

let duplicates = 0;
const toDelete = [];
for (const [key, rows] of groups) {
  if (rows.length > 1) {
    duplicates += rows.length - 1;
    rows.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    toDelete.push(...rows.slice(1).map((r) => r.id));
  }
  console.log(`  ${key}  x${rows.length}`);
}

console.log(`\n${duplicates} duplicate rows would be removed (keeping the earliest of each group).`);
if (toDelete.length) {
  const { error } = await db.from("audit_logs").delete().in("id", toDelete);
  if (error) { console.error("delete failed:", error.message); process.exit(1); }
  console.log(`deleted ${toDelete.length} duplicates`);
}

const { count } = await db.from("audit_logs").select("*", { count: "exact", head: true });
console.log(`audit_logs rows now: ${count}`);