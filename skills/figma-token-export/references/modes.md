# Modes — light/dark and every other column


## Contents

- Ask first
- Extracting each mode
- How it is stored
- What each target emits
- Narrowing a run
- Failure modes, all of them loud
- Alias linking and modes together

---

> `$S` is this skill's `scripts/` directory — resolve it once per project;
> see **Where the scripts live** in the skill doc.

## Ask first

`AskUserQuestion` before extracting, not after. A mode is a *column* in a Figma
variable collection, and `get_variable_defs` resolves to whichever column is
active in the file — so every mode is a separate extraction pass, and each one
needs a human to switch the mode in Figma first. Discovering halfway through
that dark mode was also wanted costs a full round trip.

Offer the modes the file has, plus an all/default option, and let the answer be
multi-select:

> **Which modes should the export cover?**
> `Light` · `Dark` · `All modes` · `Default only — whatever is active in Figma now`

Find the mode names before asking, rather than offering guesses:

- ask the user to open **Variables** in Figma and read the column headers, or
- call `search_design_system` and read `variableCollectionName` — modes live
  inside collections.

A file having a colour named `inverse` is not evidence of a dark mode.

## Extracting each mode

One dump per mode per frame. Keep them in separate folders so it stays obvious
which is which, and commit them:

```
dumps/
  light/  foundations.json  semantic.json
  dark/   foundations.json  semantic.json
```

```bash
node "$S/sync.mjs" dumps/light dumps/dark        # both modes, diff, verify, regenerate
```

`sync` recognises the directory-per-mode layout: each directory's basename is
the mode name, and **the first one on the command line is the default mode**
(alphabetical order would silently make `dark` the default). It is the command
to use day to day. The underlying steps, if you need them separately:

```bash
node "$S/normalize-mcp.mjs" dumps/light/*.json --mode light
node "$S/normalize-mcp.mjs" dumps/dark/*.json  --mode dark --merge
```

The first run (no `--merge`) writes the file and records `$meta.defaultMode`.
Every later run merges that mode into the tokens already there. `--merge`
without an existing token file is an error — it would otherwise silently create
a file whose "default" is the wrong mode.

## How it is stored

```json
"color/surface/base": {
  "$type": "color",
  "$value": "#FFFFFFFF",
  "$modes": { "dark": "#111111FF" },
  "$layer": "semantic"
}
```

The default mode stays in `$value`, exactly where a single-mode file always put
it. That is what keeps every older token file and every generator working
unchanged: **no `$modes` key means one mode.**

Merging reports divergence instead of smoothing it over:

- a token in the merged mode but not the default → kept, with a warning
- a token in the default but missing from the merged mode → warned, and it
  falls back to the default value

Both usually mean a variable that only one collection defines, which is a
question for design, not something a script should decide.

## What each target emits

**web** — the default mode fills `:root`; each extra mode gets a block with
**only the tokens that differ**:

```css
:root {
  --color-surface-base: #ffffff;
  --palette-brand-500: #ff5900;
}

/* mode: dark */
:root[data-theme="dark"] {
  --color-surface-base: #111111;
}
```

`--palette-brand-500` is absent from the dark block because it does not change.
A theme *is* an override set; restating identical tokens hides which ones the
mode really touches. Change the selector per mode when the app uses a different
convention:

```json
{ "type": "web", "out": "src/tokens",
  "modeSelectors": { "dark": "[data-theme=\"dark\"]" } }
```

Default when unset: `:root[data-theme="<mode>"]`.

**flutter** — `colors_modes.g.dart` with one complete class per extra mode:

```dart
abstract final class AppDarkColors {
  static const Color colorSurfaceBase = Color(0xFF111111);
  static const Color paletteBrand_500 = Color(0xFFFF5900);   // unchanged, still present
}
```

Complete, not partial: Dart has no cascade, so a class holding only the changed
colours would leave the rest undefined. The app selects a class per theme —
usually by building two `ThemeExtension` instances, one per class (see
`target-flutter.md`).

**dtcg** — modes go in `$extensions`, because the W3C spec has no mode concept:

```json
{ "$type": "color", "$value": "#FFFFFFFF",
  "$extensions": { "com.figma.modes": { "dark": "#111111FF" } } }
```

A consumer that ignores extensions still reads a valid single-mode file.

## Narrowing a run

```bash
node "$S/generate.mjs" --modes light        # skip the dark block entirely
node "$S/generate.mjs" --modes light,dark   # explicit, same as the default
```

or per target: `"modes": ["light"]`.

Default is **every mode present in tokens.json**. Extracting a mode and then
silently not shipping it is the more confusing outcome, so it has to be opted
out of, not into.

## Failure modes, all of them loud

- Asking for a mode that was never extracted **fails the run**, naming the
  modes that do exist and how to add one. It never emits an empty theme block.
- A merged mode that changes **zero** tokens is a problem in `verify.mjs` —
  that is what extracting twice from the same active Figma mode looks like, and
  it is otherwise invisible.
- Aliases are resolved **per mode**: the dark block's `var()` references are
  built from the dark values, so a semantic token pointing at a different
  primitive in dark links correctly rather than inheriting the light link.

## Alias linking and modes together

Both are on by default per target once configured, and they compose: each mode
block gets its own alias map. Where a palette itself changes between modes
(some systems flip the primitive rather than the semantic), the semantic token
keeps pointing at the same primitive name and the primitive's override carries
the change — one line in the theme block instead of dozens.
