# Agent loop patterns, version drift, and evals

**Date:** 2026-08-09
**Scope:** How the `Hendrixer/ai-engineering-fundamentals` reference repo builds an Excalidraw-driving agent; how far its dependencies have drifted from current npm; what to use for evals in a TypeScript monorepo; and what conflicts with this repo's stack.
**Out of scope (ruled out by the user):** RAG, vector stores, embeddings, web-search tools. Where the reference repo contains those, they are named only to describe its structure, not recommended.

---

## Summary

- The reference repo is **the same product this repo wants to build**: a Cloudflare Workers agent that drives an Excalidraw canvas through tool calls, plus an eval suite that grades the resulting canvas. Its most transferable ideas are _client-side tools_ (the browser fulfils `addElements`/`queryCanvas` against the live Excalidraw API) and _one shared agent core_ used by both the live app and the eval harness so they cannot drift.
- Its agent loop is **not hand-written**. It is `streamText`/`generateText` from the Vercel AI SDK with `stopWhen: stepCountIs(8)`. There is no bespoke while-loop, no retry logic, and no try/catch anywhere in the loop.
- **Version drift is large.** The repo is pinned on AI SDK v6 (`ai@6.0.146`, `@ai-sdk/openai@3.0.50`); current is **`ai@7.0.58` / `@ai-sdk/openai@4.0.36`** — one major behind, with `system` → `instructions`, `onFinish` → `onEnd`, ESM-only, Node ≥22. `agents@0.9.0` → **`0.20.1`** and `@cloudflare/ai-chat@0.3.2` → **`0.10.1`** are the biggest practical jumps (the version pinned in the repo has three known React bugs, documented in its own `KNOWN_ISSUES.md`).
- **The biggest eval surprise: OpenAI's Evals product is deprecated.** Announced 2026-06-03, read-only 2026-10-31, shut down 2026-11-30 — and OpenAI's own deprecation page points migrations at **Promptfoo**. Do not build on OpenAI Evals.
- **Neither Anthropic nor Vercel ships a TypeScript eval library.** Anthropic's own agent-eval guidance names only third-party tools; the AI SDK's only official testing page is unit-testing with mock models. You must bring your own harness.
- **Recommendation:** Vitest 4 as the test runner (the repo has none), with either Braintrust `Eval()` (what the reference uses, actively released, esbuild-based) or Promptfoo (OpenAI's own recommended target, MIT, 24k stars, released five days before this document). Deterministic scorers over the produced Excalidraw scene graph carry most of the signal here; LLM-as-judge is a supplement, not the base.
- **No TypeScript-7 blocker found.** None of Vitest, evalite, Braintrust, autoevals, Promptfoo or tsx declares a dependency or peer dependency on the `typescript` package, so none consumes the (now-absent) TS JS compiler API. Vitest's `--typecheck` shells out to the `tsc` CLI, which is exactly what this repo's `check-types` script already does.

---

## 1. The reference repo

Cloned and read locally at branch `complete`, commit `26530ae57283ab79fa04542b757dfcd60355b4b4`, authored **2026-04-07** ("lesson 10: drop HITL/architectures/flywheel as code lessons, replace with 'Where to Go Next' notes"). Source: <https://github.com/Hendrixer/ai-engineering-fundamentals/tree/complete>

Its stated purpose, from its own README: "You build a Cloudflare Workers agent that controls an Excalidraw canvas through tool calls. Then you measure it with evals" — <https://github.com/Hendrixer/ai-engineering-fundamentals/blob/complete/README.md>

### 1.1 Agent loop

**There is no hand-written loop.** The loop is the AI SDK's built-in multi-step tool loop.

- Lives in `src/agent-core.ts` — <https://github.com/Hendrixer/ai-engineering-fundamentals/blob/complete/src/agent-core.ts>
- Two entry points share one system prompt and one tool set, deliberately: the file's own header comment says "Both the worker (streaming chat) and the eval harness (batch generateText) call into this file… means the eval and production agent cannot drift apart" (`src/agent-core.ts:1-4`).
- `streamAgent()` (`src/agent-core.ts:126-140`) is the live path:

  ```ts
  return streamText({
    model,
    system,
    messages,
    tools: buildTools(env),
    stopWhen: stepCountIs(maxSteps), // maxSteps = 8
  });
  ```

- `runAgent()` (`src/agent-core.ts:146-245`) is the eval path — identical shape but `generateText`, with tool `execute` functions rewritten to mutate an in-memory simulated canvas.

**Termination:** solely `stopWhen: stepCountIs(maxSteps)` with `maxSteps` defaulting to `8` (`src/agent-core.ts:130`, `:151`). The AI SDK's own semantics are that the loop also ends naturally when a step produces no tool calls; `stepCountIs` is the hard ceiling. Stop-condition semantics: <https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling>

**Turns:** up to 8 model steps per user message. No token budget, no wall-clock timeout, no cost cap.

**Error / retry handling: effectively none.** A grep across `src/*.ts` and `src/tools/*.ts` finds `try`/`catch` in exactly two places — `src/tools/search-web.ts:45-68` and `src/tools/search-knowledge.ts:26-42` — both of which return `{ error: "…" }` as a _tool result_ so the model can reason about the failure rather than crashing. There is no `maxRetries` setting, no `onError` handler, no abort signal, and no try/catch around `streamText`/`generateText` themselves. The design intent is stated in `src/tools/search-web.ts:9-11`: "Errors are caught and returned as `{ error }` so the model can reason about the failure instead of crashing the agent loop." Reliability at the transport layer is inherited from the AI SDK's default retry behaviour, not configured.

### 1.2 Tool definitions

**Declared with the AI SDK `tool()` helper and Zod v4 schemas**, one tool per file under `src/tools/`, aggregated by `buildTools()` in `src/tools.ts` — <https://github.com/Hendrixer/ai-engineering-fundamentals/blob/complete/src/tools.ts>

Tools: `addElements`, `updateElements`, `removeElements`, `queryCanvas` (canvas), plus `searchWeb` and `searchKnowledge` (out of scope here).

The interesting part is the **execution split**:

- **Client-side tools** (`addElements`, `updateElements`, `removeElements`, `queryCanvas`) are declared **with no `execute` function**. `src/tools/query-canvas.ts:4-10` spells out the mechanism: "When the agent calls this tool, the AI SDK doesn't run anything on the worker. Instead, the tool call gets streamed to the browser as part of the assistant message, and useAgentChat's `onToolCall` handler in App.tsx fulfills it by reading the live Excalidraw scene and submitting a tool result back. The agent loop then resumes with that result in context."
- The browser side is `src/App.tsx:61-149` — a single `onToolCall` switch that mutates the live Excalidraw scene via `api.updateScene(...)` and returns the result with `addToolOutput({ toolCallId, output })`. <https://github.com/Hendrixer/ai-engineering-fundamentals/blob/complete/src/App.tsx>
- **Server-side tools** are the two search tools, built by factory functions so they can close over per-request env (`src/tools.ts:24-36`).

**Schema library: Zod 4** (`zod@4.3.6`). Two non-obvious details worth stealing, both documented in `src/tools/element-schema.ts`:

- `strict: true` is set on the canvas tools (`src/tools/add-elements.ts:27`) to force OpenAI structured-output strict mode, and every optional field is therefore modelled as **`.nullable()` rather than `.optional()`** (`element-schema.ts:23-25`). The client then strips nulls recursively before handing the payload to Excalidraw (`src/App.tsx:28-38`).
- `z.union` is used deliberately instead of `z.discriminatedUnion`, with the reason in a comment at `element-schema.ts:125-129`: "discriminatedUnion produces `oneOf`, which OpenAI's strict mode rejects with `'oneOf' is not permitted.` `z.union` produces `anyOf`, which strict mode accepts."
- Structural invariants are pushed **into the schema rather than the prompt**: labelling a shape is only expressible as `label: { text }` on the shape, and arrow binding is only expressible as `start: { id }` / `end: { id }` (`element-schema.ts:36-104`). The stated rationale (`:18-21`): "the model literally cannot construct an element that drops its label or floats its arrow."

**Tool errors surface as tool results.** Server tools return `{ error: string }`. Client tools return `{ error: "canvas not ready" }` when the Excalidraw API isn't mounted (`src/App.tsx:65-68`). Nothing throws.

There is also a **feedback channel from tool result back into the loop**: `addElements` returns `{ added, overlaps }`, where `overlaps` is computed by the shared `findOverlaps` helper (`src/App.tsx:110-118`, and the same in the eval simulator at `src/agent-core.ts:180-183`). The system prompt then makes acting on it mandatory: "If `overlaps` is non empty after a call, your next action MUST be one or more `updateElements` calls that move the offending elements apart" (`src/agent-core.ts:80`). The same helper backs the `NoOverlaps` eval scorer, so what the agent sees and what the eval grades cannot disagree (`evals/scorers/noOverlaps.ts:22-27`).

### 1.3 Streaming

- **What streams:** the full AI SDK UI message stream — text deltas, tool-call parts, tool-result parts, step boundaries. `src/agent.ts:29` returns `result.toUIMessageStreamResponse()`.
- **Transport: WebSocket, not SSE.** The Cloudflare Agents SDK routes chat over a WebSocket to a Durable Object. This is visible in the raw protocol used by the repo's own CLI harness, `scripts/test-agent.mjs:6-32`: it opens `ws://localhost:5173/agents/design-agent/test` and sends `{ type: "cf_agent_use_chat_request", id, init: { method, headers, body } }`, then reads frames of type `cf_agent_use_chat_response`. Cloudflare Agents docs: <https://developers.cloudflare.com/agents/>
- **UI consumption:** `useAgent({ agent: "design-agent", name: sessionId })` from `agents/react` plus `useAgentChat({ agent, onToolCall })` from `@cloudflare/ai-chat/react` (`src/App.tsx:8-9`, `:56-63`). The hook returns `{ messages, sendMessage, status }`, which `ChatPanel` renders; `status === "submitted" || "streaming"` drives the disabled/spinner state (`src/components/chat/ChatPanel.tsx:29`).

### 1.4 State

- **Conversation state lives server-side in a Cloudflare Durable Object with SQLite storage.** `wrangler.toml` binds `DesignAgent` as a Durable Object and declares `new_sqlite_classes = ["DesignAgent"]`. The class is `export class DesignAgent extends AIChatAgent<Env>` (`src/agent.ts:13`); `this.messages` is the persisted history that `onChatMessage` reads (`src/agent.ts:17`). Durable Objects + SQLite: <https://developers.cloudflare.com/durable-objects/>
- **Persistence across reloads is deliberately disabled.** `src/App.tsx:17-20`: "One agent instance per page load. The canvas state lives only in the browser, so persisting chat history across refreshes would leave a dead conversation referencing diagrams that no longer exist." — implemented as `const sessionId = crypto.randomUUID()` at module scope, so every page load addresses a fresh DO instance.
- **Canvas state is never mirrored server-side.** The browser's Excalidraw scene is the single source of truth, read lazily by the `queryCanvas` client tool. `src/tools/query-canvas.ts:12-18` lists why this beats stuffing canvas state into every request: lazy, protocol-native, and "no risk of stale state." When the agent does read it, it gets a compact text summary from `serializeCanvasState`, not raw Excalidraw JSON, "because it's huge and the model doesn't need pixel level coordinates" (`src/context/canvas-state.ts:1-5`).
- **The eval fakes the browser.** `runAgent` keeps a mutable `sim: Record<string, unknown>[]` array, seeded from the test case, and overrides all four canvas tools to read/write it (`src/agent-core.ts:158-222`). Crucially, `addElements` runs the model output through `applySkeleton` first so the simulated scene matches what `convertToExcalidrawElements` would produce in the real app — "Without this, the eval scorers read raw model claims and not what the canvas would actually render" (`src/agent-core.ts:172-177`).

### 1.5 Where the loop sits relative to the UI

**Server-side, inside a Durable Object, reached over a WebSocket.** `src/worker.ts` is a five-line Workers fetch handler that delegates everything to `routeAgentRequest(request, env)` from the `agents` package. The loop itself runs in `DesignAgent.onChatMessage()`. The client contributes _tool execution_ (the canvas mutations) but not loop control.

Note the direct consequence for this repo: **this architecture does not transfer as-is to Next.js.** See §4.

### 1.6 Evals

Yes — evals are the point of the repo (four of its ten lessons are about them).

- **Framework: Braintrust** (`braintrust@3.7.1`), run through its CLI: `"eval": "dotenv -e .dev.vars -- braintrust eval evals/diagram.eval.ts"` (`package.json`). Braintrust docs: <https://www.braintrust.dev/docs>
- **Definition:** one `Eval<GoldenTestCase, AgentOutput, GoldenTestCase>("Diagram Agent", { data, task, scores })` in `evals/diagram.eval.ts`. The `task` calls the shared `runAgent` from `src/agent-core.ts` — the eval grades the _real agent_, not a reimplementation.
- **Dataset:** static JSON goldens checked into the repo. `evals/datasets/golden.json` (23 cases) and `evals/datasets/golden_2.json` (31 cases, the one actually wired up). Each case carries `id`, `input`, optional `seed` (pre-existing canvas), `expectedCharacteristics`, `expectedKeywords`, `preservedIds`, `difficulty` (`simple`/`medium`/`hard`/`edge`) and `category` (`create`/`modify`/`domain`/`edge`) — `evals/buildMessages.ts:21-30`.
- **Scorers: all deterministic, zero LLM-as-judge.** Eight scorers live in `evals/scorers/`; four are wired into the eval (`schema`, `structure`, `toolChoice`, `labelKeyword`), and `boundArrows`, `boundLabels`, `connectivity`, `noOverlaps` ship but are commented as deliberately un-wired pending a later lesson (`evals/diagram.eval.ts:22-25`).

  | Scorer          | Asserts                                                                                                                                  |
  | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
  | `Schema`        | every element has `id/type/x/y/width/height` and a valid `type`; 0/1                                                                     |
  | `Structure`     | element counts parsed out of `expectedCharacteristics` strings vs actual, graded                                                         |
  | `ToolChoice`    | per category: `create`/`domain` must call `addElements`; `modify` must call `queryCanvas` _before_ any mutator (0.5 if it mutates blind) |
  | `LabelKeywords` | fraction of `expectedKeywords` found in response text or element text/label                                                              |
  | `BoundArrows`   | fraction of arrows with both `startBinding`/`endBinding` resolving to a real element id                                                  |
  | `BoundLabels`   | fraction of container shapes that have a text element with a matching `containerId`                                                      |
  | `Connectivity`  | BFS reachability over bound arrows, only for prompts containing connectivity words                                                       |
  | `NoOverlaps`    | `1 - overlappingPairs / eligiblePairs`, excluding arrows/lines and bound labels                                                          |

- Two patterns worth copying wholesale:
  - **Scorers return `null` to opt out.** "Cases without expectedKeywords return null so they don't count toward this metric" (`evals/scorers/labelKeyword.ts:6-8`); `Connectivity` returns `null` for prompts with no connectivity hint. Braintrust skips those cases for that scorer rather than scoring them zero.
  - **Graded over binary, on purpose.** "Reachability gives a continuous score (3/5 = 0.6) instead of a binary… Continuous scores show progress in the eval over time" (`evals/scorers/connectivity.ts:27-31`).
- **Run:** `npm run eval`. Requires a `BRAINTRUST_API_KEY`; every run becomes a Braintrust experiment auto-tagged with git branch/commit/dirty flag (`evals/diagram.eval.ts:1-6`). No CI wiring is present in the repo.
- `autoevals@0.0.132` is a devDependency but is **not imported anywhere** in `evals/` — the repo installs Braintrust's scorer library and then writes all its own.

### 1.7 Dependencies as pinned

From `package.json` and `package-lock.json` at `complete`:

| Package                            | Range in package.json | Locked  |
| ---------------------------------- | --------------------- | ------- |
| `ai`                               | `^6.0.146`            | 6.0.146 |
| `@ai-sdk/openai`                   | `^3.0.50`             | 3.0.50  |
| `@ai-sdk/provider` (transitive)    | —                     | 3.0.8   |
| `@ai-sdk/react` (transitive)       | —                     | 3.0.148 |
| `zod`                              | `^4.3.6`              | 4.3.6   |
| `agents`                           | `^0.9.0`              | 0.9.0   |
| `@cloudflare/ai-chat`              | `^0.3.2`              | 0.3.2   |
| `@excalidraw/excalidraw`           | `^0.18.0`             | 0.18.0  |
| `@upstash/vector` _(out of scope)_ | `^1.2.3`              | 1.2.3   |
| `react` / `react-dom`              | `^19.0.0`             | 19.2.4  |
| `braintrust` (dev)                 | `^3.7.1`              | 3.7.1   |
| `autoevals` (dev)                  | `^0.0.132`            | 0.0.132 |
| `typescript` (dev)                 | `^5.0.0`              | 5.9.3   |
| `vite` (dev)                       | `^6.0.0`              | 6.4.1   |
| `tsx` (dev)                        | `^4.21.0`             | 4.21.0  |
| `@cloudflare/vite-plugin` (dev)    | `^1.0.0`              | 1.31.0  |
| `wrangler` (transitive)            | —                     | 4.80.0  |

Model ids used: `openai("gpt-5.4")` in production (`src/agent.ts:16`) and `openai("gpt-5.4-mini")` in the eval (`evals/diagram.eval.ts:50`).

---

## 2. Version drift

All "current" figures read live from the npm registry on 2026-08-09 via `npm view <pkg> version` and `npm view <pkg> time --json`.

| Package                  | Repo pins | Current                               | Gap                                |
| ------------------------ | --------- | ------------------------------------- | ---------------------------------- |
| `ai`                     | 6.0.146   | **7.0.58** (2026-08-07)               | **1 major**                        |
| `@ai-sdk/openai`         | 3.0.50    | **4.0.36** (2026-08-07)               | **1 major**                        |
| `@ai-sdk/react`          | 3.0.148   | **4.0.61**                            | **1 major**                        |
| `agents`                 | 0.9.0     | **0.20.1** (2026-07-28)               | 11 minors (0.x = breaking)         |
| `@cloudflare/ai-chat`    | 0.3.2     | **0.10.1** (2026-07-28)               | 7 minors (0.x = breaking)          |
| `zod`                    | 4.3.6     | **4.4.3** (2026-05-04)                | minor                              |
| `braintrust`             | 3.7.1     | **3.27.0** (2026-08-04)               | 20 minors, same major              |
| `autoevals`              | 0.0.132   | **0.3.0** (2026-06-09)                | **0.0.x → 0.3.x**                  |
| `@excalidraw/excalidraw` | 0.18.0    | **0.18.1** (2026-08-07)               | patch                              |
| `typescript`             | 5.9.3     | **7.0.2** (this repo already runs it) | **2 majors**                       |
| `vite`                   | 6.4.1     | **8.2.1**                             | 2 majors (not relevant to Next.js) |
| `wrangler`               | 4.80.0    | **4.120.0**                           | minors                             |

Release dates for context: `ai@6.0.0` shipped 2025-12-22; `ai@7.0.0` shipped **2026-06-25**. So the reference repo (last commit 2026-04-07) predates AI SDK 7 entirely — it isn't neglected, it's just from before the major.

### 2.1 `ai` v6 → v7 — the significant one

Official migration guide: <https://ai-sdk.dev/docs/migration-guides/migration-guide-7-0>

Breaking changes that hit this exact codebase:

- **`system` → `instructions`.** `streamText({ system, … })` is renamed. System messages inside `messages` are now _rejected by default_; legacy histories need `allowSystemInMessages: true`. This touches `streamAgent`/`runAgent` directly. _(Verified in the shipped typings: `ai@7.0.58` `dist/index.d.ts:7913` declares `instructions?: string`; `system?: Instructions` is still present at `:686`/`:1721` as the deprecated alias, so the change is soft, not a hard break.)_
- **`stepCountIs()` → `isStepCount()`.** _Verified nuance:_ `ai@7.0.58` still exports `isStepCount as stepCountIs`, so existing code compiles. Rename it anyway for clarity.
- **`onFinish` → `onEnd`, `onStepFinish` → `onStepEnd`**, and the `experimental_` prefix dropped from `onStart`/`onStepStart`.
- **`result.fullStream` → `result.stream`.**
- **Multi-step result shape changed.** Top-level `usage` now aggregates _all_ steps rather than the final one, and final-step-only properties (`reasoning`, `request`, `response`, `providerMetadata`) moved under `result.finalStep`. `content`, `toolCalls`, `toolResults`, `files` now accumulate across all steps. **This is the one that would silently corrupt an eval harness** — the reference repo's `runAgent` flattens `result.steps[].toolCalls` manually (`src/agent-core.ts:234-237`); under v7 the top-level `result.toolCalls` already does that, and any cost/usage assertion written against v6 semantics now means something different.
- **`result.toUIMessageStreamResponse()` deprecated** in favour of the stateless top-level `createUIMessageStreamResponse()`. _(Verified: the method still exists at `dist/index.d.ts:2806`, and `createUIMessageStreamResponse` is exported — so this is deprecation, not removal.)_
- **Tool approval / HITL is now first-class:** `needsApproval` on a tool is deprecated in favour of a `toolApproval` generation option; `experimental_onToolCallStart/Finish` → `onToolExecutionStart/End`. The v7 typings export `ToolApprovalConfiguration`, `SingleToolApprovalFunction`, `ToolApprovalRequestOutput`, `ToolApprovalStatus`. A 2026 build should use this instead of hand-rolling the confirmation-card flow the reference repo sketches in `src/components/hitl/`.
- **Telemetry moved out** to a separate `@ai-sdk/otel` package; register globally with `registerTelemetry(new OpenTelemetry())`; `experimental_telemetry` → `telemetry` and is opt-out once registered. _(Verified: `registerTelemetry` is exported by `ai@7.0.58` and is **not** exported by `ai@6.0.246`.)_
- **Content part consolidation:** `{ type: 'media' }` removed; `image-*`/legacy `file-*` variants collapse into `{ type: 'file', mediaType, data }`; message `{ type: 'image', image }` → `{ type: 'file', mediaType: 'image', data }`. New `reasoning-file` part type.
- **Usage field renames:** `usage.cachedInputTokens` → `usage.inputTokenDetails.cacheReadTokens`; `usage.reasoningTokens` → `usage.outputTokenDetails.reasoningTokens`.
- **Runtime:** Node **≥22** required and **CommonJS support removed — ESM only**. _(Verified in `ai@7.0.58` package.json: `"engines": { "node": ">=22" }`, `"type": "module"`.)_ This repo already targets `@types/node` on the Node 24 line, so it is fine.
- **Peer range:** `ai@7.0.58` peers `zod@^3.25.76 || ^4.1.8`. The reference repo's `zod@4.3.6` and current `zod@4.4.3` both satisfy it.

Things that **did not** change, contrary to what a migration guide skim suggests:

- **`tool()` and `dynamicTool()` are still exported from `ai`** in both v6.0.246 and v7.0.58 _(verified by parsing the export blocks of each package's `dist/index.d.ts`)_.
- **`strict: true` on a tool still works.** It is declared in `@ai-sdk/provider-utils@5.0.25` (`dist/index.d.ts:1921`), which `ai@7.0.58` depends on. The Zod-`union`-not-`discriminatedUnion` trick therefore remains necessary and valid.
- **The client-tool round-trip is unchanged in shape.** `onToolCall` + `addToolOutput` is still the documented flow: <https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-tool-usage>. Two v7 refinements to adopt: check `if (toolCall.dynamic) return;` first for type narrowing, and report failures as `addToolOutput({ …, state: 'output-error', errorText })` rather than an ad-hoc `{ error }` payload — which is strictly better than the reference repo's `{ error: "canvas not ready" }` string blob.
- **`Agent` / `ToolLoopAgent` already existed in v6** _(verified: both are exported by `ai@6.0.246` and `ai@7.0.58`)_. If you want an object you configure once and reuse across the route handler and the eval harness, that class is the SDK-native version of what `agent-core.ts` does by hand.

New in v7 worth knowing about (present in `ai@7.0.58` exports, absent from `ai@6.0.246`): `registerTelemetry`, `detectToolDrift`, `addToolInputExamplesMiddleware`, `fingerprintTools`, `defaultInstructionsMiddleware`, `uploadSkill`.

### 2.2 `@ai-sdk/openai` v3 → v4

Current **4.0.36**, first 4.0.0 on 2026-06-25 (same day as `ai@7.0.0`) — the provider major tracks the core major. `createOpenAI` is still exported (`dist/index.d.ts:1529`) and the call site `createOpenAI({ apiKey })` is unchanged. Strict structured output is exposed as a provider option `strictJsonSchema?: boolean` (`dist/index.d.ts:19`, `:1372`). Peer: `zod@^3.25.76 || ^4.1.8`. I did not find a provider-specific migration guide beyond the core one — see open questions.

### 2.3 `agents` 0.9 → 0.20 and `@cloudflare/ai-chat` 0.3.2 → 0.10.1

Changelog: <https://github.com/cloudflare/agents/blob/main/packages/agents/CHANGELOG.md>

Only relevant if you keep the Cloudflare architecture (this repo does not — see §4). Headlines: `AIChatAgent` and the chat infrastructure moved out of `agents` core into `@cloudflare/ai-chat`; the packages now support **both AI SDK v6 and v7** with the divergences normalised internally; SQLite storage schema changed (session history and resumable-stream buffers, migrated lazily on write); MCP SDK v2 support added with v1 deprecated; durable pause/approval HITL added.

The concrete reason to upgrade if you _were_ staying: the repo's own `KNOWN_ISSUES.md` documents three React bugs in `@cloudflare/ai-chat@0.3.2` — `Maximum update depth exceeded` in `PartySocket.onAgentMessage`, duplicate-key warnings from the library appending duplicate `UIMessage` ids, and a `Cannot read properties of undefined (reading 'state')` in `Chat.makeRequest` — described there as "pre existing in `@cloudflare/ai-chat` 0.3.2 (the latest published version)". Seven minors have shipped since.

### 2.4 `braintrust` 3.7.1 → 3.27.0, `autoevals` 0.0.132 → 0.3.0

Same major for Braintrust (3.0.0 shipped 2026-02-19), so the `Eval()` / `EvalScorer` surface the reference repo uses should be intact. `autoevals` crossing 0.0.x → 0.3.0 is a 0-major bump and therefore potentially breaking, but the reference repo never imports it, so nothing to migrate. Both repos are actively pushed: `braintrustdata/braintrust-sdk` last push 2026-08-07, `braintrustdata/autoevals` 2026-07-29 (GitHub API).

### 2.5 What a fresh 2026 implementation should do differently

1. Start on `ai@7` + `@ai-sdk/openai@4` (or `@ai-sdk/anthropic@4`, also 4.0.36) — not v6.
2. Write `instructions:` not `system:`; `isStepCount` not `stepCountIs`; `onEnd`/`onStepEnd` not `onFinish`/`onStepFinish`.
3. Read `result.toolCalls` / `result.usage` as the _accumulated across steps_ values, and reach into `result.finalStep` for last-step-only data. Do not port the manual `for (const step of result.steps)` flattening.
4. Use `createUIMessageStreamResponse()` rather than the deprecated result method.
5. Use the built-in `toolApproval` option for human-in-the-loop instead of a bespoke confirmation-card protocol.
6. Keep the reference repo's genuinely good ideas, which are version-independent: one shared agent core for app and eval; client-side tools driving the live canvas; structural invariants encoded in the Zod schema rather than prose; tool results that feed a layout critique (`overlaps`) back into the loop; and one `findOverlaps` implementation shared by the tool and the scorer.
7. Add what the reference lacks: an abort signal, a wall-clock or token budget alongside the step cap, and an `onError` path. The reference's total absence of retry/abort logic is a gap, not a pattern.

---

## 3. Evals — current recommended approach

### 3.1 The headline: OpenAI Evals is being shut down

From OpenAI's own deprecations page — <https://developers.openai.com/api/docs/deprecations>:

> "On June 3, 2026, we notified developers using the Evals platform that the product is being deprecated."

- **2026-10-31** — existing evaluations become read-only
- **2026-11-30** — the Evals dashboard and API shut down
- The same page states: _"See Moving from OpenAI Evals to Promptfoo for a migration path."_

The Evals guide itself (<https://developers.openai.com/api/docs/guides/evals>) carries the same notice. Do not build anything on `openai.evals.*`. This also removes what would otherwise have been the obvious first-party option given the reference repo's OpenAI-based stack.

### 3.2 Neither model vendor ships a TypeScript eval library

**Anthropic ships no eval framework in any language.** Its canonical guidance page is "Define success criteria and build evaluations" — <https://platform.claude.com/docs/en/test-and-evaluate/develop-tests> (the older `.../define-success` and `.../eval-tool` URLs both 302 here; `docs.claude.com` / `docs.anthropic.com` now redirect to `platform.claude.com`). It recommends success criteria that are "Specific, Measurable, Achievable, Relevant", multidimensional scoring across eight axes (task fidelity, consistency, relevance/coherence, tone and style, privacy preservation, context utilization, latency, price), and three principles that align exactly with the reference repo's approach:

> "Automate when possible: Structure questions to allow for automated grading (for example, multiple-choice, string match, code-graded, LLM-graded)."
> "Prioritize volume over quality: More questions with slightly lower signal automated grading is better than fewer questions with high-quality human hand-graded evals."

It also advises using "a different model to evaluate than the model used to generate the evaluated output" for LLM-graded scoring. Anthropic's agent-specific post, "Demystifying evals for AI agents" (2026-01-09, <https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents>), recommends starting with **20–50 tasks sourced from real failures**, distinguishes code-based / model-based / human graders, and introduces `pass@k` vs `pass^k` — and the frameworks it names are **all third-party**: Harbor, Braintrust, LangSmith, Langfuse, Arize Phoenix.

Confirmed by package inspection: `@anthropic-ai/sdk` is at **0.116.0** (published 2026-08-07) and its `resources/` directory contains only `beta`, `completions`, `messages`, `models`, `shared`, `top-level` — no `evals` resource (<https://unpkg.com/browse/@anthropic-ai/sdk@0.116.0/resources/>). `@anthropic-ai/claude-agent-sdk` is at **0.3.226** (published 2026-08-08, <https://github.com/anthropics/claude-agent-sdk-typescript>) and its `sdk.d.ts` contains nothing eval-related — the only `eval` hits are an LLM-prompt-based permission _hook_, not a harness. This is the asymmetry with OpenAI, whose SDK _did_ have a first-party `evals` resource — and that is the one being shut down.

### 3.3 Vercel AI SDK — no eval framework, only unit-test mocks

The AI SDK's official testing page (<https://ai-sdk.dev/docs/ai-sdk-core/testing>) covers **deterministic unit testing only**. It exports from `ai/test`: `MockLanguageModelV4`, `MockEmbeddingModelV4`, `mockId`, `mockValues`, plus `simulateReadableStream` from `ai`. _(Verified against the shipped `ai@7.0.58` typings — `dist/test/index.d.ts` declares `MockLanguageModelV3` and `MockLanguageModelV4` classes side by side, along with mock image/speech/transcription/video/reranking/provider models.)_ Its stated rationale: language models are "non-deterministic and calling them is slow and expensive," so mock them and "test your code in a repeatable and deterministic way without actually calling a language model provider."

This is real value for this repo — it lets you test _the canvas-mutation code_ (does `addElements` produce a well-formed scene? does the null-stripping work?) with zero API spend and no flakiness — but it is **not** an eval framework. There is no scoring, no dataset, no judge, no experiment tracking. You need something on top.

This absence is confirmed structurally, not just by reading one page: `ai-sdk.dev/sitemap.xml` contains no page matching `eval`, and `ai-sdk.dev/llms.txt` has zero lines matching "eval". Two adjacent pages are easy to mistake for eval guidance and are not: <https://ai-sdk.dev/docs/agents/workflows> documents an "Evaluator-optimizer" _runtime_ pattern (one LLM critiquing another inside a live agent), and <https://ai-sdk.dev/cookbook/node/local-caching-middleware> is a caching recipe motivated by eval development. Vercel publishes eval _guidance_ as company KB/blog content (<https://vercel.com/kb/guide/an-introduction-to-evals>) but ships no eval framework in the SDK.

### 3.4 The candidates

| Tool                                        | Current version                   | Last activity                            | What it gives you                                                                                                      |
| ------------------------------------------- | --------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **Vitest**                                  | **4.1.10** (published 2026-07-06) | active                                   | Test runner only. The substrate everything else sits on.                                                               |
| **Braintrust** (`braintrust` + `autoevals`) | **3.27.0** / **0.3.0**            | repo pushed 2026-08-07 / 2026-07-29      | `Eval()` API, `braintrust eval` CLI, hosted experiment tracking + diffing, autoevals scorer library incl. LLM-as-judge |
| **Promptfoo**                               | **0.122.0** (2026-08-04)          | pushed 2026-08-09; MIT; 24,083 stars     | Declarative eval configs, large assertion library, red-teaming, CI integration. OpenAI's recommended migration target. |
| **evalite**                                 | **0.19.0** (2025-11-06)           | ⚠️ last default-branch commit 2025-11-10 | Vitest-native local-first evals with a watch-mode UI. Not archived, but ~9 months without a release.                   |

Notes on each, from primary sources:

**Vitest 4.** `npm view vitest version` → `4.1.10`; 4.0.0 shipped 2025-10-22. It has no LLM-specific features — `npm view vitest dependencies` shows a plain Vite/tinybench/expect stack. For agent evals you use it as the harness: `describe`/`test`, `test.concurrent`, custom timeouts, and snapshot testing over the produced Excalidraw scene. This is the minimum viable answer and requires no vendor account.

**Braintrust.** What the reference repo uses. `Eval(name, { data, task, scores })` with scorers of the form `({ input, output, expected, metadata }) => Score | number | null` — see `evals/scorers/*.ts` above for the exact shape in practice, and <https://www.braintrust.dev/docs/reference/libs/nodejs> for the API surface (`maxConcurrency`, `trialCount`, `timeout`, `baseExperimentName` for diffing against a previous run). _Verified from the published tarball (`braintrust@3.27.0`):_ it ships two bins (`braintrust` → `dist/cli.js`, `bt` → `bin/bt`), bundles **esbuild 0.28.1** as a direct dependency and depends on **no `typescript` package**, and its CLI matches eval files by the extensions `.eval.ts`, `.eval.tsx`, `.eval.js`, `.eval.jsx` (strings present in `dist/cli.js`). It **requires credentials** — `BRAINTRUST_API_KEY`, a `.env.braintrust` file, or an explicit `apiKey` — so results go to a hosted service. `autoevals@0.3.0` supplies both heuristic scorers (`ExactMatch`, `Levenshtein`, `JSONDiff`, `NumericDiff`, `ListContains`, `ValidJSON`, `Sql`) and LLM-as-judge scorers (`Factuality`, `ClosedQA`, `Battle`, `Humor`, `Security`, `Summary`, `Translation`, `Moderation`, `AnswerCorrectness`, `AnswerRelevancy`, plus `LLMClassifierFromTemplate` / `LLMClassifierFromSpec` for custom judges) — _verified by reading `package/jsdist/index.d.ts` in the published `autoevals@0.3.0` tarball_. `autoevals` depends on `openai@^6.7.0` and peers `zod@^3.25.0 || ^4.0.0`.

**Promptfoo.** MIT-licensed, 24,083 stars, released 0.122.0 five days ago and pushed today (GitHub API). Its own description: "Test your prompts, agents, and RAGs… Simple declarative configs with command line and CI/CD integration." Bins `promptfoo` / `pf`; it depends on `tsx@^4.21.0` (so TS files are transpiled by esbuild, not tsc) and on **no `typescript` package**. It is the option OpenAI itself points at. The details that matter for this project:

- **It can wrap an arbitrary agent function, not just a raw prompt.** <https://promptfoo.dev/docs/providers/custom-api/>: "At minimum, a custom provider must implement an `id` method and a `callApi` method." `callApi(prompt, context, options)` returns a `ProviderResponse` (`output`, `error`, `tokenUsage`, `cost`, `cached`, `metadata`). CommonJS, ESM and TypeScript are supported with a typed `ApiProvider` interface. That is exactly the seam for calling a shared `runAgent()` and returning the resulting Excalidraw scene.
- **Configuration is YAML-first** (`promptfooconfig.yaml`), with `.js` and `.json` also accepted and a custom path via `promptfoo eval -c <path>` — <https://promptfoo.dev/docs/configuration/reference/>. Test _cases_ may additionally be YAML/JSON/JSONL/CSV/TypeScript/JavaScript (<https://promptfoo.dev/docs/configuration/guide/>).
- **Assertions** (<https://promptfoo.dev/docs/configuration/expected-outputs/>) split into deterministic (`equals`, `contains`, `regex`, `is-json`, `is-valid-function-call`, `latency`, `cost`, `levenshtein`, `rouge-n`, `bleu`, and — critically here — **`javascript`** for arbitrary TS graders) and model-graded (**`llm-rubric`**, **`g-eval`**, `factuality`, `answer-relevance`, `similar`, `classifier`, `moderation`, `select-best`, `max-score`). The `javascript` assertion is what would host the scene-graph scorers.
- **CI** (<https://promptfoo.dev/docs/integrations/ci-cd/>): the documented pattern needs no install — `npx promptfoo@latest eval -c promptfooconfig.yaml -o results.json`, with multi-format output including `results.junit.xml`, exit-code gating via `--fail-on-error`, a caching path at `~/.cache/promptfoo`, and a dedicated GitHub Action.
- **Programmatic use** (<https://promptfoo.dev/docs/usage/node-package/>): `import promptfoo from 'promptfoo'; await promptfoo.evaluate(testSuite, options)` with full TS types (`TestSuiteConfiguration`, `EvaluateOptions`, `ProviderFunction`). Requires **Node ≥ 22.22.0**.
- _Caveat:_ the install docs (<https://promptfoo.dev/docs/installation/>) document global install, `npx`, brew and `npm install promptfoo --save`, but **not** `--save-dev`, and pnpm appears only in the uninstall section. `pnpm exec promptfoo eval` from a workspace devDependency should work — it is a normal package with a `bin` — but it is not documented, so verify it rather than assume.

**evalite.** The most attractive fit on paper — "the TypeScript-native, local-first tool for testing LLM-powered apps," built directly on Vitest, so `evalite watch` gives you a live scoring UI with no vendor account. **But verify the maintenance risk before adopting:** npm's registry metadata puts the last publish, `0.19.0`, at **2025-11-06**, and the GitHub API shows the newest commit on the default branch at **2025-11-10** with 63 open issues. The repo is _not_ archived or disabled (`{"archived": false, "disabled": false}`) and metadata was touched as recently as 2026-04-28, but nine months without a release for a fast-moving category is a real signal. It did track Vitest 4 as of its 0.17.0 release.

### 3.5 Recommendation for this repo

**Deterministic scorers over the Excalidraw scene graph are where almost all the signal is**, and this domain is unusually lucky in that respect: "is every arrow bound to a real element", "do any two shapes overlap", "is the graph connected", "did the agent call `queryCanvas` before mutating" are all _exactly computable_. The reference repo proves the point — it ships eight scorers and not one of them calls a model. Reach for LLM-as-judge only for the genuinely fuzzy residue (does the diagram actually answer the question? is the labelling idiomatic?), and treat it as a supplementary metric.

Concretely:

1. **Add Vitest 4 as the test runner.** It is the piece the repo is missing, it is needed regardless of eval framework, and it unlocks the AI SDK's `MockLanguageModelV4` for cheap deterministic tests of the tool-execution and canvas-mutation code.
2. **Layer the eval framework on top, choosing by whether you want a hosted service.** Braintrust if you want experiment-over-experiment diffing and are happy sending traces to a vendor (and it is the path with a working, readable reference implementation you can lift almost verbatim). Promptfoo if you want to stay local/OSS and follow OpenAI's own migration advice. Both are actively released as of this month; both are esbuild/tsx-based and safe under TS 7.
3. **Do not adopt evalite without a maintenance decision**, despite it being the best conceptual fit.
4. **Steal the reference repo's eval _architecture_ regardless of framework:** one shared agent core called by both the app and the eval; a headless simulated canvas so evals run without a browser; scorers that return `null` to opt out; graded rather than binary scores; and one implementation of each geometric check shared by the tool result and the scorer.

### 3.6 Running it in this Turborepo — what actually needs adding

This repo has **no test runner and no test task** — confirmed: neither `apps/web/package.json` nor the root exposes a `test` script, and `CLAUDE.md` states "No test runner is configured yet."

Required additions:

- A `vitest` devDependency and a `vitest.config.ts` per package that needs one. Node-environment agent evals need no React plugin; component tests would additionally need `@vitejs/plugin-react` and a jsdom/happy-dom environment.
- A `test` script per package plus a `test` task in root `turbo.json`. Per Turborepo's task docs (<https://turborepo.com/docs/reference/configuration#tasks>), the task needs `"dependsOn": ["^build"]` only if consumed packages were built — this repo's shared packages are unbuilt and imported as source, so that is unnecessary.
- **Evals must not be cached like tests.** They are non-deterministic, cost money, and hit the network. Give them their own Turborepo task with `"cache": false`, and keep it off the default `pnpm test` path so `turbo` never replays a stale eval score. Task options: <https://turborepo.com/docs/reference/configuration#cache>
- Env var passthrough: any API key an eval reads must be declared in the task's `env` array or Turborepo will hash it out. <https://turborepo.com/docs/crafting-your-repository/using-environment-variables>
- A separate location for eval files. The reference repo puts them in a top-level `evals/` directory with a `*.eval.ts` suffix — a convention Braintrust's CLI matches natively and which keeps them out of Vitest's default `*.test.ts` glob.

---

## 4. Fit notes for this repo

Constraints read from `/Users/m0t0r/Developer/drawing-agent/CLAUDE.md` and `/Users/m0t0r/Developer/drawing-agent/apps/web/package.json`: Next.js 16.3.0 App Router, React 19.2.8, React Compiler via `babel-plugin-react-compiler@1.0.0`, Tailwind 4, TypeScript `^7.0.2`, oxlint + oxfmt (no ESLint, no Prettier), `@types/node` on the Node 24 line, pnpm 9 workspaces + Turborepo.

**The architecture does not port; the patterns do.** The reference repo's loop lives in a Cloudflare Durable Object behind a WebSocket (`routeAgentRequest`, `AIChatAgent`, `wrangler.toml`). This repo is a Next.js app. The natural translation is:

- Loop in a **Next.js Route Handler** (`apps/web/app/api/chat/route.ts`) calling `streamText` and returning `createUIMessageStreamResponse(...)`.
- Client via **`useChat` from `@ai-sdk/react`** (current **4.0.61**) rather than `useAgentChat`.
- **Canvas tools stay client-side, unchanged in spirit** — declare them with no `execute`, fulfil them in `onToolCall` against the `ExcalidrawImperativeAPI` this repo already exposes (commit `372f0d6`, "add Excalidraw canvas with imperative API context"), and return via `addToolOutput`.
- Neither `agents` nor `@cloudflare/ai-chat` is needed. That sidesteps the entire 0.9→0.20 migration _and_ the three known React bugs.

Things to check before committing:

- **`@ai-sdk/react@4.0.61` peer range is `react: "^18 || ~19.0.1 || ~19.1.2 || ^19.2.1"`** _(read live from npm)_. This repo pins `react@19.2.8`, which satisfies `^19.2.1`. It is a narrow, enumerated range though — re-check it on any React bump, because a future `19.3.x` may not be covered until the SDK adds it.
- **Conversation persistence has no home yet.** The reference repo got it free from a Durable Object. A Next.js route handler is stateless; you either keep history client-side and post it each turn (simplest, and consistent with the reference repo's deliberate choice not to persist across reloads) or add a store. Decide before writing the route.
- **React Compiler + `useChat`.** The reference repo's `App.tsx` holds the Excalidraw API in a `useRef` specifically because "`onToolCall` (captured once at hook init) always reads the live API instead of a stale closure copy" (`src/App.tsx:45-50`). That refs-for-liveness pattern is exactly the kind of thing React Compiler reasons about; it should be fine (refs are opt-out by construction) but it is worth verifying in practice rather than assuming.
- **`ai@7` is ESM-only and needs Node ≥22.** Fine here, but it means the package must be genuinely ESM at every import site; no `require()` in any script that touches it.
- **Tailwind `@source` rule.** If eval or agent code ever ships UI into `packages/design-system`, the `@source` directive in `apps/web/app/globals.css` remains load-bearing per `CLAUDE.md`.

**TypeScript 7 blocker check — clean, no blockers found.** `CLAUDE.md` records the hard constraint: TS 7 is the native Go compiler and ships **no JS compiler API** (`lib/typescript.js` is gone), so any tool consuming the TS API programmatically is unusable here. I checked every candidate's declared dependencies and peer dependencies live via `npm view`:

| Package                 | Depends on `typescript`?                          |
| ----------------------- | ------------------------------------------------- |
| `vitest@4.1.10`         | **No** (no dep, no peer)                          |
| `@vitest/runner@4.1.10` | **No**                                            |
| `evalite@0.19.0`        | **No**                                            |
| `braintrust@3.27.0`     | **No** — bundles `esbuild@0.28.1` instead         |
| `autoevals@0.3.0`       | **No**                                            |
| `promptfoo@0.122.0`     | **No** — depends on `tsx@^4.21.0` (esbuild-based) |
| `tsx@4.21.0`            | **No**                                            |

All of them transpile TypeScript with esbuild or Vite, which never touches the TS compiler API. Two caveats:

- **Vitest's `--typecheck` mode is safe but only because it shells out.** Per <https://vitest.dev/guide/testing-types>, "Vitest uses `tsc --noEmit` or `vue-tsc --noEmit`, depending on your configuration" and parses the results — a subprocess invocation of the CLI, not the JS API. That is the same mechanism `apps/web`'s `check-types` script and `next build` already rely on. It is still worth an actual smoke test, since Vitest parses `tsc`'s _output format_, and TS 7's native compiler is a different binary that may format diagnostics differently. **Do not assume `vitest --typecheck` works under TS 7 until run.**
- Nothing here needs typescript-eslint, so the ESLint/`eslint-plugin-react` landmine recorded in `CLAUDE.md` stays out of scope.

---

## Open questions — not verified

1. **`@ai-sdk/openai` v3 → v4 provider-specific migration notes.** I read the core `ai` 7.0 migration guide and the shipped v4 typings (`createOpenAI` unchanged, `strictJsonSchema` present), but I did not locate a provider-specific migration document. There may be OpenAI-provider breaking changes I have not enumerated.
2. **Whether `strict: true` on `tool()` still forces OpenAI structured-output strict mode end-to-end in v7.** I verified the option exists in `@ai-sdk/provider-utils@5.0.25` typings and that `strictJsonSchema` exists on the v4 provider, but I did not verify at runtime that the `z.union`-vs-`z.discriminatedUnion` `anyOf`/`oneOf` constraint still behaves as the reference repo describes. Test this before relying on it.
3. **Braintrust `Eval()` API changes between 3.7.1 and 3.27.0.** Same major, so semver implies compatibility, but I did not find a per-release changelog for the TS SDK and did not diff the typings.
4. **Whether Braintrust evals can run fully offline / without a hosted account.** The docs describe `BRAINTRUST_API_KEY` as required and I found no documented local-only mode. Unverified whether a no-network mode exists.
5. **evalite's true maintenance status.** npm and the GitHub API disagree in emphasis: last publish 2025-11-06, last default-branch commit 2025-11-10, repo `updated_at` 2026-08-08 and `pushed_at` 2026-04-28, not archived. I could not determine whether it is paused, being rewritten, or quietly abandoned.
6. **Whether `vitest --typecheck` actually works against TypeScript 7's native compiler.** Reasoned about (subprocess, not API) but not executed. Flagged above.
7. **The `gpt-5.4` / `gpt-5.4-mini` model ids** used by the reference repo are taken from its source; I did not verify them against OpenAI's current model list, nor evaluate whether they are the right choice for this project.
8. **Cloudflare `agents` changelog details** were read via a summarising fetch of `packages/agents/CHANGELOG.md` rather than line-by-line. Since the recommendation is to drop the Cloudflare layer entirely, I did not verify individual entries.
9. **Whether Promptfoo can be run as `pnpm exec promptfoo` from a workspace devDependency.** Its custom-provider and assertion surfaces are verified (§3.4), but the install docs never show `--save-dev` and mention pnpm only under uninstall. `npx promptfoo@latest eval` is documented and package-manager-agnostic; the workspace-devDependency path is not. Verify before adopting.
10. **Whether a `promptfooconfig.ts` (as opposed to `.yaml` / `.js` / `.json`) is directly loadable.** The docs list `.js` and `.json` as alternatives to YAML but do not confirm `.ts` for the top-level config; the documented TS path is the programmatic `promptfoo.evaluate()` Node API.
11. **The current state of the Anthropic Console's Evaluate tab UI.** The standalone "Evaluation tool" doc page no longer exists — it has been consolidated into `develop-tests` — so the current UI could not be verified from primary docs.
12. **AI SDK repo-level eval tooling.** A GitHub code search over `vercel/ai` for `evals` returned zero results, but the unauthenticated API rate-limited a follow-up query, so treat that as weak evidence. The docs-site evidence (sitemap and `llms.txt` both containing no `eval` pages) is solid.

---

## Addendum 2026-08-09b — OpenAI hand-rolled loop surface

Scope: a hand-rolled agent loop (no Vercel AI SDK) against OpenAI, TypeScript / Next.js 16 App Router,
Node 24, ESM, with tool calls executed **in the browser**. Primary sources only. Every claim below is
either a live doc URL, a line inside the published `openai@7.4.0` tarball, or a command run locally on
2026-08-09. Package inspection was done against `npm pack openai@latest` / `npm pack zod@latest`; paths
below are relative to the extracted `package/` root.

### 1. `openai` npm package — current version and major-version drift

- **`openai@7.4.0`**, `time.modified = 2026-08-03T22:00:38.765Z` (`npm view openai version time.modified`).
- `package/package.json:22` — `"engines": { "node": ">=22.0.0" }`. Fine on Node 24.
- `package/package.json:261` — zod is an **optional peer dependency**: `"zod": "^3.25 || ^4.0"`.

Last two majors, from `package/CHANGELOG.md`:

- **7.0.0 (2026-07-27)** — one breaking change only: _"require Node.js 22 and codify version support"_
  (`CHANGELOG.md:72-80`). **Nothing about function calling or streaming.** 7.1–7.4 are additive
  (transcription models, a "fast" service tier, content-provenance checks, `gpt-5.5` + tool metadata fields).
- **6.0.0 (2025-09-30)** — one breaking change (`CHANGELOG.md:956-966`):
  _"`ResponseFunctionToolCallOutputItem.output` and `ResponseCustomToolCallOutput.output` now return
  `string | Array<ResponseInputText | ResponseInputImage | ResponseInputFile>` instead of `string` only.
  This may break existing callsites that assume `output` is always a string."_
  This **does** touch function calling: a tool result can now be multimodal, and reading `.output` off a
  returned item needs a narrowing check. For a canvas agent this is actually useful — a tool can return a
  rendered image of the canvas as its result.

Relevant non-breaking changes in the 6.4x line, all of which matter to a hand-rolled loop:

- `6.47.0` — `add async event iterators (#1977)`, `add fromReadableStream to ResponseStream (#1987)`,
  `docs: clarify strict Zod function schemas (#1988)`, `zod: support zod v4 mini schemas (#1985)`.
- `6.49.0` — `helpers: add standard schema support (#1997)`, `zod: support schema definitions (#1993)`,
  and three `zod:` bug fixes around strict validation and `$ref` escaping.

No migration doc ships in the tarball beyond `CHANGELOG.md`; there is no `MIGRATION.md`.

### 2. API surface: Responses, not Chat Completions

**Recommendation — use the Responses API.** OpenAI's own words, from
<https://developers.openai.com/api/docs/guides/migrate-to-responses>:

> "While Chat Completions remains supported, Responses is recommended for all new projects."

And from <https://developers.openai.com/api/reference/chat-completions/overview>:

> "Starting a new project? We recommend trying Responses to take advantage of the latest OpenAI platform features."

**Chat Completions is NOT deprecated.** It "remains supported" and no maintenance-mode or sunset language
appears on either page. Read it as first-class-but-not-where-new-features-land. (For contrast, the
Assistants API _is_ deprecated — announced 2025-08-26, sunset 2026-08-26 — so it is not the recommendation
and is out of scope here.)

Per the migration guide, the stated advantages relevant to this project are: better results from reasoning
models (internal evals cite ~3% on SWE-bench with identical prompt/setup), and materially better prompt-cache
utilisation (40–80% improvement vs Chat Completions in internal tests), which is the dominant cost lever in a
loop that replays a growing transcript every turn.

**Concrete shape difference in a multi-turn tool loop:**

|                         | Chat Completions                                    | Responses                                                                        |
| ----------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------- |
| Transport unit          | one flat `messages` array                           | typed **Items**: `message`, `reasoning`, `function_call`, `function_call_output` |
| Model asks for a tool   | assistant message with `tool_calls[]`               | a `function_call` **output item**                                                |
| Feeding the result back | a `{ role: 'tool', tool_call_id, content }` message | a separate `function_call_output` **input item**                                 |
| Correlation key         | `tool_call_id`                                      | `call_id`                                                                        |
| Server-side state       | none                                                | three options (below)                                                            |

Item shapes, quoted from <https://developers.openai.com/api/docs/guides/function-calling>:

```jsonc
{"type":"function_call","id":"...","call_id":"...","name":"...","arguments":"{...}"}
{"type":"function_call_output","call_id":"...","output":"..."}
```

Note the guide's framing: _"tool calls and their outputs are two distinct types of Items that are correlated
using a `call_id`."_ The `id` and the `call_id` are different fields; **`call_id` is the one you echo back**.

**Server-side conversation state — offered, and it is opt-OUT, not opt-in.** Three documented strategies:

1. **Manual replay** — append prior output Items to the next request's `input`. Fully stateless.
2. **`previous_response_id`** — chain each request to the last response.
3. **Conversations API** — `conversation` param on the request. In the shipped typings
   (`package/src/resources/responses/responses.ts:7402-7408`): _"The conversation that this response belongs
   to. Items from this conversation are prepended to `input_items` for this response request. Input items and
   output items from this response are automatically added to this conversation after this response completes."_
   The SDK exposes this as `client.conversations.*` (`package/resources/conversations*`).

The storage default is the trap: the migration guide states **"Responses are stored by default."** `store` is
`store?: boolean | null` (`package/src/resources/responses/responses.ts:7598`, `:8790`) and you must pass
`store: false` to opt out — required for zero-data-retention postures. **Decide this deliberately before the
first deploy**; the default silently persists every canvas transcript on OpenAI's side.

For this project — tools execute in the browser, so the server can't run the loop to completion in one
request anyway — either manual replay or `previous_response_id` works. Manual replay keeps the canonical
transcript in your own store, which is the better fit for a canvas whose state you already own client-side;
`previous_response_id` is cheaper on the wire and preserves reasoning items across turns (a real quality
factor with reasoning models, which is the main argument for it).

### 3. `gpt-5.4-mini` — **yes, it exists**

Confirmed in two independent places.

Shipped typings, `package/src/resources/shared.ts:22-48`, current `gpt-5.x` ids:

```
gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna, gpt-5.5,
gpt-5.4, gpt-5.4-mini, gpt-5.4-nano, gpt-5.4-mini-2026-03-17, gpt-5.4-nano-2026-03-17,
gpt-5.3-chat-latest, gpt-5.2, gpt-5.2-2025-12-11, gpt-5.2-chat-latest, gpt-5.2-pro, gpt-5.2-pro-2025-12-11,
gpt-5.1, gpt-5.1-2025-11-13, gpt-5.1-codex, gpt-5.1-codex-max, gpt-5.1-mini, gpt-5.1-chat-latest,
gpt-5, gpt-5-mini, gpt-5-nano, gpt-5-2025-08-07, gpt-5-mini-2025-08-07, gpt-5-nano-2025-08-07,
gpt-5-chat-latest, gpt-5-codex, gpt-5-pro, gpt-5-pro-2025-10-06
```

The gpt-5.4 family, from the live model pages:

| Model          | Context                     | Max output | $/1M in | $/1M out | Fn calling | Structured outputs | Streaming | Snapshot                  |
| -------------- | --------------------------- | ---------- | ------- | -------- | ---------- | ------------------ | --------- | ------------------------- |
| `gpt-5.4`      | 1,050,000                   | 128,000    | $2.50   | $15.00   | yes        | yes                | yes       | `gpt-5.4-2026-03-05`      |
| `gpt-5.4-mini` | 400,000 (272,000 max input) | 128,000    | $0.75   | $4.50    | yes        | yes                | yes       | `gpt-5.4-mini-2026-03-17` |
| `gpt-5.4-nano` | 400,000                     | 128,000    | $0.20   | $1.25    | yes        | yes                | yes       | `gpt-5.4-nano-2026-03-17` |

Sources: <https://developers.openai.com/api/docs/models/gpt-5.4>,
<https://developers.openai.com/api/docs/models/gpt-5.4-mini>,
<https://developers.openai.com/api/docs/models/gpt-5.4-nano>.

`gpt-5.4-mini` is documented as "designed for high-volume workloads" with prompt caching at a 10% discount
vs standard input pricing, and supports configurable reasoning effort. It is a reasonable default for a
canvas-driving loop. Note that **newer families exist** (`gpt-5.5`, and the `gpt-5.6-{sol,terra,luna}` line —
the SDK README's own examples use `model: 'gpt-5.5'`), so "latest" and "gpt-5.4-mini" are not the same claim.
Pricing/context for the 5.5 and 5.6 families was **not** fetched — see unverified list.

### 4. Strict mode on function tools — unchanged, and still the same three rules

All quotes from <https://developers.openai.com/api/docs/guides/function-calling> and the linked
<https://developers.openai.com/api/docs/guides/structured-outputs>.

**`strict: true` is still supported on function tool definitions:**

> "Setting `strict` to `true` will ensure function calls reliably adhere to the function schema, instead of being best effort."

**Schema subset enforced.** Supported: String, Number, Boolean, Integer, Object, Array, Enum, and **`anyOf`**;
string `pattern` and `format` (date-time, time, date, duration, email, hostname, ipv4, ipv6, uuid); number
`multipleOf` / `maximum` / `exclusiveMaximum` / `minimum` / `exclusiveMinimum`; array `minItems` / `maxItems`.
Explicitly unsupported composition keywords:

> "composition: `allOf`, `not`, `dependentRequired`, `dependentSchemas`, `if`, `then`, `else`"

**`oneOf` vs `anyOf` — still true.** `anyOf` is named in the supported list; `oneOf` appears nowhere in it.
The docs never spell out "`oneOf` is rejected" in those words — the evidence is (a) its absence from the
supported set, and (b) the SDK actively rewriting it, which is strong corroboration. From
`package/src/helpers/zod.ts:132-146`, inside the Zod v4 → JSON Schema `override` hook:

```ts
// Discriminator values are mutually exclusive, so anyOf preserves the
// union while staying inside the API's supported JSON Schema subset.
jsonSchema.anyOf = jsonSchema.oneOf;
delete jsonSchema.oneOf;
```

The SDK would not go out of its way to strip `oneOf` if the API accepted it. Also note the **root** constraint:
_"The root level object of a schema must be an object, and not use `anyOf`"_, enforced client-side at
`package/src/lib/transform.ts:153-157` with the message _"Root schema must not use `anyOf` because strict
Structured Outputs requires a root object without a union."_

**Every property must be in `required` — still true:**

> "All fields in `properties` must be marked as `required`."
> "All fields or function parameters must be specified as `required`."

and the workaround, unchanged:

> "You can denote optional fields by adding `null` as a `type` option" — i.e. `"type": ["string", "null"]`.

Plus: **"`additionalProperties: false` must always be set in objects."**

**Size limits** (worth knowing for a canvas tool surface with many element kinds): max 5000 object properties
total; up to 10 levels of nesting; 120,000 characters total across property names, definitions, enum values and
constants; up to 1000 enum values across all properties; and for a single enum property with 250+ string values,
a 15,000-character limit.

**Changes in the last year:** none to the rules themselves. What changed is _tooling around_ them — the SDK
added a `standard-schema` helper (6.49.0), Zod-v4-mini support (6.47.0), schema-definition/`$ref` support with
strict validation (6.49.0), and a docs pass explicitly titled "clarify strict Zod function schemas" (6.47.0).

### 5. Zod → JSON Schema — **use the OpenAI helper, not raw `z.toJSONSchema()`**

Current Zod is **`zod@4.4.3`** (`npm view zod version`).

Both paths exist in the current published packages:

- `openai/helpers/zod` ships and exports (`package/helpers/zod.d.ts:67-103`):
  `zodResponseFormat`, `zodTextFormat`, `zodFunction`, `zodResponsesFunction`, `zodRealtimeFunction`.
  For the Responses API the relevant pair is **`zodResponsesFunction`** (tools) and **`zodTextFormat`**
  (structured final output). `zodFunction` is the Chat Completions flavour.
- `z.toJSONSchema()` exists in Zod 4.4.3 at `v4/core/to-json-schema.d.cts`, with options
  `target` (`draft-04 | draft-07 | draft-2020-12 | openapi-3.0`, line 17), `unrepresentable`
  (`"throw" | "any"`, line 21), `override` (line 23), `io` (`"input" | "output"`, line 31),
  `cycles` (`"ref" | "throw"`, line 32), `reused` (`"ref" | "inline"`, line 33), `metadata` (line 11).

**They do not produce the same thing.** Verified by running both against the same schema on 2026-08-09
(`openai@7.4.0` + `zod@4.4.3`, Node 24.11.0):

Raw `z.toJSONSchema(schema, { target: 'draft-7' })` on `z.object({ a: z.string(), b: z.number().optional(), c: z.string().nullable() })`:

- emits `additionalProperties: false` — **good**;
- emits `"required": ["a", "c"]` — **`b` is omitted, so this is NOT strict-mode-compatible**;
- renders `.nullable()` as `anyOf: [{type:'string'},{type:'null'}]` — fine.

And on a `z.discriminatedUnion(...)` it emits **`oneOf`**, which is outside the supported subset.

The OpenAI helper closes both gaps. `zodResponsesFunction` on the same discriminated union returned
`anyOf` (rewritten by the `override` hook above) with `strict: true` and `additionalProperties: false`
throughout. And given `.optional()` without `.nullable()`, it **throws at definition time** rather than
letting a bad schema reach the API (`package/src/lib/transform.ts`, reached via `toStrictJsonSchema`):

> ``Schema field at `properties/b` uses `.optional()` without `.nullable()` which is not supported by the API.``

Mechanically, `zodResponsesFunction` → `zodV4ToJsonSchema` (`package/src/helpers/zod.ts:120-152`) calls
`z4.toJSONSchema(schema, { target: 'draft-7', override })` and then pipes the result through
`toStrictJsonSchema()` (`package/src/lib/transform.ts:133-171`), which normalises singleton type arrays,
resolves `allOf`/`$ref`, rejects nested `$id` scopes, and recursively closes every object. It emits
`{ type: 'function', name, parameters, strict: true }` — already the exact Responses tool shape.

**Verdict: define tools with Zod and convert them with `zodResponsesFunction` from `openai/helpers/zod`.**
Reserve raw `z.toJSONSchema()` for cases where you deliberately want a non-strict schema; if you do go that
route you must add `io: 'input'` (what the SDK uses for its non-strict path,
`package/src/helpers/zod.ts:165-167`, so that `.transform()`/`.default()` describe what the _model sends_, not
what Zod outputs), force every key into `required`, and rewrite `oneOf` → `anyOf` yourself. That is
re-implementing `toStrictJsonSchema`, badly.

One caveat for a browser-executed tool loop: `zodResponsesFunction` bundles an optional `function` callback
for the SDK's auto-run helpers. **Do not pass it** — the callback exists to let the SDK execute the tool
server-side, which is precisely what this architecture does not want. Pass only `{ name, parameters, description }`
and keep execution in the browser. There is also a `openai/helpers/standard-schema` module (added 6.49.0,
`package/src/helpers/standard-schema.ts`) using the same `toStrictJsonSchema` (line 446) if you ever want to
accept non-Zod validators.

### 6. Streaming to a browser

`client.responses.stream(body, options)` returns a **`ResponseStream<ParsedT>`**
(`package/src/resources/responses/responses.ts:203-208`), declared as
`class ResponseStream<ParsedT = null> extends EventStream<ResponseEvents> implements AsyncIterable<ResponseStreamEvent>`
(`package/lib/responses/ResponseStream.d.ts:49`). It is **typed and async-iterable** —
`[Symbol.asyncIterator](): AsyncIterator<ResponseStreamEvent>` (line 56) — plus:

- `finalResponse(): Promise<ParsedResponse<ParsedT>>` (line 61) — resolves with the assembled response;
- `static fromReadableStream(stream: ReadableStream): ResponseStream<null>` (line 53) — **this is the one
  that matters here**: it lets a browser client re-hydrate a typed event stream from the `ReadableStream`
  your Next.js route handler proxied through, instead of hand-parsing SSE;
- `ResponseStreamByIdParams` with `response_id` + `starting_after` (lines 12-35) — resume a stream after a
  dropped connection, replaying internally to keep the snapshot correct. Useful for a long canvas generation
  over a flaky link.

`client.responses.create({ stream: true })` also works and returns `APIPromise<Stream<ResponseStreamEvent>>`
(`package/resources/responses/responses.d.ts:52`), iterable with `for await` per README:

```ts
const stream = await client.responses.create({ model: "gpt-5.5", input: "...", stream: true });
for await (const event of stream) {
  console.log(event);
}
```

(`package/README.md:203-220`, "We provide support for streaming responses using Server-Sent Events (SSE).")

**Event types.** The full discriminated union of `type` literals is in
`package/src/resources/responses/responses.ts` (54 of them). The ones a hand-rolled loop needs:

| Event                                                                                        | Role                                                                          |
| -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `response.created`, `response.in_progress`, `response.queued`                                | lifecycle start                                                               |
| `response.output_item.added`                                                                 | **a new item started — inspect its `type` to see if it is a `function_call`** |
| `response.output_text.delta`                                                                 | **text deltas** (field `delta: string`)                                       |
| `response.output_text.done`                                                                  | text for that content part finalised                                          |
| `response.function_call_arguments.delta`                                                     | **tool-call argument deltas**                                                 |
| `response.function_call_arguments.done`                                                      | tool-call arguments finalised                                                 |
| `response.content_part.added` / `.done`                                                      | content part boundaries                                                       |
| `response.reasoning_text.delta` / `.done`, `response.reasoning_summary_text.delta` / `.done` | reasoning stream                                                              |
| `response.refusal.delta` / `.done`                                                           | refusal stream                                                                |
| `response.output_item.done`                                                                  | item complete                                                                 |
| `response.completed`, `response.incomplete`, `response.failed`, `error`                      | terminal                                                                      |

Note the **dot** before `delta`: `response.function_call_arguments.delta`, not `..._arguments_delta`. Verified
against `package/src/resources/responses/responses.ts:3061`.

**Yes, arguments arrive as deltas and need accumulation.** `ResponseFunctionCallArgumentsDeltaEvent` carries
`delta: string`, `item_id: string`, `output_index: number`, `sequence_number: number`
(`package/src/resources/responses/responses.ts:3040-3062`) — a raw JSON-text fragment, not an object.
`ResponseFunctionCallArgumentsDoneEvent` carries the finished `arguments: string`, plus `item_id` and `name`
(lines 3067-3085) — still a **string** you must `JSON.parse`.

**There IS an accumulation helper, and it's easy to miss.** `ResponseStream` re-types two events to add a
running snapshot (`package/lib/responses/EventTypes.d.ts`):

```ts
export type ResponseFunctionCallArgumentsDeltaEvent = RawResponseFunctionCallArgumentsDeltaEvent & {
  snapshot: string;
};
export type ResponseTextDeltaEvent = RawResponseTextDeltaEvent & { snapshot: string };
```

So when you consume via `client.responses.stream()` (or `ResponseStream.fromReadableStream`) rather than the
raw `create({stream:true})` iterator, **`event.snapshot` is the accumulated-so-far string** and you never
write your own concatenation buffer. `ResponseStream` also narrows these two in its event-emitter map
(`package/lib/responses/ResponseStream.d.ts:36-44`), so `stream.on('response.function_call_arguments.delta', ...)`
is typed with `snapshot` too. For a fully assembled, parsed result, `finalResponse()` returns a
`ParsedResponse<ParsedT>` whose function-call items carry parsed arguments when the tools were built with
`zodResponsesFunction`.

**Detecting "wants a tool call" vs "finished":** do _not_ look for a `finish_reason` — Responses has no such
field. Watch `response.output_item.added` / `response.output_item.done` and branch on the item's `type`: a
`function_call` item means the model wants a tool; a `message` item is prose. The turn ends at
`response.completed` (or `response.incomplete` / `response.failed` / `error`). The loop condition is therefore
"did this response's output contain any `function_call` items?" — if yes, execute them in the browser and send
`function_call_output` items (matched by `call_id`) as the next request's input; if no, the turn is done.
Because multiple `function_call` items can stream concurrently, **key your accumulation buffers by `item_id`**
(or use `output_index`), not by a single "current tool call" variable.

### 7. Abort, timeout, retries

From `package/README.md:381-421` and the shipped typings:

- **Retries — default 2.** _"Certain errors will be automatically retried 2 times by default, with a short
  exponential backoff. Connection errors (for example, due to a network connectivity problem), 408 Request
  Timeout, 409 Conflict, 429 Rate Limit, and >=500 Internal errors will all be retried by default."_
  Configurable client-wide (`new OpenAI({ maxRetries: 0 })` — _"default is 2"_) or **per-request** as the
  second argument: `client.responses.create(body, { maxRetries: 5 })`.
- **Timeout — default 10 minutes.** _"Requests time out after 10 minutes by default."_ Set client-wide
  (`new OpenAI({ timeout: 20 * 1000 })`) or per-request (`{ timeout: 5 * 1000 }`). _"On timeout, an
  `APIConnectionTimeoutError` is thrown."_ Important gotcha, stated in the README: _"Note that requests which
  time out will be retried twice by default"_ — so worst-case wall time is roughly 3× your timeout unless you
  also set `maxRetries: 0`.
- **Abort — per-request `signal`.** `signal?: AbortSignal | undefined | null` on `RequestOptions`
  (`package/src/internal/request-options.ts:67`), honoured in the client both before dispatch and during the
  request (`package/src/client.ts:794`, `:805`, `:1010-1021`, `:1141`).

For a Next.js route handler proxying a stream to the browser, wire the incoming `Request.signal` straight
into the per-request `signal` so a closed browser tab cancels the upstream generation, and consider
`maxRetries: 0` on streaming calls — a retried stream restarts output from scratch, which is worse than a
clean error for a UI that has already rendered partial deltas.

### 8. What this changes for a hand-rolled loop

1. **Target Responses, not Chat Completions.** Different item model, different correlation field (`call_id`),
   different result channel (`function_call_output` items, not `role: 'tool'` messages).
2. **Set `store` explicitly.** It defaults to _on_. Silent server-side persistence of every session.
3. **Build tools with `zodResponsesFunction`.** Raw `z.toJSONSchema()` is a footgun here: right on
   `additionalProperties`, wrong on `required`, and wrong on `oneOf` for discriminated unions.
4. **Model `.optional()` as `.nullable()`** in every tool schema. The SDK throws if you don't, which is the
   good outcome; the bad outcome is a hand-rolled schema that the API rejects at runtime.
5. **Use `client.responses.stream()` / `ResponseStream.fromReadableStream()`** for the `snapshot` field —
   it removes the argument-accumulation buffer entirely.
6. **Key partial tool calls by `item_id`.** Parallel tool calls interleave in the stream.
7. **Tool results can be multimodal since 6.0.0** — a `function_call_output` may carry images. For a canvas
   agent, returning a rendered PNG of the current Excalidraw scene as a tool result is a supported pattern.
8. **`maxRetries: 0` on streaming calls**, and plumb the request `AbortSignal` through the route handler.

### Open questions — not verified (addendum)

1. **Pricing and context windows for `gpt-5.5` and the `gpt-5.6-{sol,terra,luna}` family.** They exist in the
   SDK typings (`package/src/resources/shared.ts:22-25`) and the README uses `gpt-5.5` in examples, but I did
   not fetch their model pages. If "latest" is the goal, check those before settling on `gpt-5.4-mini`.
2. **An explicit docs sentence rejecting `oneOf`.** The supported-schema list names `anyOf` and omits `oneOf`,
   and the SDK rewrites `oneOf` → `anyOf` with a comment about "the API's supported JSON Schema subset". That
   is strong but circumstantial; I found no sentence of the form "`oneOf` is not supported".
3. **Chat Completions lifecycle beyond "remains supported".** No maintenance-mode or sunset statement was
   found on either the migration guide or the Chat Completions overview. Absence of evidence only.
4. **Whether `previous_response_id` and the `conversation` param can be combined**, and their interaction with
   `store: false`. The typings document each separately; I did not find a page covering the combinations.
   Given `store` defaults on, a ZDR posture plus `previous_response_id` may be mutually exclusive — verify.
5. **Runtime behaviour of `ResponseStream.fromReadableStream` in a browser bundle.** The typing is
   unambiguous (`package/lib/responses/ResponseStream.d.ts:53`) and it was added deliberately in 6.47.0
   (`#1987`), but I did not execute it in a browser, nor check the bundle-size cost of importing `openai`
   client-side. An alternative is to parse SSE in the browser yourself and keep `openai` server-only.
6. **The Conversations API surface in detail.** I confirmed `client.conversations.*` exists in the tarball and
   quoted the `conversation` request param's doc comment, but did not read the Conversations reference pages
   (item lifecycle, pruning, retention).
7. **Reasoning-item replay requirements.** The migration guide cites better reasoning-model results and cache
   hits with Responses, and the typings include `reasoning` items, but I did not verify whether manual replay
   must include reasoning items verbatim across turns for a reasoning model to behave correctly. This directly
   affects whether manual replay or `previous_response_id` is the right choice — **verify before building.**
8. **Whether the docs pages for streaming use the exact event-name spellings I list.** The event names above
   are taken from the shipped typings (authoritative for the SDK); a summarising fetch of the streaming guide
   rendered one of them as `response.function_call_arguments_delta` (underscore), which contradicts the
   typings' `response.function_call_arguments.delta`. I trust the typings, but the doc page's own rendering
   was not confirmed character-for-character.

## Addendum 2026-08-09c — TOON for canvas serialization

Scope: is `@toon-format/toon` the right serialization for the `queryCanvas` tool's element list?
Primary sources only: <https://toonformat.dev/>, <https://github.com/toon-format/toon>, the npm registry,
and the published tarball (`@toon-format/toon@4.1.1`, extracted and executed locally on Node 24).
Third-party evals are cited explicitly as third-party.

### 1. What TOON is

Its own one-liner, verbatim from the package README (`package/README.md` in the tarball, line 11):

> **Token-Oriented Object Notation** is a compact, human-readable encoding of the JSON data model that
> minimizes tokens and makes structure easy for models to follow.

The problem it claims to solve, same README, "Why TOON?": _"LLM tokens cost money – and JSON spends a lot of
them on structure."_ It is positioned as a **translation layer**, not a storage format — README line 15:
_"use JSON programmatically, and encode it as TOON for LLM input – a drop-in, lossless representation of the
JSON you already have."_

It is **all three**: a written spec, an encoding, and a library. The spec lives in a separate repo,
<https://github.com/toon-format/spec> (`SPEC.md`, currently v4.1, 320 stars, last pushed 2026-08-05), and the
TS package carries `@toon-format/spec@^4.1.1` as a devDependency (tarball `package/package.json`). So yes —
there is a normative spec independent of the implementation, and there are third-party implementations in
Python, Rust, Go, Java, Swift and .NET (README "Other Implementations").

Maintainer: **Johann Schopplich** (sole author field in `package/package.json`; `MIT License © 2025-PRESENT
Johann Schopplich`). It is one person's project, not a foundation or vendor format.

Self-declared sweet spot and weak spot, README line 13:

> Its sweet spot is uniform objects – same fields across items, whether in an array or keyed by ID – reaching
> CSV-like compactness while adding explicit structure... **For deeply nested or non-uniform data, JSON may be
> more efficient.**

The README also flags its own maturity honestly (line 18): _"The TOON format is stable, but also an idea in
progress. Nothing's set in stone."_

### 2. Package facts (verified)

| Fact             | Value                                                                       | Source                                                              |
| ---------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Name             | `@toon-format/toon` — **confirmed**                                         | <https://registry.npmjs.org/@toon-format/toon>                      |
| Latest           | **4.1.1**, published **2026-08-05**                                         | registry `time` field                                               |
| License          | MIT                                                                         | `package/package.json`, `package/LICENSE`                           |
| Runtime deps     | **none** (zero `dependencies`; only devDep `@toon-format/spec`)             | `package/package.json`                                              |
| Module format    | **ESM only** — `"type": "module"`, single export `./dist/index.mjs`         | `package/package.json`                                              |
| Types            | `./dist/index.d.mts`, hand-shipped `.d.mts`                                 | `package/package.json`                                              |
| `engines`        | **not declared** — no Node floor stated at all                              | `package/package.json`                                              |
| Tarball contents | 5 files: LICENSE, README.md, package.json, dist/index.d.mts, dist/index.mjs | `npm pack` output                                                   |
| Weekly downloads | **1,205,577** (2026-08-02 → 2026-08-08)                                     | <https://api.npmjs.org/downloads/point/last-week/@toon-format/toon> |
| Stars            | **25,121**                                                                  | GitHub API `/repos/toon-format/toon`                                |
| Open issues      | **3**                                                                       | GitHub API                                                          |
| Last commit      | **2026-08-07** (`docs: rebuild the brand palette in OKLCH…`)                | GitHub API `/commits`                                               |
| Last release     | **v4.1.1, 2026-08-05**                                                      | GitHub API `/releases`                                              |
| Forks            | 1,113                                                                       | GitHub API                                                          |

**TypeScript 7 compatibility — the constraint that matters here.** The package declares **no `typescript`
dependency of any kind** (`package/package.json` has exactly one devDependency, `@toon-format/spec`) and ships
**zero runtime dependencies**. It does not consume the TypeScript compiler API, so the TS 7 native-Go-compiler
constraint recorded in `CLAUDE.md` does not bite. It ships a pre-built `.d.mts`, which `tsc --noEmit` merely
reads.

**ESM-only is fine for this project** (`apps/web` is ESM, Node 24). But note there is **no CJS fallback** — any
consumer needing `require()` is out of luck. No `engines` field means npm will not warn on old Node; the code
uses generators and async iterators, which Node 24 has comfortably.

Maturity read: v0.6.0 was published 2025-11-01 and it is at v4.1.1 nine months later, with **four major
versions in ~9 months** (2.0.0 in Nov 2025, 4.0.0 in Jul 2026 — note 3.x was skipped in the published list).
That is a fast-moving format, not a settled one. Pin the version.

### 3. The actual format

**Worked example, verbatim from the tarball README (lines 711-725) and reproduced by running the shipped
`encode()` locally:**

```ts
import { encode } from "@toon-format/toon";
const data = {
  users: [
    { id: 1, name: "Ada", role: "admin" },
    { id: 2, name: "Bob", role: "user" },
  ],
};
console.log(encode(data));
```

```
users[2]{id,name,role}:
  1,Ada,admin
  2,Bob,user
```

`[2]` is the **length marker**, `{id,name,role}` the **field list declared once**, then one CSV-ish row per
element. There are **four forms** (README lines 96-128), chosen automatically from the data's shape:

1. **inline** — primitive arrays on the header line: `alerts[2]: frost,wind`
2. **tabular** — `forecast[3]{day,temp{min,max},condition,rainChance}:` + one row per element
3. **keyed tabular** — for objects-of-uniform-objects, marked by a colon after the length:
   `environments[2:]{region,replicas,debug}:` with each row carrying its own key
4. **list form** — the fallback for _"mixed types, non-uniform objects"_: one `- ` item per element

**Tabular eligibility** (<https://toonformat.dev/guide/format-overview>): _"Tabular form requires identical
field sets across all objects (same keys, order per object may vary), at least one key per object, and every
column either primitive-valued or a uniform nested object."_ Disqualifiers: empty `{}` elements, mixed value
shapes in a column, arrays/non-primitives in a column, fewer than two uniform objects.

**Nested objects** fold into the header as a _nested field group_ while rows stay flat —
`orders[2]{id,customer{name,country},total}:` → `1,Ada,DK,99`. This only works when the nested objects are
themselves uniform.

**Non-uniform keys** → list form. No padding, no union-of-keys header. Verified empirically below.

**null / undefined.** `null` is a first-class primitive and encodes as the bare token `null`. Per the API
reference type-normalization table (<https://toonformat.dev/reference/api>), `undefined`, `function` and
`symbol` all normalize to **`null`**; `NaN`/`±Infinity` → `null`; `Date` → quoted ISO 8601 string; `Set` →
array; `Map` → object with `String(key)` keys; `BigInt` in safe range → number, else quoted decimal string.
Confirmed locally: `encode({ a: undefined, b: 1 })` → `"a: null\nb: 1"`. **Note the semantic gotcha: an absent
optional field passed as `undefined` becomes an explicit `null`, not an omission** — which, for our use case,
is actually the behaviour we want (see §7).

**Quoting/escaping rules** (<https://toonformat.dev/guide/format-overview>). Strings are quoted when they: are
empty; have leading/trailing whitespace; equal `true`/`false`/`null` (case-sensitive); look like numbers
(`"42"`, `"-3.14"`, `"1e-6"`); contain colons, quotes, backslashes, brackets, braces or control chars
(U+0000–U+001F); match the active delimiter; equal `-` or start with `-` plus any char; or equal/start with
`#`. Exactly six escapes are legal — `\\`, `\"`, `\n`, `\r`, `\t`, and `\uXXXX` for control chars. _"Other
escapes (e.g., `\x`, `\0`, `\b`) are always rejected."_ Delimiters are **scoped to the array header**: _"Inside
an array scope, only the active delimiter triggers quoting – the others are literal data."_ Full-line `#`
comments are stripped on decode; encoders never emit them.

**Lossless / round-trippable?** Yes, with a stated caveat. README line 147: _"Encodes the same objects, arrays,
and primitives as JSON with deterministic, lossless round-trips."_ The API reference is more precise: _"TOON
provides lossless round-trips **after normalization**"_ — i.e. `decode(encode(x))` equals `normalize(x)`, and
normalization is the table above (Date → string, undefined → null, etc.). For input that is already plain JSON
values, round-trip is exact. There **is** a real decoder (`decode`, plus streaming variants), and `strict: true`
by default enforces declared array lengths and row counts.

I verified this on our own shapes — **all four test payloads round-tripped byte-identically** under
`JSON.stringify(decode(encode(v))) === JSON.stringify(v)` (see §7).

### 4. The token-efficiency claim

**Headline claim** (README line 146, and the tip at line 225): _"Matches JSON's retrieval accuracy while using
**42.6% fewer tokens**."_ Source: <https://toonformat.dev/guide/benchmarks> and the README's inlined results.

**Methodology, as published** (README "Run Configuration", lines 439-448):

- Tokenizer: **`gpt-tokenizer` with `o200k_base` (the GPT-5 tokenizer)**. The README itself hedges: _"Other
  providers tokenize differently, so absolute counts are tokenizer-specific; relative differences between
  formats hold directionally."_
- Baseline: formatted JSON with 2-space indentation. Compact JSON is reported separately.
- 13 datasets, split into two tracks so comparisons are like-for-like.

**Token savings vs JSON, by track:**

| Track                                 | TOON        | vs JSON    | vs JSON compact | vs YAML | vs XML | vs CSV    |
| ------------------------------------- | ----------- | ---------- | --------------- | ------- | ------ | --------- |
| Mixed-structure (nested/semi-uniform) | 264,734 tok | **−32.7%** | **+1.6%**       | −15.7%  | −40.9% | n/a       |
| Flat-only (fully tabular)             | 68,030 tok  | **−58.7%** | −35.2%          | −48.2%  | −64.3% | **+5.9%** |

**Be skeptical in exactly this way:** the shape of the data drives almost everything.

- Against **compact JSON** on mixed/nested data, TOON is **+1.6% — i.e. slightly worse**. The headline −42.6%
  is against _pretty-printed_ JSON. If you would otherwise send `JSON.stringify(x)` with no indentation, the
  savings on non-tabular data are **zero or negative**.
- Per-dataset the spread is enormous: −66.5% on "Contacts with nested address and plan groups" (100% tabular
  eligibility) but **+19.9% vs compact JSON** on "Semi-uniform event logs" (50% eligibility) and **+6.7% vs
  compact JSON** on "Deeply nested configuration" (0% eligibility).
- The benchmark **does** reflect TOON's sweet spot in the flat-only track (three 100%-eligible uniform
  datasets), and the project deserves credit for publishing the unflattering mixed-structure numbers too.

**Reproducible?** Partially. The datasets, question generation and answer validation are documented at
<https://github.com/toon-format/toon/tree/main/benchmarks>, and the tokenizer and models are named. I did not
run it. Rerunning it requires API keys for four commercial models (5,856 LLM calls).

### 5. Does the model actually _understand_ it? — the crux

**This is where the evidence is genuinely contested, and the honest answer is "unsettled".**

**The project's own eval** (<https://toonformat.dev/guide/benchmarks>, mirrored in README lines 171-448) _is_
a comprehension eval, not just a token count — 244 data-retrieval questions × 6 formats × 4 models = 5,856 LLM
calls. So the "it's only token count, not comprehension" criticism does **not** apply to the project's own
claims. Their numbers:

```
TOON           29.2 acc%/1K tok  │  72.2%  ±2.8 acc  │  2,474 tokens
JSON compact   23.8 acc%/1K tok  │  69.0%  ±2.9 acc  │  2,892 tokens
YAML           20.1 acc%/1K tok  │  70.1%  ±2.9 acc  │  3,487 tokens
JSON           16.6 acc%/1K tok  │  71.4%  ±2.8 acc  │  4,308 tokens
XML            14.4 acc%/1K tok  │  70.7%  ±2.9 acc  │  4,909 tokens
```

Per-model, TOON beats JSON on 3 of 4 models and loses on one:
`claude-haiku-4-5` 65.6% ±5.9 vs JSON 63.5% ±6.0 · `gemini-3.6-flash` 69.3% vs 68.4% ·
`grok-4.5` 97.1% vs 96.3% · `gpt-5.4-nano` **57.0% vs JSON 57.4%** (TOON 3rd).

**Critically, the project itself tells you these gaps are not significant.** README line 282: _"Accuracy
figures include Wilson 95% confidence intervals (±); when two formats' intervals overlap, the difference
between them is not statistically meaningful."_ Every TOON-vs-JSON gap above is ~1-2pp against a ±3-6pp
interval. **So the correct reading of the project's own eval is: TOON is not measurably worse than JSON on
comprehension, at ~40% fewer tokens.** It is not "TOON is more accurate".

One genuinely interesting result is **structural validation**, where the `[N]` length marker does real work
(README line 295): TOON **100.0%** vs JSON 50.0%, XML 80.0%, YAML 50.0%, JSON compact 45.0%. Models detect
truncated/extra/malformed rows in TOON because the declared count contradicts the rows. Conversely, TOON is
_worse_ than JSON at Field Retrieval (97.8% vs 99.2%) and Filtering (38.0% vs 41.1%).

**Third-party evidence, which is less flattering:**

1. **Peer-adjacent academic work.** "Notation Matters: A Benchmark Study of Token-Optimized Formats in Agentic
   AI Systems", Lorenz Kutschka & Bernhard Geiger, arXiv 2605.29676 (submitted 2026-05-28, revised
   2026-06-17), <https://arxiv.org/abs/2605.29676>. Four agentic benchmarks (BFCL, MCPToolBenchPP,
   MCP-Universe, StableToolBench) and five open-weight LLMs. Abstract, verbatim: _"TOON achieves up to 18%
   reduction at a similar **9pp accuracy cost**, but additionally **cascades on multi-turn parsing failures**
   and **collapses parallel tool-call output for most models**."_ This is a much harsher result than the
   project's, and it is on **agentic loops** — which is precisely our setting. Two caveats before over-weighting
   it: it uses **open-weight** models (not the frontier hosted models we target), and much of the damage is
   attributed to TOON as an **output/generation** format for tool calls, which is _not_ what we would be doing.
2. **Independent tabular eval**, improvingagents.com, <https://www.improvingagents.com/blog/is-toon-good-for-table-data>.
   12 formats, gpt-4.1-nano, tabular data. TOON ranks **9th of 12 at 47.5% (44.4–50.6%) on 21,518 tokens**,
   _below_ JSON at **52.3% (49.2–55.4%) on 66,396 tokens** and well below Markdown-KV at **60.7% on 52,104
   tokens**. Note TOON was the second most token-efficient of the twelve (only CSV and Pipe-Delimited were
   cheaper, and both scored worse). The article does **not** publish its code or full methodology on that page,
   deferring to a prior comparison article — so treat it as a signal, not a result.
3. A secondary write-up (Tomasz Konecki, 2026-01-09, SoftServe on Medium) reproduces the official numbers and
   concludes that the official/independent discrepancy means performance _"depends heavily on data structure,
   question types, and the specific model used."_

**Honest summary of §5:** comprehension evidence exists on both sides and **does not converge**. The project's
own eval says parity-with-JSON at ~40% fewer tokens, but its own confidence intervals say "parity", not "win".
Two independent evaluations put TOON meaningfully _below_ JSON on accuracy — one of them (the arXiv paper) in
an agentic setting. **Nobody has evaluated TOON on our data or our model.** There is no published eval of TOON
on `gpt-*` via the Responses API for spatial/geometric data of any kind.

**"When Not to Use TOON" — the project's own list, verbatim** (README lines 153-162):

> - **Structures are deeply nested or non-uniform** (tabular eligibility ≈ 0%) – compact JSON often wins outright.
> - **Arrays are semi-uniform** (~40–60% eligibility) – savings shrink; stay on JSON if your pipeline already speaks it.
> - **Data is purely tabular** – CSV is smaller. TOON's ~5–10% overhead buys declared lengths, field lists, and
>   delimiter scoping, which is a reliability trade, not a size one.
> - **Latency dominates** – some deployments (notably local or quantized models) process compact JSON faster
>   despite the higher token count. Measure TTFT and total time on your own setup.

The docs also give a prompting rule worth adopting if we use it (README line 787): _"TOON works best when you
**show** the format instead of describing it. Once a model sees one tabular example, the header – `[N]` length
plus `{fields}` field list – tells it how to read the rest. Wrap data in ` ```toon ` code blocks for input."_

### 6. API surface (from the shipped `dist/index.d.mts`, v4.1.1)

```ts
declare function encode(input: unknown, options?: EncodeOptions): string;
declare function decode(input: string, options?: DecodeOptions): JsonValue;
declare function encodeLines(input: unknown, options?: EncodeOptions): Iterable<string>;
declare function decodeFromLines(lines: Iterable<string>, options?: DecodeOptions): JsonValue;
declare function decodeStreamSync(
  lines: Iterable<string>,
  options?: DecodeStreamOptions,
): Iterable<JsonStreamEvent>;
declare function decodeStream(
  source: AsyncIterable<string> | Iterable<string>,
  options?: DecodeStreamOptions,
): AsyncIterable<JsonStreamEvent>;
declare function escapeString(value: string): string;
declare function rawString(value: string): RawString;
declare class ToonDecodeError extends SyntaxError {
  readonly line?: number;
  readonly source?: string;
}

interface EncodeOptions {
  indentSize?: number; // default 2
  indent?: number; // @deprecated — use indentSize
  delimiter?: "," | "\t" | "|"; // default ','  (DEFAULT_DELIMITER)
  replacer?: EncodeReplacer;
}
interface DecodeOptions {
  indentSize?: number; // default 2
  indent?: number; // @deprecated
  strict?: boolean; // default true — enforce array lengths and tabular row counts
}
type EncodeReplacer = (
  key: string,
  value: JsonValue,
  path: readonly (string | number)[],
) => unknown;
```

Also exported: `DEFAULT_DELIMITER`, `DELIMITERS` (`{ comma: ',', tab: '\t', pipe: '|' }`), and the types
`Delimiter`, `DelimiterKey`, `JsonValue`/`JsonObject`/`JsonArray`/`JsonPrimitive`, `JsonStreamEvent`,
`ResolvedEncodeOptions`, `ResolvedDecodeOptions`.

**Options relevant to a flat array of uniform objects:**

- **`delimiter`** — the only knob that changes token count. `'\t'` is recommended by the docs for further
  savings (README line 787: _"Tab delimiters buy further token savings"_). Encoded output marks it in the
  header: `elements[3\t]{id\ttype\t…}:`.
- **`indentSize`** — for a single top-level tabular array this affects only the row indent; `indentSize: 1`
  shaves one space per row (3 chars on a 3-row scene, ~100 chars on a 100-element scene). Marginal.
- **`replacer`** — genuinely useful here: it is the clean place to round coordinates, drop noisy Excalidraw
  fields, and flatten `startBinding` objects to a bare id. Signature includes a `path`, unlike
  `JSON.stringify`'s replacer.
- **Key folding and length markers are automatic** — there is no option to force or disable tabular form. You
  get the tabular form iff the data is uniform. That is the crux for §7.
- There is **no** "pad missing keys" or "union of keys" option. None.

### 7. Fit verdict for `queryCanvas`

**The described shape sits squarely in TOON's sweet spot — but only if we make the element records uniform
ourselves, which is entirely under our control.**

I ran the shipped encoder on four variants of the exact `queryCanvas` shape (5-100 elements; `id`, `type`, `x`,
`y`, `width`, `height`, optional text/label, optional `startBinding`/`endBinding`). Results:

**(A) Uniform — optional fields present as explicit `null`.** Tabular form, one line per element:

```
elements[3]{id,type,x,y,width,height,text,startBinding,endBinding}:
  a1,rectangle,100,200,180,90,Login,null,null
  a2,ellipse,400,210,120,120,DB,null,null
  a3,arrow,280,245,120,5,null,a1,a2
```

191 chars vs 628 (JSON pretty) vs 374 (JSON compact) — **~49% fewer characters than even compact JSON**,
because the nine key names are paid for once rather than 3× (and, at 100 elements, once rather than 100×).
That ratio _improves_ with element count, since the header cost amortises. This is the good case.

**(B) Non-uniform — optional fields simply omitted, the natural JS output.** Tabular form is **lost entirely**
and it falls back to list form:

```
elements[3]:
  - id: b1
    type: rectangle
    x: 100
    ...
```

**311 chars vs 274 for compact JSON — TOON is now _worse_ than JSON.** This is the failure mode, and it is
triggered by exactly the thing the task flagged: some elements have text, some don't; some have bindings, some
don't. **One element missing one key destroys the tabular form for the whole array.**

**The fix is one line and it is entirely ours to make:** normalize every element to the same key set before
encoding, filling absent optionals with `null` (or `''`/`0`). Either build the record uniformly in
`queryCanvas`, or use the `replacer` option. Since `undefined` normalizes to `null` anyway, an object literal
with `text: el.text ?? null, startBinding: el.startBinding?.elementId ?? null` gets you shape (A) for free.
**Non-uniform keys are a solved problem here precisely because we are generating the payload.** This is very
different from TOON's genuine weak spot, which is data whose shape you don't control.

**(C) Nested binding objects** (real Excalidraw `startBinding` is `{ elementId, focus, gap }`) still work,
_provided every element has them and they are uniform_ — key folding puts them in the header:

```
elements[2]{id,type,x,y,width,height,startBinding{elementId,focus,gap},endBinding{elementId,focus,gap}}:
  c1,arrow,1,2,3,4,c0,0.1,4,c2,-0.2,8
```

But this is brittle: the moment a rectangle has no `startBinding`, uniformity breaks. **Flatten bindings to
bare id strings** (`startBinding: 'a1' | null`) — cheaper in tokens, and it keeps every element uniform
regardless of type. The task's own description already assumes this flattened form; keep it.

**(D) Text/labels with delimiters, newlines, quotes** are handled correctly and losslessly:

```
  d1,text,0,0,10,10,"Hello, world"
  d2,text,0,0,10,10,"line1\nline2"
  d3,text,0,0,10,10,"say \"hi\""
  d4,text,0,0,10,10,"42"
```

Note `d4`: the string `"42"` is quoted to disambiguate it from the number 42 — so a label that looks numeric
survives the round trip. Multi-line labels are escaped to `\n` and stay on one row, so **the row-per-element
invariant holds even for multi-line text**. If canvas labels commonly contain commas, `delimiter: '|'` or
`'\t'` avoids most of that quoting.

**Round-trip:** all four payloads satisfied `JSON.stringify(decode(encode(v))) === JSON.stringify(v)` exactly.

**Verdict — cautious yes, gated on a measurement.**

_In favour:_ the payload is a flat array of 5-100 uniform records, mostly numbers and short strings — literally
the case TOON was built for, and the case where its benchmark is strongest (−58.7% vs JSON pretty, −35.2% vs
JSON compact on the flat-only track). It is zero-dependency, ESM, TS-7-safe, MIT, and actively maintained. The
`[N]` length marker means a model can tell it has seen every element — the one place TOON's own eval shows a
large, non-overlapping win (100% vs JSON's 50% on structural validation). Round-trip is exact on our shapes.

_Against:_ the comprehension evidence is contested (§5), and the two independent evals both put TOON **below**
JSON on accuracy. Our task is not pure retrieval — the agent must reason spatially about coordinates and follow
binding references between rows, which resembles the "Filtering" and "Aggregation" question types where TOON's
own benchmark scores worst in absolute terms (38.0% and 48.4%) and does not beat JSON. Token savings on a
100-element scene are real but bounded: a scene that big is maybe 3-5k tokens as JSON, so we are saving 1-2k
tokens per `queryCanvas` call — worth having on a multi-turn loop, not transformative.

_Recommendation:_ keep `queryCanvas` returning a normalized, strictly-uniform element record (all optionals
present, bindings flattened to ids), and make the serializer a **one-line swap** between `JSON.stringify` and
`encode`. Then A/B it on real scenes with the actual model. Show one worked example of the format in the tool
description rather than explaining it, per the project's own advice. Do **not** adopt it as the format the
model _writes back_ — the arXiv paper's finding that TOON _"collapses parallel tool-call output for most
models"_ is a direct warning against that, and tool arguments should stay JSON since the Responses API
schema-validates them anyway.

### Could not verify

1. **Any evaluation of TOON on spatial/geometric data, or on an Excalidraw-like scene graph.** None exists that
   I could find. The entire published evidence base is business-record retrieval (employees, orders, repos,
   logs, feature flags). Whether a model reads `x,y,width,height` from a TOON row as well as from JSON is
   **completely unmeasured**.
2. **Any evaluation on the models this project actually targets** via `openai@7.4.0` Responses API. The
   project's eval used `gpt-5.4-nano` — the one model where TOON _lost_ to JSON — plus three non-OpenAI models.
   The arXiv paper used open-weight models only. The improvingagents eval used `gpt-4.1-nano`.
3. **I did not run either benchmark.** All accuracy numbers in §4-§5 are reported from their sources, not
   reproduced. The improvingagents eval in particular does not publish its code on the cited page.
4. **The `[2:]` keyed-tabular syntax** I quote from the README but did not exercise locally; it is not relevant
   to our array-shaped payload.
5. **Latency.** The README explicitly says to measure TTFT yourself and that some setups process compact JSON
   faster. Not measured here.
6. **Node engine floor.** The package declares no `engines` field, so the minimum supported Node is undocumented.
   It works on Node 24 (verified by execution); anything older is untested by me and unstated by the project.
7. **Actual token counts for our payloads.** I measured _characters_, not tokens — I did not install
   `gpt-tokenizer`. Character ratios track token ratios only loosely, especially for the numeric-heavy rows in
   this use case.
8. **The `SPEC.md` document itself.** I confirmed the spec repo exists, is separate, is at v4.1, and is
   referenced as a devDependency, but I did not read the normative spec end to end; the format rules in §3 come
   from the guide pages and from executing the encoder.

## Addendum 2026-08-09d — Hand-rolled loop behind the AI SDK wire

Scope: does "own agent loop against OpenAI Responses API + AI SDK UI message stream on the wire + `useChat` on the client" work, and what does it cost? Sources: ai-sdk.dev docs and the shipped typings/runtime of `ai@7.0.58`, `@ai-sdk/react@4.0.61`, `@ai-sdk/provider-utils@5.0.25` (fetched via `npm pack`, read from `dist/index.d.ts` and `dist/index.js`). Package-local line numbers below refer to those extracted files.

### 0. Verdict up front

It works, and the wire format half is explicitly supported. The two costs are (a) you write your own OpenAI-Responses-Item ↔ `UIMessage` translator in both directions, and (b) the "server suspends on a client tool" story is not a suspend at all — it is a fresh stateless HTTP request carrying the whole conversation, so your loop must be able to rehydrate from `UIMessage[]` on every turn.

### 1. Writing a UI message stream by hand — fully supported, fully typed

`ai@7.0.58` exports all the pieces (export list at `ai/dist/index.d.ts:9320`):

- `createUIMessageStream({ execute, onError?, originalMessages?, onStepEnd?, onEnd?, generateId? }): ReadableStream<InferUIMessageChunk<UI_MESSAGE>>` — `ai/dist/index.d.ts:5907-5934`. `execute` receives `{ writer }`.
- `interface UIMessageStreamWriter<UI_MESSAGE>` — `ai/dist/index.d.ts:5875-5890`:
  ```ts
  write(part: InferUIMessageChunk<UI_MESSAGE>): void;
  merge(stream: ReadableStream<InferUIMessageChunk<UI_MESSAGE>>): void;
  onError: ErrorHandler | undefined;
  ```
  `write` takes the **entire** `UIMessageChunk` union — there is no narrowing that reserves text/tool chunks for `streamText`. A caller with no `streamText` result can emit anything.
- `createUIMessageStreamResponse({ status?, statusText?, headers?, stream, consumeSseStream? }): Response` — `ai/dist/index.d.ts:5948`. Also `pipeUIMessageStreamToResponse` (`:5973`) for Node `ServerResponse`, and `JsonToSseTransformStream` (`:5957`) if you want to frame SSE yourself.
- `UI_MESSAGE_STREAM_HEADERS` (`ai/dist/index.js:6468`): `content-type: text/event-stream`, `cache-control: no-cache`, `connection: keep-alive`, `x-vercel-ai-ui-message-stream: v1`, `x-accel-buffering: no`.
- `uiMessageChunkSchema` is exported (`ai/dist/index.d.ts:2266`) — usable to self-validate hand-built chunks in tests.

**Exact chunk union** — `type UIMessageChunk<METADATA, DATA_TYPES>`, `ai/dist/index.d.ts:2275-2416`. Required fields, verbatim from the typings (`?` = optional):

| chunk `type`                        | fields                                                                                                                                      |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `text-start`                        | `id: string`; `providerMetadata?`                                                                                                           |
| `text-delta`                        | `id: string`, `delta: string`; `providerMetadata?`                                                                                          |
| `text-end`                          | `id: string`; `providerMetadata?`                                                                                                           |
| `reasoning-start` / `reasoning-end` | `id: string`; `providerMetadata?`                                                                                                           |
| `reasoning-delta`                   | `id: string`, `delta: string`; `providerMetadata?`                                                                                          |
| `custom`                            | `kind: \`${string}.${string}\``; `providerMetadata?`                                                                                        |
| `error`                             | `errorText: string`                                                                                                                         |
| `tool-input-start`                  | `toolCallId: string`, `toolName: string`; `providerExecuted?`, `providerMetadata?`, `toolMetadata?: JSONObject`, `dynamic?`, `title?`       |
| `tool-input-delta`                  | `toolCallId: string`, `inputTextDelta: string`                                                                                              |
| `tool-input-available`              | `toolCallId: string`, `toolName: string`, `input: unknown`; `providerExecuted?`, `providerMetadata?`, `toolMetadata?`, `dynamic?`, `title?` |
| `tool-input-error`                  | `toolCallId`, `toolName`, `input`, `errorText: string`; + same optionals                                                                    |
| `tool-output-available`             | `toolCallId: string`, `output: unknown`; `providerExecuted?`, `providerMetadata?`, `toolMetadata?`, `dynamic?`, `preliminary?`              |
| `tool-output-error`                 | `toolCallId: string`, `errorText: string`; + optionals                                                                                      |
| `tool-output-denied`                | `toolCallId: string`                                                                                                                        |
| `tool-approval-request`             | `approvalId: string`, `toolCallId: string`; `isAutomatic?`, `signature?`                                                                    |
| `tool-approval-response`            | `approvalId: string`, `approved: boolean`; `reason?`, `providerExecuted?`, `providerMetadata?`                                              |
| `source-url`                        | `sourceId`, `url`; `title?`, `providerMetadata?`                                                                                            |
| `source-document`                   | `sourceId`, `mediaType`, `title`; `filename?`, `providerMetadata?`                                                                          |
| `file` / `reasoning-file`           | `url: string`, `mediaType: string`; `providerMetadata?`                                                                                     |
| `data-${NAME}`                      | `data: DATA_TYPES[NAME]`; `id?`, `transient?` (`:2267`)                                                                                     |
| `start-step` / `finish-step`        | no fields                                                                                                                                   |
| `start`                             | `messageId?`, `messageMetadata?`                                                                                                            |
| `finish`                            | `finishReason?`, `messageMetadata?`                                                                                                         |
| `abort`                             | `reason?`                                                                                                                                   |
| `message-metadata`                  | `messageMetadata: METADATA`                                                                                                                 |

Ordering constraints are enforced at runtime, not by types: `reasoning-end` for an unknown id throws `UIMessageStreamError` (`ai/dist/index.js:7054-7062`); the same pattern applies to text parts. `start-step` pushes a `{ type: 'step-start' }` part (`ai/dist/index.js:7350`) and `finish-step` resets the active text/reasoning id maps (`:7354`).

Documentation nuance worth being honest about: https://ai-sdk.dev/docs/ai-sdk-ui/streaming-data documents `createUIMessageStream` / `createUIMessageStreamResponse` / `writer.write`, but every example there writes **data parts** and obtains text via `writer.merge(toUIMessageStream({ stream: result.stream }))`. Hand-writing `text-start`/`text-delta`/`text-end` is **type-legal and protocol-legal but not shown in the docs examples**. The protocol page (below) does document those parts as wire format, so this is a gap in examples, not in support.

### 2. The client-side tool round trip

**What makes `onToolCall` fire.** From `ai/dist/index.js:7174-7203`: on a `tool-input-available` chunk the reducer sets the part to `state: 'input-available'`, then:

```js
if (onToolCall && !chunk.providerExecuted) {
  await onToolCall({ toolCall: chunk });
}
```

So: emit `tool-input-available` with `toolCallId`, `toolName`, `input`, and **do not** set `providerExecuted: true`. `tool-input-start`/`tool-input-delta` are optional (they only drive the `input-streaming` render state). Callback type: `ChatOnToolCallCallback = (options: { toolCall: InferUIMessageToolCall<UI_MESSAGE> }) => void | PromiseLike<void>` (`ai/dist/index.d.ts:5414`); `toolCall.dynamic === true` when you set `dynamic: true` on the chunk.

**`addToolOutput` does not by itself POST.** Signature `ChatAddToolOutputFunction` at `ai/dist/index.d.ts:5381-5402`:

```ts
({ tool, toolCallId, options? } & ({ state?: 'output-available'; output; errorText?: never }
                                 | { state: 'output-error'; output?: never; errorText: string }))
  => void | PromiseLike<void>
```

Implementation `ai/dist/index.js:17717-17746`: it patches the matching tool part in the last message (and in the in-flight `activeResponse`), then **only** if `status !== 'streaming' && status !== 'submitted'` **and** `sendAutomaticallyWhen` is set does it evaluate that predicate and call `makeRequest({ trigger: 'submit-message', messageId: lastMessage.id, ...options })`. In the normal case — the tool runs while the stream is still open — the auto-send fires instead at stream end (`ai/dist/index.js:18002`: `if (!isError && await this.shouldSendAutomatically())`).

So the resubmit is **opt-in and configurable**, exactly as documented:

- `ChatInit.sendAutomaticallyWhen?: (options: { messages: UI_MESSAGE[] }) => boolean | PromiseLike<boolean>` — `ai/dist/index.d.ts:5478`.
- `lastAssistantMessageIsCompleteWithToolCalls({ messages }: { messages: UIMessage[] }): boolean` — `ai/dist/index.d.ts:5754`; impl `ai/dist/index.js:18085-18102`: takes parts after the **last `step-start`**, keeps tool parts with `!providerExecuted`, returns true iff there is at least one and all are `output-available` or `output-error`. **Practical consequence: emit `start-step` before each batch of tool calls**, or the predicate scans the whole message and a resumed multi-step turn can mis-evaluate.
- Without `sendAutomaticallyWhen`, nothing is sent; the app calls `sendMessage`/`regenerate` itself.

Documented client example (https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-tool-usage), verbatim in the relevant part:

```tsx
const { messages, sendMessage, addToolOutput } = useChat({
  transport: new DefaultChatTransport({ api: '/api/chat' }),
  sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
  async onToolCall({ toolCall }) {
    if (toolCall.dynamic) return;
    if (toolCall.toolName === 'getLocation') {
      // No await - avoids potential deadlocks
      addToolOutput({ tool: 'getLocation', toolCallId: toolCall.toolCallId, output: ... });
    }
  },
});
```

Note the docs' own warning: call `addToolOutput` **without `await`** inside `onToolCall` (also in the `ChatInit.onToolCall` doc comment, `ai/dist/index.d.ts:5457-5462`) — the reducer awaits your callback, so awaiting the job-executor-scheduled `addToolOutput` inside it deadlocks.

**What the server receives on the follow-up.** Default body, built in `HttpChatTransport.sendMessages` (`ai/dist/index.js:17473-17480`) when no `prepareSendMessagesRequest` is supplied:

```js
{ ...resolvedBody, ...options.body, id: chatId, messages: options.messages, trigger, messageId }
```

i.e. a plain JSON POST of `{ id, messages: UIMessage[], trigger: 'submit-message' | 'regenerate-message', messageId }`. `messages` is the **full history**, including the trailing assistant message whose tool part now reads `{ type: 'tool-<name>', toolCallId, state: 'output-available', input, output }` (part shape: `ToolUIPart` at `ai/dist/index.d.ts:2092-2096` over `UIToolInvocation` `:1997-2091`). That — plus `trigger`/`messageId` — is everything the resume has to work from. `PrepareSendMessagesRequest` (`ai/dist/index.d.ts:5585-5606`) lets you reshape the body (e.g. send only the last message plus a server-side thread id).

**Typed path for a non-`streamText` server.** There is a first-class validation entry point: `validateUIMessages({ messages, metadataSchema?, dataSchemas?, tools? }): Promise<UIMessage[]>` (`ai/dist/index.d.ts:5864`) and `safeValidateUIMessages`. After that you are on your own — `convertToModelMessages(messages, { tools?, ignoreIncompleteToolCalls?, convertDataPart? }): Promise<ModelMessage[]>` (`ai/dist/index.d.ts:5579`) produces **AI SDK `ModelMessage`**, not OpenAI Responses items. Its tool shapes are `ToolCallPart { type: 'tool-call', toolCallId, toolName, input, providerOptions?, providerExecuted? }` and `ToolResultPart { type: 'tool-result', toolCallId, toolName, output: ToolResultOutput, providerOptions? }` (`@ai-sdk/provider-utils/dist/index.d.ts:320-368`), where `ToolResultOutput` is a tagged `{type:'text'|'json'|...}` wrapper (`:372+`). Going through `convertToModelMessages` therefore buys you nothing for a Responses-API loop except a second dialect to translate out of. **Translate `UIMessage[]` → Responses items directly.**

### 3. The impedance mismatch, concretely

**Responses items → UI chunks (server → client), per turn:**

| Responses stream event                   | emit                                                                                                                                                                                    |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| turn begins                              | `start` (optionally `{ messageId }`), then `start-step`                                                                                                                                 |
| `response.output_text.delta`             | `text-start` once per output-text item id, then `text-delta` per delta, `text-end` at `output_text.done`                                                                                |
| `response.function_call_arguments.delta` | `tool-input-start` (needs `toolName`, known from the `output_item.added` event) + `tool-input-delta`                                                                                    |
| function call item complete              | `tool-input-available { toolCallId, toolName, input }` — **`toolCallId` must be the Responses `call_id`**, since that is what comes back and what `function_call_output` must reference |
| reasoning item                           | `reasoning-start`/`reasoning-delta`/`reasoning-end` if you have summary text; otherwise nothing renderable                                                                              |
| step ends                                | `finish-step`; at the end of the whole HTTP response, `finish`                                                                                                                          |

**UI messages → Responses items (client → server, the resume):** walk `messages[].parts` in order and rebuild `input` items — user text → `{role:'user'}`, assistant text → `{role:'assistant'}`, each tool part → a `function_call` item (`call_id = part.toolCallId`, `name = getToolName(part)`, `arguments = JSON.stringify(part.input)`) immediately followed by `function_call_output` (`call_id`, `output = JSON.stringify(part.output)`), or the `errorText` for `state: 'output-error'`. Helpers `isToolUIPart` / `isStaticToolUIPart` / `isDynamicToolUIPart` / `getToolName` are exported (`ai/dist/index.d.ts:2199-2252`).

Things that do **not** map cleanly:

1. **`call_id` vs `id`.** Responses `function_call` items carry _two_ identifiers — `call_id` (correlates with `function_call_output`) and the item `id`. A `UIMessage` tool part has exactly one string slot, `toolCallId`. Put `call_id` there. If you also need the item `id` (you do if you ever replay items rather than reconstruct them), use the escape hatch: **`toolMetadata?: JSONObject`** and **`providerMetadata`/`callProviderMetadata`** exist on both the chunks (`tool-input-start`/`-available`/`tool-output-available`, `ai/dist/index.d.ts:2309-2358`) and the resulting parts (`UIToolInvocation`, `:2002-2003`, `:2013`), and the reducer copies them onto the part (`ai/dist/index.js:7176-7196`) where they survive `addToolOutput` (it spreads `...part`, `ai/dist/index.js:17726`) and therefore ride back to the server in the next POST. **This is the metadata escape hatch and it is typed and round-trips.**
2. **Reasoning.** For encrypted / persisted reasoning items (`reasoning.encrypted_content`, item ids) the only carrier is `ReasoningUIPart.providerMetadata` (`ai/dist/index.d.ts:1879-1893`); `reasoning-end`'s `providerMetadata` is written onto the part (`ai/dist/index.js:7063`). Shipping encrypted reasoning blobs through the browser and back is possible but it is your design decision, with the obvious size/trust cost. I did **not** verify round-trip fidelity of large `providerMetadata` payloads — there is no size guard in the code I read, but I did not test it. The alternative — server-side conversation state via `previous_response_id` / `conversation`, with the browser sending only the tool output — is cleaner but means the wire messages are no longer the source of truth.
3. **Parallel tool calls.** Fine on the wire — chunks are correlated by `toolCallId`, and `useChat` renders N `input-available` parts. But `onToolCall` fires **sequentially and awaited** per chunk (`await onToolCall(...)` at `ai/dist/index.js:7199`), so a slow browser tool blocks processing of the rest of the stream. Keep `onToolCall` bodies synchronous-dispatch-only.
4. **Multi-step boundaries.** `start-step`/`finish-step` are field-less and purely advisory to the client, but `lastAssistantMessageIsCompleteWithToolCalls` depends on the last `step-start` (§2). Emit them.
5. **Output shape.** `tool-output-available.output` is `unknown`/JSON — no `ToolResultOutput` tagged wrapper on the UI side. Your Responses `function_call_output` needs a string, so you serialize at the boundary. Minor, but it means an Excalidraw tool returning a large scene blob is JSON-stringified into both the browser message list and the model input.

### 4. Does `useChat` need an AI-SDK server? No — protocol only

https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol documents the UI Message Stream Protocol as a wire format, explicitly for foreign backends: _"You can use this information to develop custom backends and frontends for your use case, e.g., to provide compatible API endpoints that are implemented in a different language such as Python."_ It specifies the required `x-vercel-ai-ui-message-stream: v1` header, `data: {json}` SSE framing terminated by `data: [DONE]`, and enumerates the same part families as the typings above. A FastAPI backend example is linked. **So a non-AI-SDK server writing this protocol is a documented, supported use case — not merely tolerated.**

What `DefaultChatTransport` actually enforces (`ai/dist/index.js:17546-17565`): it POSTs JSON, then pipes the response body through `parseJsonEventStream({ stream, schema: uiMessageChunkSchema })` and **throws on the first chunk that fails schema validation**. It does _not_ check the `x-vercel-ai-ui-message-stream` header on the response. Practical read: the header is required by spec (and by proxies/observability), but the hard runtime contract is "every `data:` payload validates against `uiMessageChunkSchema`". `createUIMessageStreamResponse` sets the headers for you.

Custom transports are a supported extension point: `interface ChatTransport<UI_MESSAGE>` with `sendMessages` and `reconnectToStream` (`ai/dist/index.d.ts:5270-5336`), `HttpChatTransport` as an abstract base with a single `processResponseStream` hook (`:5675`), plus shipped `DefaultChatTransport`, `TextStreamChatTransport`, `DirectChatTransport`. The interface doc comment itself advertises "alternative communication protocols like WebSockets, custom authentication patterns, or specialized backend integrations."

### 5. Versions and peers

- Latest at time of writing: **`ai@7.0.58`**, **`@ai-sdk/react@4.0.61`** (`npm view ... version`, 2026-08-09).
- `@ai-sdk/react@4.0.61` peer: `react: "^18 || ~19.0.1 || ~19.1.2 || ^19.2.1"`. **React 19.2.8 satisfies `^19.2.1`** — compatible, no override needed.
- `@ai-sdk/react` deps: `ai@7.0.58` (exact), `@ai-sdk/mcp`, `@ai-sdk/provider`, `@ai-sdk/provider-utils`, `swr`, `throttleit`. It pins `ai` exactly, so the two version-lockstep.
- **`ai` needs no `@ai-sdk/<provider>` package.** Its only deps are `@ai-sdk/provider@4.0.7`, `@ai-sdk/provider-utils@5.0.25`, `@ai-sdk/gateway@4.0.46`; the sole peer is `zod: ^3.25.76 || ^4.1.8`. `createUIMessageStream` and friends need no model. The UI-stream half is genuinely usable standalone — you just carry the `zod` peer and the gateway dep as dead weight.
- Both packages: `"type": "module"`, `"engines": { "node": ">=22" }`. ESM-only, Node 22+. Fine for Next 16 route handlers (and the stream helpers are Web-Streams-based, so edge runtime works too — untested here).

### 6. Honest verdict

**Supported and documented:** the wire format (explicitly, for foreign backends); `createUIMessageStream`/`createUIMessageStreamResponse`/`UIMessageStreamWriter` accepting the full chunk union; the client-side-tool round trip with `onToolCall` + `addToolOutput` + `sendAutomaticallyWhen`; `validateUIMessages`; custom `ChatTransport`. None of that is a hack.

**Improvised (works, but you are off the documented trail):** hand-writing `text-start`/`text-delta`/`text-end` and `tool-input-*`/`tool-output-*` chunks — legal per the protocol page, but every SDK example routes text through `streamText`. Consequences you own: chunk ordering invariants that are runtime-throws rather than type errors; `start-step` placement that `lastAssistantMessageIsCompleteWithToolCalls` silently depends on; and version risk — `uiMessageChunkSchema` is the real contract and it can gain fields between minors, with `@ai-sdk/react` pinning `ai` exactly.

**Code you still write in the hybrid:** (1) Responses SSE event → `UIMessageChunk` emitter, ~150–300 LoC and the fiddliest part (item-id bookkeeping, argument-delta accumulation, ordering); (2) `UIMessage[]` → Responses `input[]` rehydrator, ~100–200 LoC; (3) the loop itself — tool-call detection, when to stop, when to suspend for browser tools, error/abort paths.

**Code you write if you drop the AI SDK entirely:** all of the above minus (1)/(2) collapsing into one direct mapping, **plus** your own SSE framing and parsing, your own client-side message reducer (the `ai` reducer that turns 25 chunk types into ordered `UIMessage.parts` is several hundred lines and handles partial-JSON tool inputs via `parsePartialJson`, id maps, throttling, abort, reconnect), your own `status`/`error`/`stop`/`regenerate` state machine, and your own React binding. That is the larger pile — the AI SDK's real value here is the **client**, not the server.

**Recommendation, stated plainly:** the hybrid is the better trade for this project _if_ the reason for hand-rolling is control of the loop (Responses API items, `previous_response_id`, provider-specific features) rather than dislike of the SDK. You keep `useChat`'s reducer and tool round trip — the expensive, fiddly part — and pay a two-way translator you would have written anyway in some form. The genuine risks are the undocumented-by-example chunk authoring and the exact-pin coupling between `ai` and `@ai-sdk/react`; mitigate both by validating every emitted chunk against the exported `uiMessageChunkSchema` in tests, which turns a silent protocol drift on upgrade into a red test.

**Not verified:** (a) whether large `providerMetadata`/`toolMetadata` payloads (encrypted reasoning) round-trip without truncation — no size guard seen in code, but not tested; (b) behaviour on edge/Workers runtime; (c) whether Vercel treats `x-vercel-ai-ui-message-stream` as load-bearing at the platform level (it is absent from the client's runtime checks); (d) any of this against a live OpenAI Responses stream — all Responses-API event names above are from prior knowledge of that API, not re-verified in this pass, so treat the left column of the §3 table as a sketch to confirm against OpenAI's docs.

## Addendum 2026-08-09e — harness-engineering: a second hand-rolled loop

Source: `Hendrixer/harness-engineering` @ branch `complete` (commit `c497c33`, "Complete harness:
durable, sandboxed, memory-managed, multi-agent, human-gated runtime"), cloned and read locally.
68 files, ~2k LoC of hand-written source. All line numbers below are that checkout.

### 0. Headline: it is NOT a hand-rolled OpenAI loop

The premise this repo was fetched to test does not hold. It hand-rolls **the multi-step loop**, but
the **model call itself is Vercel AI SDK**. `harness/model.ts:1,9`:

```ts
import { openai } from "@ai-sdk/openai";
export const model = openai("gpt-5.5");
```

and `harness/runtime.ts:1-3,33`:

```ts
import { DBOS } from "@dbos-inc/dbos-sdk";
import { streamText } from "ai";
import type { ModelMessage, JSONValue, ToolSet } from "ai";
...
const result = streamText({ model, messages: context, tools: agentTools });
```

`ai@6.0.202`, `@ai-sdk/openai@3.0.70` (`package.json:18,20`). So on question 1 the repo is **silent
on every sub-question**:

- **Responses vs Chat Completions** — not chosen in repo code; delegated to `@ai-sdk/openai`'s
  default for `openai("gpt-5.5")`. No `openai.responses(...)`, no `openai.chat(...)` anywhere.
- **`store`** — grep for `store` across `harness/ server/ shared/ web/src/ scripts/` returns only
  `server/index.ts:19` (a comment about Postgres as DBOS's "checkpoint store") and
  `web/src/useTheme.ts:6-7` (`localStorage`). Never set.
- **`previous_response_id`** — zero occurrences.
- **`include: ["reasoning.encrypted_content"]`** — zero occurrences. No `providerOptions` anywhere.
- **Reasoning items** — zero occurrences of `reasoning` in any `.ts`/`.tsx`. The only hits repo-wide
  are prose in `lessons/01-.../index.md:287` and `lessons/06-.../index.md:26`.

**It does replay a message array manually**, and that array is `ModelMessage[]` — the AI SDK's
provider-agnostic message type, not Responses items. `harness/runtime.ts:49` takes
`(await result.response).messages` and `:135` seeds the next turn with `[...turn.responseMessages]`.
Whether reasoning survives that round-trip is a property of `@ai-sdk/openai`'s
`ModelMessage`↔provider mapping, which this repo neither configures nor tests.

**Conclusion for the blocking risk: this repo cannot answer it either.** It is the second reference
repo in a row that delegated the question to the AI SDK. The `store: false` + stateless-resume +
dropped-reasoning question remains unverified and still needs the smallest-possible script.

### 1. The loop

`harness/runtime.ts:90-227`, `agentWorkflow(input: string): Promise<string>`. A flat `while` loop,
not recursion, not a generator. `MAX_STEPS = 30` (`:17`).

```ts
let currentAgent = triageAgent;
const turns: ModelMessage[][] = [];
let summary = "";

let step = 0;
while (step < MAX_STEPS) {
  // 1. compact old turns once over budget  (:104-127)
  // 2+3. hydrate context, run one turn     (:130-133)
  const context = buildContext(currentAgent.systemPrompt, input, summary, turns);
  const turn = await DBOS.runStep(() => modelTurn(workflowId, context, currentAgent.tools), {
    name: `model-${step}`,
  });

  const turnMessages: ModelMessage[] = [...turn.responseMessages];

  if (turn.toolCalls.length === 0) {           // :137 — the ONLY termination test
    ... emit ModelCompleted + WorkflowCompleted
    return turn.text;
  }

  for (const call of turn.toolCalls) { ... }   // :149-211
  turns.push(turnMessages);
  step++;
}
// :217-226 falls out to WorkflowFailed("Hit the 30-step limit without finishing.") and returns ""
```

Notable shape details:

- **Termination is `turn.toolCalls.length === 0`** (`:137`) — not a finish-reason check. Exhausting
  the step cap returns `""`, not an error throw (`:226`).
- **No argument accumulation to write.** `modelTurn` (`:28-51`) streams `fullStream` only to emit
  `text-delta` as `ModelDelta` events (`:35-38`), then awaits the settled `result.toolCalls`,
  `result.text`, `result.response` (`:41-49`). Partial tool-call JSON never reaches this code — the
  SDK assembles it. This is exactly the piece the drawing-agent has to write itself.
- **Turns are stored as `ModelMessage[][]`** — an array _per turn_, so compaction can peel whole
  turns (`:106-108 turns.shift()`), never splitting an assistant tool-call from its tool result.
  That grouping is a genuinely good idea and cheap to adopt.
- **One step = one model call + its tool results**, matching the drawing-agent's "step" vocabulary,
  but the cap is 30 vs their 8.

### 2. Tools and dispatch — the closest thing to an "injected executor"

Declared with the AI SDK's `tool()` + Zod 4 (`harness/tools.ts:1-2,48-96`). **No `strict: true`, no
`zodResponsesFunction`, no raw JSON Schema.** Schemas are plain `z.object({...})` with `z.enum`;
`.optional()`/`.nullable()` never appear.

The load-bearing pattern: **tools declared WITHOUT `execute` are executed by the harness.**
`harness/tools.ts:51-95` — every entry is `tool({ description, inputSchema })` and nothing else. The
AI SDK therefore returns the call instead of running it, and the harness dispatches:

```ts
// harness/tools.ts:102-129
export async function runTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  switch (name) {
    case "runCode": return runInSandbox(String(args.code ?? ""), sandboxApi);
    ...
    default: throw new Error(`unknown tool: ${name}`);
  }
}
```

The contrast is made explicitly, in the same repo: sub-agent tools **do** get `execute`
(`harness/investigators.ts:9-19`) with the comment "Their tools have `execute`, so the AI SDK runs
the tool loop inline and each sub-agent is one bounded interaction we can run as a single durable
step" (`:6-8`), driven by `generateText({ ..., stopWhen: stepCountIs(5) })` (`:52-58`). So the repo
runs _both_ execution modes side by side and picks per call-site. That is the same seam the
drawing-agent calls "suspend vs in-process", validated in practice — but selected by tool
declaration, not by an injected parameter. There is no `ToolExecutor` type and nothing is injected;
`runtime.ts` imports `runTool` and `model` as module singletons (`:6-7`).

Results are fed back as AI SDK tool messages (`harness/runtime.ts:72-79`):

```ts
return {
  role: "tool",
  content: [
    {
      type: "tool-result",
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      output: { type: "json", value },
    },
  ],
};
```

**Two tools are intercepted rather than executed** — the drawing-agent's suspend idea in miniature:

- `handoff` (`runtime.ts:150-165`) — never reaches `runTool`; switches `currentAgent` and pushes a
  synthetic tool result telling the model it is now the specialist.
- anything in `NEEDS_APPROVAL = new Set(["issueRefund"])` (`:21`) — emits `ApprovalRequested`, then
  **suspends** on `await DBOS.recv<{approved: boolean}>("approval", APPROVAL_TIMEOUT_S)` (`:182`,
  timeout 86 400 s). A rejection is fed back as a normal tool result with
  `"Do not retry — tell the customer it needs manual review."` (`:196-204`).

**Error handling in dispatch: none.** `toolStep` (`:54-70`) does not wrap `runTool` in try/catch, so
a thrown tool error propagates out of the workflow. `EventType.ToolFailed` exists
(`shared/events.ts:23,48`) and the UI renders it (`web/src/components/TaskPane.tsx:124-128`) but
**nothing ever emits it** — grep confirms zero emit sites. This is a real gap, not a pattern.

**No client-side/browser-executed tools exist.** Every tool runs on the Node server. There is no
round-trip protocol to learn from here.

### 3. Streaming and the wire — bespoke, and deliberately not the AI SDK's

Transport is **one WebSocket** at `/ws` (`server/index.ts:51`), Express 5 + `ws`. The wire is a
hand-rolled discriminated union of JSON events, `shared/events.ts:12-63`: an `EventType` enum with
18 members (`workflow.started`, `model.delta`, `tool.requested`, `memory.compacted`,
`agent.handoff`, `plan.created`, `approval.requested`, …) and an `EventInput` union, stamped with
`{ id, ts }` on emit (`harness/bus.ts:20`). No AI SDK UI package, no `useChat`, no SSE, no
`data:` framing. `@ai-sdk/react` is not a dependency.

Every event is **persisted to Postgres before broadcast** (`harness/bus.ts:19-23`), and on connect
the server replays the whole log (`server/index.ts:81`, `bus.ts:26-29`). The client reducer is
`toTranscript(events)` in `web/src/components/TaskPane.tsx:63-195` — a fold over the event array
into a `Turn[]` union, with `Map`s keyed by `toolCallId` for in-place tool and approval state
transitions (`:108,113-128,169-187`) and a mutable `assistant` accumulator for `ModelDelta` text
(`:85-96`). ~130 lines, and it is the whole client-side protocol.

The rejection of `useChat` is explicit and reasoned, `CLAUDE.md:54-58`:

> We do NOT use the AI SDK's `useChat`/UI transport — that's request-scoped and can't express
> server-initiated events (a sub-agent finishing, a workflow resuming days later). The AI SDK is
> used server-side only (`streamText`), bridged into our event bus.

Read that carefully: the reason is **server-initiated events across requests**, which the
drawing-agent does not have (its resume is client-initiated by construction). The argument does not
transfer.

### 4. Error handling, abort, retries, budgets

Thinner than the drawing-agent's stated plan, with two exceptions.

- **AbortSignal: absent.** Zero occurrences of `abort` or `signal` in any source file. No request
  cancellation anywhere.
- **Retries: absent.** No `maxRetries`, no retry loop, no backoff. (DBOS gives crash _recovery_, not
  retry.)
- **Token/cost caps: absent.** No usage accounting, no cost tracking, no wall-clock cap on the loop.
- **`onError`: absent.** `streamText` is called with no `onError`. The only `catch`es in server code
  are `server/index.ts:67` (malformed WS JSON → silently return) and `:89` (startup failure →
  `process.exit(1)`).
- **Step cap:** 30 (`runtime.ts:17`); sub-agents `stepCountIs(5)` (`investigators.ts:57`).
- **Context budget — worth stealing.** `harness/memory.ts:10-20`: `MAX_CONTEXT_TOKENS = 3000`,
  `KEEP_CONTEXT_TOKENS = 1500`, `estimateTokens` = `JSON.stringify(content).length / 4`. The loop
  compacts when over budget by summarizing the oldest whole turns into a running string
  (`runtime.ts:104-127`, `memory.ts:49-74`). Comment at `memory.ts:7-8`: "Token budget — not turn
  count — is what actually drives context bloat, and it holds up even when the model batches many
  tool calls into one turn."
- **Sandbox timeouts — worth reading.** `harness/sandbox.ts:23-60`: `node:vm` with a frozen context
  exposing only `tools` + `console.log`, `{ timeout: timeoutMs }` for sync code plus a
  `Promise.race` backstop for async hangs (`:53-59`), all errors returned as
  `{ ok: false, error, logs }` rather than thrown (`:48-50`). The file's own comment is honest that
  `vm` is not a security boundary (`:12-15`).
- **Partial-failure degradation:** the supervisor uses `Promise.allSettled` and continues with
  whatever succeeded (`harness/supervisor.ts:65-111`), emitting `SubagentFailed` for the rest.
- **Chaos hook for reproducible failure demos:** `CHAOS_FAIL=technical` throws in a named
  investigator (`harness/investigators.ts:45-47`). A cheap idea worth copying into evals.

### 5. Testing and evals — there are none

No test runner. `package.json:6-16` has `dev`, `dev:server`, `dev:web`, `build`, `preview`,
`typecheck`, `docs*` — no `test`, no `eval`. Neither `vitest` nor `jest` appears in dependencies or
the lockfile top level. No `*.test.ts`, `*.spec.ts`, or `*.eval.ts` files exist. No fake model
client, no fixtures, no scorers.

The only executable checks are two manual demo scripts: `scripts/test-sandbox.ts` (34 lines, prints
sandbox behaviour for four inputs, run by hand per `lessons/03-secure-sandboxing/index.md:347`) and
`scripts/inspect-log.ts` (33 lines, dumps the event log). Neither asserts anything.

**This repo teaches nothing about testing a hand-rolled loop deterministically.** It does, however,
suggest one seam by accident: the durable **event log is the transcript**, so a run's entire
behaviour is a `SELECT ... ORDER BY seq` away. Asserting over an event array is a plausible eval
shape — but it is our inference, not a pattern present in the repo.

### 6. Architecture

Plain **Node.js + TypeScript run through `tsx`, no build step** for the server; Vite + React 19 for
the inspector; Postgres via Drizzle + `postgres.js` for the event log; DBOS for durability. Not
Next, not Workers, not a CLI. Layout: `shared/events.ts` (the contract), `harness/*` (bus, db,
model, memory, tools, sandbox, agents, investigators, runtime, supervisor), `server/index.ts`
(Express + ws + DBOS launch), `web/` (inspector), `lessons/` (VitePress course notes).

Module boundaries are clean and one-way: `runtime.ts` imports `bus`, `model`, `tools`, `agents`,
`memory`; nothing imports `runtime` except `server/index.ts`. But everything is a **module
singleton** — `model` and `runTool` are imported directly (`runtime.ts:6-7`), never passed in. The
only injected thing is `currentAgent.tools` (`runtime.ts:131`), which selects a `ToolSet` per agent.
So: no injected model client, no injected executor, no seam a test could reach. `harness/agents.ts`
is the nicest bit — "An agent is just a name, a system prompt, and the subset of tools it's allowed
to use… adding a specialist is data, not new machinery" (`:4-6`).

### 7. Dependencies (exact, from `package-lock.json`), and drift vs npm latest 2026-08-09

Runtime: `@ai-sdk/openai` 3.0.70 (**latest 4.0.36 — a major behind**) · `ai` 6.0.202 (**latest
7.0.58 — a major behind, i.e. this repo predates AI SDK 7 exactly like the first reference repo**) ·
`@dbos-inc/dbos-sdk` 4.19.8 (latest 4.25.14) · `zod` 4.4.3 (current) · `drizzle-orm` 0.45.2
(current) · `postgres` 3.4.9 · `express` 5.2.1 (current) · `ws` 8.21.0 · `react`/`react-dom` 19.2.7
(latest 19.2.8) · `react-markdown` 10.1.0 · `marked` 18.0.5 · `shiki` 4.2.0 · `radix-ui` 1.5.0 ·
`lucide-react` 1.17.0 · `class-variance-authority` 0.7.1 · `clsx` 2.1.1 · `tailwind-merge` 3.6.0 ·
`use-stick-to-bottom` 1.1.6 · `remark-gfm` 4.0.1 · `remark-breaks` 4.0.0 · `dotenv` 17.4.2.

Dev: `typescript` 5.9.3 (**latest 7.0.2 — two majors behind; this repo says nothing about TS 7**) ·
`vite` 6.4.3 (**latest 8.2.1 — two majors behind**) · `tailwindcss`/`@tailwindcss/vite` 4.3.0 ·
`@vitejs/plugin-react` 4.7.0 · `tsx` 4.22.4 · `concurrently` 9.2.1 · `vitepress` 1.6.4 ·
`@types/node` 24.13.2 · `@types/react` 19.2.17 · `@types/react-dom` 19.2.3 · `@types/express` 5.0.6
· `@types/ws` 8.18.1 · `@tailwindcss/typography` 0.5.20 · `tw-animate-css` 1.4.0.

Same caveat as the first reference repo: **a source of patterns, not of versions.**

### 8. Verdict — decision by decision

| Decision                                                             | This repo                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hand-rolled loop against the `openai` SDK, Responses API             | **Contradicts, weakly.** It hand-rolls the _loop_ but keeps the SDK for the _call_, and gets a real benefit for it (no tool-argument assembly, no SSE parsing). It never confronts Responses-vs-Chat. Not evidence against the decision, but proof the decision is not the only way to own a loop.                                                                                     |
| `store: false`, reasoning dropped between turns                      | **Silent.** Zero occurrences of `store`, `previous_response_id`, `reasoning`, `encrypted`, `providerOptions`. The blocking risk is untouched.                                                                                                                                                                                                                                          |
| AI SDK UI message stream protocol, `useChat`                         | **Contradicts, for reasons that don't apply.** It rejects `useChat` explicitly (`CLAUDE.md:54-58`) because it needs _server-initiated_ events days later. The drawing-agent's resume is client-initiated, so the objection is void. Keep `useChat`.                                                                                                                                    |
| Client-side tools, browser executes, turn ends                       | **Partially confirms the mechanism, not the location.** Declaring a tool with no `execute` so the harness dispatches it (`tools.ts:51-95` + `runTool`) is exactly the drawing-agent's client-tool trick, one layer down. And `DBOS.recv` at `runtime.ts:182` proves the loop-suspends-mid-turn shape works. But every tool here is server-side; the browser round trip is unexercised. |
| One turn function, injected model client + injected executor         | **Contradicts.** Module singletons throughout (`runtime.ts:6-7`). Nothing is injectable, and the price is visible: zero tests. Their seam is the better design; this repo is the counterexample that shows what its absence costs.                                                                                                                                                     |
| Step cap 8, `AbortSignal`, `maxRetries: 0`, tool failures as results | **Mostly silent.** Step cap yes (30). Abort/retries entirely absent. Tool failures are _thrown_, not returned — `ToolFailed` is defined and rendered but never emitted. The drawing-agent's plan is strictly better here.                                                                                                                                                              |
| Evals: Vitest 4, deterministic scorers, no vendor                    | **Silent.** No test runner at all.                                                                                                                                                                                                                                                                                                                                                     |

**Adopt from this repo:**

1. **Turn-grouped history.** `ModelMessage[][]` — one array per step, never split when trimming
   (`runtime.ts:98,135,213`; `memory.ts:42`). Prevents orphaning a tool call from its result, which
   is a real failure mode when replaying a stateless history.
2. **Token-budget compaction, not turn-count.** `memory.ts:10-20` + the reasoning at `:7-8`.
   Deferred for the drawing-agent, but the shape is right when it lands.
3. **Errors as tool results, with an instruction attached.** `runtime.ts:196-204` returns
   `"Do not retry — tell the customer it needs manual review."` inside the result. Telling the model
   what to do next, in the result body, is better than returning a bare error string.
4. **A closed event-type enum as the harness↔UI contract.** `shared/events.ts:12-38`. Even behind
   the AI SDK wire, an internal typed event union is a good spine for the eval transcript.
5. **A chaos env var** (`CHAOS_FAIL`, `investigators.ts:45-47`) for reproducing failure paths.
6. **Agents-as-data** (`agents.ts:7-11`) if a second prompt/tool subset is ever needed.

**Do NOT copy:** module-singleton model and executor (kills testability); shipping with no tests;
throwing from tool dispatch; the WebSocket event bus (solves a problem the drawing-agent doesn't
have); `MAX_STEPS = 30`; returning `""` on step exhaustion instead of surfacing it; `node:vm` as a
sandbox (irrelevant here, and the file itself says it isn't a boundary).

**Net:** on the one question that mattered — reasoning replay under `store: false` — this repo
teaches nothing, for the same reason the first one didn't: it delegated to the AI SDK. Its real
contribution is the suspend-mid-turn proof (`DBOS.recv`) and the execute/no-execute dispatch split,
plus a handful of small hygiene patterns. Everything about testing, injection, abort, and retries,
the drawing-agent already plans to do better.

### 9. Not verified

- Which OpenAI API surface `@ai-sdk/openai@3.0.70`'s `openai("gpt-5.5")` actually hits, and how it
  maps reasoning into/out of `ModelMessage` — that lives in `node_modules`, which was not installed
  in this checkout (no `node_modules`; read from `package-lock.json` only).
- Whether the loop runs. Nothing was executed — it needs `DATABASE_URL` (`harness/db.ts:6-9`) and
  `OPENAI_API_KEY`.
- `lessons/*` prose was grepped for `reasoning`/`store`/`Responses` (only two incidental prose hits)
  but not read end to end; the course notes are ~2 500 lines and may discuss the Responses API
  without the code using it.
- npm "latest" figures are from `npm view <pkg> version` on 2026-08-09.

## Addendum 2026-08-09f — streamText inside an owned loop

**Question.** Can the team own the multi-step loop (own `while`, own step accounting, budgets,
compaction, termination) while using `streamText` from `ai` for each individual model call, with
client-side tools executed in the browser and a stateless resume on each follow-up request?

**Answer: yes, and it is the documented pattern.** The AI SDK ships a "Manual Loop Control" section
that says exactly this, and `streamText`'s default is already one model call. Verdict below is
backed by the shipped typings/source of `ai@7.0.58` and `@ai-sdk/openai@4.0.36`, by the `.mdx` docs
vendored inside the `ai` tarball (`ai/docs/**`, the source of ai-sdk.dev), and by probes actually
executed against those packages.

**Sources.** Tarballs unpacked to the session scratchpad:
`scratchpad/ai/` (`npm pack ai@7.0.58`; ships `dist/index.d.ts`, `src/`, **and `docs/`**),
`scratchpad/aiopenai/package/` (`npm pack @ai-sdk/openai@4.0.36`, ships `docs/03-openai.mdx`),
`scratchpad/react/` (`@ai-sdk/react@4.0.61`), `scratchpad/pu/` (`@ai-sdk/provider-utils@5.0.25`).
File:line references below are relative to those roots. Live-doc spot checks against
<https://ai-sdk.dev/docs/agents/loop-control> agree with the vendored copy.

### 1. `streamText` is single-step by default

`stopWhen` defaults to **`isStepCount(1)`** — one model call per `streamText` invocation. It does
**not** loop over tool results unless you raise it.

- `ai/src/generate-text/stream-text.ts:376` — `stopWhen = isStepCount(1),`
- `ai/src/generate-text/generate-text.ts:249` — same default for `generateText`
- `ai/dist/index.d.ts:3398-3400` — `@default isStepCount(1)` on `streamText`'s `stopWhen`
- `ai/dist/index.d.ts:4964-4966` — `ToolLoopAgent`'s default is `isStepCount(20)`; that 20 is the
  number everyone quotes, and it belongs to the Agent class, **not** to `streamText`.

**So: to get exactly one model call, pass nothing.** `stopWhen: isStepCount(1)` is legal and
explicit but redundant. Note the ai-sdk.dev `streamText` reference page documents neither the
default nor a description for `stopWhen` — the `@default` only exists in the typings/source.

**Naming.** In v7 the canonical name is **`isStepCount`**. `stepCountIs` still exists as an alias:

- `ai/dist/index.d.ts:1777` — `declare function isStepCount(stepCount: number): StopCondition<any, any>;`
- `ai/dist/index.d.ts:9320` (export list) — `isStepCount as stepCountIs`
- `ai/docs/08-migration-guides/23-migration-guide-7-0.mdx:298-313` — "Stop Condition Helper Rename:
  `stepCountIs` -> `isStepCount`"
- Probe: `stepCountIs === isStepCount` → `true`.

Also available: `hasToolCall(...names)` (`dist/index.d.ts:1791`) and `isLoopFinished()` (never
triggers; removes the step limit). Independently of `stopWhen`, the SDK's own loop stops when a
called tool has no `execute` (`ai/docs/03-agents/04-loop-control.mdx:7-13`) — so for browser-side
canvas tools, the turn would end at the tool call anyway.

### 2. Reading a result to drive your own loop

Relevant members of `StreamTextResult` (`ai/dist/index.d.ts:2560-2820`). All are `PromiseLike` and
**auto-consume the stream**:

| Property           | Type                                                                                                         | Use                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| `responseMessages` | `PromiseLike<Array<ResponseMessage>>` (`= AssistantModelMessage \| ToolModelMessage`, `dist/index.d.ts:176`) | **Append these to your history.**                         |
| `toolCalls`        | `PromiseLike<TypedToolCall<TOOLS>[]>`                                                                        | non-empty ⇒ model wants tools ⇒ hand off to browser       |
| `finishReason`     | `PromiseLike<FinishReason>`                                                                                  | `'stop'` ⇒ natural stop; `'tool-calls'` ⇒ tools requested |
| `steps`            | `PromiseLike<Array<StepResult<TOOLS, RUNTIME_CONTEXT>>>`                                                     | length is always 1 under the default                      |
| `finalStep`        | `PromiseLike<StepResult<…>>`                                                                                 | shortcut for `steps.at(-1)`                               |
| `usage`            | `PromiseLike<LanguageModelUsage>`                                                                            | **sum across all steps**                                  |
| `stream`           | `AsyncIterableStream<TextStreamPart<TOOLS>>`                                                                 | feed to `toUIMessageStream`                               |

`StepResult` shape: `ai/dist/index.d.ts:1395-1510` (`stepNumber`, `content`, `text`, `reasoning`,
`toolCalls`, `toolResults`, `finishReason`, `usage`, `request`, `response`, `providerMetadata`, …).

**v7 changes that matter for an owned loop** (`ai/docs/08-migration-guides/23-migration-guide-7-0.mdx`):

- `:1104-1140` — `step.response.messages` **no longer accumulates**; each `StepResult` carries only
  its own messages. Use top-level **`result.responseMessages`** for the full history. (It also
  includes response messages produced before the first model step, e.g. tool results from approved
  tool calls in the input.) `result.response.messages` is now the _last step's_ messages, and
  `result.response` itself is deprecated in favour of `finalStep.response`.
- `:1447-1473` — top-level `usage` is now the **total across all steps** (old `totalUsage`);
  `totalUsage` is deprecated. Use `finalStep.usage` for final-step-only.
- `:1479-1540` — same accumulation change for `content`, `toolCalls`, `staticToolCalls`,
  `dynamicToolCalls`, `toolResults`, `files`, `sources`, `warnings`. Use `finalStep.*` for
  final-step-only.

Under `stopWhen: isStepCount(1)` there is exactly one step, so accumulated and final-step values
coincide — but the owned loop is doing the accumulating itself, and must not double-count if it ever
raises `stopWhen`.

The documented manual-loop skeleton (`ai/docs/03-agents/04-loop-control.mdx:474-505`):

```ts
const messages: ModelMessage[] = [{ role: "user", content: "..." }];
let step = 0;
while (step < maxSteps) {
  const result = await generateText({ model, messages, tools });
  messages.push(...result.responseMessages);
  if (result.text) break; // stop when model generates text
  step++;
}
```

### 3. Merging several `streamText` results into ONE UI message stream — supported and documented

This is the load-bearing mechanism and it is a first-class, documented API.

```ts
declare function createUIMessageStream<UI_MESSAGE extends UIMessage>({
  execute,
  onError,
  originalMessages,
  onStepEnd,
  onEnd,
  generateId,
}: {
  execute: (options: { writer: UIMessageStreamWriter<UI_MESSAGE> }) => Promise<void> | void;
  onError?: (error: unknown) => string;
  originalMessages?: UI_MESSAGE[];
  onStepEnd?: UIMessageStreamOnStepEndCallback<UI_MESSAGE>;
  onEnd?: UIMessageStreamOnEndCallback<UI_MESSAGE>;
  generateId?: IdGenerator;
}): ReadableStream<InferUIMessageChunk<UI_MESSAGE>>;
```

(`ai/dist/index.d.ts:5907-5945`)

```ts
interface UIMessageStreamWriter<UI_MESSAGE extends UIMessage = UIMessage> {
  write(part: InferUIMessageChunk<UI_MESSAGE>): void;
  merge(stream: ReadableStream<InferUIMessageChunk<UI_MESSAGE>>): void;
  onError: ErrorHandler | undefined;
}
```

(`ai/dist/index.d.ts:5875-5891`) — `merge` is documented as "Merges the contents of another stream
to this stream", and `onError` exists specifically "for forwarding when merging streams".

**`result.toUIMessageStream()` is DEPRECATED in 7.0.58.** `ai/dist/index.d.ts:2771-2776`: "Use the
standalone `toUIMessageStream` helper from `'ai'` with `result.stream` instead. This method will be
removed in the next major release." Same for `toUIMessageStreamResponse`, `pipeUIMessageStreamToResponse`,
`toTextStreamResponse`. Use:

```ts
declare function toUIMessageStream<TOOLS extends ToolSet, UI_MESSAGE extends UIMessage>({
  stream,
  tools,
  sendReasoning,
  sendSources,
  sendStart,
  sendFinish,
  onError,
  messageMetadata,
  originalMessages,
  generateMessageId,
  onEnd,
}: {
  stream: ReadableStream<TextStreamPart<TOOLS>>;
  tools?: TOOLS;
} & UIMessageStreamOptions<UI_MESSAGE>): ReadableStream<InferUIMessageChunk<UI_MESSAGE>>;
```

(`ai/dist/index.d.ts:6021-6027`)

**Step boundaries.** Each `streamText` result's stream carries its own `start` → `start-step` …
`finish-step` → `finish` envelope. `toUIMessageChunk` passes `start-step`/`finish-step` through
unconditionally (`ai/src/ui-message-stream/to-ui-message-chunk.ts:335-341`) and gates
`start`/`finish` on `sendStart`/`sendFinish` (`:343,:358`, defaults `true`,
`src/ui-message-stream/to-ui-message-stream.ts:26-27`). The `sendFinish` JSDoc says verbatim: _"Set
to false if you are using additional `streamText` calls that send additional data"_; `sendStart`:
_"Set to false if you are using additional `streamText` calls and the message start event has
already been sent"_ (`ai/dist/index.d.ts:2531-2545`).

So the recipe for N results in one writer: `sendStart: i === 0`, `sendFinish: false` on all of them,
and `writer.write({ type: 'finish' })` once the owned loop decides the turn is over. Each merged
result still contributes its own `start-step`/`finish-step` pair — which is exactly what you want,
because that is what the client uses to delimit steps.

Documented examples of `writer.merge(toUIMessageStream({ stream: result.stream }))`:
`ai/docs/04-ai-sdk-ui/20-streaming-data.mdx:116`, `ai/docs/03-ai-sdk-core/15-tools-and-tool-calling.mdx:844`,
`ai/docs/07-reference/02-ai-sdk-ui/40-create-ui-message-stream.mdx:50`, and — with `sendStart: false`
— `ai/docs/04-ai-sdk-ui/03-chatbot-message-persistence.mdx:444-445`.

**Probe (executed, `scratchpad/probe/loop.mjs`).** An owned `while` loop, two `streamText` calls
against one `MockLanguageModelV4` (text step, then tool-call step), both merged into one
`createUIMessageStream` writer with `sendStart: i === 0, sendFinish: false`. Emitted chunk sequence:

```
start, start-step, text-start, text-delta, text-end, finish-step,
       start-step, tool-input-start, tool-input-delta, tool-input-available, finish-step,
finish
```

`model.doStreamCalls.length === 2`. One `start`, one `finish`, two step pairs — a single continuous
UI message.

**`lastAssistantMessageIsCompleteWithToolCalls` still behaves correctly.** Its implementation
(`ai/src/ui/last-assistant-message-is-complete-with-tool-calls.ts`) finds the index of the **last**
`step-start` part and requires that every non-`providerExecuted` tool part after it be in
`output-available` or `output-error`, with at least one such part. Multiple merged results produce
multiple `step-start` parts, so only the final step is examined — the desired semantics.
Probe (`scratchpad/probe/ui.mjs`, via `readUIMessageStream`): the merged stream yields parts
`["step-start","text","step-start","tool-draw"]`; the helper returns `false` before the tool output
is added and `true` after. Confirmed.

### 4. Client-side tools with an owned loop — the resume works

Flow, all confirmed:

1. **Declare** with `tool({ description, inputSchema })` and **no `execute`**
   (`ai/docs/04-ai-sdk-ui/03-chatbot-tool-usage.mdx:83-95`). `tool` is re-exported from
   `@ai-sdk/provider-utils` (`ai/dist/index.d.ts:7`).
2. **`streamText` emits** `tool-input-start` / `tool-input-delta` / `tool-call` on `result.stream`;
   `toUIMessageStream` maps these to `tool-input-start` / `tool-input-delta` / `tool-input-available`
   UI chunks (observed in the probe).
3. **`useChat`'s `onToolCall`** — `ChatOnToolCallCallback = (options: { toolCall: InferUIMessageToolCall<UI_MESSAGE> }) => void | PromiseLike<void>`
   (`ai/dist/index.d.ts:5414-5416`). Check `toolCall.dynamic` first for type narrowing; call
   `addToolOutput` **without `await`** to avoid deadlocks (`03-chatbot-tool-usage.mdx:113-121`).
4. **`addToolOutput`** — `ChatAddToolOutputFunction` (`ai/dist/index.d.ts:5381-5402`):
   `{ tool, toolCallId, options? } & ({ state?: 'output-available'; output } | { state: 'output-error'; errorText })`.
   `addToolResult` is the same function under the old name (`:5555-5557`).
5. **`sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls`** —
   `(options: { messages: UI_MESSAGE[] }) => boolean | PromiseLike<boolean>`, called "when the stream
   is finished or a tool call is added" (`ai/dist/index.d.ts:5474-5481`).

**`convertToModelMessages` resume verdict: YES, it produces exactly what is needed.**

```ts
declare function convertToModelMessages<UI_MESSAGE extends UIMessage>(
  messages: Array<Omit<UI_MESSAGE, 'id'>>,
  options?: {
    tools?: ToolSet;
    ignoreIncompleteToolCalls?: boolean;
    convertDataPart?: (part: DataUIPart<…>) => TextPart | FilePart | undefined;
  },
): Promise<ModelMessage[]>;
```

(`ai/dist/index.d.ts:5579-5583`) — **it is `async` in v7**; always `await` it.

Probe (`scratchpad/probe/resume.mjs`), input = assistant message with `step-start`, a `reasoning`
part carrying `providerMetadata.openai.{itemId, reasoningEncryptedContent}`, a `text` part, and a
`tool-draw` part in `state: 'output-available'`. Actual output:

```jsonc
[
  { "role": "user", "content": [{ "type": "text", "text": "draw a circle" }] },
  {
    "role": "assistant",
    "content": [
      {
        "type": "reasoning",
        "text": "I should draw.",
        "providerOptions": { "openai": { "itemId": "rs_123", "reasoningEncryptedContent": "ENC" } },
      },
      { "type": "text", "text": "Sure, drawing now." },
      {
        "type": "tool-call",
        "toolCallId": "call-1",
        "toolName": "draw",
        "input": { "shape": "circle" },
      },
    ],
  },
  {
    "role": "tool",
    "content": [
      {
        "type": "tool-result",
        "toolCallId": "call-1",
        "toolName": "draw",
        "output": { "type": "json", "value": { "ok": true, "elementId": "el_9" } },
      },
    ],
  },
]
```

Mechanics in `ai/src/ui/convert-to-model-messages.ts`: assistant parts are batched into blocks split
on `step-start` (`:407-421`) so each step becomes its own assistant/tool message pair; a tool part in
any state other than `input-streaming` emits a `tool-call` (`:203-220`); non-`providerExecuted` tool
parts in `output-available`/`output-error` emit a `tool-result` in a following `role: 'tool'` message
(`:349-378`).

Caveats:

- **Pass `tools`.** `options.tools` feeds `createToolModelOutput`, which uses the tool's
  `toModelOutput` (if any) to shape the result; without it you get the default JSON wrapping
  (`:361-372`). Harmless for plain-JSON canvas results, wrong if you ever add `toModelOutput`.
- **`ignoreIncompleteToolCalls: true`** (default `false`) pre-filters tool parts not in
  `approval-responded` / `output-available` / `output-error` / `output-denied` (`:58-69`). Useful for
  regenerate-after-abort; do **not** enable it on the normal resume path or you would silently drop
  the very tool call you are resuming.
- `input-streaming` parts are dropped entirely; a call aborted mid-input-stream leaves no orphan.

### 5. Reasoning across a replayed history — the previously-identified risk is **resolved**, with conditions

**Which API.** `openai('gpt-5.4-mini')` hits the **Responses API by default**.
`aiopenai/package/src/openai-provider.ts:298-320`: the callable provider → `createLanguageModel` →
`createResponsesModel` → `OpenAIResponsesBatchLanguageModel`. Configurable: `openai.chat(id)` gives
Chat Completions, `openai.responses(id)` is explicit. The docs say so too
(`aiopenai/package/docs/03-openai.mdx:41-45`): "The default OpenAI model factory (`openai('model-id')`)
uses the Responses API." `'gpt-5.4-mini'` and `'gpt-5.4-mini-2026-03-17'` are literals in
`OpenAIResponsesModelId` (`aiopenai/package/dist/index.d.ts:1348`).

**Reasoning survives a `UIMessage[]` round-trip.** Reasoning provider metadata is written into the
UI chunks (`ai/src/ui-message-stream/to-ui-message-chunk.ts:91-118` — `reasoning-start`,
`reasoning-delta`, `reasoning-end` all forward `providerMetadata`), stored on the client's reasoning
part (`ai/src/ui/process-ui-message-stream.ts:509-527`), and converted back to
`{ type: 'reasoning', providerOptions }` by `convertToModelMessages`
(`ai/src/ui/convert-to-model-messages.ts:196-202`) — verified in the probe above.

**What the provider does with it** (`aiopenai/package/src/responses/convert-to-openai-responses-input.ts:746-846`):

- `store: true` (the API default) **and** an `itemId` ⇒ the reasoning is sent as
  `{ type: 'item_reference', id: itemId }` — server-side item persistence carries the actual content.
- `store: false` and an `itemId` ⇒ a full `{ type: 'reasoning', id, encrypted_content, summary }` item.
- No `itemId` but `reasoningEncryptedContent` present ⇒ `{ type: 'reasoning', encrypted_content, summary }`
  with no id (`:812-836`) — explicitly to "enable multi-turn reasoning even when server-side item
  persistence is not used or when `itemId` has been stripped".
- Neither ⇒ warning `"Non-OpenAI reasoning parts are not supported. Skipping reasoning part"` (`:840-843`).
- `conversation` or `previousResponseId` set **and** `itemId` present ⇒ reasoning items are **skipped**
  on input, because the server already has them (`:755-760`, flag threaded at `:112`).
- Belt-and-braces: with `store: false`, any remaining reasoning item lacking `encrypted_content` is
  filtered out with the warning "Reasoning parts without encrypted content are not supported when
  store is false" (`:1279-1300`).

**Provider options exist for all three knobs**, under `providerOptions.openai`
(`aiopenai/package/dist/index.d.ts:1349-1387`, `openaiLanguageModelResponsesOptionsSchema`):
`store`, `previousResponseId`, `conversation`, `include` (which accepts
`'reasoning.encrypted_content'`), `reasoningEffort`, `reasoningSummary`, `reasoningMode`,
`reasoningContext`, `promptCacheKey`, `promptCacheRetention`, `contextManagement` (server-side
compaction), `truncation`, `serviceTier`, `strictJsonSchema`, `instructions`, `maxToolCalls`.
`conversation` and `previousResponseId` are mutually exclusive
(`src/responses/openai-responses-language-model.ts:298-303`). Typed as
`OpenAILanguageModelResponsesOptions`; reasoning metadata typed as
`OpenaiResponsesReasoningProviderMetadata` (`dist/index.d.ts:1694-1700`:
`{ openai: { itemId: string; reasoningEncryptedContent?: string | null } }`).

**Auto-behaviour worth knowing:** when `store === false` **and** the model is a reasoning model, the
provider automatically adds `'reasoning.encrypted_content'` to `include`
(`src/responses/openai-responses-language-model.ts:420-425`). `store` is otherwise left unset and
defaults to `true` server-side (`:421`, and `docs/03-openai.mdx:154-156`).

**Recommendation for this architecture (stateless resume, replayed `UIMessage[]`):** set
`providerOptions: { openai: { store: false } }`. Encrypted reasoning is then requested
automatically, round-trips through the browser inside the UI message, and is replayed verbatim — no
dependence on server-side item retention across the browser hop, and no `previousResponseId` to
thread through a stateless request. If instead you leave `store` at its default `true` and rely on
`item_reference`, correctness depends on OpenAI still holding those items; that is the residual risk
and it is now avoidable. Not verified: whether `store: false` + encrypted content behaves identically
on `gpt-5.4-mini` specifically — no live API call was made.

### 6. `tool({ strict: true })` — still present, still maps to OpenAI strict

- `@ai-sdk/provider-utils@5.0.25` `dist/index.d.ts:1915-1921` — `strict?: boolean` on
  `BaseFunctionTool`: "Providers that support strict mode will use this setting to determine how the
  input should be generated. Strict mode will always produce valid inputs, but it might limit what
  input schemas are supported." (`:1963` — `strict?: never` on provider-defined tools.)
- `@ai-sdk/openai@4.0.36` `src/responses/openai-responses-prepare-tools.ts:436` —
  `...(tool.strict != null ? { strict: tool.strict } : {})`, i.e. passed straight through to the
  Responses API function-tool definition.

**The `union`-not-`discriminatedUnion` constraint still applies.** Probed with zod `4.4.3` +
`asSchema` from `@ai-sdk/provider-utils` (`scratchpad/probe/z.mjs`):

- `z.discriminatedUnion('kind', […])` → `{"oneOf": [...]}`
- `z.union([…])` → `{"anyOf": [...]}`

OpenAI strict structured outputs accept `anyOf` and reject `oneOf`, so `z.union` remains the correct
choice. **Not verified from a primary AI SDK source:** the `oneOf` rejection is OpenAI platform
behaviour, not something the AI SDK documents or validates — no live API call was made to confirm it
on `gpt-5.4-mini`. What _is_ verified here is only the JSON Schema each Zod combinator produces
through this exact code path.

### 7. Deterministic testing of an owned loop — fully supported

`ai/test` exports (`ai/dist/test/index.d.ts`, `ai/docs/03-ai-sdk-core/55-testing.mdx:11-19`):
`MockLanguageModelV4`, `MockLanguageModelV3`, `MockEmbeddingModelV4/V3`, `MockImageModelV4/V3`,
`mockId`, `mockValues`, plus re-exports `convertArrayToAsyncIterable`,
`convertArrayToReadableStream`, `convertReadableStreamToArray`. `simulateReadableStream` is imported
from **`'ai'`**, not `'ai/test'`.

```ts
declare class MockLanguageModelV4 implements LanguageModelV4 {
  readonly specificationVersion = "v4";
  doGenerateCalls: LanguageModelV4CallOptions[];
  doStreamCalls: LanguageModelV4CallOptions[];
  constructor({ provider, modelId, supportedUrls, doGenerate, doStream }?: {
    provider?: string; modelId?: string;
    supportedUrls?: …;
    doGenerate?: LanguageModelV4['doGenerate'] | LanguageModelV4GenerateResult | LanguageModelV4GenerateResult[];
    doStream?:   LanguageModelV4['doStream']   | LanguageModelV4StreamResult   | LanguageModelV4StreamResult[];
  });
}
```

(`ai/dist/test/index.d.ts`)

**The array form is the answer to "script a sequence across multiple successive `streamText` calls".**
`doStream` accepts `LanguageModelV4StreamResult[]`, consumed one entry per call. Verified: the
`loop.mjs` probe passed `doStream: [textStep(…), toolStep(…)]` to a **single** model instance,
called `streamText` twice inside the owned `while`, and got the two scripted responses in order with
`model.doStreamCalls.length === 2`. `doStreamCalls` / `doGenerateCalls` also let you assert on the
exact prompt each iteration sent — which is how you test compaction, budget trimming, and history
assembly.

```ts
declare function simulateReadableStream<T>({
  chunks,
  initialDelayInMs,
  chunkDelayInMs,
}: {
  chunks: T[];
  initialDelayInMs?: number | null;
  chunkDelayInMs?: number | null;
}): ReadableStream<T>;
```

(`ai/dist/test/index.d.ts`) — `null` skips the delay entirely (distinct from `0`).

**Gotcha discovered the hard way in the probe:** in the V4 spec the stream `finish` part's
`finishReason` is an **object**, not a string —
`{ type: 'finish', usage, finishReason: LanguageModelV4FinishReason }` where
`LanguageModelV4FinishReason = { unified: 'stop' | 'length' | 'content-filter' | 'tool-calls' | …; raw?: string }`
(`@ai-sdk/provider@4.0.7` `dist/index.d.ts:2536,2721-2724`). Writing `finishReason: 'stop'` silently
yields `result.finishReason === 'other'` — no error, just a wrong answer, which would quietly break
an owned loop's termination test. The docs' samples use the correct
`finishReason: { unified: 'stop', raw: undefined }` (`ai/docs/03-ai-sdk-core/55-testing.mdx:38,76`).
Note also that the doc samples' `usage` uses the nested v7 shape
(`inputTokens: { total, noCache, cacheRead, cacheWrite }`, `outputTokens: { total, text, reasoning }`).

**Documented pattern for testing multi-step/agentic code with mocks:** the testing page covers
`generateText`, `streamText`, both with `Output`, and simulating a raw UI-message-stream SSE
response — but there is **no worked example of testing a multi-step or manual loop**. The array form
of `doStream`/`doGenerate` is documented only in the type signature, not in prose. It works (probed);
it is just not showcased. `readUIMessageStream({ stream })` (`ai/docs/04-ai-sdk-ui/24-reading-ui-message-streams.mdx`)
is the missing half: it reconstructs client-side `UIMessage`s from a server stream, which is how you
assert on merged step boundaries without a browser — that is what `ui.mjs` did above.

### 8. Versions and peers (npm, 2026-08-09)

| Package          | Version    | Peers / engines                                                                                                                                                      |
| ---------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ai`             | **7.0.58** | peer `zod: ^3.25.76 \|\| ^4.1.8`; `engines.node >= 22`; `"type": "module"`; deps `@ai-sdk/provider@4.0.7`, `@ai-sdk/provider-utils@5.0.25`, `@ai-sdk/gateway@4.0.46` |
| `@ai-sdk/openai` | **4.0.36** | peer `zod: ^3.25.76 \|\| ^4.1.8`; `engines.node >= 22`; ESM                                                                                                          |
| `@ai-sdk/react`  | **4.0.61** | peer `react: ^18 \|\| ~19.0.1 \|\| ~19.1.2 \|\| ^19.2.1`; `engines.node >= 22`; ESM; deps pin `ai@7.0.58` exactly                                                    |

- **React 19.2.8 satisfies `^19.2.1`.** OK.
- `@ai-sdk/react` pins `ai` to the **exact** version `7.0.58` — the two must be bumped together, and
  a mismatched `ai` in the workspace will produce a duplicate install.
- Node 24 ≥ 22. OK. All three packages are ESM-only (`"type": "module"`), which matches the repo.
- Zod: any `^4.1.8` works; the probe ran `zod@4.4.3`.

### 9. Not verified

- **No live OpenAI API call was made.** Everything about `gpt-5.4-mini`'s actual behaviour —
  reasoning replay under `store: false`, `oneOf` rejection under `strict: true`, whether encrypted
  reasoning survives a browser round-trip in practice — is inferred from provider source plus
  OpenAI's documented contract, not observed end to end.
- The `oneOf`-vs-`anyOf` rejection itself is **not** documented by the AI SDK; only the JSON Schema
  each Zod combinator emits was verified.
- `ai-sdk.dev` was consulted for two pages only (`/docs/agents/loop-control`,
  `/docs/reference/ai-sdk-core/stream-text`); the rest of the doc citations are the `.mdx` sources
  vendored in the `ai` and `@ai-sdk/openai` tarballs. Those are the files the site is built from, but
  a site-side edit newer than the published tarball would not show up here.
- **The `streamText` `stopWhen` default of `isStepCount(1)` appears only in typings/source JSDoc**;
  the ai-sdk.dev `streamText` reference page documents no default and no description for `stopWhen`.
  Live docs confirm only the `ToolLoopAgent` default of `isStepCount(20)`.
- Interaction of `createUIMessageStream`'s `onStepEnd` / `originalMessages` persistence mode with
  **merged** multi-result streams was not probed — only the chunk sequence and
  `lastAssistantMessageIsCompleteWithToolCalls` were.
- No probe of an actual `useChat` in a browser; the client-side half was verified via
  `readUIMessageStream` and by reading `@ai-sdk/react@4.0.61` typings.
- Abort/error semantics of `writer.merge` when one merged result throws mid-stream were not
  exercised; the typings note `UIMessageStreamWriter.onError` exists "for forwarding when merging
  streams to prevent duplicated error masking", which implies care is needed there.

---

## Addendum 2026-08-14a — the reasoning question is now answered

This document twice concludes that the reasoning question could not be settled by reading:
"whether reasoning survives that round-trip is a property of `@ai-sdk/openai`'s
`ModelMessage`↔provider mapping, which this repo neither configures nor tests… the `store: false` +
stateless-resume + dropped-reasoning question remains unverified and still needs the
smallest-possible script," and open question 7, "Reasoning-item replay requirements… **verify before
building**."

**Both are now closed.** The smallest-possible script was written and run for
[#5](https://github.com/m0t0r/drawing-agent/issues/5). Reasoning does survive: with `store: false`
the provider requests encrypted reasoning content unprompted and replays it verbatim on every fresh
request, including where a reasoning item sits between a tool call and its tool result. The decision
is [ADR-0001](../adr/0001-stateless-resume-carries-encrypted-reasoning.md); the provider-source
reading behind it is [`reasoning-across-stateless-resume.md`](reasoning-across-stateless-resume.md).

Manual replay, not `previous_response_id`, is therefore the right choice — which is what open
question 7 said this would decide.
