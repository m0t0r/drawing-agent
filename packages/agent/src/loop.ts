import {
  convertToModelMessages,
  createUIMessageStream,
  streamText,
  toUIMessageStream,
  type JSONValue,
  type LanguageModel,
  type ModelMessage,
  type ToolSet,
  type UIMessage,
  type UIMessageChunk,
} from "ai";
import { PROVIDER_OPTIONS } from "./model";
import { SYSTEM_PROMPT } from "./prompt";

/**
 * The most model calls one **turn** may make.
 *
 * The loop's only unconditional bound: a model that keeps asking for tools stops
 * being the user's problem after eight steps. Wall-clock and cost budgets are
 * deliberately absent — the cap bounds both adequately at this scale, and a
 * budget cannot be tuned without data.
 */
export const MAX_STEPS = 8;

/** One tool call, as the **executor** sees it. */
export type ToolCall = {
  toolCallId: string;
  toolName: string;
  input: unknown;
};

/**
 * What a **turn** does when the model calls a client-side tool.
 *
 * Injected, and the single reason one `runTurn` can serve production, the evals
 * and the tests rather than splitting into entry points that drift:
 *
 * | Context                 | model | executor   |
 * | ----------------------- | ----- | ---------- |
 * | Production route        | real  | suspend    |
 * | Evals                   | real  | in-process |
 * | Unit tests              | mock  | in-process |
 */
export type ToolExecutor =
  | { mode: "suspend" }
  | { mode: "in-process"; run: (call: ToolCall) => Promise<JSONValue> };

/**
 * End the turn and let the browser fulfil the call against the live canvas.
 *
 * The result arrives as a fresh request carrying the whole history — there is no
 * server-side suspend, and the canvas is never mirrored here.
 */
export const suspend: ToolExecutor = { mode: "suspend" };

/**
 * Run the call here and keep stepping, against an in-memory element array.
 *
 * The known soft spot in the seam: production never takes this path, so anything
 * that accumulates in an executor is something the two paths can drift on. The
 * mitigation is that everything substantive lives in the **canvas op**, leaving
 * `run` a bare switch on tool name.
 */
export function inProcess(run: (call: ToolCall) => Promise<JSONValue>): ToolExecutor {
  return { mode: "in-process", run };
}

/** One **turn**'s worth of model messages. */
export type Turn = { messages: ModelMessage[] };

export type RunTurnOptions = {
  model: LanguageModel;
  /** The whole conversation, client-held and posted in full. */
  messages: UIMessage[];
  executor: ToolExecutor;
  tools?: ToolSet;
  abortSignal?: AbortSignal;
  /**
   * Where the model's warnings go. Every way reasoning replay can fail degrades
   * to a warning rather than an error — the provider strips a reasoning item
   * lacking encrypted content instead of rejecting it — so a loop that discards
   * these would never learn that the agent had stopped carrying its train of
   * thought across a tool call.
   */
  onWarnings?: (warnings: unknown[]) => void;
  /**
   * Turns a thrown error into the text the client is shown, and is the only
   * place a failed turn can be logged. Anything thrown inside the loop or on a
   * merged step's stream arrives here.
   */
  onError?: (error: unknown) => string;
};

/**
 * One **turn**: call the model a step at a time until it stops or the cap is hit,
 * streaming the whole thing as a single assistant message.
 *
 * Own the loop, borrow the call. Stepping, termination, the cap, history shape
 * and error policy are ours; each individual model call is `streamText`'s, which
 * performs exactly one step by default — and halts on a tool with no `execute`
 * regardless, which every canvas tool is.
 *
 * Returns the wire rather than a `Response` so that tests can read the chunks
 * without a server. The stream is lazy: `execute` runs as it is consumed.
 */
export function runTurn({
  model,
  messages,
  executor,
  tools = {},
  abortSignal,
  onWarnings = defaultOnWarnings,
  onError = defaultOnError,
}: RunTurnOptions): ReadableStream<UIMessageChunk> {
  return createUIMessageStream({
    // Without this the SDK's default swallows the cause: the client gets a
    // generic string and the server logs nothing at all, so a missing API key,
    // an unknown model id, a rate limit and a malformed history are one
    // indistinguishable failure. The text the client sees stays deliberately
    // vague — it reaches a browser — but the cause has to land somewhere.
    onError,
    // The client re-posts the whole history, so on a resume its last message is
    // the assistant message holding the unfulfilled tool call. Passing it means
    // the stream continues that message instead of starting a second one, which
    // would split one turn into two bubbles and strand the tool part. Today the
    // last message is always a user message and a fresh id is minted either way.
    originalMessages: messages,
    async execute({ writer }) {
      // Rebuilt from the request, never held here. `ignoreIncompleteToolCalls`
      // stays off: on a resume it would discard the very call being resumed.
      const history = groupIntoTurns(await convertToModelMessages(messages, { tools }));
      const turn = currentTurn(history);

      /*
       * `no-await-in-loop` is disabled deliberately, and for the whole loop
       * rather than line by line. Steps are sequential by definition — each
       * step's prompt contains the previous step's output — so the rule's advice
       * to collect the promises and `Promise.all` them describes a different,
       * broken program. Tool calls *within* one step are the parallelisable part,
       * and later tickets may batch them; the steps themselves never are.
       */
      /* eslint-disable no-await-in-loop */
      for (let step = 0; step < MAX_STEPS; step++) {
        const result = streamText({
          model,
          instructions: SYSTEM_PROMPT,
          messages: history.flatMap((entry) => entry.messages),
          tools,
          providerOptions: PROVIDER_OPTIONS,
          abortSignal,
        });

        // `sendStart` on the first step only and `sendFinish` never: each merged
        // result still contributes its own step-boundary pair, so N steps arrive
        // as one message containing N steps. Those boundaries are not cosmetic —
        // `convertToModelMessages` splits a turn back into steps at them, and the
        // client's completeness check keys off the last one.
        writer.merge(
          toUIMessageStream({
            stream: result.stream,
            tools,
            sendStart: step === 0,
            sendFinish: false,
            // The merge needs its own handler, and it is the one that sees the
            // *real* failure. An error on a step's stream becomes an error chunk
            // here, after which the loop's own await rejects with
            // `NoOutputGeneratedError` — so the stream-level handler gets a
            // wrapper saying "check the stream for errors" and nothing about the
            // 401 behind it. Left unset this one would also emit the SDK's
            // default text, masking ours on the wire.
            onError,
          }),
        );

        // Read after the step's stream has finished, never from a snapshot taken
        // during it: a reasoning part only carries its encrypted content once
        // `reasoning-end` has arrived, and taking messages mid-stream drops it
        // silently.
        turn.messages.push(...(await result.responseMessages));

        const warnings = (await result.warnings) ?? [];
        if (warnings.length > 0) onWarnings(warnings);

        const toolCalls = await result.toolCalls;
        if (toolCalls.length === 0) break;
        if (executor.mode === "suspend") break;

        for (const call of toolCalls) {
          const output = await executor.run({
            toolCallId: call.toolCallId,
            toolName: call.toolName,
            input: call.input,
          });

          // On the wire as well as in the history, so a turn reads the same
          // whichever executor ran it.
          writer.write({
            type: "tool-output-available",
            toolCallId: call.toolCallId,
            output,
          });
          turn.messages.push(toolResultMessage(call.toolCallId, call.toolName, output));
        }
      }
      /* eslint-enable no-await-in-loop */

      // The loop decides the turn is over, not any individual step.
      writer.write({ type: "finish" });
    },
  });
}

/**
 * Splits a flat message list into **turns**, one per user message.
 *
 * Grouping costs nothing here and makes any later compaction safe by default:
 * a whole turn can be dropped without orphaning a tool call from its result,
 * which is exactly what dropping messages from a flat array would do.
 *
 * A history that opens with something other than a user message still groups
 * rather than throwing — the loop's job is not to validate the client's history.
 */
export function groupIntoTurns(messages: ModelMessage[]): Turn[] {
  const turns: Turn[] = [];

  for (const message of messages) {
    if (message.role === "user" || turns.length === 0) turns.push({ messages: [] });
    turns.at(-1)?.messages.push(message);
  }

  return turns;
}

/** The turn being run: the last group, or a fresh one if the history is empty. */
function currentTurn(history: Turn[]): Turn {
  const last = history.at(-1);
  if (last) return last;

  const turn: Turn = { messages: [] };
  history.push(turn);
  return turn;
}

function toolResultMessage(toolCallId: string, toolName: string, output: JSONValue): ModelMessage {
  return {
    role: "tool",
    content: [
      { type: "tool-result", toolCallId, toolName, output: { type: "json", value: output } },
    ],
  };
}

function defaultOnWarnings(warnings: unknown[]) {
  console.warn("[agent] model warnings", warnings);
}

/**
 * The cause goes to the server log; the client gets a sentence it can render.
 *
 * Deliberately not the provider's message — that can carry request details, and
 * this string is handed to a browser.
 */
function defaultOnError(error: unknown): string {
  console.error("[agent] turn failed", error);
  return "The agent could not finish that turn. Try again.";
}
