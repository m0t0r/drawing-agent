# @repo/agent

The drawing agent's core: the loop, the system prompt, the tool schemas, the canvas ops, the scorers and the evals. Not published and not built — the app and the eval harness both import the `.ts` source through the `exports` map.

Everything substantive about the agent lives here so that `apps/web` and the evals cannot drift apart. The route handler and the React provider stay in the app; nothing in this package imports React or Excalidraw's imperative API.

Read [`CONTEXT.md`](../../CONTEXT.md) at the repo root first — it defines _turn_, _step_, _canvas op_, _executor_, _element skeleton_ and _runtime element_, and this package uses those words precisely.

## Layout

```
src/
  evals/                Golden cases and `*.eval.ts` suites
```

The `exports` map reserves `./canvas/*` (canvas ops: pure `(elements, input) => elements`) and `./scorers/*` (pure functions over the final element array). Those directories do not exist yet — the package currently ships scaffolding only, and later tickets fill them along with `./loop`, `./prompt` and `./tools` under the top-level `./*` pattern.

## Consuming it

```ts
import { runTurn } from "@repo/agent/loop";
import { addElements } from "@repo/agent/canvas/ops";
```

There is no root export, by the same reasoning as `@repo/design-system`: a barrel would let a browser bundle pull in the eval-only half of the package by accident, and the cleanest way to say "import a subpath" is to offer no root. `apps/web` needs three things, exactly as it does for the design system — `"@repo/agent": "workspace:*"`, an entry in `transpilePackages`, and a `paths` mapping for `@repo/agent/*`.

## Tests and evals

| Command     | Files              | Model | Cached | Costs money |
| ----------- | ------------------ | ----- | ------ | ----------- |
| `pnpm test` | `src/**/*.test.ts` | mock  | yes    | no          |
| `pnpm eval` | `src/**/*.eval.ts` | real  | no     | yes         |

Two configs, two globs. `vitest.config.ts` includes only `*.test.ts`, so an eval can never be dragged into the fast suite; `vitest.eval.config.ts` includes only `*.eval.ts`. The Turbo `eval` task sets `"cache": false` — a cached eval score is a replayed number presented as a fresh measurement.

`describe`, `it` and `expect` are **globals** — don't import them. Both configs set `test.globals: true` and `tsconfig.json` lists `vitest/globals` in `types`; the two have to move together, and naming `types` at all switches off automatic `@types/*` inclusion, which is why `node` is listed beside it.

Evals need `OPENAI_API_KEY` in the gitignored `.env` at the repo root (see `.env.example`). Two separate things have to be true for it to arrive:

- Turbo 2 dropped its dotenv support, so nothing loads that file for us — `vitest.eval.config.ts` reads it with Vite's `loadEnv` and hands it to the tests as `test.env`.
- Turbo 2 also runs tasks in **strict env mode**, filtering out any variable a task hasn't declared. That is why the `eval` task lists `"env": ["OPENAI_API_KEY"]`: without it, a key exported in your shell never reaches the process (verified by removing the declaration and watching the eval fail). It is not about the cache — the task is uncached.

`loadEnv` is imported from `vite` rather than `vitest/config`: Vitest 4 re-exports only the config helpers.

### Type-level tests

`vitest --typecheck` works against this repo's TypeScript 7, which was not a given — the type-check mode shells out to the `tsc` CLI, and TS 7 is the native Go compiler. Verified on Vitest 4.1.10 with tsgo 7.0.2: a deliberate error is reported at the right file, line and column, and a clean file reports `no errors`. Vitest still labels the mode experimental, so pin the version if `*.test-d.ts` files are ever added. Nothing uses it today.
