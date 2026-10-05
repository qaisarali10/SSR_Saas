import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export function supabaseConfigured() {
  return Boolean(url && anonKey);
}

// supabase-js has no way to persist the PKCE code verifier without also
// persisting the session, so it writes both through one storage adapter and we
// have to separate them here. Two different lifetimes are at stake:
//
//   * the code verifier is created on the button page and must survive the trip
//     out to Google and back, otherwise the callback has nothing to exchange
//     the ?code= for -- hence sessionStorage, which is tab-scoped and cleared
//     when the tab closes;
//   * the session is only ever needed for the few hundred milliseconds between
//     the callback landing and the tokens being handed to our own server, so it
//     stays in memory and never touches disk.
//
// Every verifier key supabase-js writes ends in "-code-verifier" (the per-flow
// slots, their index, and the single fixed key it mirrors them into), so that
// suffix is what separates the two.
const VERIFIER_KEY_SUFFIX = "-code-verifier";

function sessionStorageOrNull() {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

function transientAuthStorage() {
  const memory = new Map();
  const isVerifier = (key) => String(key).endsWith(VERIFIER_KEY_SUFFIX);
  const store = () => sessionStorageOrNull();

  return {
    getItem(key) {
      if (!isVerifier(key)) return memory.get(key) ?? null;
      return store()?.getItem(key) ?? null;
    },
    setItem(key, value) {
      if (!isVerifier(key)) {
        memory.set(key, value);
        return;
      }
      try {
        store()?.setItem(key, value);
      } catch {
        // A full or unavailable sessionStorage must not break the redirect that
        // is already in flight; the exchange simply fails later with a real error.
      }
    },
    removeItem(key) {
      if (!isVerifier(key)) {
        memory.delete(key);
        return;
      }
      try {
        store()?.removeItem(key);
      } catch {
        // Nothing to clean up if we could not write in the first place.
      }
    }
  };
}

let client = null;

/**
 * Browser-side Supabase client, used ONLY to drive the OAuth redirect dance
 * (signInWithOAuth + parsing the tokens Supabase's callback lands back with).
 * The anon key is public by design -- safe to ship in the bundle -- and the
 * session this client recovers is never persisted (see transientAuthStorage):
 * once the callback page reads the tokens it hands them to our own server (see
 * /auth/oauth/session), which mints the same httpOnly cookies every other
 * sign-in method uses. The app's normal API calls keep going through
 * server/src routes, not through this client.
 */
export function supabaseBrowser() {
  if (!client) {
    if (!supabaseConfigured()) {
      throw new Error("Google sign-in is not configured.");
    }
    client = createClient(url, anonKey, {
      auth: {
        autoRefreshToken: false,
        flowType: "pkce",
        detectSessionInUrl: true,
        storage: transientAuthStorage()
      }
    });
  }
  return client;
}
