# Target: Web — CSS custom properties + TypeScript


## Contents

- Output
- Which one to use where
- Theming
- Tailwind
- `colorFormat` — matching a project that already exists
- `cssPrefix` — when it earns its keep
- Colour format
- Type checking

---

## Output

```
src/tokens/
  tokens.css   :root { --… } + one utility class per text style
  tokens.ts    typed mirror: literals, var() references, and key types
```

```css
:root {
  /* Colour */
  --text-primary-default: #030712;
  --color-mono-black-10: rgb(0 0 0 / 0.102);

  /* spacing */
  --spacing-8: 8px;

  /* Shadow */
  --shadow-md: 0 0 1px 0 var(--color-shadow-md-edge), 0 8px 24px -4px var(--color-shadow-md-ambient);

  /* Typography */
  --body-lg-bold-font-family: "Google Sans", sans-serif;
  --body-lg-bold-font-size: 16px;
  --body-lg-bold-font-weight: 700;
  --body-lg-bold-line-height: 1.375;
}

.body-lg-bold {
  font-family: var(--body-lg-bold-font-family);
  font-size: var(--body-lg-bold-font-size);
  font-weight: var(--body-lg-bold-font-weight);
  line-height: var(--body-lg-bold-line-height);
  letter-spacing: var(--body-lg-bold-letter-spacing, normal);
}
```

```ts
export const color = { textPrimaryDefault: "#030712" } as const;
export const colorVar = { textPrimaryDefault: "var(--text-primary-default)" } as const;
export const spacing = { n8: 8 } as const;
export const typography = {
  bodyLgBold: { fontFamily: "Google Sans, sans-serif", fontSize: "16px", fontWeight: 700, lineHeight: 1.375 },
} as const;
export const boxShadow = { shadowMd: "0 0 1px 0 rgb(0 0 0 / 0.122), 0 8px 24px -4px rgb(0 0 0 / 0.122)" } as const;
export const boxShadowVar = { shadowMd: "var(--shadow-md)" } as const;

export type ColorToken = keyof typeof color;
```

A shadow's colour stays a `var()` in the CSS, so re-theming
`--color-shadow-md-edge` re-themes every shadow built on it — the structure
Figma has. The lengths are literals on purpose: they are exported alongside
(`--shadow-radius-md`) for anyone who wants them, and a `box-shadow` assembled
from four nested `var()` calls is unreadable in devtools. The `boxShadow`
literals resolve the colours, because a `var()` cannot resolve in a JS string.

`boxShadow`, not `shadow`: a design system with a `shadow/*` dimension
namespace (offsets, radii, spreads) already exports `shadow`. Where a namespace
and a fixed name really do collide — a `typography/font-size/*` scale next to
text styles — the styles keep `typography` and the scale becomes
`typographyScale`.

Options:

| key | effect |
|---|---|
| `cssPrefix` | namespaces every var and class (`"ds-"` → `--ds-text-primary-default`) |
| `dimensionUnit` | `"px"` (default), `"rem"` (divided by `remBase`), or `"raw"` |
| `remBase` | denominator for `rem`, default 16 |
| `react` | `true` adds `satisfies Record<string, React.CSSProperties>` and the type import |
| `typographyClasses` | `false` omits the utility classes, vars only |
| `tailwind` | `4` adds `@theme` blocks to `tokens.css`; `3` adds `tokens.tailwind.cjs` for `theme.extend` |
| `colorFormat` | `"rgb"` (default) or `"hex"` — how a colour with alpha is spelled |

## Which one to use where

**Use `colorVar` in components.** A `var(--…)` reference is themeable at
runtime — a `[data-theme="dark"]` block or a scoped `:root` override reaches
every component at once. A literal baked into a component is frozen at build
time and there is no override that reaches it.

**Use `color` literals only where a var cannot go**: canvas 2D, inline SVG
presentation attributes, JS-driven animation that interpolates colours, or a
value sent to a non-CSS consumer.

This is why both are generated. A single "just use the object" export quietly
pushes people into the frozen path.

## Theming

`tokens.css` writes one `:root` block — one mode. Add themes by overriding the
same var names, hand-written, next to the generated file:

```css
/* src/tokens/theme-dark.css — hand-written */
:root[data-theme="dark"] {
  --text-primary-default: #f9fafb;
  --surface-main-primary: #030712;
}
```

Only semantic tokens should ever be overridden. If a theme file overrides a
primitive (`--color-mono-black`), the primitive scale has stopped meaning
anything and the semantic layer is missing from the Figma file — fix it there,
not here.

For a second extracted mode, generate `tokens.dark.json` into its own `out`
and wrap the result in the theme selector rather than hand-maintaining values.

## Tailwind

A custom property in `:root` produces no Tailwind utility. Without this option
the project keeps a second, hand-written list mapping every token to a theme
entry — the two-source split this pipeline exists to remove. **The option
carries the major version**, because the two majors need entirely different
output and emitting the wrong one produces no utilities *and no error*.

**`tailwind: 4`** appends two blocks to `tokens.css`:

```css
:root            { --surface-primary: #e50913; }
@theme inline    { --color-surface-primary: var(--surface-primary); }  /* themeable */
@theme           { --spacing-md: 16px; --shadow-md: 0 8px 24px -4px …; }
```

Colours keep the `var()` hop so a mode block still reaches every utility built
on them. Scales go in directly — nothing re-themes a spacing ramp, and `@theme`
emits the custom properties itself, so repeating them in `:root` would be two
declarations of one token.

**`tailwind: 3`** adds `tokens.tailwind.cjs` instead, since v3 builds utilities
from the config file:

```js
// tailwind.config.js — hand-written
const tokens = require('./src/tokens/tokens.tailwind.cjs');
module.exports = { theme: { extend: { ...tokens } } };
```

`.cjs` because it has to load from both worlds: a CommonJS config can `require`
it, an ESM or TS config can `import` it. The reverse is not true.

Colours nest by token path with a `default` leaf becoming `DEFAULT`, because v3
flattens nested colour objects and maps `DEFAULT` to the bare key — so
`color/primary/default` yields `bg-primary`, not `bg-primary-default`. A
leading `color/` or `colors/` segment is dropped once, leaving the utility name
equal to the custom property it points at.

Four things this deliberately does not do:

- **Opacity modifiers do not compose.** `bg-primary/50` needs a colour in
  channel form; a `var()` value cannot provide one. Keeping the var is worth
  more than the modifier — freezing values to regain it would cost the theming.
- **`fontFamily` is not emitted.** A v3 `fontSize` entry cannot carry it, and
  font loading belongs to the project. The whole text style, family included,
  is the generated utility class in `tokens.css`.
- **A token named `spacing/8` shadows Tailwind's own `8`.** That is the design
  system taking ownership of its scale, but it is worth knowing before `p-8`
  changes meaning.
- **v3 and v4 name colours differently on purpose** — `bg-primary` under v3
  (matching what v3 projects already write), `bg-primary-default` under v4
  (matching v4's own convention). Migrating between majors renames utilities.

## `colorFormat` — matching a project that already exists

The default spells a colour with alpha as `rgb(0 0 0 / 0.027)`. A project whose
CSS is written as `#00000007` will diff on every one of those lines even though
nothing changed. `colorFormat: "hex"` keeps 8-digit hex, so adopting the
pipeline shows only the values that genuinely moved. Opaque colours are
`#rrggbb` either way.

## `cssPrefix` — when it earns its keep

Skip it in an app. Use it in a library or anything embedded in a host page:
unprefixed `--spacing-8` will collide with someone else's, and CSS custom
properties inherit, so the collision silently wins inside your subtree.

## Colour format

Fully opaque colours emit `#rrggbb`; anything with alpha emits
`rgb(r g b / a)` — space-separated CSS Color 4 syntax, supported by every
current browser and more readable in a diff than 8-digit hex. If you must
support a browser without Color 4 (real IE-era targets only), change `cssColor`
in `lib/targets/web.mjs` to emit legacy `rgba(r, g, b, a)`.

## Type checking

The generated `tokens.ts` passes `tsc --strict` with no dependencies. `react:
true` adds `import type React from 'react'` — only enable it in a project that
has React types, or the token file becomes a compile error for everyone.

Commit both files. `generate.mjs --check` in CI compares against them.
