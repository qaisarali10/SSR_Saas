import { SupabaseStore } from "./supabaseStore.js";
import { supabaseAdmin, supabaseConfigured } from "../services/supabaseClient.js";

export async function createStore() {
  if (!supabaseConfigured()) {
    throw new Error("Supabase is not configured (set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY).");
  }

  // Cheapest possible round trip that proves the service-role key, the URL and
  // the table grants are all valid before handing the store to the rest of the
  // app.
  //
  // This deliberately does NOT use `head: true`. A HEAD response carries no
  // body, so PostgREST's error detail (e.g. "permission denied for table
  // companies", code 42501) is thrown away and the crash log shows only
  // "Supabase connection failed:" with nothing after it. Selecting one row
  // costs the same round trip and keeps the diagnosis.
  const { error } = await supabaseAdmin().from("companies").select("id").limit(1);
  if (error) {
    const detail = [error.message, error.code && `code ${error.code}`, error.hint]
      .filter(Boolean)
      .join(" | ");
    throw new Error(`Supabase connection failed: ${detail}`);
  }

  console.log("Connected to Supabase");
  return new SupabaseStore();
}
