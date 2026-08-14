# Stateless resume carries encrypted reasoning

**Status:** accepted · **Date:** 2026-08-14 · **Verified by:** spike for [#5](https://github.com/m0t0r/drawing-agent/issues/5)

The agent ends a turn whenever the model asks for a client-side tool, and resumes on a fresh
HTTP request rebuilt from client-held message history — there is no server-side suspend. That
left one question the design could not settle by reasoning: whether the model's reasoning
survives that round trip, or whether the loop silently loses its train of thought halfway
through a diagram (user story 18).

**Decision: keep the resume stateless and set `store: false`.** The OpenAI provider then asks
the Responses API for encrypted reasoning content and replays it verbatim on every subsequent
request. This is now observed, not inferred.

## What was observed

Five real `gpt-5.4-mini` calls through `ai@7` / `@ai-sdk/openai@4`, each one a fresh request
replaying the full history, with a tool that has no `execute`.

- Setting `providerOptions.openai.store = false` makes the provider add
  `include: ["reasoning.encrypted_content"]` to the request body by itself. Nothing else has to
  be configured.
- Every reasoning part comes back carrying `providerMetadata.openai.itemId` and
  `providerMetadata.openai.reasoningEncryptedContent` (~1.4–2.9 KB per item here).
- On the next request those reappear as a Responses `reasoning` input item with the original
  `id`, the original `encrypted_content`, and the summary array — byte-identical, unmodified.
- `previous_response_id` is never sent. The resume is genuinely stateless; correctness depends
  only on data we hold.
- A reasoning item sitting **between a tool call and its tool result** is accepted and correctly
  positioned: the replayed input reads `reasoning` → `function_call` → `function_call_output`,
  repeated once per step. No error, no warning, no degradation across three chained steps.
- Several reasoning parts may share one `itemId` (one response item, several summary
  paragraphs). The provider's converter merges them back into a single `reasoning` item with a
  multi-entry `summary`, so parts must never be reordered or split across messages.

Provider source, read alongside the run and written up in
[`docs/research/reasoning-across-stateless-resume.md`](../research/reasoning-across-stateless-resume.md),
adds two conditions the run cannot show. The auto-`include` is gated on the provider classifying the
model as a reasoning model — `gpt-5.4-mini` qualifies, but a model-id change could switch it off
silently. And every way this can fail degrades to a **warning, not an error**: the provider strips a
reasoning item that has no encrypted content rather than rejecting it. `result.warnings` is the canary,
and the loop must not discard it.

## The one trap

`convertToModelMessages` uses the `step-start` parts on a UI message to decide where a step
ended. Because the wire merges every step of a turn into **one** assistant message, an assistant
message without `step-start` separators converts to _all_ assistant parts followed by _all_ tool
results — tool calls detached from their outputs. The provider accepted even that without
error, but it is the wrong history. With `step-start` emitted per step, conversion interleaves
exactly. The wire's `sendStart`-per-step behaviour is therefore load-bearing for history
fidelity, not just for client rendering.

## Considered and rejected

**Provider-side storage** (`store: true` plus `previous_response_id`) would also preserve
reasoning, but it makes turn-to-turn correctness depend on OpenAI's retention behaviour rather
than on data we hold, and it reintroduces server-side conversation state that the stateless
resume exists to avoid. The two are mutually exclusive by construction: with `previousResponseId`
set, the provider skips any reasoning part that has an `itemId` rather than inlining it.

## Consequences

- Reasoning is replayed in full on every step, so a turn's request grows by roughly 1–3 KB of
  opaque ciphertext per prior step. Bounded by the step cap of 8; worth remembering if the cap
  ever moves or if history compaction lands.
- Encrypted reasoning passes through the browser as message content. It is opaque to us and to
  the client, but it is on the wire and in client memory.
- Anything that rewrites assistant history — compaction, truncation, retries — must preserve
  reasoning parts, their `providerMetadata`, their order, and their `step-start` boundaries, or
  reasoning is lost or malformed.
