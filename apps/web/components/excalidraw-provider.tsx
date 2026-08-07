"use client";

import type { ExcalidrawElementSkeleton } from "@excalidraw/excalidraw/data/transform";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { createContext, use, useCallback, useMemo, useState } from "react";
import { ensureCanvasFontLoaded } from "../lib/excalidraw-fonts";

type ExcalidrawContextValue = {
  /** Null until the editor has mounted and handed us its API. */
  api: ExcalidrawImperativeAPI | null;
  setApi: (api: ExcalidrawImperativeAPI) => void;
  /**
   * Puts elements on the canvas, replacing the current scene.
   *
   * Every path that creates elements should go through this rather than
   * calling `updateScene` directly: element skeletons are measured during
   * conversion, so text created before Excalidraw's font loads is sized
   * against a fallback and renders clipped. Funnelling through here is what
   * keeps that guarantee from depending on each caller remembering it.
   *
   * No-ops before the editor has mounted.
   */
  drawElements: (skeletons: ExcalidrawElementSkeleton[]) => Promise<void>;
};

const ExcalidrawContext = createContext<ExcalidrawContextValue | null>(null);

export function ExcalidrawProvider({ children }: { children: React.ReactNode }) {
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);

  const drawElements = useCallback(
    async (skeletons: ExcalidrawElementSkeleton[]) => {
      if (!api) return;
      // Excalidraw is imported lazily so it stays in the canvas chunk, and the
      // font is awaited alongside it rather than after, so it costs no extra
      // round trip once warm.
      const [{ convertToExcalidrawElements }] = await Promise.all([
        import("@excalidraw/excalidraw"),
        ensureCanvasFontLoaded(),
      ]);
      api.updateScene({ elements: convertToExcalidrawElements(skeletons) });
    },
    [api],
  );

  const value = useMemo(() => ({ api, setApi, drawElements }), [api, drawElements]);

  return <ExcalidrawContext value={value}>{children}</ExcalidrawContext>;
}

export function useExcalidraw() {
  const ctx = use(ExcalidrawContext);
  if (!ctx) {
    throw new Error("useExcalidraw must be used inside <ExcalidrawProvider>");
  }
  return ctx;
}
