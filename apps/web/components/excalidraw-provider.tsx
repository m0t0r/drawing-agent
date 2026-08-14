"use client";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { createContext, use, useMemo, useState } from "react";

type ExcalidrawContextValue = {
  /** Null until the editor has mounted and handed us its API. */
  api: ExcalidrawImperativeAPI | null;
  setApi: (api: ExcalidrawImperativeAPI) => void;
};

const ExcalidrawContext = createContext<ExcalidrawContextValue | null>(null);

/**
 * Hands the editor's imperative API to anything outside the canvas, and nothing
 * else. Canvas work belongs in a **canvas op** in `@repo/agent`, reached
 * through `lib/canvas-adapter` — logic that lived here could not be reached by
 * a headless eval.
 */
export function ExcalidrawProvider({ children }: { children: React.ReactNode }) {
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);

  const value = useMemo(() => ({ api, setApi }), [api]);

  return <ExcalidrawContext value={value}>{children}</ExcalidrawContext>;
}

export function useExcalidraw() {
  const ctx = use(ExcalidrawContext);
  if (!ctx) {
    throw new Error("useExcalidraw must be used inside <ExcalidrawProvider>");
  }
  return ctx;
}
