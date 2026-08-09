/**
 * Deliberately shaped like the AI SDK's `UIMessage`: a message is a list of
 * parts, and tool calls arrive as `tool-<name>` parts carrying a lifecycle
 * `state`. Nothing here fetches — swapping these types for the real `UIMessage`
 * and feeding `useChat`'s output straight into `<ChatPanel>` should be a
 * mechanical change, not a rewrite.
 */

export type ChatRole = "user" | "assistant";

export type ChatTextPart = {
  type: "text";
  text: string;
};

export type ChatToolState =
  | "input-streaming"
  | "input-available"
  | "output-available"
  | "output-error";

export type ChatToolPart = {
  type: `tool-${string}`;
  state: ChatToolState;
};

export type ChatPart = ChatTextPart | ChatToolPart;

export type ChatMessage = {
  id: string;
  role: ChatRole;
  parts: ChatPart[];
};

/** Mirrors the AI SDK `useChat` status union. */
export type ChatStatus = "ready" | "submitted" | "streaming" | "error";

export function isToolPart(part: ChatPart): part is ChatToolPart {
  return part.type.startsWith("tool-");
}
