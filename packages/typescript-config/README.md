# @repo/typescript-config

Shared `tsconfig.json` bases for the workspace. Not published and not built — consumers extend the JSON directly.

| File                 | For                                                                            |
| -------------------- | ------------------------------------------------------------------------------ |
| `base.json`          | Everything; strict, `NodeNext` resolution, ES2022 target                       |
| `nextjs.json`        | Next.js apps; extends `base.json`, switches to `ESNext`/`Bundler` and `noEmit` |
| `react-library.json` | React packages; extends `base.json` and adds the JSX runtime                   |

## Usage

Add the workspace dependency, then extend:

```jsonc
// apps/<app>/tsconfig.json
{
  "extends": "@repo/typescript-config/nextjs.json",
}
```

`react-library.json` is used by `@repo/design-system`. That package ships source rather than build output, so it overrides `moduleResolution`/`module` to `Bundler`/`ESNext` and turns off `declaration` — the inherited `NodeNext` + `declaration` defaults here suit a package that actually emits.
