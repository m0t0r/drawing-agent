# @repo/agent

The drawing agent's core: the loop, the system prompt, the tool schemas, the canvas ops, the scorers and the evals. Not published and not built — the app and the eval harness both import the `.ts` source through the `exports` map.

Everything substantive about the agent lives here so that `apps/web` and the evals cannot drift apart. The route handler and the React provider stay in the app; nothing in this package imports React or Excalidraw's imperative API.

Read [`CONTEXT.md`](../../CONTEXT.md) at the repo root first — it defines _turn_, _step_, _canvas op_, _executor_, _element skeleton_ and _runtime element_, and this package uses those words precisely.

## Layout

```
src/
  loop.ts               `runTurn()` — the owned loop and the wire
  prompt.ts             The system prompt, as one constant
  model.ts              The model id, the provider factory, and `store: false`
  canvas/               Canvas ops: pure `(elements, input) => elements`
  testing/              Scripted model responses for the loop's tests
  evals/                Golden cases and `*.eval.ts` suites
```

`./loop` is the seam. `runTurn()` takes an injected **model** and an injected **executor** and returns the UI message stream — not a `Response`, so a test can read the chunks without a server. It owns stepping, termination, the step cap of 8, history shape and error policy; each individual step is one `streamText` call. Its history is grouped by **turn** rather than kept flat, which costs nothing now and makes later compaction safe by default: a whole turn can be dropped without orphaning a tool call from its result.

`./canvas/ops` holds the ops themselves — `addElements` today, update and remove later. They are pure and synchronous, take **element skeletons** in and hand **runtime elements** back, and import neither React nor Excalidraw's imperative API, which is what lets the browser and the eval harness call the same function. Everything substantive lives here rather than in a caller: null stripping (strict-mode tool schemas send `null` for absent optional fields, and Excalidraw's defaults only fire on `undefined`), the skeleton conversion, and id preservation (`convertToExcalidrawElements` regenerates ids unless told not to, which would break the model's own references).

`./canvas/headless-environment` is what makes those ops runnable off the browser — see below.

The `exports` map also reserves `./scorers/*` (pure functions over the final element array). That directory does not exist yet; a later ticket fills it, along with `./tools` under the top-level `./*` pattern. `src/testing/` is not exported at all — the `./*` pattern is one level deep, so scripted model responses stay internal.

## Running the canvas ops headlessly

`convertToExcalidrawElements` does **not** run in a bare Node process, and the reasons are worth knowing before you touch a Vitest config. Both were measured; the workings are in [`docs/research/excalidraw-skeleton-conversion.md`](../../docs/research/excalidraw-skeleton-conversion.md).

- `@excalidraw/excalidraw@0.18.1` publishes a bundle only a bundler can load. Node's resolver rejects it three times over before any Excalidraw code runs. Hence `server.deps.inline` in both configs — without it Vitest externalises the package and hands it to Node.
- It then reads browser globals at import time. `src/canvas/headless-environment.ts` supplies the five it needs, in about 25 lines. No jsdom, no `node-canvas`. It is a `setupFiles` entry so it lands before the import; `FontFace` in particular is read at _call_ time, from inside conversion, so a shim built by "import it and see what breaks" misses it.

Both settings live in `vitest.shared.ts` so the test and eval configs cannot drift on them.

The shim also installs Excalidraw's `setCustomTextMetricsProvider`. Text width comes only from canvas `measureText`, and headless there is no font — left to a stub the numbers would be whatever the stub returned. Pinning a per-character ratio makes headless conversion deterministic, but **not** real: the measurement decides where `wrapText` breaks lines and how tall a labelled container grows, so scorers must not grade text `width`/`height`, wrapped line breaks, a label-sized container, or any overlap involving one.

## Consuming it

```ts
import { runTurn } from "@repo/agent/loop";
import { addElements } from "@repo/agent/canvas/ops";
```

`@excalidraw/excalidraw` is a dependency here, for `convertToExcalidrawElements` alone. That is the data layer, not the editor — the imperative API and the React binding stay in `apps/web`. It is a heavy import all the same, so `apps/web` reaches the ops through a dynamic `import()` in `lib/canvas-adapter.ts` and they stay in the canvas chunk.

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
