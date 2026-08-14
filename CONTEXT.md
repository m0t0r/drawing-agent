# CONTEXT

The vocabulary and settled decisions for the drawing agent. Read this before exploring the
codebase; use these terms in issues, tests, and code rather than synonyms.

Established 2026-08-09 in a grilling session. Supporting research, with sources, is in
[`docs/research/agent-loop-patterns.md`](docs/research/agent-loop-patterns.md).

## Glossary

**The agent** — the system that turns a user's chat message into changes on the Excalidraw
canvas. Not a class or a file; the whole loop-plus-tools-plus-prompt.

**The loop** — the multi-step cycle we own: call the model for one step, dispatch any tool
calls, feed results back, repeat until the model stops or the step cap is hit. Lives in
`@repo/agent/src/loop.ts` as `runTurn()`. The shorthand is **own the loop, borrow the call**:
stepping, termination, budgets, history and error policy are ours; a single model call is
`streamText`'s. The AI SDK documents this as _Manual Loop Control_.

**Step** — one model call. `streamText` performs exactly one by default, so one step is one
`streamText` call. Capped at 8 per turn.

**Turn** — one HTTP request/response cycle, containing one or more steps. A turn ends when the
model stops or asks for a client-side tool. Not the same as a **step**.

**The wire** — the AI SDK UI message stream protocol carrying the loop's output to the
browser. Each step's stream is merged into one writer so a multi-step turn arrives as a single
assistant message. Distinct from **the loop**: the loop decides what happens, the wire only
carries it.

**Client-side tool** — a tool declared with no `execute`. The loop emits the call, the turn
ends, the browser fulfils it against the live canvas and posts the result back on the next
turn. All four canvas tools are client-side.

**Canvas op** — a pure `(elements, input) => elements` function implementing one tool's
effect. Knows nothing about React or Excalidraw's imperative API. Lives in
`@repo/agent/src/canvas/ops.ts`. The unit both the browser and the eval harness call.

**The adapter** — the thin layer that reads `getSceneElements()` and writes `updateScene()`,
bridging a **canvas op** to the live editor. The only browser-coupled canvas code.

**The executor** — what a **turn** does when the model calls a canvas tool. Either _suspend_
(end the turn and let the browser fulfil it) or _in-process_ (run the **canvas op** against an
in-memory element array and continue). Injected, which is what lets one `runTurn()` serve
production, evals and tests.

**Element skeleton** — the _input_ shape `convertToExcalidrawElements` consumes: `label: { text }`
for labels, `start`/`end: { id }` for arrow bindings. What the model emits.

**Runtime element** — what actually lives on the canvas after conversion: `containerId`,
`boundElements`, `startBinding`/`endBinding`. What scorers read. Never conflate the two —
grading skeletons grades the model's claims rather than what would render.

**Scene summary** — the compact serialization `queryCanvas` returns: id, type, geometry,
text/label, bindings, and nothing else. Never raw Excalidraw JSON.

**Scorer** — a pure function over the final element array returning a fraction in `[0,1]`,
or `null` to opt out when a case can't exercise it. Not a test assertion; scores are graded,
not pass/fail.

**Golden case** — one entry in an eval dataset: `id`, `input`, optional `seed` scene,
`expectedCharacteristics`, `expectedKeywords`, `preservedIds`, `difficulty`, `category`.

**The overlap loop** — `addElements` returns `{ added, overlaps }`; the system prompt obliges
the model to fix a non-empty `overlaps` with `updateElements`. One `findOverlaps` backs both
the tool result and the `NoOverlaps` scorer, so what the agent sees and what the eval grades
cannot disagree.

**The reference repos** — `Hendrixer/ai-engineering-fundamentals@complete` (same product,
Cloudflare-shaped) and `Hendrixer/harness-engineering@complete` (an owned loop around
`streamText`). Sources of patterns, not of versions or architecture.

## Settled decisions

- **OpenAI**, `gpt-5.4-mini` as a single exported constant. The AI SDK's OpenAI provider hits
  the **Responses API** by default. Evals choose the model later; we do not choose it up front.
- **Own the loop, borrow the call.** Our `while` loop owns stepping, termination, the step cap
  of 8, history shape, and error policy; each step is one `streamText` call. `streamText`
  defaults to `stopWhen: isStepCount(1)`, so single-stepping requires passing nothing — and it
  halts on a tool with no `execute` regardless.
- **Bounds**: step cap 8, `AbortSignal` from the request, tool failures returned as tool
  results carrying a next-step instruction rather than thrown.
- **The wire is the AI SDK's**, assembled by hand across steps: `createUIMessageStream` with
  `writer.merge()` per step, `sendStart` only on the first, `sendFinish` never, and an explicit
  finish when the loop decides. `useChat` on the client with
  `sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls`.
- **Resume is stateless.** A client tool result arrives as a fresh request with the full
  message history; the loop rebuilds model messages with `convertToModelMessages` — which is
  async, takes `tools`, and must not be given `ignoreIncompleteToolCalls` on this path.
- **Reasoning survives via `store: false`.** The provider then automatically requests encrypted
  reasoning content and replays it verbatim through the browser. Storing provider-side instead
  would make correctness depend on OpenAI retention.
- **Tools** are declared with `tool()`, `inputSchema`, and `strict: true`. Under strict mode
  every property must be required, so optional fields are `.nullable()` and nulls are stripped
  before the **element skeleton** reaches Excalidraw. Use `z.union`, never
  `z.discriminatedUnion` — the latter emits `oneOf`, which strict mode rejects. Structural
  invariants live in the schema, not the prompt.
- **Canvas ops are pure**; the React context exposes only `api`/`setApi`. Everything
  substantive lives in the op so both **executors** stay a bare switch.
- **Chat history is client-held and dies on reload**, matching the canvas's own lifetime.
- **The design system stays presentational** — it keeps its own message types; `apps/web`
  adapts at the boundary.
- **`@repo/agent`** holds the prompt, loop, tools, canvas ops, scorers, and evals. The route
  handler and React provider stay in `apps/web`.
- **Evals are Vitest 4 with our own deterministic scorers.** No vendor. Eval files are
  `*.eval.ts`; the Turbo `eval` task sets `"cache": false` — a cached eval score is a lie.
- **Loop tests inject `MockLanguageModelV4`** from `ai/test`, whose `doStream` accepts an array
  consumed one entry per call — which is how a multi-step turn is scripted.

## Deferred, deliberately

Durable execution · a hosted eval platform · tool approval on `removeElements` · wall-clock
and cost budgets · history compaction · TOON as the scene-summary encoding (behind a swappable
encoder, to be A/B'd once scorers exist) · model upgrades. RAG and web-search tools are ruled
out entirely.

## Traps worth knowing

- `@ai-sdk/react` pins `ai` **exactly**. Bump them together.
- `result.toUIMessageStream()` is deprecated; use the standalone `toUIMessageStream({ stream })`.
- In v7 top-level `usage`/`toolCalls`/`content` accumulate across steps; `finalStep.*` is the
  old single-step behaviour. Harmless at one step, but the loop must not double-count if the
  step budget ever moves.
- `MockLanguageModelV4`'s finish part takes `finishReason` as an object (`{ unified: 'stop' }`).
  A bare string silently becomes `'other'`.
- Unverified: whether `convertToExcalidrawElements` runs in bare Node (decides how far the pure
  core extends).
- Settled 2026-08-14: `vitest --typecheck` **does** parse TypeScript 7's output. Vitest 4.1.10
  shelling out to `tsgo` 7.0.2 reports a deliberate type error against the right file, line and
  column, and reports `no errors` once it is removed. The mode is still labelled experimental by
  Vitest, so pin the version if `*.test-d.ts` files are ever added; nothing uses it today.
