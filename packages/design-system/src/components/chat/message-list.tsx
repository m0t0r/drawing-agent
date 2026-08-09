"use client";

import { BotIcon, MessageSquareIcon } from "lucide-react";
import { Streamdown } from "streamdown";

import { Avatar, AvatarFallback } from "@repo/design-system/components/avatar";
import { Bubble, BubbleContent } from "@repo/design-system/components/bubble";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@repo/design-system/components/empty";
import { Marker, MarkerContent } from "@repo/design-system/components/marker";
import { Message, MessageAvatar, MessageContent } from "@repo/design-system/components/message";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@repo/design-system/components/message-scroller";
import { ToolStatus } from "@repo/design-system/components/chat/tool-status";
import { isToolPart, type ChatMessage } from "@repo/design-system/components/chat/types";

function MessageParts({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";

  return (
    <Bubble variant={isUser ? "default" : "muted"} align={isUser ? "end" : "start"}>
      {message.parts.map((part, index) => {
        if (isToolPart(part)) {
          return (
            <ToolStatus
              // Parts have no stable identity of their own; their position in
              // the array is the identity, and it only ever grows.
              key={`${message.id}-${index}`}
              name={part.type.slice("tool-".length)}
              state={part.state}
            />
          );
        }

        return (
          <BubbleContent key={`${message.id}-${index}`}>
            {isUser ? part.text : <Streamdown>{part.text}</Streamdown>}
          </BubbleContent>
        );
      })}
    </Bubble>
  );
}

/**
 * The thread. `MessageScroller` owns follow-while-streaming, anchoring, and the
 * jump-to-latest control — there is deliberately no scroll bookkeeping here.
 */
function MessageList({ messages, label }: { messages: ChatMessage[]; label?: string }) {
  if (messages.length === 0) {
    return (
      <Empty className="flex-1">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <MessageSquareIcon />
          </EmptyMedia>
          <EmptyTitle>Nothing drawn yet</EmptyTitle>
          <EmptyDescription>
            Describe a diagram and it will be created on the canvas.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <MessageScrollerProvider autoScroll>
      <MessageScroller className="flex-1">
        <MessageScrollerViewport>
          <MessageScrollerContent className="gap-6 p-4">
            {label ? (
              <Marker variant="separator">
                <MarkerContent>{label}</MarkerContent>
              </Marker>
            ) : null}
            {messages.map((message) => {
              const isUser = message.role === "user";

              return (
                <MessageScrollerItem key={message.id} messageId={message.id} scrollAnchor={isUser}>
                  <Message align={isUser ? "end" : "start"}>
                    {isUser ? null : (
                      <MessageAvatar>
                        <Avatar>
                          <AvatarFallback>
                            <BotIcon />
                          </AvatarFallback>
                        </Avatar>
                      </MessageAvatar>
                    )}
                    <MessageContent>
                      <MessageParts message={message} />
                    </MessageContent>
                  </Message>
                </MessageScrollerItem>
              );
            })}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton />
      </MessageScroller>
    </MessageScrollerProvider>
  );
}

export { MessageList };
