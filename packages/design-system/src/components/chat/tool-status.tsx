import { CheckIcon, LoaderIcon, XIcon } from "lucide-react";

import { cn } from "@repo/design-system/lib/utils";
import { Badge } from "@repo/design-system/components/badge";
import type { ChatToolState } from "@repo/design-system/components/chat/types";

const ICONS = {
  running: LoaderIcon,
  complete: CheckIcon,
  error: XIcon,
} as const;

type ToolPhase = keyof typeof ICONS;

function phaseOf(state: ChatToolState): ToolPhase {
  if (state === "output-available") return "complete";
  if (state === "output-error") return "error";
  return "running";
}

/**
 * A tool call rendered inline in the assistant's turn. The `shimmer` utility
 * (from `shadcn/tailwind.css`) carries the "still working" signal, so there is
 * no bespoke keyframe here.
 */
function ToolStatus({
  name,
  state,
  className,
}: {
  name: string;
  state: ChatToolState;
  className?: string;
}) {
  const phase = phaseOf(state);
  const Icon = ICONS[phase];

  return (
    <Badge
      variant={phase === "error" ? "destructive" : "secondary"}
      className={cn("font-mono", className)}
    >
      <Icon className={cn(phase === "running" && "animate-spin")} />
      <span className={cn(phase === "running" && "shimmer")}>{name}</span>
    </Badge>
  );
}

export { ToolStatus };
