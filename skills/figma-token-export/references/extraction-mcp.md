# Extraction path A — Figma MCP `get_variable_defs`


## Contents

- Why this is the default
- What the tool returns
- The coverage problem, and how to work around it
- Saving a dump
- Confirming coverage instead of assuming it
- What MCP cannot give you

---

> `$S` is this skill's `scripts/` directory — resolve it once per project;
> see **Where the scripts live** in the skill doc.

## Why this is the default

Design systems store tokens as Figma **Variables**. The REST endpoint for
variables (`GET /v1/files/:key/variables`) requires the `file_variables:read`
scope, which Figma gates to **Enterprise** plans — on an Organization plan it
returns 403 regardless of how the personal access token was created. The MCP
server reads variables through the authenticated Figma session instead, so it
works on Organization and Professional plans.

## What the tool returns

`get_variable_defs({ fileKey, nodeId })` → a flat map of variable name to
string value, for every variable bound anywhere inside that node's subtree.
Verified output from a production file:

```json
{
  "radius/2": "2",
  "color/mono/black": "#000000",
  "text/primary/default": "#030712",
  "spacing/8": "8",
  "surface/main/primary": "#ffffff",
  "border/strong/quaternary": "#d4d4d4",
  "body/font": "Google Sans",
  "body/lg/bold/size": "16",
  "body/lg/bold/weight": "Bold",
  "body/lg/bold/line-height": "22",
  "body/lg/bold/letter-spacing": "0",
  "Body/lg/bold": "Font(family: \"body/font\", style: body/lg/bold/weight, size: body/lg/bold/size, weight: 700, lineHeight: body/lg/bold/line-height, letterSpacing: body/lg/bold/letter-spacing)"
}
```

Everything is a string. Colours may or may not carry alpha. Composite type
variables are a `Font(...)` string whose fields point at other variables by
name — `normalize-mcp.mjs` resolves them, then parks the consumed parts in
`other` so `body/lg/bold/size` never gets mistaken for a spacing token.

## The coverage problem, and how to work around it

**One call ≠ the whole file.** The result is scoped to the node you pass. A
button component returns the ten variables that button binds, not the 500 in
the library.

Getting full coverage:

1. Open the Figma file and list the pages that define tokens — usually named
   Foundations, Primitives, Colors, Typography, Spacing.
2. For each, copy a node-specific URL (right-click a frame → *Copy link to
   selection*). The `node-id=1643-43256` query param is the node id; convert
   the dash to a colon: `1643:43256`.
3. Call `get_variable_defs` per node and save each result as its own JSON file
   under `dumps/`.
4. Add a screen or two that exercises the **semantic** layer. Foundations pages
   often bind only primitives; the semantic aliases (`text/primary/default`,
   `surface/main/primary`) appear where they are actually used.
5. Merge:

```bash
node "$S/normalize-mcp.mjs" dumps/*.json
```

The normalizer merges every dump, and where two dumps disagree on a value it
**keeps the first and records a warning** in `$meta.warnings` rather than
letting file order decide. Read those warnings — a genuine disagreement means
two parts of the file define the same token differently, which is a design
question, not a script question.

Keep `dumps/` in the repo. It makes the extraction reproducible and shows a
reviewer exactly which frames the numbers came from.

## Saving a dump

Paste the tool result into a file as-is. The reader also accepts a wrapper
object (`{"variables": {...}}` or `{"result": {...}}`), so a transcript-copied
envelope works too. Non-string values are ignored.

## Confirming coverage instead of assuming it

After normalizing, check the counts against what design says exists:

```bash
node "$S/verify.mjs"
```

If the colour count is far below the palette size, a Foundations page is
missing from `dumps/`. If `other` is full of `*/size`, `*/weight`,
`*/line-height` entries, that is expected — they are the resolved parts of
typography composites.

## What MCP cannot give you

- **Modes/themes.** `get_variable_defs` resolves to the mode active in the
  file, so a light/dark variable collection comes back as one set of values.
  For multi-mode output, extract once per mode (switch the mode in Figma, or
  point at frames pinned to each mode) into separate `tokens.<mode>.json`
  files, and give each its own target `out`.
- **Unbound values.** A colour typed directly into a layer is not a variable
  and will not appear. That is a feature — it keeps ad-hoc values out of the
  token set instead of laundering them into one.
- **Unattended runs.** It needs an authenticated Figma session. For CI, use
  `references/extraction-rest.md` or gate with `generate.mjs --check`.
