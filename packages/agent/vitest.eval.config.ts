import { resolve } from "node:path";
// `loadEnv` comes from Vite itself: Vitest 4's `vitest/config` re-exports only
// the config helpers, not the whole of Vite's config surface.
import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";

const repoRoot = resolve(import.meta.dirname, "../..");

export default defineConfig(({ mode }) => ({
  test: {
    include: ["src/**/*.eval.ts"],
    globals: true,
    // Turbo 2 dropped its dotenv support, so nothing loads the gitignored root
    // `.env` for us. The empty prefix means "every variable", not just Vite's.
    env: loadEnv(mode, repoRoot, ""),
    // A single eval case is a real model turn plus several tool round trips.
    testTimeout: 120_000,
  },
}));
