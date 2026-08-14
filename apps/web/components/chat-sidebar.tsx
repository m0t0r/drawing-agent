"use client";

import { useChat } from "@ai-sdk/react";
import { ChatPanel } from "@repo/design-system/components/chat/chat-panel";
import { toChatMessages } from "../lib/chat-messages";

/**
 * The chat sidebar: `useChat` above, the presentational panel below, and the
 * message adapter between them.
 *
 * Nothing survives a reload, deliberately — the conversation's lifetime matches
 * the canvas's, and restoring a conversation about shapes that no longer exist
 * would be worse than losing it.
 *
 * The canvas is not wired in yet. The agent has no tools, so this turn is text
 * only; `useExcalidraw` comes back when `addElements` does, and `<ChatPanel>`
 * will not need to change for it.
 */
export function ChatSidebar() {
  // The id is fixed rather than generated. `useChat` would otherwise mint one
  // with `Math.random()` during render, and Cache Components refuses to prerender
  // an unstable value in a Client Component. There is only ever one conversation
  // on this page, and it does not survive a reload, so a constant is honest.
  const { messages, sendMessage, status } = useChat({ id: "drawing-agent" });

  function handleSend(text: string) {
    sendMessage({ text });
  }

  return (
    <ChatPanel
      messages={toChatMessages(messages)}
      status={status}
      onSend={handleSend}
      title="Drawing agent"
    />
  );
}
