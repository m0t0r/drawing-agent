# `convertToExcalidrawElements` outside the browser

**Date:** 2026-08-14
**Scope:** Whether Excalidraw's **element skeleton** → **runtime element** conversion runs in Node; the minimum environment it needs; whether its text measurement is deterministic and whether it is correct; and the concrete type differences between `ExcalidrawElementSkeleton` and `ExcalidrawElement`.
**Method:** Everything below was executed, not reasoned about. Every claim cites either a file path under `node_modules` or a command plus its verbatim output.
**Versions:** `@excalidraw/excalidraw@0.18.1`, Node `v24.11.0`, Vitest `4.1.10`. The package resolves from `apps/web/node_modules/@excalidraw/excalidraw` → `node_modules/.pnpm/@excalidraw+excalidraw@0.18.1_…/node_modules/@excalidraw/excalidraw`. Paths below are abbreviated as `<pkg>`.

---

## Summary

- **Plain `node` cannot import the package at all.** Three separate bundler-only assumptions in the shipped ESM bundle break Node's resolver before a single line of Excalidraw code runs: extensionless specifiers, a JSON import without an import attribute, and CJS named-export interop. This is a _resolution_ failure, not a DOM failure.
- **Through Vite/Vitest the import resolves, and then fails on `window`.** `ReferenceError: window is not defined` at `<pkg>/constants.ts:9`. Import-time, not call-time.
- **The minimum viable environment is a bundler plus five globals** — `window.location.origin`, `devicePixelRatio`, `Element`, `FontFace`, and a `document` with `fonts` and a `createElement()` returning something with `getContext()`. Roughly 25 lines. No jsdom, no `node-canvas`. Neither `jsdom` nor `happy-dom` is installed in this repo and neither is needed.
- **Text measurement is `CanvasRenderingContext2D.measureText`** and it is the _only_ thing that reads real font data. In Node, whatever the stub `measureText` returns _becomes the element geometry_. So conversion in Node is **deterministic** (given a fixed measurement function) but **arbitrary** — the widths are as right or wrong as the stub.
- **Excalidraw ships a supported escape hatch: `setCustomTextMetricsProvider`**, a public root export, explicitly documented as being "for overriding the width calculation algorithm where canvas API is not available". This is the intended way to make Node conversion deterministic.
- **A wrong measurement is not just wrong sizes — it changes the element `text` and the container's `width`/`height`.** Demonstrated below: the same skeleton yields a 2-line label in a 100px-tall box under one metric and a 5-line label in a 135px-tall box under another.
- **The clipping mechanism described in `apps/web/lib/excalidraw-fonts.ts` is confirmed in source.** When a font later loads, `Fonts.onLoaded` invalidates the _shape cache_ only; it never calls `redrawTextBoundingBox`, so the fallback-font `width`/`height` stay baked into the element forever.
- **Practical limit for a pure core:** a pure `@repo/agent` module may safely construct, validate and reason about **element skeletons**, and may run conversion for _structure_ (bindings, containment, ids, ordering, relative layout of non-text elements). It must not treat converted text geometry as ground truth. Scorers that assert on text `width`/`height`, on the wrapped `text` string, or on a label-driven container size are measuring the stub, not Excalidraw.

---

## 1. Plain Node: three failures before any Excalidraw code runs

Script (`scratchpad/convert.mjs`), importing the bare specifier with `apps/web/node_modules` symlinked in so resolution matches the app:

```js
import { convertToExcalidrawElements } from "@excalidraw/excalidraw";

const skeleton = [
  {
    type: "rectangle",
    x: 0,
    y: 0,
    width: 200,
    height: 100,
    id: "rect1",
    label: { text: "Hello label" },
  },
  { type: "text", x: 0, y: 200, text: "plain text element" },
  {
    type: "arrow",
    x: 210,
    y: 50,
    id: "arr1",
    start: { type: "rectangle", id: "rect1" },
    end: { type: "ellipse", id: "ell1" },
  },
];

console.log(JSON.stringify(convertToExcalidrawElements(skeleton), null, 2));
```

### 1a. Extensionless specifier

```
$ node convert.mjs
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/node_modules/roughjs/bin/rough'
imported from …/@excalidraw/excalidraw/dist/prod/index.js
Did you mean to import "roughjs/bin/rough.js"?
    at finalizeResolution (node:internal/modules/esm/resolve:274:11)
```

`dist/prod/index.js` imports `roughjs/bin/rough` with no extension — legal for a bundler, illegal for Node ESM.

### 1b. JSON import with no import attribute

With a resolve hook that retries extensionless specifiers with `.js`:

```
$ node --experimental-loader ./ext-hook.mjs convert.mjs
TypeError [ERR_IMPORT_ATTRIBUTE_MISSING]: Module "…/open-color/open-color.json"
needs an import attribute of "type: json"
    at validateAttributes (node:internal/modules/esm/assert:88:15)
```

### 1c. CJS named-export interop

With the JSON attribute also injected by the hook:

```
$ node --experimental-loader ./ext-hook.mjs convert.mjs
SyntaxError: The requested module '@excalidraw/laser-pointer' does not provide
an export named 'LaserPointer'
    at #_instantiate (node:internal/modules/esm/module_job:254:21)
```

**Verdict for step 1–3(a):** the answer to "does it run in a bare Node process" is **no, and not for DOM reasons**. `@excalidraw/excalidraw@0.18.1` publishes a bundle that only a bundler can load. Reaching the DOM question at all requires Vite, esbuild, webpack or equivalent. Note that `dist/prod` is what plain Node picks (the `default` condition in `<pkg>/package.json`); under Vitest the `development` condition selects `dist/dev`, which is the same code with sourcemaps.

---

## 2. Through Vitest: `window is not defined`

Config (`scratchpad/vitest.tmp.config.mts`, run from `packages/agent` so its Vitest binary is used). `server.deps.inline` is load-bearing — without it Vitest externalises the package and hands it to Node's resolver, reproducing §1a exactly.

```js
export default {
  root: SCRATCH,
  test: {
    globals: true,
    environment: "node",
    include: ["convert.test.ts"],
    setupFiles: [`${SCRATCH}/shim-min.mts`],
    server: { deps: { inline: [/@excalidraw/, /roughjs/, /open-color/] } },
  },
};
```

```
$ cd packages/agent && ./node_modules/.bin/vitest run --config …/vitest.tmp.config.mts
 FAIL  convert.test.ts [ convert.test.ts ]
ReferenceError: window is not defined
 ❯ …/@excalidraw/excalidraw/constants.ts:9:17
 ❯ …/@excalidraw/excalidraw/dist/dev/index.js:66:31
 ❯ convert.test.ts:1:1
```

**Failure mode: import-time crash.** The stack ends at `convert.test.ts:1:1`, the `import` statement.

---

## 3. The minimum viable environment

Bisected by adding one global at a time and re-running until the test passed. Each entry below is there because removing it produced the quoted error.

| Global                                  | Error if absent                                                                                                                                          | Why                                                                 |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `window.location.origin`                | `ReferenceError: window is not defined`, then `TypeError: Cannot read properties of undefined (reading 'origin')` at `constants.ts:252`                  | module-scope constants                                              |
| `devicePixelRatio`                      | `ReferenceError: devicePixelRatio is not defined`                                                                                                        | module-scope constants                                              |
| `Element`                               | `ReferenceError: Element is not defined` at `polyfill (…)`                                                                                               | `canvas-roundrect-polyfill` patches prototypes on import            |
| `document.createElement().getContext()` | called at import time by `var supportsContextFilters = "filter" in document.createElement("canvas").getContext("2d")` — `<pkg>/dist/dev/index.js:14351`  | feature detection                                                   |
| `FontFace`                              | `ReferenceError: FontFace is not defined` — **runtime**, inside `convertToExcalidrawElements → getLineHeight → Fonts.registered → Fonts.init → register` | font registry builds `FontFace` objects lazily on first measurement |
| `document.fonts`                        | —                                                                                                                                                        | needed once `Fonts` is touched                                      |

Two things it does **not** need: `navigator` (Node 24 already defines it, and it is getter-only — assigning throws `TypeError: Cannot set property navigator of #<Object> which has only a getter`), and `matchMedia`, `ResizeObserver`, `localStorage`, `HTMLCanvasElement`, `Image` (a first, fatter shim included all of these; removing them changed nothing — both shims produced byte-identical geometry).

The working minimum, in full:

```ts
const g = globalThis as any;
g.window = { location: { origin: "http://localhost" } };
g.devicePixelRatio = 1;
g.Element = class Element {};
g.FontFace = class FontFace {
  load() {
    return Promise.resolve(this);
  }
};
g.document = {
  fonts: { add() {}, check: () => true, load: async () => [] },
  createElement: () => ({
    getContext: () => ({
      measureText: (t: string) => ({ width: t.length * 10 }),
      set font(_v: string) {},
    }),
  }),
};
```

With it, conversion succeeds:

```
 Test Files  1 passed (1)
      Tests  1 passed (1)
```

Note the `FontFace` requirement is a **runtime** crash, not an import-time one — the import succeeds and `convertToExcalidrawElements` throws. Any shim built by "import it and see" will miss this.

### Conversion output (5 elements from a 3-element skeleton)

Abbreviated from `out-shim.json`; ids are the generated ones.

```
rectangle  id=bU7QHAuwMNG1PiekYDzsz  200×100  boundElements=[{text,UeAy…},{arrow,twZD…}]
text       id=Mq7iCcQ2widfvFovF3azS  180×25   "plain text element"  containerId=null  fontFamily=5
arrow      id=twZDuUPL-jx_4MM6FyrWn  100×0    startBinding={elementId:bU7Q…,focus:0,gap:10}
                                              endBinding  ={elementId:0vtr…,focus:0,gap:1}
text       id=UeAyfvx12EqQnTWaKx27i  110×25   "Hello label"  containerId=bU7Q…  x=45 y=37.5
ellipse    id=0vtrMc4LYjgtG4ypyjAmM  100×100  boundElements=[{arrow,twZD…}]
```

Three behaviours worth recording:

1. **A fifth element appeared.** The arrow's `end: { type: "ellipse", id: "ell1" }` referenced an id that is not in the skeleton array, so conversion **fabricated** a default 100×100 ellipse at `(310, 0)` — and did so **silently**. `<pkg>/dist/dev/index.js:22206-22209` does `Object.assign(end, { id: oldToNewElementIdMap.get(end.id) })` unconditionally; an unknown id becomes `undefined`, which then skips the `console.error("No element for end binding …")` branch at `:21912` and falls through to `newElement({...end})` with `id: undefined` → a fresh `randomId()`. **A dangling arrow binding is not an error; it silently invents geometry.** Anything validating agent output must check binding ids itself.
2. **Ids are regenerated by default.** `opts.regenerateIds` defaults to `true` (`<pkg>/dist/dev/index.js:22041`). Passing `{ regenerateIds: false }` preserves them — verified: `rect1` and `arr1` came back verbatim. The fabricated ellipse still got a random id, per (1).
3. **`fontFamily: 5` is Excalifont** (`<pkg>/dist/dev/chunk-4FTI6OG3.js:192`), the default.

---

## 4. Text measurement

### 4.1 It is canvas `measureText`, with an official override

`<pkg>/dist/types/excalidraw/element/textMeasurements.d.ts` and its implementation at `<pkg>/dist/dev/chunk-4FTI6OG3.js:1830-1918`:

```js
var measureText = (text, font, lineHeight) => {
  const _text = text
    .split("\n")
    .map((x) => x || " ")
    .join("\n");
  const fontSize = parseFloat(font);
  const height = getTextHeight(_text, fontSize, lineHeight); // fontSize * lineHeight * lineCount
  const width = getTextWidth(_text, font); // max over lines of getLineWidth
  return { width, height };
};

var CanvasTextMetricsProvider = class {
  constructor() {
    this.canvas = document.createElement("canvas");
  }
  getLineWidth(text, fontString) {
    const context = this.canvas.getContext("2d");
    context.font = fontString;
    const metrics = context.measureText(text);
    return metrics.width; // advance width
  }
};

var getLineWidth = (text, font) => {
  if (!textMetricsProvider) {
    textMetricsProvider = new CanvasTextMetricsProvider();
  }
  return textMetricsProvider.getLineWidth(text, font);
};
```

So: **width comes from canvas `measureText` only; height is pure arithmetic** (`fontSize × lineHeight × lineCount`) and needs no font at all. There is no DOM-based fallback path — no offscreen `<span>`, no character table. If `getContext("2d")` returns something without `measureText`, it throws.

`<pkg>/dist/types/excalidraw/element/textMeasurements.d.ts:23-31` documents the escape hatch verbatim:

```ts
/**
 * Set a custom text metrics provider.
 *
 * Useful for overriding the width calculation algorithm where canvas API is not available / desired.
 */
export declare const setCustomTextMetricsProvider: (provider: TextMetricsProvider) => void;
export interface TextMetricsProvider {
  getLineWidth(text: string, fontString: FontString): number;
}
```

It is re-exported from the package root — `<pkg>/dist/types/excalidraw/index.d.ts:45` — so it is public API, not an internal.

Verified end-to-end: with `getLineWidth = text.length * fontSize * 0.6`, the same skeleton produced `"plain text element"` at width **216** (18 × 20 × 0.6) and `"Hello label"` at **132** (11 × 20 × 0.6), against **180** and **110** from the `text.length * 10` canvas stub. Measurement is fully injectable.

With a custom provider installed before conversion, `CanvasTextMetricsProvider` is never constructed — but `document.createElement("canvas").getContext("2d")` is _still_ required, because the import-time `supportsContextFilters` check runs regardless. Verified: a shim whose `createElement` returns `{ getContext: () => ({}) }` (no `measureText` at all) plus a custom provider converts successfully.

### 4.2 Where conversion measures

Two call sites, both inside `convertToExcalidrawElements`:

- Standalone text — `<pkg>/dist/dev/index.js:22091-22102`: `measureText(normalizedText, getFontString({fontFamily, fontSize}), lineHeight)` feeds `newTextElement({ width: metrics.width, height: metrics.height, … })`.
- Labels — `bindTextToContainer` (`:21808-21826`) calls `redrawTextBoundingBox(textElement, container, elementsMap)`.

`redrawTextBoundingBox` (`<pkg>/dist/dev/chunk-4FTI6OG3.js:14560-14608`) does three things with the measurement:

```js
boundTextUpdates.text = wrapText(textElement.originalText, getFontString(textElement), maxWidth);
const metrics = measureText(boundTextUpdates.text, getFontString(textElement), textElement.lineHeight);
…
if (metrics.height > maxContainerHeight) { mutateElement(container, { height: nextHeight }); }
if (metrics.width  > maxContainerWidth)  { mutateElement(container, { width:  nextWidth  }); }
```

So the measurement decides (a) the bound text's `width`/`height`, (b) **where the line breaks go in the stored `text` string**, and (c) **the container's dimensions**.

### 4.3 Demonstration: measurement changes content, not just size

Same skeleton — a 200×100 rectangle labelled `"The quick brown fox jumps over the lazy dog"` — converted twice, differing only in the injected per-character width:

```json
{
  "narrow": [
    // 0.4em/char
    { "type": "rectangle", "w": 200, "h": 100 },
    {
      "type": "text",
      "w": 184,
      "h": 50,
      "text": "The quick brown fox\njumps over the lazy dog",
      "lines": 2
    }
  ],
  "wide": [
    // 0.8em/char
    { "type": "rectangle", "w": 200, "h": 135 },
    {
      "type": "text",
      "w": 160,
      "h": 125,
      "text": "The quick\nbrown fox\njumps over\nthe lazy\ndog",
      "lines": 5
    }
  ]
}
```

The container grew from 100 to 135 and the text gained three newlines. **Text measurement is not a cosmetic detail of the conversion; it is an input to the scene graph's structure.**

### 4.4 Determinism, and correctness

**Deterministic:** yes, for geometry — given a fixed metrics provider, `x`/`y`/`width`/`height`/`text`/`containerId`/`boundElements`/`startBinding`/`endBinding` are reproducible. Confirmed by running the fat shim and the minimal shim and diffing: identical.

**Not deterministic**, and never will be, for three fields — from `<pkg>/dist/dev/chunk-4FTI6OG3.js:15019-15022` and `:15057-15085`:

```js
var random = new Random(Date.now());
var randomInteger = () => Math.floor(random.next() * 2 ** 31);
var randomId = () => isTestEnv() ? `id${testIdBase++}` : nanoid();
…
id: rest.id || randomId(),
seed: rest.seed ?? randomInteger(),
updated: getUpdatedTimestamp(),
```

`id` (nanoid), `seed` (seeded from `Date.now()`) and `updated` (epoch ms) vary per run. `versionNonce` defaults to `0` at construction (`:15078`) but is bumped by `mutateElement`, so labelled containers and bound text get non-zero, run-varying values. Any snapshot must strip these. Note `isTestEnv()` is `import.meta.env.MODE === "test"` **baked in at Excalidraw's build time** (`:1464`) — it is `"development"` in `dist/dev` and cannot be flipped from a consumer, so the deterministic `id0`, `id1`, … path is not reachable from this repo.

**Correct?** No, and not "approximately" — arbitrarily. The Node number is whatever the stub returns. There is no relationship to Excalifont's real advance widths, which live only in the `.woff2` files under `<pkg>/dist/prod/fonts/Excalifont/`. Excalidraw's own font metadata (`<pkg>/dist/dev/chunk-4FTI6OG3.js:4517+`) carries `unitsPerEm`/`ascender`/`descender`/`lineHeight` — **vertical metrics only**, no advance widths. Height is therefore reproducible in Node _and correct_; width is reproducible and _meaningless_.

### 4.5 The clipping mechanism, confirmed

`apps/web/lib/excalidraw-fonts.ts` states that Excalidraw measures text at element-creation time and loads Excalifont lazily, so text created too early renders clipped. Both halves check out in source.

Lazy loading — `Fonts.loadFontFaces` (`<pkg>/dist/dev/chunk-4FTI6OG3.js:6851-6866`) is what actually calls `window.document.fonts.add(fontFace)` and `window.document.fonts.load(font, text)`, and it runs from `loadSceneFonts` (`:6806`), i.e. when a scene loads — not at import. Until then the family is unregistered with the browser, which is exactly the state in which `document.fonts.check()` returns `true` and `document.fonts.load()` resolves empty, as the comment in `excalidraw-fonts.ts` warns.

No re-measure on load — `Fonts.onLoaded` (`:6774-6802`) carries the comment "if we load a (new) font, it's likely that text elements using it have already been rendered using a fallback font. Thus, we want invalidate their shapes and rerender. See #637." Its body deletes `ShapeCache` entries and clears `charWidth` caches. **It does not call `redrawTextBoundingBox` or touch `width`/`height` on any element.** The stale fallback measurement is permanent until something else re-measures — which is why double-clicking to edit "fixes" it. The `ensureCanvasFontLoaded` poll in `apps/web` is therefore not belt-and-braces; it is the only thing preventing permanently mis-sized elements.

---

## 5. Skeleton vs runtime element

Sources: `<pkg>/dist/types/excalidraw/data/transform.d.ts` (skeleton), `<pkg>/dist/types/excalidraw/element/types.d.ts` (runtime), `<pkg>/dist/types/excalidraw/element/newElement.d.ts` (`ElementConstructorOpts`).

### 5.1 Signature

```ts
// data/transform.d.ts:79-81
export declare const convertToExcalidrawElements: (
  elementsSkeleton: ExcalidrawElementSkeleton[] | null,
  opts?: { regenerateIds: boolean },
) => import("../element/types").OrderedExcalidrawElement[];
```

### 5.2 The relational fields — the whole point of the distinction

| Concept           | Skeleton (`data/transform.d.ts`)                                                                         | Runtime (`element/types.d.ts`)                                                                                                                                      |
| ----------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Label on a shape  | `ValidContainer.label?: { text: string; fontSize?; fontFamily?; textAlign?; verticalAlign? }` (`:47-53`) | a **separate** `ExcalidrawTextElement` with `containerId: <container id>`, plus `boundElements: [{ type: "text", id }]` on the container (`BoundElement`, `:22-25`) |
| Label on an arrow | `ValidLinearElement.label?` (`:8-14`)                                                                    | same — separate text element, `containerId` set                                                                                                                     |
| Arrow endpoints   | `start?` / `end?`, each `{ type?, id? }` or an inline `{ type: "text", text }` (`:15-42`)                | `startBinding` / `endBinding`: `{ elementId, focus, gap }`, plus `boundElements: [{ type: "arrow", id }]` on the target                                             |
| Arrow geometry    | `x`, `y` only; `width`/`height` optional                                                                 | `points: LocalPoint[]`, `startArrowhead`, `endArrowhead`, `elbowed`, recomputed `width`/`height`                                                                    |

Observed from the run in §3: skeleton `label: { text: "Hello label" }` became a fourth element with `containerId` set and `textAlign: "center" / verticalAlign: "middle"` (defaults applied by `bindTextToContainer`, `<pkg>/dist/dev/index.js:21808-21817`); skeleton `start: { id: "rect1" }` became `startBinding: { elementId, focus: 0, gap: 10 }` **plus** a reciprocal `boundElements` entry on the rectangle. The skeleton expresses relations **once, from the referring side**; the runtime graph stores them **twice, on both ends**. Nothing in the skeleton corresponds to `boundElements`.

### 5.3 What is optional in the skeleton and auto-filled

`ValidContainer` = `{ type, id?, label? } & ElementConstructorOpts`, and `ElementConstructorOpts` (`newElement.d.ts:4`) is `MarkOptional<Omit<ExcalidrawGenericElement, "id"|"type"|"isDeleted"|"updated">, …>` marking optional:

> `width`, `height`, `angle`, `groupIds`, `frameId`, `index`, `boundElements`, `seed`, `version`, `versionNonce`, `link`, `strokeStyle`, `fillStyle`, `strokeColor`, `backgroundColor`, `roughness`, `strokeWidth`, `roundness`, `locked`, `opacity`, `customData`

So a shape skeleton needs only `type`, `x`, `y`; a text skeleton needs `type`, `x`, `y`, `text`; an arrow needs `type`, `x`, `y`. Everything else is filled by `_newElementBase` (`<pkg>/dist/dev/chunk-4FTI6OG3.js:15025-15087`) plus the per-type branches in `convertToExcalidrawElements` (`<pkg>/dist/dev/index.js:22044-22143`):

| Runtime field                                                   | Filled with                                                                                                                | Source                            |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| `id`                                                            | skeleton `id`, else `nanoid()`; **replaced** unless `regenerateIds: false`                                                 | `:15058`, `:22041-22043`          |
| `seed`                                                          | `randomInteger()` from a `Date.now()`-seeded RNG                                                                           | `:15076`, `:15019`                |
| `version`                                                       | `1`                                                                                                                        | `:15077`                          |
| `versionNonce`                                                  | `0`, then bumped by mutations                                                                                              | `:15078`                          |
| `updated`                                                       | epoch ms                                                                                                                   | `:15081`                          |
| `index`                                                         | `null`, then assigned `"a0"`, `"a1"`, … by `syncInvalidIndices` on `getElements()`                                         | `:22018`                          |
| `angle`                                                         | `0`                                                                                                                        | `:15037`                          |
| `strokeColor`                                                   | `"#1e1e1e"`                                                                                                                | `DEFAULT_ELEMENT_PROPS`, observed |
| `backgroundColor`                                               | `"transparent"`                                                                                                            | observed                          |
| `fillStyle` / `strokeStyle`                                     | `"solid"` / `"solid"`                                                                                                      | observed                          |
| `strokeWidth` / `roughness` / `opacity`                         | `2` / `1` / `100`                                                                                                          | observed                          |
| `groupIds` / `boundElements` / `frameId` / `roundness` / `link` | `[]` / `null` / `null` / `null` / `null`                                                                                   | `:15038-15043`                    |
| `isDeleted` / `locked`                                          | `false` / `false`                                                                                                          | `:15079`, `:15044`                |
| `width` / `height` (shapes)                                     | skeleton value, else `100`; **`0` if the shape has a `label` and no explicit size**, then grown by `redrawTextBoundingBox` | `:22048-22049`                    |
| `width` / `height` (arrows/lines)                               | `100` / `0`, then recomputed from `points`                                                                                 | `:21803-21806`, `:22079-22082`    |
| `endArrowhead` (arrows)                                         | `"arrow"`                                                                                                                  | `:22074`                          |
| `width` / `height` (text)                                       | **measured** — see §4                                                                                                      | `:22091-22102`                    |
| `fontFamily` / `fontSize`                                       | `5` (Excalifont) / `20`                                                                                                    | `:22086-22087`                    |
| `lineHeight`                                                    | `Fonts.registered.get(family).metadata.metrics.lineHeight` (`1.25` for Excalifont)                                         | `chunk-4FTI6OG3.js:7033-7036`     |
| `containerId` / `originalText` / `autoResize`                   | `null` / `text` / `true` for standalone text                                                                               | observed                          |

The runtime type also carries fields with **no skeleton counterpart at all**: `index` (fractional index for ordering), `updated`, `version`/`versionNonce` (collaboration reconciliation), and `boundElements`. Their doc comments are in `element/types.d.ts:26-72`.

---

## 6. What this means for a pure core and an eval harness

- A pure `@repo/agent` module can own **element skeletons** end to end — schemas, validation, canvas ops that manipulate skeletons — with zero DOM. That is the boundary CONTEXT.md already draws, and nothing here moves it.
- Running `convertToExcalidrawElements` in Node is **possible** (a ~25-line shim plus `server.deps.inline`) but it drags `@excalidraw/excalidraw` — a React component library — into a package whose stated rule is that nothing there imports React or Excalidraw's imperative API. Weigh that before doing it.
- If it is done, **install a `setCustomTextMetricsProvider` before the first conversion**, unconditionally. Without it the numbers depend on the accidental shape of the canvas stub, which is a far worse failure than an explicit approximation.
- **Scorer boundary.** Safe to grade in Node: element count and types, `containerId`/`boundElements`/`startBinding`/`endBinding` graph shape, label _text content_ (`originalText` is untouched by measurement), and the geometry of elements the model sized explicitly. Not safe: text `width`/`height`, the wrapped `text` string's line breaks, container dimensions that were derived from a label, and any overlap/collision check involving a text element or an auto-sized labelled container.
- **Two silent traps to defend against in validation, independent of Node:** an arrow `end.id` pointing outside the batch fabricates a default 100×100 element rather than erroring (§3, note 1), and ids are regenerated unless `regenerateIds: false` is passed.

---

## Commands, verbatim

All from the worktree root unless noted. Scratchpad files were throwaway and are not in the repo.

```sh
# §1 — plain node, prod bundle
node scratchpad/convert.mjs
node --experimental-loader ./ext-hook.mjs convert.mjs        # cwd = scratchpad

# §2–§4 — vitest, dev bundle
cd packages/agent
SCRATCH=<scratchpad> VITEST_SHIM=shim-min.mts \
  ./node_modules/.bin/vitest run --config <scratchpad>/vitest.tmp.config.mts
```
