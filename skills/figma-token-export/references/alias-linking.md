# Alias linking — putting the pointer back


## Contents

- The problem
- What this does instead
- Why it refuses instead of guessing
- Reading the result
- Output per target
- When the plan is upgraded to Enterprise

---

> `$S` is this skill's `scripts/` directory — resolve it once per project;
> see **Where the scripts live** in the skill doc.

## The problem

A design system is a graph, not a list:

```
color/surface/primary/default  ──▶  palette/brand-primary/500  =  #e50913
```

`get_variable_defs` walks that arrow for you and returns only the destination:

```json
{ "palette/brand-primary/500": "#e50913", "color/surface/primary/default": "#e50913" }
```

Two tokens, same value, no arrow. Everything downstream inherits the loss —
CSS gets two independent literals, Dart gets two independent `Color()` calls.
Values stay correct, so nothing breaks visibly. What breaks is theming:
overriding `--palette-brand-primary-500` reaches nothing, because no semantic
token refers to it.

The Variables REST API returns the real alias (`variableAliases`), but it is
Enterprise-gated (see `extraction-rest.md`), so on Organization plans the arrow
genuinely is not available anywhere in the data.

## What this does instead

Match on value. Within one target's token set, every non-primitive colour whose
value equals **exactly one** primitive's value is emitted as a reference to it.

```json
"layers": {
  "semantic":  ["color/**"],
  "primitive": ["palette/**"]
},
"targets": [
  { "type": "web", "out": "src/tokens",
    "aliasLinking": { "source": "primitive", "strict": false } }
]
```

| key | meaning |
|---|---|
| `source` | the layer name holding primitives — the only tokens that may be linked *to* |
| `strict` | `true` fails the run if any token cannot be linked unambiguously; `false` (default) keeps it as a literal and reports it |

## Why it refuses instead of guessing

Value-matching is an inference. It is right when the palette is a set of
distinct values — which is what a palette is for — and wrong the moment two
primitives share a value, because then the arrow could point at either.

So the rules are deliberately conservative:

- **Two or more candidates → no link.** Reported as `ambiguous`, kept as a
  literal.
- **No candidate → no link.** Reported as `unmatched`, kept as a literal.
- **Primitives are never linked**, only linked *to*. A primitive pointing at
  another primitive would be a chain this cannot verify.
- **Dimensions and typography are never linked.** `spacing/8` and `radius/8`
  are both `8`; linking them would assert a relationship the design system does
  not have. Only colours pass through.
- **A target cannot link to a layer it filters out.** Config validation rejects
  `layers: ["semantic"]` combined with `aliasLinking.source: "primitive"`,
  because the reference would dangle.

A literal is always a *correct* value. The fallback is safe; the reporting is
what stops "safe" from silently becoming "half-linked".

## Reading the result

```
[verify] web: aliasLinking — 261 linked, 0 ambiguous, 0 unmatched (against 354 primitives)
```

- **near-100% linked** — the palette has distinct values and the semantic layer
  is built from it. Turn `strict: true` on to keep it that way: a future
  extraction that breaks the property fails the build instead of quietly
  degrading to literals.
- **many ambiguous** — the palette repeats values (a duplicated ramp, a colour
  defined twice under different names). Every link there is a coin flip. Leave
  `aliasLinking` off until the Figma file is deduplicated.
- **many unmatched** — the semantic layer holds values that are not in the
  palette at all, i.e. someone typed a hex directly into a semantic variable.
  Worth raising with design; it is the same problem the semantic layer exists
  to prevent.

## Output per target

**web** — the primitive's custom property, with the resolved value as a comment
so the file still reads as documentation:

```css
--palette-brand-primary-500: #e50913;
--color-surface-primary-default: var(--palette-brand-primary-500);  /* #e50913 */
```

Theming now works the way the design file implies: override
`--palette-brand-primary-500` in a theme block and every semantic token built
on it follows. Overriding semantic tokens directly still works and is still the
better default for light/dark — but you now have both.

The TypeScript `color` map deliberately keeps **literals**: a `var(--…)` string
is useless outside CSS. `colorVar` is where the references live.

**flutter** — a const reference across classes:

```dart
abstract final class AppPaletteColors {
  static const Color paletteBrandPrimary_500 = Color(0xFFE50913);
}
abstract final class AppColors {
  /// Figma: `color/surface/primary/default` → `palette/brand-primary/500` (#E50913FF)
  static const Color colorSurfacePrimaryDefault = AppPaletteColors.paletteBrandPrimary_500;
}
```

Still `const`, so const constructors and const widget subtrees keep working.

**dtcg** — the spec's reference syntax, so the structure survives a round trip
through Style Dictionary, Tokens Studio, or an import back into Figma:

```json
{ "$type": "color", "$value": "{palette.brand-primary.500}", "$description": "Resolves to #E50913FF" }
```

## When the plan is upgraded to Enterprise

Read the real aliases from `GET /v1/files/:key/variables` and stamp them onto
the tokens at extraction time. Everything here becomes a fallback for files
that cannot be read that way, and `strict: true` becomes the check that the
inference agreed with the truth.
