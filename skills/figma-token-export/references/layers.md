# Choosing which tokens to export


## Contents

- Why you would export less than everything
- Figma collections vs. what the tools return
- Writing the config
- Pattern syntax
- One-off exports
- Failure modes, all of them loud
- `$layer` in tokens.json

---

> `$S` is this skill's `scripts/` directory — resolve it once per project;
> see **Where the scripts live** in the skill doc.

Export-all is the default. Everything here is opt-in, for when it should not be.

## Why you would export less than everything

A design system has layers. Typical three:

| layer | example | who should reference it |
|---|---|---|
| primitive | `color/blue/500`, `spacing/8` | the design system only |
| semantic | `text/primary/default`, `surface/main/primary` | product code |
| component | `button/primary/bg` | that component only |

A **product app** wants the semantic layer. Exporting primitives into it hands
every developer 400 raw colours and an invitation to pick one directly, which
is exactly the habit a semantic layer exists to prevent.

A **design-system package** wants all of them — it is the thing that maps
primitive to semantic.

So the selection is per target, not per project. One repo can generate both.

## Figma collections vs. what the tools return

Figma models layering as **variable collections** — real names from files in
this org: `1. Primitive`, `2. Alias`, `3. Semantic`, `3.Component`.

The catch: **`get_variable_defs` does not return the collection.** Its output
is a flat `name → value` map, nothing else. So the pipeline matches on the
token **name** instead.

That works because a file with layered collections almost always names its
tokens layered too (`color/**` primitives, `text/**` / `surface/**` semantics).
But confirm it rather than assuming — mapping the wrong prefix to a layer
produces a token file that is wrong in a way nothing downstream will catch.

### Reading the real collection names

`search_design_system` **does** return `variableCollectionName`:

```
search_design_system({
  fileKey: "<file key>",
  query: "primary text color",
  includeVariables: true, includeComponents: false, includeStyles: false
})
```

Verified response fields, per variable: `name`, `libraryName`, `libraryKey`,
`variableType`, `variableCollectionName`, `scopes`, `filePath`. For example
`text/primary/inverse` in `[PP] Design System` reports collection
`3. Semantic`.

Two limits worth knowing before you lean on it:

1. **It searches, it does not enumerate.** You get the top matches for a query,
   not every variable. Use it to *confirm* a mapping — query two or three names
   per layer — never as the extractor.
2. **It searches every library the org can see.** A query for "primary text
   color" comes back with matches from a dozen unrelated design systems. Filter
   by `libraryName`, or pass `includeLibraryKeys` from `get_libraries` to scope
   it to the file's own libraries.

Alternatively, just open the Variables panel in Figma and read the collection
tabs. It is faster, and for a one-time mapping it is enough.

## Writing the config

Start by looking at what actually exists:

```bash
node "$S/verify.mjs"
```

It prints every first path segment with a count and an example — the vocabulary
your globs are written against. Real output from a production file:

```
[verify] namespaces (first path segment):
  color             276  [color]  e.g. color/mono/black
  surface            49  [color]  e.g. surface/main/primary
  border             30  [color]  e.g. border/main/primary
  icon               28  [color]  e.g. icon/primary/default
  text               22  [color]  e.g. text/primary/default
  spacing            22  [dimension]  e.g. spacing/0
  brand              17  [color]  e.g. brand/50
  …
```

Then map them:

```json
"layers": {
  "semantic":   ["text/**", "surface/**", "border/**", "icon/**"],
  "primitive":  ["color/**", "brand/**", "accent/**", "neutral/**", "base/**",
                 "static/**", "success/**", "danger/**", "warning/**", "info/**"],
  "scale":      ["spacing/**", "radius/**", "border-width/**"],
  "typography": ["body/**", "heading/**", "label/**", "display/**", "link/**", "button/**"]
}
```

Layer names are yours — `semantic`/`primitive`/`component` is a convention, not
a requirement. **First match wins**, so list the most specific patterns first.

Then select per target:

```json
"targets": [
  { "type": "flutter", "out": "apps/app/lib/tokens", "prefix": "App",
    "layers": ["semantic", "scale", "typography"] },

  { "type": "flutter", "out": "packages/design_system/lib/src/tokens", "prefix": "PP" }
]
```

The first target gets 199 tokens; the second omits `layers` and gets all 581.

## Pattern syntax

Globs over the slash-separated token path, matched case-insensitively (Figma
names are inconsistently cased — `Body/lg/bold` next to `body/font`).

| pattern | matches |
|---|---|
| `color/**` | everything under `color/` at any depth |
| `color/*` | exactly one segment below `color/` |
| `*/primary/**` | any first segment, then `primary/` |
| `text/primary` | that exact token |

Selectors combine as **layers → include → exclude**. Any that is omitted means
"everything", which is why the default exports all.

```json
{ "type": "web", "out": "src/tokens", "exclude": ["**/deprecated/**"] }
```

## One-off exports

No config edit needed; the CLI selector overrides every target for that run:

```bash
node "$S/generate.mjs" --layers semantic
node "$S/generate.mjs" --target web --exclude "color/**"
node "$S/generate.mjs" --include "text/**,surface/**"
```

Useful for answering "what would the app-facing set look like?" without
committing to it.

## Failure modes, all of them loud

- A selection matching **0 tokens** aborts the run. An empty generated file is
  indistinguishable from a design system with no tokens, so it is never
  written.
- A `layers` entry naming a layer that **no token carries** is reported as a
  warning at generation and a problem in `verify.mjs` — that is what a typo or
  a renamed namespace looks like.
- A `target.layers` value **not defined** in the top-level `layers` map fails
  config validation before anything runs.
- Tokens matching **no layer** get `$layer: null`, are listed by `verify.mjs`,
  and are still exported unless a target selects specific layers. Unclassified
  never means dropped.

## `$layer` in tokens.json

Extraction stamps the layer onto each token:

```json
"text/primary/default": { "$type": "color", "$value": "#030712FF", "$layer": "semantic" }
```

It is stored rather than computed on the fly so the layering shows up in the
`tokens.json` diff. When a designer moves a token between collections and
renames it accordingly, that line changes in review — which is the moment to
notice, not after it lands in the wrong package.

The config remains the authority: `generate.mjs` re-stamps from `layers` on
every run, so editing the patterns takes effect without re-extracting.
