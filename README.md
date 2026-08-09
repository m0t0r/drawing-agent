# drawing-agent

Turborepo monorepo for the drawing-agent project. It holds a single Next.js app — an Excalidraw canvas with a chat panel beside it — plus a shared design system and a shared TypeScript config package. There is no model behind the chat yet; sending a prompt draws a labelled box.

## Requirements

- Node 24 (the repo's `@types/node` tracks that major; `engines` permits >= 18)
- pnpm 9 (pinned via `packageManager`)

```sh
pnpm install
```

## Layout

```
apps/
  web/                  Next.js 16 App Router app — React 19, Tailwind CSS 4, React Compiler
packages/
  design-system/        shadcn/ui components + the Tailwind theme (@repo/design-system)
  typescript-config/    Shared tsconfig bases (@repo/typescript-config)
```

Workspaces are `apps/*` and `packages/*`. Shared packages are unbuilt: apps consume them as `workspace:*` and import their source directly.

## Commands

Run from the repo root — Turborepo fans each task out across the workspace.

| Command             | What it does                                                |
| ------------------- | ----------------------------------------------------------- |
| `pnpm dev`          | Start all apps in watch mode (web on http://localhost:3000) |
| `pnpm build`        | Production build                                            |
| `pnpm lint`         | oxlint                                                      |
| `pnpm check-types`  | `next typegen` + `tsc --noEmit`                             |
| `pnpm format`       | oxfmt, rewriting files in place                             |
| `pnpm format:check` | oxfmt in check mode, for CI                                 |

Scope any task to one package with a filter:

```sh
pnpm exec turbo dev --filter=web
```

Package-local scripts also work from inside `apps/web`.

No test runner is set up yet.

## Toolchain

| Concern             | Tool                                         |
| ------------------- | -------------------------------------------- |
| Build orchestration | Turborepo 2                                  |
| Language            | TypeScript 7 (the native Go compiler)        |
| Linting             | oxlint                                       |
| Formatting          | oxfmt                                        |
| UI components       | shadcn/ui (Base UI primitives, `vega` style) |

Linting and formatting are entirely [oxc](https://oxc.rs) — ESLint and Prettier were both removed. oxlint is configured per package (`apps/web/.oxlintrc.json`, `packages/design-system/.oxlintrc.json`); oxfmt is configured once at the root (`.oxfmtrc.json`) and runs repo-wide, honouring `.gitignore`.

Two constraints worth knowing before changing versions:

- **TypeScript 7 ships no JavaScript compiler API.** Any tool that consumes the TypeScript API programmatically — typescript-eslint, ts-jest, ts-morph — cannot be added until the API returns in 7.1. Nothing in the repo depends on it today.
- **oxfmt is pre-1.0.** Its output can change between minor releases, so bump it in its own commit to keep repo-wide reformatting out of feature diffs.

`CLAUDE.md` carries the same context in more detail, for coding agents.
