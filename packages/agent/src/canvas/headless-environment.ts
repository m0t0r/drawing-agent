/**
 * Makes `convertToExcalidrawElements` runnable outside a browser.
 *
 * Import this for its side effect **before** anything imports
 * `@excalidraw/excalidraw` — it is a Vitest `setupFiles` entry in both configs.
 * The browser never loads it; `apps/web` has a real DOM.
 *
 * Two separate obstacles, both measured rather than guessed
 * (`docs/research/excalidraw-skeleton-conversion.md`):
 *
 * 1. **The package does not load in bare Node at all.** Its published ESM
 *    bundle uses extensionless specifiers, a JSON import with no import
 *    attribute, and CJS named-export interop — bundler-legal, Node-illegal. A
 *    bundler is a hard requirement; the configs pass `server.deps.inline` so
 *    Vite processes it rather than handing it to Node's resolver.
 * 2. **It then reads browser globals at import time.** These five are the whole
 *    set; each is here because removing it produces a crash. `FontFace` is the
 *    trap — it is read at *call* time, from inside conversion, so a shim built
 *    by "import it and see what breaks" misses it.
 *
 * `navigator` is deliberately absent: Node 24 already defines it, getter-only,
 * and assigning to it throws.
 */

/**
 * Advance width per character, as a fraction of the font size.
 *
 * Excalidraw measures text with canvas `measureText`, which is the only thing
 * in conversion that reads real font data — and headless there is no font. The
 * measurement is not cosmetic: it decides where `wrapText` breaks lines and how
 * tall a labelled container grows, so it feeds the scene graph's structure, not
 * just its sizes. Left to a stub `measureText` the numbers would be whatever
 * the stub happened to return; pinning them here makes headless conversion
 * deterministic and explicit instead of accidental.
 *
 * It is an approximation, not Excalifont. Nothing headless should grade text
 * `width`/`height`, a wrapped `text` string's line breaks, or a container sized
 * by its label.
 */
const CHARACTER_WIDTH_RATIO = 0.5;

const globals = globalThis as Record<string, unknown>;

globals.window ??= { location: { origin: "http://localhost" } };
globals.devicePixelRatio ??= 1;
// `canvas-roundrect-polyfill` patches prototypes as it is imported.
globals.Element ??= class {};
globals.FontFace ??= class {
  load() {
    return Promise.resolve(this);
  }
};
globals.document ??= {
  fonts: { add() {}, check: () => true, load: async () => [] },
  // Read at import time by a `"filter" in getContext("2d")` feature detection.
  // `measureText` is absent on purpose: the custom metrics provider below
  // replaces it, and a stub would only hide it being bypassed.
  createElement: () => ({ getContext: () => ({}) }),
};

const { setCustomTextMetricsProvider } = await import("@excalidraw/excalidraw");

setCustomTextMetricsProvider({
  getLineWidth: (text, fontString) =>
    text.length * Number.parseFloat(fontString) * CHARACTER_WIDTH_RATIO,
});
