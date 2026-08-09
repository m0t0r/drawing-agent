"use client";

import { ChatPanel } from "@repo/design-system/components/chat/chat-panel";
import type { ChatMessage } from "@repo/design-system/components/chat/types";
import { useState } from "react";
import { useExcalidraw } from "./excalidraw-provider";

const SEED_MESSAGES: ChatMessage[] = [
  {
    id: "seed-user",
    role: "user",
    parts: [{ type: "text", text: "Draw a box that says hello." }],
  },
  {
    id: "seed-assistant",
    role: "assistant",
    parts: [
      { type: "tool-addElements", state: "output-available" },
      {
        type: "text",
        text: "Done — one **rectangle** on the canvas. Ask for another shape and it lands next to it.",
      },
    ],
  },
];

/**
 * Scaffolding, in the same spirit as the button it replaces: it proves the
 * imperative canvas API reaches a sibling of the canvas, now through the real
 * prompt UI. There is no model behind it — sending draws a labelled rectangle
 * and appends a canned turn. Swap this for `useChat`/`useAgentChat` and
 * `<ChatPanel>` stays untouched.
 */
export function ChatSidebar() {
  const { api, drawElements } = useExcalidraw();
  const [messages, setMessages] = useState<ChatMessage[]>(SEED_MESSAGES);

  async function handleSend(text: string) {
    const id = crypto.randomUUID();

    setMessages((current) => [
      ...current,
      { id: `${id}-user`, role: "user", parts: [{ type: "text", text }] },
      {
        id: `${id}-assistant`,
        role: "assistant",
        parts: [
          { type: "tool-addElements", state: "output-available" },
          { type: "text", text: `Drew a box labelled \`${text}\`.` },
        ],
      },
    ]);

    await drawElements([
      {
        type: "rectangle",
        x: 100,
        y: 100,
        width: 240,
        height: 120,
        label: { text },
      },
    ]);
    api?.scrollToContent(undefined, { fitToContent: true });
  }

  return <ChatPanel messages={messages} status="ready" onSend={handleSend} title="Drawing agent" />;
}
