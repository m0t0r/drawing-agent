/**
 * Excalidraw measures text at the moment elements are created, but registers
 * and loads Excalifont lazily — so text created too early is sized against a
 * fallback and renders clipped once the real glyphs land. (Double-clicking the
 * text "fixes" it only because editing forces a re-measure.)
 *
 * Two FontFaceSet traps make this easy to get wrong:
 *
 *   - `document.fonts.check(spec)` returns **true** when no matching @font-face
 *     is registered at all — "nothing to wait for" reads the same as "ready".
 *   - `document.fonts.load(spec)` resolves immediately, with an empty array,
 *     for a family it doesn't know yet. Awaiting it guarantees nothing.
 *
 * So the only trustworthy signal is `load()` resolving with at least one face,
 * which means we have to poll until Excalidraw has registered the family.
 *
 * Only the default canvas font is covered. If we later let the agent pick
 * fonts, Nunito and Comic Shanns need the same treatment.
 */
const FONT_SPEC = "20px Excalifont";
const POLL_INTERVAL_MS = 50;

let ready = false;
let pending: Promise<void> | null = null;

export function ensureCanvasFontLoaded(timeoutMs = 5000): Promise<void> {
  if (ready || typeof document === "undefined") return Promise.resolve();

  pending ??= (async () => {
    const deadline = performance.now() + timeoutMs;
    // Sequential awaits are the point here — this polls, so the iterations
    // cannot be parallelised the way no-await-in-loop assumes.
    /* eslint-disable no-await-in-loop */
    while (performance.now() < deadline) {
      const faces = await document.fonts.load(FONT_SPEC);
      if (faces.length > 0) {
        ready = true;
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    /* eslint-enable no-await-in-loop */
    // Give up rather than block drawing forever. `ready` stays false, so the
    // next caller retries instead of inheriting a failed result.
  })().finally(() => {
    pending = null;
  });

  return pending;
}
