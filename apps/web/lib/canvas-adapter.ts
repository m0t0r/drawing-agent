import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { AddElementsInput } from "@repo/agent/canvas/ops";
import { ensureCanvasFontLoaded } from "./excalidraw-fonts";

/**
 * The adapter: reads the live scene, runs a **canvas op**, writes the result
 * back. It is deliberately trivial — null stripping, skeleton conversion and id
 * assignment all live in the op, which is what lets the eval harness exercise
 * the same code with no editor.
 *
 * The font has to be loaded before the op runs, not after. Element skeletons
 * are measured during conversion and the measurement is baked in permanently —
 * loading Excalifont later invalidates only the shape cache, so text converted
 * too early stays mis-sized until something re-measures it. Every path that
 * creates elements therefore goes through here rather than calling
 * `updateScene` directly.
 *
 * The op is imported dynamically because it pulls in `@excalidraw/excalidraw`,
 * which belongs in the canvas chunk; the font is awaited alongside it rather
 * than after, so it costs no extra round trip once warm.
 */
export async function applyAddElements(
  api: ExcalidrawImperativeAPI,
  input: AddElementsInput,
): Promise<void> {
  const [{ addElements }] = await Promise.all([
    import("@repo/agent/canvas/ops"),
    ensureCanvasFontLoaded(),
  ]);

  api.updateScene({ elements: addElements(api.getSceneElements(), input) });
}
