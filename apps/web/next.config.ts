import type { NextConfig } from "next";

/*
 * The API key lives in one gitignored `.env` at the repo root, shared with the
 * evals. Next only loads a `.env` beside the app, and Turbo 2 runs tasks in
 * strict env mode — so a key exported in your shell would be filtered out too,
 * unless the `dev` task declares it. Reading the file here sidesteps both, and
 * `process.loadEnvFile` is built into Node 24, so it costs no dependency.
 *
 * Missing is not fatal: `next dev` still boots without a key, and the first
 * message fails as a turn rather than at startup — the cause on the server log,
 * a short notice in the chat panel.
 */
try {
  process.loadEnvFile(new URL("../../.env", import.meta.url));
} catch {
  // No root .env — see .env.example.
}

const nextConfig: NextConfig = {
  /* config options here */
  reactCompiler: true,
  cacheComponents: true,
  // Both shared packages ship TypeScript source rather than build output.
  transpilePackages: ["@repo/agent", "@repo/design-system"],
};

export default nextConfig;
