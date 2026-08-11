# The `tokens.json` contract

Everything upstream produces this; everything downstream consumes only this.
Keep it that way and extraction and codegen stay independently replaceable.

## Contents

- Invariants the generators rely on
- Legacy shape tolerance
- Adding a target
- Multi-mode (light/dark) tokens

---

```jsonc
{
  "$meta": {
    "source": "figma-mcp:get_variable_defs",   // or "figma-rest"
    "fileKey": "1aHYp1CNL5AHI154KdRCHf",
    "extractedAt": "2026-08-09T04:12:00.000Z",
    "inputs": ["foundations.json", "semantic.json"],
    "warnings": ["Conflicting value for \"text/primary/default\": …"]
  },

  "color": {
    "text/primary/default": { "$type": "color", "$value": "#030712FF", "$layer": "semantic" }
  },
  "dimension": {
    "spacing/8": { "$type": "dimension", "$value": 8 }
  },
  "typography": {
    "body/lg/bold": {
      "$type": "typography",
      "$value": {
        "fontFamily": "Google Sans",
        "fontWeight": 700,
        "fontStyleName": "Bold",
        "fontSize": 16,
        "lineHeight": 22,        // PIXELS, as Figma reports it
        "letterSpacing": 0
      }
    }
  },
  "shadow": {
    "shadow-md": {
      "$type": "shadow",
      "$value": [                          // ARRAY: Figma stacks effects
        {
          "color": "#0000001F",
          "colorRef": "color/shadow/md/edge",   // the colour token it pointed at
          "offsetX": 0, "offsetY": 0, "blur": 1, "spread": 0,
          "inset": false
        },
        {
          "color": "#0000001F",
          "colorRef": "color/shadow/md/ambient",
          "offsetX": 0, "offsetY": 8, "blur": 24, "spread": -4,
          "inset": false
        }
      ]
    }
  },
  "other": {
    "elevation/shadow/soft": {
      "$type": "unknown",
      "$value": "0 1 2 rgba(0,0,0,0.05)",
      "$note": "unclassified string variable"
    }
  }
}
```

## Invariants the generators rely on

- **Token names stay exactly as Figma spells them**, slashes included. They are
  the join key back to design, and the only thing that makes a diff legible to
  a designer. Renaming happens at generation time, never at extraction time.
- **Colours are always `#RRGGBBAA`.** Alpha is explicit so no target guesses.
- **Dimensions are unitless numbers** in Figma's px. Units are a target
  concern (`px` vs `rem` vs Dart `double`).
- **`lineHeight` is in pixels.** Flutter and CSS both want a ratio; both
  generators divide by `fontSize`. Storing the ratio instead would lose
  information when `fontSize` is missing.
- **A shadow `$value` is an array of layers, never one flattened layer.** Figma
  stacks effects — a typical elevation token is a 1px edge shadow plus a soft
  ambient one — and collapsing them changes how it renders. `colorRef` is the
  colour token the layer pointed at, kept so the web and DTCG targets can emit
  `var(--color-shadow-md-edge)` / `{color.shadow.md.edge}` instead of a hex that
  no theme can reach. It is omitted when the effect used a raw colour.
  Unlike the parts a `Font(...)` consumes, the parts an `Effect(...)` consumes
  stay in `color`/`dimension`: the output references them, so removing them
  would dangle.
- **An effect that is not a shadow is refused whole.** A stack containing a
  layer blur has no `box-shadow` equivalent, so the entire token goes to
  `other` rather than emitting only the shadow layers — which would silently
  render something the designer never drew.
- **`other` is never empty by accident.** Anything the extractor could not
  classify lands there with a note, and `verify.mjs` prints it. Nothing is
  dropped silently — a missing token must be visible, not inferred later from a
  broken screen.
- **`$figma`** (node id, style key, variable id) is optional provenance. REST
  extraction fills it; MCP has no node ids to attach. Only the DTCG target
  reads it, as `$extensions`.
- **`$layer`** is which layer of the design system the token belongs to
  (`primitive` / `semantic` / whatever the config names), derived from the
  `layers` globs in `tokens.config.json`. `null` means no pattern matched.
  Stored so layering is visible in the diff; recomputed on every generate, so
  the config stays the authority. See `references/layers.md`.

## Legacy shape tolerance

`loadTokens` also accepts `color` split into sub-groups
(`color.global` / `color.alias` / `color.semantic`), as older hand-rolled
pipelines wrote it. Sub-groups are flattened on load; namespacing is recovered
from the token path at generation time. Verified against a production
`tokens.json` of that shape: 511 colours, no collisions, `dart analyze` clean.

## Adding a target

1. Write `scripts/lib/targets/<name>.mjs` exporting
   `generate<Name>(set, target) → [{ file, contents }]`.
2. Register it in the `GENERATORS` map in `generate.mjs` **and** in
   `verify.mjs` (so the identifier check covers it too).
3. Add its type to `VALID_TARGETS` in `lib/config.mjs`.
4. Add defaults to `DEFAULT_TARGET_OPTIONS` in `generate.mjs`.
5. Add assertions to `selftest.mjs` — at minimum one per value type, since
   colour, dimension, and typography each have a different failure mode.

Reuse `lib/naming.mjs` rather than writing new case conversion. And call
`assertUniqueIdentifiers` before returning contents, never after writing:
a collision that reaches disk looks like a missing token.

## Multi-mode (light/dark) tokens

The schema holds one mode. For two, extract twice into `tokens.light.json` and
`tokens.dark.json` and run `generate.mjs` with a config per mode, each with its
own `out`. Merging modes into one token file is possible but changes the
contract for every target at once — do it only when more than one project
actually needs it.
