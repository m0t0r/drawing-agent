# Reasoning across a stateless resume

**Date:** 2026-08-14
**Scope:** How `@ai-sdk/openai`'s Responses-API language model and `ai`'s `convertToModelMessages` carry
reasoning content across a **stateless resume** — the pattern this repo settled on, where a client-side
tool result arrives as a fresh HTTP request carrying the full message history and no provider-side
conversation state.
**Out of scope:** `previousResponseId` / `conversation` (provider-side state) as an architecture — they
appear only where they change the code path. Chat Completions. Anthropic's `thinking` blocks.

**Sources.** Everything cited as `file:line` was read from the installed packages in the throwaway
workspace built for [#5](https://github.com/m0t0r/drawing-agent/issues/5) (since deleted — the spike
was never production code), pinned at **`@ai-sdk/openai@4.0.41`** and
**`ai@7.0.65`**. Both ship a single bundled `dist/index.js` (there is no `index.mjs`); the `.d.ts` is
cited where the public type matters. Paths below are abbreviated to
`@ai-sdk/openai/dist/index.js:NNNN` and `ai/dist/index.js:NNNN`. Doc claims carry a URL.

---

## Summary

- **`store: false` does exactly one thing to reasoning on the request side: it flips the input encoding
  from `item_reference` stubs to inlined items, and — for a model the provider classifies as a reasoning
  model — it auto-adds `include: ['reasoning.encrypted_content']`.** The condition is four lines long and
  is verified below. You do not write the `include` yourself.
- **Encrypted reasoning is surfaced to the caller** as
  `providerMetadata.openai.reasoningEncryptedContent` on every reasoning part, alongside
  `providerMetadata.openai.itemId`, on both the generate and the stream path.
- **It is replayed verbatim.** The Responses input converter reads the same
  `reasoningEncryptedContent` back out of `providerOptions.openai` and writes it into the request as
  `{ type: 'reasoning', id, encrypted_content, summary }`. The round-trip is symmetric by construction —
  one Zod schema (`openaiResponsesReasoningProviderOptionsSchema`) defines both directions.
- **`convertToModelMessages` preserves reasoning parts unconditionally.** No last-message filter, no
  "must be followed by text" rule, no drop. It copies `providerMetadata` → `providerOptions` verbatim and
  keeps stream order. The only thing that can remove a reasoning part is `ignoreIncompleteToolCalls`, and
  that only touches tool parts.
- **Ordering across a tool boundary survives**, because `step-start` parts split the assistant UI message
  into one model message per step and content parts are emitted in stream order. A step that produced
  reasoning + a tool call becomes `assistant[reasoning, tool-call]` followed by `tool[tool-result]` — the
  shape OpenAI's own guide asks for.
- **An `id` is not required** on a replayed reasoning item, but encrypted content effectively is. The
  provider carries `id` when it has one and drops it when it doesn't; a reasoning part with **neither**
  `itemId` nor encrypted content is discarded with a warning, and a final sweep strips any reasoning item
  that still has no `encrypted_content` when `store` is false. That sweep is the guard against the
  much-reported `Item 'rs_…' of type 'reasoning' was provided without its required following item`.
- **One caveat on "automatically":** the auto-`include` is gated on the provider _recognising the model as
  a reasoning model_. It does recognise `gpt-5.4-mini` — the spike observed the `include` on the wire — but
  a future model id the provider does not classify would silently lose the header. Per OpenAI's current
  docs the `include` is in any case no longer strictly necessary, since stateless responses return
  `encrypted_content` by default. Both facts are belt-and-braces in our favour; neither changes the
  recommendation.

---

## 1. What `store: false` does

### 1.1 The `include` trigger — verified

`@ai-sdk/openai/dist/index.js:6220-6223`, inside the Responses model's `getArgs`:

```js
const store = openaiOptions?.store;
if (store === false && isReasoningModel) {
  addInclude("reasoning.encrypted_content");
}
```

(`addInclude` is a local helper at `:6197-6203` that seeds or appends to the user-supplied
`include` array without duplicating.)

Three things follow from the literal `store === false`:

- **`undefined` does not trigger it.** Omitting the option leaves `store` undefined, the key is dropped
  from the JSON body, and OpenAI's own default (`true`) applies. You must pass `store: false`
  explicitly.
- **`isReasoningModel` gates it.** Resolved at `:6138` as
  `openaiOptions?.forceReasoning ?? modelCapabilities.isReasoningModel`, where the capability comes from
  a heuristic over the model id at `:53`:
  `oSeriesVersion != null || (gptVersion != null && gptVersion.major >= 5 && !isGptChatModel)`.
  `gpt-5.4-mini` — this repo's model — is also enumerated explicitly in
  `openaiResponsesReasoningModelIds` (`:5386`). A model id the heuristic doesn't recognise gets **no**
  auto-`include`; `forceReasoning: true` is the escape hatch.
- **The provider considers this its own job.** The `include` option's own doc comment says so
  (`:5441-5442`):

  ```js
  z27.enum([
    "reasoning.encrypted_content",
    // handled internally by default, only needed for unknown reasoning models
  ```

`include` is then placed on the request body at `:6256`, next to `previous_response_id` (`:6251`),
`store` (`:6252`) and `service_tier` (`:6255`).

### 1.2 The second, larger effect: input encoding

`store` is also threaded into the prompt→input converter, defaulting to `true` there
(`:6184`: `store: openaiOptions?.store ?? true`). Inside `convertToOpenAIResponsesInput` it selects
between two entirely different encodings of prior assistant content:

| Part                          | `store: true` (default)                         | `store: false`                                                             |
| ----------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------- |
| assistant text                | `{ type: 'item_reference', id }` (`:4625-4628`) | full `{ role:'assistant', content:[output_text], id }` (`:4629-4634`)      |
| reasoning                     | `{ type: 'item_reference', id }` (`:4919-4927`) | full `{ type:'reasoning', id, encrypted_content, summary }` (`:4941-4948`) |
| provider-executed tool result | `{ type: 'item_reference', id }` (`:4896-4898`) | **dropped**, with a warning (`:4899-4904`)                                 |

That last row is a genuine `store: false` cost — `"Results for OpenAI tool ${part.toolName} are not sent
to the API when store is false"` — but it applies only to _provider-executed_ tools (web search, code
interpreter, …). This repo has none: all four canvas tools are client-side, and client tool results
travel as ordinary `function_call_output` items (`:5315-5320`), untouched by `store`.

Ordinary client-side `function_call` items are pushed with `call_id`, `name` and `arguments` and
**no `id`** (`:4813-4822`), so they are self-contained in both modes.

### 1.3 Interaction with `previousResponseId` / `conversation`

If either is set, reasoning parts that carry an `itemId` are **skipped entirely** —
`@ai-sdk/openai/dist/index.js:4913-4916`:

```js
const reasoningId = providerOptions2?.itemId;
if ((hasConversation || hasPreviousResponseId) && reasoningId != null) {
  break;
}
```

The provider assumes the server still holds them. Combining `store: false` with `previousResponseId` is
therefore incoherent: the auto-`include` fires, the encrypted content comes back, and then the converter
throws it away. **Do not set both.** Our design sets neither `previousResponseId` nor `conversation`,
which is the only configuration in which the `store: false` reasoning path is fully exercised.

---

## 2. Is encrypted reasoning surfaced, and replayed?

### 2.1 Surfaced — yes, on both paths

One schema defines the shape in both directions (`@ai-sdk/openai/dist/index.js:5343-5346`):

```js
var openaiResponsesReasoningProviderOptionsSchema = z26.object({
  itemId: z26.string().nullish(),
  reasoningEncryptedContent: z26.string().nullish(),
});
```

and it is a public type — `@ai-sdk/openai/dist/index.d.ts:1684-1690`:

```ts
type ResponsesReasoningProviderMetadata = {
  itemId: string;
  reasoningEncryptedContent?: string | null;
};
type OpenaiResponsesReasoningProviderMetadata = {
  openai: ResponsesReasoningProviderMetadata;
};
```

**`doGenerate`** (`:6429-6446`) emits one `reasoning` content part per summary entry, each carrying
`{ itemId: part.id, reasoningEncryptedContent: part.encrypted_content ?? null }`. Note `:6430-6432`: if
the item has **no** summary at all, an empty `summary_text` is synthesised so the encrypted content still
gets a part to ride on. That matters — see §2.4.

**`doStream`** spreads the same metadata across three chunk types:

- `reasoning-start`, emitted on `response.output_item.added` (`:7200-7215`), with the
  `encrypted_content` as it stands at that moment — normally `null`.
- `reasoning-delta`, emitted on `response.reasoning_summary_text.delta` (`:7813-7827`), carrying **only**
  `{ itemId }` — no `reasoningEncryptedContent` key.
- `reasoning-end`, emitted on `response.output_item.done` (`:7624-7648`), carrying the real
  `encrypted_content`.

This staging is load-bearing because `ai` **replaces** rather than merges the metadata on each chunk
(`ai/dist/index.js:7058` for delta, `:7070` for end; and `:9184`/`:9198` on the `streamText` recording
path). A mid-stream read of a reasoning part will show `reasoningEncryptedContent` absent; the value is
only correct once `reasoning-end` has landed. Anything that snapshots reasoning parts before the stream
finishes will silently lose the encrypted content.

### 2.2 Over the wire to the browser

`sendReasoning` defaults to **`true`** on both `toUIMessageChunk` and `toUIMessageStream`
(`ai/dist/index.js:7550`, `:7805`), and all three reasoning chunk types forward `providerMetadata` when
present (`:7590-7610`). The UI chunk schema declares `providerMetadata` on each
(`ai/dist/index.js:6651-6666`), so it survives validation.

Client-side, `processUIMessageStream` builds the `reasoning` UI part on `reasoning-start` with the
chunk's metadata (`:7035-7047`), overwrites it on each delta (`:7048-7061`) and overwrites it once more
on `reasoning-end` (`:7062-7076`). The persisted UI part therefore ends up with the `reasoning-end`
metadata — the one that has the encrypted content.

When those messages are posted back, `uiMessagesSchema` accepts `providerMetadata` on the `reasoning`
part (`ai/dist/index.js:11080-11086`), so `validateUIMessages` does not strip it.

### 2.3 Replayed — yes, verbatim

`@ai-sdk/openai/dist/index.js:4907-4977` is the reasoning branch of the assistant converter. Under
`store: false` with an `itemId` present (`:4941-4948`):

```js
if (reasoningMessage === void 0) {
  reasoningMessages[reasoningId] = {
    type: "reasoning",
    id: reasoningId,
    encrypted_content: providerOptions2?.reasoningEncryptedContent,
    summary: summaryParts,
  };
  input.push(reasoningMessages[reasoningId]);
}
```

The string is passed through untouched. `summaryParts` is `[{ type:'summary_text', text: part.text }]`
when the reasoning part has text, and `[]` when it doesn't (`:4929-4934`).

Two nuances in the same branch:

- **Merging by `itemId`.** `reasoningMessages` is a per-assistant-message map (`:4615`). A second
  reasoning part with the same `itemId` does **not** push a second item; its summary text is appended to
  the already-pushed one and any non-null encrypted content overwrites the old (`:4949-4954`). Since
  OpenAI emits one reasoning item id per step, and `convertToModelMessages` splits steps into separate
  assistant messages (§3), this is a no-op for us. It would matter if step boundaries were ever lost.
- **No `itemId` at all** (`:4956-4976`): if encrypted content is present the item is pushed _without_ an
  `id`; if it isn't, the part is dropped with
  `"Non-OpenAI reasoning parts are not supported. Skipping reasoning part: …"`.

### 2.4 What if the model returns no reasoning summary?

The `reasoning` request parameter is only sent when `reasoningEffort` / `reasoningSummary` /
`reasoningMode` / `reasoningContext` is set (`:6271-6287`), and `reasoningSummary` defaults to
`"detailed"` **only when `reasoningEffort` is explicitly set** (`:6137`). Set neither and you get
reasoning items with an empty `summary` array.

That is still fine end-to-end: `doGenerate` synthesises an empty summary part (`:6430-6432`) and the
stream path emits `reasoning-start`/`reasoning-end` off the `output_item` events regardless of whether
any summary text streamed (`:7200-7215`, `:7624-7648`). So a zero-length reasoning UI part is created,
it carries the encrypted content, `convertToModelMessages` keeps it (there is no empty-text filter —
`isReasoningUIPart` is just `part.type === 'reasoning'`, `ai/dist/index.js:6767-6769`), and the converter
replays it with `summary: []`. **Encrypted reasoning does not depend on asking for summaries.**

---

## 3. `convertToModelMessages` and reasoning parts

`ai/dist/index.js:10786-11051`. The assistant branch:

**It preserves them, with metadata** (`:10889-10894`):

```js
} else if (isReasoningUIPart(part)) {
  content.push({
    type: "reasoning",
    text: part.text,
    providerOptions: part.providerMetadata
  });
}
```

Note this is an unconditional assignment, not a spread-if-present — reasoning is the one part type whose
`providerOptions` is always set, even to `undefined`. Nothing downstream cares.

**It never drops them conditionally.** Grepping the whole function: the only filter is
`ignoreIncompleteToolCalls` (`:10788-10795`), which filters `isToolUIPart` parts by state and leaves
everything else alone. There is no last-assistant-message restriction, no "reasoning must be followed by
text" rule, and no dedupe. (`CONTEXT.md` already records that this path must not be given
`ignoreIncompleteToolCalls`; that is about tool calls, and is unrelated to reasoning.)

**Order is stream order.** The part loop (`:11029-11035`) pushes every content part into a `block` in
array order and flushes the block on `step-start`:

```js
for (const part of message.parts) {
  if (isCustomContentUIPart(part) || isTextUIPart(part) || isReasoningUIPart(part) || … ) {
    block.push(part);
  } else if (part.type === "step-start") {
    await processBlock();
  }
}
await processBlock();
```

`processBlock` emits **one `assistant` model message** with the block's content in order (`:10945-10950`),
then **one `tool` model message** with the results of the block's non-provider-executed tool calls
(`:10957-11026`). `start-step` chunks become `step-start` UI parts (`ai/dist/index.js:7358-7360`,
`:7761-7763`), and our loop emits one per step.

---

## 4. Reasoning between a tool call and its result

The concrete case: step 1 emits reasoning + a `queryCanvas` call, the turn suspends, the browser fulfils
it, and a fresh stateless request arrives carrying the whole history.

**The UI message** looks like
`[step-start, reasoning, tool-queryCanvas(output-available)]`.

**`convertToModelMessages`** turns that into two model messages, in this order:

1. `{ role: 'assistant', content: [ {type:'reasoning', text, providerOptions}, {type:'tool-call', …} ] }`
2. `{ role: 'tool', content: [ {type:'tool-result', toolCallId, output} ] }`

**The Responses converter** walks the assistant content in order (`@ai-sdk/openai/dist/index.js:4616`)
and pushes the reasoning item (`:4948`) before the `function_call` item (`:4813-4822`), then the `tool`
message becomes a `function_call_output` (`:5315-5320`). The resulting `input` array is:

```jsonc
{ "type": "reasoning", "id": "rs_…", "encrypted_content": "…", "summary": [] }
{ "type": "function_call", "call_id": "call_…", "name": "queryCanvas", "arguments": "{…}" }
{ "type": "function_call_output", "call_id": "call_…", "output": "…" }
```

**Ordering survives, and this is the shape OpenAI asks for.** Its reasoning guide
(<https://developers.openai.com/api/docs/guides/reasoning>) says: _"we highly recommend you pass back any
reasoning items returned with the last function call (in addition to the output of your function)"_, and
_"If the model calls multiple functions consecutively, you should pass back all reasoning items, function
call items, and function call output items, since the last `user` message."_ Its context-optimisation
note is the operative constraint: _"just ensure all items between the last user message and your function
call output are passed into the next response untouched."_

**Is an `id` required?** No. Three cases, all in the same branch:

| Reasoning part carries                 | Emitted as                                                                        |
| -------------------------------------- | --------------------------------------------------------------------------------- |
| `itemId` + `reasoningEncryptedContent` | `{ type:'reasoning', id, encrypted_content, summary }` (`:4941-4948`)             |
| `reasoningEncryptedContent` only       | `{ type:'reasoning', encrypted_content, summary }` — no `id` (`:4966-4970`)       |
| neither                                | dropped, warning `"Non-OpenAI reasoning parts are not supported…"` (`:4971-4976`) |

Encrypted content is the load-bearing field, not the id. And a fourth case is caught by a sweep after the
whole prompt is converted (`:5330-5340`):

```js
if (
  !store &&
  input.some(
    (item) => "type" in item && item.type === "reasoning" && item.encrypted_content == null,
  )
) {
  warnings.push({
    type: "other",
    message:
      "Reasoning parts without encrypted content are not supported when store is false. Skipping reasoning parts.",
  });
  input = input.filter(
    (item) => !("type" in item) || item.type !== "reasoning" || item.encrypted_content != null,
  );
}
```

So an `itemId` that arrived with a null `encrypted_content` — exactly what a mid-stream snapshot or a
non-reasoning-model response would produce — is stripped rather than sent. **This is the provider's
safety net, and it fails silently into a `warning`, not an error.** Surfacing `result.warnings` is
therefore the cheapest possible canary that reasoning is not actually surviving the resume.

---

## 5. Failure modes

### 5.1 The error everyone hits

`Item 'rs_…' of type 'reasoning' was provided without its required following item.` — an
`invalid_request_error` from the Responses API. It fires when a `reasoning` item in `input` is not
immediately followed by the `message` or `function_call` item it belongs to. The sibling error, from the
other direction, is `'function_call' was provided without its required 'reasoning' item`.

Both are well documented on OpenAI's forum rather than in the API reference:

- <https://community.openai.com/t/how-to-solve-badrequesterror-400-item-rs-of-type-reasoning-was-provided-without-its-required-following-item/1151686>
- <https://community.openai.com/t/responses-api-error-with-type-reasoning-provided-without-its-required-following-item/1280238>
- <https://community.openai.com/t/responses-api-invalid-request-error-function-call-was-provided-without-its-required-reasoning-item/1236046>

The AI SDK's own instance was <https://github.com/vercel/ai/issues/7099> ("Item 'rs_…' of type 'reasoning'
was provided without its required following item"), reported against `ai@5.0.0-beta.7` /
`@ai-sdk/openai@2.0.0-beta.5`, closed as merged. The version under test here is three majors later and
contains the pairing logic described above.

**How this bites a stateless resume, in decreasing likelihood:**

1. **Reasoning kept, tool call dropped.** Anything that persists or replays only part of an assistant
   message — a history-compaction pass, a hand-rolled message store, a client that filters UI parts
   before posting — can orphan a reasoning item. Our design posts the whole client-held history, so this
   is a risk only if compaction (currently deferred, per `CONTEXT.md`) ever lands.
2. **Tool call kept, reasoning dropped.** The mirror image, and the one `store: false` makes easy to
   trip: set `sendReasoning: false`, or strip `providerMetadata` anywhere in the client round-trip, and
   the `function_call` arrives without its reasoning.
3. **A trailing reasoning item.** A reasoning item that ends the `input` array with nothing after it. The
   converter cannot produce this from a well-formed turn — reasoning is always followed by the step's
   text or tool call — but a truncated/aborted stream persisted to history could.

### 5.2 Does the API reject reasoning items with `store: false` and no encrypted content?

**Not verified — and in the SDK path it cannot arise**, because of the `:5330-5340` sweep. The item is
removed client-side before the request is built. What OpenAI would do with such an item if you sent it
raw is untested here; the provider's own warning text asserts it is "not supported".

### 5.3 `previous_response_id`

Covered in §1.3: setting it makes the converter skip every reasoning part that has an `itemId`
(`:4913-4916`), which is the opposite of what `store: false` is for. It also changes tool-call encoding
(`:4697-4699`). Treat `store: false` and `previousResponseId` as mutually exclusive.

### 5.4 `serviceTier`

Checked because it sits adjacent in the request builder (`:6255`). It is orthogonal to `store` and to
reasoning; the only logic attached to it is two capability warnings that delete `service_tier` from the
body for unsupported models (`:6337-6351`). No interaction.

### 5.5 Cost note

Under `store: true` the provider sends `item_reference` stubs and OpenAI holds the transcript, which is
what makes prompt caching effective. Under `store: false` the full transcript — encrypted reasoning
blobs included — is re-uploaded every step. `promptCacheKey` (`:6257`) exists to claw some of that back
and is worth trying if turn latency becomes a problem. **Unmeasured.**

---

## 6. What this means for this repo

`CONTEXT.md` records the decision as _"Reasoning survives via `store: false`. The provider then
automatically requests encrypted reasoning content and replays it verbatim through the browser."_ That
holds, with three refinements worth writing down:

1. **`store: false` must be explicit**, and the model must be one the provider classifies as a reasoning
   model. `gpt-5.4-mini` is (`:5386`), so no `forceReasoning` is needed today; a model-id change is the
   thing that would silently switch the auto-`include` off.
2. **`sendReasoning` must stay at its default `true`**, and nothing between the route handler and the
   browser may strip `providerMetadata` from reasoning parts. That metadata _is_ the mechanism.
3. **Surface `warnings`.** The three failure paths (`:4899-4904`, `:4971-4976`, `:5330-5340`) all
   degrade to a warning. If reasoning is quietly not surviving, that array is where it says so first, and
   a loop that discards it will never find out.

Worth one assertion in the loop tests: convert a two-step history through `convertToModelMessages` and
assert the reasoning part's `providerOptions.openai.reasoningEncryptedContent` is a non-empty string and
that it precedes the `tool-call` in the same assistant message. That is checkable with
`MockLanguageModelV4` and no network.

---

## Settled by the live spike

The throwaway spike for [#5](https://github.com/m0t0r/drawing-agent/issues/5) ran five real
`gpt-5.4-mini` turns and closed the first three of these. See
[ADR-0001](../adr/0001-stateless-resume-carries-encrypted-reasoning.md) for the observations.

1. **The end-to-end claim holds.** Three chained stateless resumes, a client-side tool with no
   `execute`, `store: false`. Reasoning came back with `itemId` and `reasoningEncryptedContent` on every
   step, was replayed verbatim as a `reasoning` input item, and the provider neither errored nor warned
   — `result.warnings` was empty throughout.
2. **The auto-`include` is on the wire.** The captured request body carried
   `include: ["reasoning.encrypted_content"]` on every request, so the provider does classify
   `gpt-5.4-mini` as a reasoning model. Whether the API would have returned encrypted content without it
   was not tested — the provider always sends it, so the question is moot in practice.
3. **Replayed `rs_…` ids are accepted** under `store: false`. Every replayed reasoning item carried its
   original `id` and none was rejected.
4. **Multi-summary reasoning items behave as read.** One step returned two reasoning parts sharing one
   `itemId`; the converter merged them back into a single item with a two-entry `summary`, and the API
   accepted it.

Also observed, and not something source reading predicted: `convertToModelMessages` only interleaves
tool results with their calls if the assistant UI message carries `step-start` parts. Without them it
emits every assistant part first and every tool result after. **The API accepted that malformed order
without error or warning** — which makes it exactly the kind of silent degradation §6.3 warns about.

## Open questions — still not verified

4. **The exact API-side rule for "required following item."** Reconstructed from forum reports, not from
   the API reference, which does not document it.
5. **Prompt-cache impact of `store: false`** and whether `promptCacheKey` recovers it. Unmeasured (§5.5).
6. **Reasoning under abort.** If the request is aborted mid-stream, the reasoning part's metadata is
   whatever the last `reasoning-delta` set — i.e. `{ itemId }` with no encrypted content. The
   `:5330-5340` sweep would then strip it on the next request. Whether that produces a degraded-but-
   working turn or an API error is untested.
