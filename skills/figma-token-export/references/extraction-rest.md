# Extraction path B — Figma REST API


## Contents

- Token setup
- What it reads: `styles` mode (default)
- What it reads: `scrape` mode (opt-in)
- What it will never read
- In CI

---

> `$S` is this skill's `scripts/` directory — resolve it once per project;
> see **Where the scripts live** in the skill doc.

The fallback: no Figma session, no MCP server, runs unattended in CI.

## Token setup

Create a personal access token at **figma.com → Settings → Security → Personal
access tokens** with `file_content:read`. Export it as `FIGMA_ACCESS_TOKEN`.

Do not commit it. In CI, use a repository secret; locally, a gitignored `.env`
that you source, or a shell export.

```bash
FIGMA_ACCESS_TOKEN=figd_... node "$S/fetch-rest.mjs"
```

`figma.fileKey` in `tokens.config.json` is the segment after `/design/` in the
file URL.

## What it reads: `styles` mode (default)

```
GET /v1/files/:key/styles          → published styles (key, name, node_id, style_type)
GET /v1/files/:key/nodes?ids=...   → each style's resolved node
```

- **FILL** styles → colours, from `document.fills[0].color` plus the fill's
  `opacity`, folded into the stored alpha. Gradient and image fills are skipped
  with a warning; they are not colour tokens.
- **TEXT** styles → typography, from `document.style` (`fontFamily`,
  `fontWeight`, `fontSize`, `lineHeightPx`, `letterSpacing`). This reads the
  style's own defining node, so it is authoritative — no sampling of usage
  sites, no guessing from a heading that happens to use it.

**The catch:** it only sees what is *published as a style*. A file whose tokens
live purely in Variables returns zero, and the script fails loudly telling you
to use the MCP path rather than writing an empty `tokens.json`.

## What it reads: `scrape` mode (opt-in)

Some design files document tokens as canvas artefacts — a swatch card with the
hex printed next to it, a table of `8px` rows. That is readable, and it is how
a pre-Variables file usually looks. Two patterns are supported:

```json
"rest": {
  "styles": true,
  "scrape": [
    { "pattern": "card", "nodes": ["1643:50684"], "hexTextName": "{hex-value}" },
    { "pattern": "px-rows", "nodes": ["1694:57100"], "namespace": "spacing" }
  ]
}
```

- **`card`** — an `INSTANCE` whose name contains `/` (so it reads as a token
  path) containing a `TEXT` node named `hexTextName` whose characters *are* the
  resolved hex. Conflicting values for one name are reported, not overwritten.
- **`px-rows`** — a row `FRAME` with a direct `TEXT` child matching `<N>px`.
  Emits `<namespace>/<N>`. Repeated scales (pages often show the same values
  twice, once as a table and once as a visual) are de-duplicated.

Scraping depends on canvas conventions and will break the first time a
designer restructures the page. It is a bridge, not a destination: prefer
`styles`, and prefer MCP over both. When it breaks, the failure is loud
(0 tokens, or a warning per unparseable card) rather than quiet.

Set `"keepRaw": true` (or pass `--keep-raw`) to save the raw API responses
under `rawDir` — worth it the first time you write a scrape rule, so you can
inspect the actual node tree instead of guessing at it.

## What it will never read

`GET /v1/files/:key/variables` needs the Enterprise-only `file_variables:read`
scope. The client refuses to call it and turns a 403 into a message pointing at
the MCP path. If the org ever upgrades to Enterprise, that endpoint becomes the
best path of all — and because everything downstream consumes `tokens.json`,
adding it means one new extractor file and no change to any generator.

## In CI

```yaml
- run: node "$S/fetch-rest.mjs"
  env:
    FIGMA_ACCESS_TOKEN: ${{ secrets.FIGMA_ACCESS_TOKEN }}
- run: node "$S/verify.mjs" --baseline tokens/tokens.committed.json
- run: node "$S/generate.mjs"
```

Have the job open a PR with the diff rather than pushing to the default branch.
A token change is a design decision reaching production; it deserves the same
review as code.

If REST cannot see this file's tokens, drop the extraction step and keep only
the gate — it still catches hand-edited generated files and un-regenerated
token updates:

```yaml
- run: node "$S/generate.mjs" --check
```
