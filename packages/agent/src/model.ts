import { openai } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import type { OpenAILanguageModelResponsesOptions } from "@ai-sdk/openai";

/**
 * The baseline model, in one place so that changing it is one edit and one eval
 * run. Deliberately not chosen on taste — the evals exist to decide it.
 *
 * `openai(id)` targets the **Responses API** by default, which is what the
 * reasoning replay below depends on.
 */
export const MODEL_ID = "gpt-5.4-mini";

/** The production model. Tests and evals inject their own. */
export function defaultModel(): LanguageModel {
  return openai(MODEL_ID);
}

/**
 * `store: false` is the whole of the stateless-resume contract, and it is not a
 * privacy setting.
 *
 * Setting it makes the provider add `include: ["reasoning.encrypted_content"]`
 * unprompted, so each reasoning part comes back carrying its own ciphertext and
 * is replayed verbatim on the next request. The agent therefore keeps its train
 * of thought across a client-side tool round trip without any server-side
 * conversation state — correctness depends only on data we hold. Verified
 * against real calls; see ADR-0001.
 *
 * Two conditions ride on it. The auto-`include` is gated on the provider
 * classifying the model as a reasoning model, so a change to {@link MODEL_ID} is
 * what would silently switch reasoning replay off. And every way replay can fail
 * degrades to a **warning** rather than an error, which is why the loop surfaces
 * `result.warnings` instead of discarding them.
 */
export const PROVIDER_OPTIONS = {
  openai: { store: false } satisfies OpenAILanguageModelResponsesOptions,
};
