import { defineConfig } from "vitest/config";
import { headlessExcalidraw } from "./vitest.shared.ts";

export default defineConfig({
  test: {
    ...headlessExcalidraw,
    // Evals are `*.eval.ts` and run from `vitest.eval.config.ts`. The default
    // glob deliberately misses them: `pnpm test` must stay free, fast and
    // deterministic, and an eval is none of those.
    include: ["src/**/*.test.ts"],
    // `describe`/`it`/`expect` without an import in every file. The types come
    // from `vitest/globals` in tsconfig.json; keep the two in step.
    globals: true,
  },
});
