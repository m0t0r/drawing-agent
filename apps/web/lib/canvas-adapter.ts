import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { AddElementsInput } from "@repo/agent/canvas/ops";
import { ensureCanvasFontLoaded } from "./excalidraw-fonts";

/**
 * The adapter: reads the live scene, runs a **canvas op**, writes the result
 * back. It is deliberately trivial — null stripping, skeleton conversion and id
 * assignment all live in the op, which is what lets the eval harness exercise
 * the same code with no editor.
 *
 * The font has to be loaded before the op runs, not after, and that is
 * load-bearing rather than belt-and-braces — the reasoning, with sources, is in
 * `CONTEXT.md`'s traps. Every path that creates elements goes through here
 * rather than calling `updateScene` directly, so that the guarantee does not
 * depend on each caller remembering it.
 *
 * The op is imported dynamically because it pulls in `@excalidraw/excalidraw`,
 * which belongs in the canvas chunk; the font is awaited alongside it rather
 * than after, so it costs no extra round trip once warm.
 *
 * Known trade-off: `getSceneElements()` omits deleted elements, so a scene an
 * op has rewritten no longer carries the editor's tombstones. That is the
 * deliberate choice — the alternative makes every op and every scorer filter
 * `isDeleted` — but it means undoing a deletion made before an op ran may not
 * restore the element.
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
