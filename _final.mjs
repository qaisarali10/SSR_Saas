import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";

const env = Object.fromEntries(
  fs.readFileSync(".env", "utf8").split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);
const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

for (const t of ["companies", "distributors", "audit_logs"]) {
  const { count } = await db.from(t).select("*", { count: "exact", head: true });
  const { count: shared } = await db.from(t).select("*", { count: "exact", head: true }).is("user_id", null);
  console.log(t.padEnd(13), "total", String(count).padStart(4), "  shared(NULL owner)", shared);
}