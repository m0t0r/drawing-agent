import { runTurn, suspend } from "@repo/agent/loop";
import { defaultModel } from "@repo/agent/model";
import { createUIMessageStreamResponse, safeValidateUIMessages } from "ai";

/**
 * One **turn** per request.
 *
 * The handler is deliberately thin: everything the agent does lives in
 * `@repo/agent` so the app and the eval harness cannot drift apart. All this
 * chooses is the two injected halves — the real model, and the **suspend**
 * executor, because in the browser the canvas is the source of truth and a tool
 * call has to be fulfilled there rather than here.
 *
 * `POST` is never cached, so Cache Components has no bearing on this route.
 */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response("Expected a JSON body.", { status: 400 });
  }

  // The history is client-held and arrives in full on every request, which makes
  // it untrusted input rather than something we can assume well-formed.
  const validated = await safeValidateUIMessages({
    messages: (body as { messages?: unknown })?.messages,
  });
  if (!validated.success) {
    return new Response("Expected a valid UI message history.", { status: 400 });
  }

  return createUIMessageStreamResponse({
    stream: runTurn({
      model: defaultModel(),
      messages: validated.data,
      executor: suspend,
      // Closing the tab or navigating away stops the work rather than leaving it
      // running and billing.
      abortSignal: request.signal,
    }),
  });
}
