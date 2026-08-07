"use client";

// Since v0.18 Excalidraw no longer injects its own styles, and this is the only
// module that pulls the package in, so the stylesheet belongs here.
import "@excalidraw/excalidraw/index.css";
import dynamic from "next/dynamic";
import { useEffect } from "react";
import { ensureCanvasFontLoaded } from "../lib/excalidraw-fonts";
import { useExcalidraw } from "./excalidraw-provider";

// Excalidraw has no SSR support. `ssr: false` is only legal inside a Client
// Component, which is why this lives here rather than in the page.
//
// No <Suspense> wrapper needed: next/dynamic is itself a composite of
// React.lazy and Suspense, and `loading` is that boundary's fallback.
// `h-full`, not `flex-1` — the wrapper below is a block, not a flex container,
// so flex sizing here would collapse the fallback to 0px.
const Excalidraw = dynamic(async () => (await import("@excalidraw/excalidraw")).Excalidraw, {
  ssr: false,
  loading: () => <div className="h-full" />,
});

export function Canvas() {
  const { setApi } = useExcalidraw();

  // Warm the canvas font while the user is still reading an empty canvas, so
  // the first generated diagram doesn't have to wait on it.
  useEffect(() => {
    void ensureCanvasFontLoaded();
  }, []);

  return (
    // Excalidraw fills 100% of its containing block, so that block needs a height.
    <div className="min-h-0 flex-1">
      <Excalidraw excalidrawAPI={setApi} initialData={{ appState: { openSidebar: null } }} />
    </div>
  );
}
