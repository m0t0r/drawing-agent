"use client";

import { useExcalidraw } from "./excalidraw-provider";

/**
 * Scaffolding: proves the imperative API reaches a component that is a sibling
 * of the canvas rather than a child of it. Replaced by the prompt UI later.
 */
export function DrawDemoButton() {
  const { api, drawElements } = useExcalidraw();

  async function drawSample() {
    await drawElements([
      {
        type: "rectangle",
        x: 100,
        y: 100,
        width: 240,
        height: 120,
        backgroundColor: "#e0f2fe",
        strokeColor: "#0369a1",
        label: { text: "Hello from the API" },
      },
    ]);
    api?.scrollToContent(undefined, { fitToContent: true });
  }

  return (
    <button
      type="button"
      onClick={drawSample}
      disabled={!api}
      className="absolute bottom-4 left-1/2 z-10 -translate-x-1/2 rounded-full bg-sky-600 px-4 py-2 text-sm font-medium text-white shadow-lg transition hover:bg-sky-700 disabled:opacity-50"
    >
      Draw a sample shape
    </button>
  );
}
