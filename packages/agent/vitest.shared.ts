/**
 * What both configs need to run the canvas ops headlessly.
 *
 * `@excalidraw/excalidraw` publishes a bundle only a bundler can load, so Vite
 * has to process it rather than externalise it to Node's resolver; and it reads
 * browser globals at import time, so the shim has to be installed first. See
 * `src/canvas/headless-environment.ts` for the measurements behind both.
 */
export const headlessExcalidraw = {
  setupFiles: ["./src/canvas/headless-environment.ts"],
  server: { deps: { inline: [/@excalidraw/, /roughjs/, /open-color/] } },
};
