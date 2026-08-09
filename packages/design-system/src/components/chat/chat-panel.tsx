"use client";

import { useState } from "react";
import { ArrowUpIcon } from "lucide-react";

import { cn } from "@repo/design-system/lib/utils";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@repo/design-system/components/input-group";
import { Spinner } from "@repo/design-system/components/spinner";
import { MessageList } from "@repo/design-system/components/chat/message-list";
import type { ChatMessage, ChatStatus } from "@repo/design-system/components/chat/types";

type ChatPanelProps = {
  messages: ChatMessage[];
  status: ChatStatus;
  onSend: (text: string) => void;
  title?: string;
  placeholder?: string;
  className?: string;
};

/**
 * Presentational only: it owns the draft input and nothing else. `messages`,
 * `status`, and `onSend` are the same triple `useChat` hands back, so a real
 * transport can be dropped in above this component without touching it.
 */
function ChatPanel({
  messages,
  status,
  onSend,
  title = "Chat",
  placeholder = "Describe a diagram…",
  className,
}: ChatPanelProps) {
  const [input, setInput] = useState("");
  const isBusy = status === "submitted" || status === "streaming";

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = input.trim();
    if (!text || isBusy) return;
    onSend(text);
    setInput("");
  }

  return (
    <div className={cn("flex h-full min-h-0 flex-col bg-card", className)}>
      <header className="flex shrink-0 items-center border-b px-4 py-3">
        <h2 className="text-sm font-medium">{title}</h2>
      </header>

      <MessageList messages={messages} />

      <form onSubmit={handleSubmit} className="shrink-0 border-t p-3">
        <InputGroup>
          <InputGroupInput
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder={placeholder}
            disabled={isBusy}
            aria-label={title}
          />
          <InputGroupAddon align="inline-end">
            <InputGroupButton
              type="submit"
              variant="default"
              size="icon-xs"
              disabled={isBusy || input.trim().length === 0}
            >
              {isBusy ? <Spinner /> : <ArrowUpIcon />}
              <span className="sr-only">Send</span>
            </InputGroupButton>
          </InputGroupAddon>
        </InputGroup>
      </form>
    </div>
  );
}

export { ChatPanel, type ChatPanelProps };
