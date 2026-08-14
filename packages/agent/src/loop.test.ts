import { tool, type ModelMessage, type UIMessage } from "ai";
import { convertReadableStreamToArray, MockLanguageModelV4 } from "ai/test";
import { z } from "zod";
import { groupIntoTurns, inProcess, MAX_STEPS, runTurn, suspend } from "./loop";
import { SYSTEM_PROMPT } from "./prompt";
import { textStep, toolCallStep } from "./testing/mock-model";

/**
 * A client-side tool, in the only sense that matters to the loop: it has no
 * `execute`, so `streamText` halts at the call and the **executor** decides what
 * happens next. The canvas tools arrive in later tickets; this one exists so the
 * executor seam can be exercised before they do.
 */
const ping = tool({
  description: "Ping, for tests.",
  inputSchema: z.object({ note: z.string() }),
});

const tools = { ping };

function userMessage(text: string): UIMessage {
  return { id: "user-1", role: "user", parts: [{ type: "text", text }] };
}

/** Every chunk the turn put on the wire, in order. */
async function chunkTypes(stream: ReadableStream<{ type: string }>) {
  return (await convertReadableStreamToArray(stream)).map((chunk) => chunk.type);
}

function countOf(types: string[], type: string) {
  return types.filter((entry) => entry === type).length;
}

describe("runTurn", () => {
  it("streams a single step as one assistant message", async () => {
    const model = new MockLanguageModelV4({ doStream: [textStep("Two boxes and an arrow.")] });

    const types = await chunkTypes(
      runTurn({ model, messages: [userMessage("draw the login flow")], executor: suspend }),
    );

    expect(countOf(types, "start")).toBe(1);
    expect(countOf(types, "finish")).toBe(1);
    expect(countOf(types, "start-step")).toBe(1);
    expect(types.at(0)).toBe("start");
    expect(types.at(-1)).toBe("finish");
    expect(types).toContain("text-delta");
  });

  it("merges several steps into one message, one step-boundary pair per step", async () => {
    const model = new MockLanguageModelV4({
      doStream: [
        toolCallStep({ toolName: "ping", toolCallId: "call-1", input: { note: "first" } }),
        textStep("Done."),
      ],
    });

    const types = await chunkTypes(
      runTurn({
        model,
        messages: [userMessage("draw the login flow")],
        executor: inProcess(async () => ({ ok: true })),
        tools,
      }),
    );

    // The turn ran twice but reads as one message: opened once, closed once.
    expect(model.doStreamCalls).toHaveLength(2);
    expect(countOf(types, "start")).toBe(1);
    expect(countOf(types, "finish")).toBe(1);
    expect(countOf(types, "start-step")).toBe(2);
    expect(countOf(types, "finish-step")).toBe(2);
  });

  it("ends the turn at a tool call when the executor suspends", async () => {
    const model = new MockLanguageModelV4({
      doStream: [
        toolCallStep({ toolName: "ping", toolCallId: "call-1", input: { note: "first" } }),
        textStep("never reached"),
      ],
    });

    const types = await chunkTypes(
      runTurn({ model, messages: [userMessage("draw it")], executor: suspend, tools }),
    );

    // The browser fulfils the call and posts the result back as a fresh turn.
    expect(model.doStreamCalls).toHaveLength(1);
    expect(types).toContain("tool-input-available");
    expect(types).not.toContain("tool-output-available");
    expect(types.at(-1)).toBe("finish");
  });

  it("runs the tool in process and carries its output back to the model", async () => {
    const model = new MockLanguageModelV4({
      doStream: [
        toolCallStep({ toolName: "ping", toolCallId: "call-1", input: { note: "first" } }),
        textStep("Done."),
      ],
    });
    const calls: unknown[] = [];

    const types = await chunkTypes(
      runTurn({
        model,
        messages: [userMessage("draw it")],
        executor: inProcess(async (call) => {
          calls.push(call);
          return { overlaps: [] };
        }),
        tools,
      }),
    );

    expect(calls).toEqual([{ toolCallId: "call-1", toolName: "ping", input: { note: "first" } }]);
    // The output reaches the wire too, so both executors produce the same message.
    expect(types).toContain("tool-output-available");

    // And it reaches the next step as a tool result, in the same turn.
    const secondPrompt = model.doStreamCalls[1]?.prompt ?? [];
    expect(secondPrompt.at(-1)).toMatchObject({
      role: "tool",
      content: [{ type: "tool-result", toolCallId: "call-1", toolName: "ping" }],
    });
  });

  it("stops at the step cap rather than looping forever", async () => {
    const model = new MockLanguageModelV4({
      doStream: Array.from({ length: MAX_STEPS + 4 }, (_, index) =>
        toolCallStep({ toolName: "ping", toolCallId: `call-${index}`, input: { note: "again" } }),
      ),
    });

    const types = await chunkTypes(
      runTurn({
        model,
        messages: [userMessage("loop forever")],
        executor: inProcess(async () => ({ ok: true })),
        tools,
      }),
    );

    expect(model.doStreamCalls).toHaveLength(MAX_STEPS);
    // Still one well-formed message — a capped turn is not a truncated stream.
    expect(countOf(types, "finish")).toBe(1);
    expect(types.at(-1)).toBe("finish");
  });

  it("replays client-held history to the model", async () => {
    const model = new MockLanguageModelV4({ doStream: [textStep("Sure.")] });
    const history: UIMessage[] = [
      userMessage("draw the login flow"),
      {
        id: "assistant-1",
        role: "assistant",
        parts: [{ type: "step-start" }, { type: "text", text: "Two boxes and an arrow." }],
      },
      { id: "user-2", role: "user", parts: [{ type: "text", text: "make it three" }] },
    ];

    await chunkTypes(runTurn({ model, messages: history, executor: suspend }));

    // Nothing is held server-side, so the whole conversation has to arrive on the
    // request and be rebuilt — including the prior assistant turn. The prompt
    // leads with the shared system prompt, which the loop passes as
    // `instructions` rather than as a message inside the history.
    const prompt = model.doStreamCalls[0]?.prompt ?? [];
    expect(prompt.map((message) => message.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(prompt.at(0)?.content).toBe(SYSTEM_PROMPT);
  });
});

describe("groupIntoTurns", () => {
  const user = (text: string): ModelMessage => ({ role: "user", content: text });
  const assistant = (text: string): ModelMessage => ({ role: "assistant", content: text });

  it("starts a new turn at each user message", () => {
    const turns = groupIntoTurns([
      user("draw the login flow"),
      assistant("Two boxes and an arrow."),
      user("make it three"),
      assistant("Three boxes."),
    ]);

    expect(turns).toHaveLength(2);
    expect(turns[0]?.messages).toHaveLength(2);
    expect(turns[1]?.messages).toHaveLength(2);
  });

  it("keeps a multi-step turn's messages together in one group", () => {
    const turns = groupIntoTurns([
      user("draw it"),
      assistant("calling a tool"),
      { role: "tool", content: [] },
      assistant("done"),
    ]);

    // A whole turn can later be dropped without orphaning a tool call from its
    // result, which is the point of grouping rather than keeping one flat array.
    expect(turns).toHaveLength(1);
    expect(turns[0]?.messages).toHaveLength(4);
  });

  it("tolerates a history that does not open with a user message", () => {
    const turns = groupIntoTurns([assistant("unprompted"), user("draw it")]);

    expect(turns).toHaveLength(2);
    expect(turns[0]?.messages).toHaveLength(1);
  });
});
