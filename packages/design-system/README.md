# @repo/design-system

The workspace's UI layer: [shadcn/ui](https://ui.shadcn.com) components and the Tailwind theme they read from. Not published and not built — apps import the `.tsx` source directly through the `exports` map.

## Layout

```
components.json         shadcn CLI config (style base-vega, Base UI primitives, lucide icons)
postcss.config.mjs      Shared PostCSS config; apps/web re-exports it
src/
  components/           shadcn primitives, one file per registry item
  components/chat/      Compositions written here, not vendored
  lib/utils.ts          cn()
  styles/globals.css    Tailwind entry + design tokens
```

`src/components/*.tsx` at the top level is **vendored source**: `shadcn add` rewrites those files wholesale, so local edits are lost on the next update. Anything hand-written belongs in a subdirectory.

## Consuming it

```tsx
import { Button } from "@repo/design-system/components/button";
import { cn } from "@repo/design-system/lib/utils";
```

An app needs four things: `"@repo/design-system": "workspace:*"`, `transpilePackages: ["@repo/design-system"]` in its Next config, a `paths` entry mapping `@repo/design-system/*` to `../../packages/design-system/src/*`, and a `globals.css` that imports this package's:

```css
@import "@repo/design-system/globals.css";
@source "../../../packages/design-system/src";
```

The `@source` line is not optional — Tailwind v4 scans the importing project's tree, so without it every class used only inside this package is tree-shaken away.

## Adding components

```sh
pnpm dlx shadcn@latest add <component> -c packages/design-system
```

**Presets and themes are applied from the app, not from here:**

```sh
pnpm dlx shadcn@latest apply <preset-code> -c apps/web
```

`init` and `apply` refuse to run against this package — they glob the working directory for a framework config file (`next.config.*`, `vite.config.*`, `astro.config.*`, `composer.json`, …) and a UI package has none, so detection falls through to `manual` and the command exits. `add` skips that check, which is why it works here.

Running from `apps/web` satisfies the check via its `next.config.ts`, and `apps/web/components.json` resolves `ui`, `utils`, and the Tailwind CSS file into this package, so the writes still land in the right place. `apply` updates both `components.json` files and rewrites the fonts in `apps/web/app/layout.tsx`. It also drops a duplicate `cn()` at `apps/web/lib/utils.ts` — delete it; the app's `utils` alias already points here.

## Theme

`src/styles/globals.css` carries the token set from preset `b1Z6CCvHU` — style `vega`, base colour `zinc`, `cyan` theme, `blue` charts — as `:root` for light and `.dark` for dark, plus three imports: `tailwindcss`, `tw-animate-css`, and `shadcn/tailwind.css`. That last one ships the `scroll-fade` and `shimmer` utilities the chat primitives depend on.

Dark mode is class-based (`@custom-variant dark (&:is(.dark *))`) and nothing toggles the class yet, so the app renders light-only.

## Chat

`src/components/chat/` composes the shadcn chat primitives (`MessageScroller`, `Message`, `Bubble`, `Marker`) into a drop-in panel:

```tsx
<ChatPanel messages={messages} status={status} onSend={send} />
```

`ChatMessage` / `ChatStatus` in `chat/types.ts` mirror the AI SDK's `UIMessage` and `useChat` status union — messages are lists of parts, and tool calls arrive as `tool-<name>` parts. Nothing here fetches; wiring a real transport means replacing the caller, not the panel.

`MessageScroller` owns follow-while-streaming, turn anchoring, and jump-to-latest. Don't add scroll bookkeeping around it.
