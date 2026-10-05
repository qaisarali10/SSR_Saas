import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envDir = path.resolve(__dirname, "..");

export default defineConfig(({ command, mode }) => {
  // The Google sign-in button depends on these two VITE_ vars being inlined into
  // the bundle. A production build without them still succeeds, but every user
  // then gets "Google sign-in is not configured." at runtime -- so fail the
  // build here, where the cause is visible. Dev stays lenient so the rest of the
  // app is still usable without Google sign-in.
  //
  // These must be read with loadEnv rather than process.env: Vite resolves the
  // config file before it loads any .env, so process.env only holds vars the
  // caller exported for real (which is exactly what the Docker build args do).
  // loadEnv merges both the .env files and the real environment.
  if (command === "build") {
    const env = loadEnv(mode, envDir, "VITE_");
    const missing = ["VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY"].filter(
      (name) => !env[name]
    );
    if (missing.length) {
      throw new Error(
        `Missing ${missing.join(" and ")}: the Google sign-in button needs these at build time. ` +
          "Set them in .env for local builds, or pass them as Docker build args."
      );
    }
  }

  return {
    root: "client",
    // Read the project root's .env instead of client/.env, so VITE_SUPABASE_URL
    // and VITE_SUPABASE_ANON_KEY can live alongside the server's own SUPABASE_*
    // vars in one file. Only names prefixed VITE_ are ever exposed to the
    // browser bundle -- SUPABASE_SERVICE_ROLE_KEY etc. never leave the server.
    envDir,
    plugins: [react()],
    build: {
      outDir: "../dist",
      emptyOutDir: true,
      rollupOptions: {
        output: {
          // Vendor code changes far less often than app code; splitting it keeps
          // a deploy from invalidating the React and icon chunks in the browser
          // cache. Recharts is not listed here because it is already isolated by
          // the lazy import in AnalyticsCharts.jsx.
          manualChunks: {
            react: ["react", "react-dom"],
            icons: ["lucide-react"]
          }
        }
      }
    },
    server: {
      strictPort: true,
      proxy: {
        "/api": {
          target: "http://localhost:5050",
          changeOrigin: true,
          configure: (proxy) => {
            // Without this the proxy answers an unreachable API with an empty
            // text/plain 500, which the client could only report as the raw
            // "Internal Server Error" status text.
            proxy.on("error", (error, _req, res) => {
              console.error(`[api proxy] ${error.code || error.message} - is the API running on port 5050?`);
              if (!res || typeof res.writeHead !== "function" || res.headersSent) return;
              res.writeHead(503, { "Content-Type": "application/json" });
              res.end(JSON.stringify({
                message: "Cannot reach the API server on port 5050. Start it with `npm run server:dev`."
              }));
            });
          }
        }
      }
    }
  };
});
