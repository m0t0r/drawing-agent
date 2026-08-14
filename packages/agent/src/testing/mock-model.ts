import { simulateReadableStream } from "ai";
import type { LanguageModelV4StreamPart, LanguageModelV4Usage } from "@ai-sdk/provider";

/**
 * Scripted model responses for the loop's tests.
 *
 * Internal to the package — `package.json` exports `./*` from `src/*.ts` and
 * `./canvas/*`, so nothing under `src/testing/` is reachable from outside.
 *
 * The point of scripting a *sequence* is that `MockLanguageModelV4`'s `doStream`
 * accepts an array consumed one entry per call, which is exactly one entry per
 * step of an owned loop.
 */

/**
 * Zero usage, in v7's nested shape.
 *
 * Every field is required, so a step's usage cannot be a bare number.
 */
const NO_USAGE: LanguageModelV4Usage = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
};

/**
 * Wraps the scripted parts as a `doStream` result.
 *
 * `initialDelayInMs`/`chunkDelayInMs` are `null` rather than `0` — `null` skips
 * the timer entirely, where `0` still defers a tick per chunk.
 */
function streamOf(parts: LanguageModelV4StreamPart[]) {
  return {
    stream: simulateReadableStream({ chunks: parts, initialDelayInMs: null, chunkDelayInMs: null }),
  };
}

/**
 * A step that produces text and stops.
 *
 * `finishReason` is an **object**. A bare `'stop'` is silently coerced to
 * `'other'`, which would make a scripted natural stop look like an abnormal
 * termination — and so make a termination test pass for the wrong reason. This
 * helper exists mostly to encode that once.
 */
export function textStep(text: string) {
  return streamOf([
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "text-0" },
    { type: "text-delta", id: "text-0", delta: text },
    { type: "text-end", id: "text-0" },
    { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage: NO_USAGE },
  ]);
}

/** A step that calls one tool, the way a client-side tool arrives. */
export function toolCallStep(options: { toolName: string; toolCallId: string; input: unknown }) {
  const input = JSON.stringify(options.input);

  return streamOf([
    { type: "stream-start", warnings: [] },
    { type: "tool-input-start", id: options.toolCallId, toolName: options.toolName },
    { type: "tool-input-delta", id: options.toolCallId, delta: input },
    { type: "tool-input-end", id: options.toolCallId },
    {
      type: "tool-call",
      toolCallId: options.toolCallId,
      toolName: options.toolName,
      input,
    },
    { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage: NO_USAGE },
  ]);
}
