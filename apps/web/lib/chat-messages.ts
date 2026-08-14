import { getToolName, isToolUIPart, type ToolUIPart, type UIMessage } from "ai";
import type {
  ChatMessage,
  ChatPart,
  ChatToolState,
} from "@repo/design-system/components/chat/types";

/**
 * The boundary at which the SDK's message shape becomes the design system's.
 *
 * The design system stays presentational and keeps its own types, so the app
 * adapts rather than the package importing `ai`. That is not ceremony: it is
 * what stops the chat UI from being coupled to whichever SDK produced the
 * messages, and it is why the panel needed no changes when a real model
 * replaced the canned reply.
 *
 * The two shapes were designed to line up, so this is a filter more than a
 * translation — it drops the parts the panel has no way to render rather than
 * reshaping the ones it does.
 */
export function toChatMessages(messages: UIMessage[]): ChatMessage[] {
  return messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => ({
      id: message.id,
      role: message.role as ChatMessage["role"],
      parts: message.parts.flatMap(toChatPart),
    }));
}

/**
 * `flatMap` rather than `map`, so an unrenderable part yields nothing.
 *
 * `step-start` is the main one dropped: it delimits steps for the client's
 * completeness check and for history fidelity on the next request, but a step
 * boundary is not something a reader should see — a multi-step turn is meant to
 * read as one reply. Reasoning parts are dropped too; surfacing the model's
 * thinking is a product decision nobody has made.
 */
function toChatPart(part: UIMessage["parts"][number]): ChatPart[] {
  if (part.type === "text") return [{ type: "text", text: part.text }];
  if (isToolUIPart(part)) {
    return [{ type: `tool-${getToolName(part)}`, state: toChatToolState(part.state) }];
  }

  return [];
}

/**
 * The SDK models three approval states the design system does not.
 *
 * Tool approval is deferred — the canvas is ephemeral and the editor has its own
 * undo stack — so nothing here can produce one today. Rather than widening the
 * design system's type for states it has no UI for, a pending approval collapses
 * to `input-available` (the call is known, the output is not) and a denial to
 * `output-error` (the call is over and produced nothing).
 *
 * Exhaustive on purpose, with no `default`: `@ai-sdk/react` pins `ai` exactly, so
 * a new state can only arrive with a deliberate version bump, and a compile error
 * at that moment is the cheapest possible way to be told about it.
 */
function toChatToolState(state: ToolUIPart["state"]): ChatToolState {
  switch (state) {
    case "input-streaming":
    case "input-available":
    case "output-available":
    case "output-error":
      return state;
    case "approval-requested":
    case "approval-responded":
      return "input-available";
    case "output-denied":
      return "output-error";
  }
}
