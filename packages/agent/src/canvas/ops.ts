import { convertToExcalidrawElements } from "@excalidraw/excalidraw";
import type { ExcalidrawElementSkeleton } from "@excalidraw/excalidraw/data/transform";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";

/**
 * The `addElements` tool's input: a batch of **element skeletons** to place on
 * the canvas. Nothing else — the scene is the op's other argument, not part of
 * the input.
 */
export type AddElementsInput = {
  elements: ExcalidrawElementSkeleton[];
};

/**
 * The additive **canvas op**: `(elements, input) => elements`.
 *
 * Pure, synchronous, and knows nothing about React or Excalidraw's imperative
 * API — the browser and the eval harness call the same function, which is the
 * only reason the two cannot drift.
 *
 * It consumes **element skeletons** and returns **runtime elements**: the
 * conversion happens here, so callers never hold a half-converted scene. Ids
 * the caller chose are preserved, because the model refers to them in later
 * turns (`start: { id }`, `updateElements`), and conversion would otherwise
 * regenerate every one of them.
 *
 * Note that conversion is not portable to a bare Node process. See
 * `headless-environment.ts` and `docs/research/excalidraw-skeleton-conversion.md`.
 */
export function addElements(
  elements: readonly ExcalidrawElement[],
  input: AddElementsInput,
): ExcalidrawElement[] {
  const skeletons = stripNulls(input.elements);

  return [...elements, ...convertToExcalidrawElements(skeletons, { regenerateIds: false })];
}

/**
 * Drops every `null` from a skeleton, recursively.
 *
 * The tool schemas run in strict mode, where no property may be optional, so an
 * absent optional field arrives as an explicit `null`. Excalidraw's defaults are
 * parameter defaults, which only `undefined` triggers — a `null` sails straight
 * through and lands on the runtime element. Stripping is therefore load-bearing
 * rather than tidying, and it belongs here so that neither **executor** has to
 * remember it.
 */
function stripNulls<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.filter((entry) => entry !== null).map(stripNulls) as T;
  }

  if (value === null || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== null)
      .map(([key, entry]) => [key, stripNulls(entry)]),
  ) as T;
}
