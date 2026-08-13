# Maintainer's guide

> [ภาษาไทย](MAINTAINING.md) · English
> Just want tokens in your project? You don't need this file →
> [GETTING-STARTED.en.md](GETTING-STARTED.en.md)

For people who run the scripts by hand, set up CI, debug a run, or change the
skill. Assumes you have read `skills/figma-token-export/figma-token-export.md`
(the operating manual).

## Contents

- [The shape of it](#the-shape-of-it) — pipeline, where files live
- [Running the scripts yourself](#running-the-scripts-yourself) — `$S` and the command table
- [Finding node ids](#finding-node-ids-setting-up-a-new-project) — setting up a new project
- [Minimum config](#minimum-config)
- [Reading verify output](#reading-verify-output) — `other`, `(unassigned)`, alias ratio
- [Troubleshooting](#troubleshooting)
- [Confirmed limits](#confirmed-limits) — plan tier, REST
- [Test status](#test-status) — **the only place this is recorded**
- [How shadows work](#how-shadows-work-v110)
- [Colliding symbol names](#colliding-symbol-names)
- [Changing the skill](#changing-the-skill) — selftest, adding a target, adding a group
- [Read next](#read-next)

---

## The shape of it

```
Figma ──extract──▶ tokens/tokens.json ──generate──▶ Flutter | Web | DTCG
        (MCP/REST)  (committed)                      (committed)
```

`tokens.json` is the contract. Extraction can change without touching a
generator, and a new target is one file in `scripts/lib/targets/`.

**Scripts live in the skill; data lives in the project.** `tokens.config.json`,
`tokens/tokens.json`, `dumps/` and generated code all live in the project and
resolve relative to `tokens.config.json`, not the cwd — so the commands work
from anywhere, including CI.

---

## Running the scripts yourself

```bash
cd ~/dev/my-project
S=".claude/skills/figma-token-export/scripts"          # installed into the project
# S="$HOME/.claude/skills/figma-token-export/scripts"  # installed with --global

node "$S/verify.mjs"     # errors with no config — but it must NOT be "module not found"
```

`Cannot find module` means `$S` is wrong. Fix that before anything else; it is
the single most common way a first run fails. Put the resolved path in the
project's own README.

| Command | What it does |
|---|---|
| `node "$S/selftest.mjs"` | whole pipeline against a fixture in a temp dir (see [Test status](#test-status)) |
| `node "$S/normalize-mcp.mjs" dumps/*.json` | dumps → `tokens.json` |
| `node "$S/verify.mjs"` | gate before generating; prints namespaces / layers / `other` |
| `node "$S/generate.mjs"` | `tokens.json` → code |
| `node "$S/generate.mjs" --check` | exits 1 if committed code ≠ tokens.json (**put this in CI**) |
| `node "$S/sync.mjs" dumps/*.json` | all of the above plus the diff (the everyday command) |

`sync` guarantees two things: (1) if verify fails, `tokens.json` is restored from
the snapshot and no generated file is touched; (2) it refuses `--target` /
`--layers` / `--modes`, because rebuilding one target against an updated shared
token file leaves the others stale.

---

## Finding node ids (setting up a new project)

`get_variable_defs` only reads variables bound inside the subtree of the node
you pass, and it must be a **frame** id, not a page id — pass a page and you get
`You currently have nothing selected`.

MCP `get_metadata` does not list pages reliably on every file (we hit one that
reports only the cover page). **Use REST**, which needs only the
`file_content:read` scope:

```bash
set -a && . ./.env && set +a      # FIGMA_ACCESS_TOKEN, FIGMA_FILE_ID

# every page in the file
curl -s -H "X-Figma-Token: $FIGMA_ACCESS_TOKEN" \
  "https://api.figma.com/v1/files/$FIGMA_FILE_ID?depth=1" \
  | jq -r '.document.children[] | "\(.id)  \(.name)"'

# frames on one page
curl -s -H "X-Figma-Token: $FIGMA_ACCESS_TOKEN" \
  "https://api.figma.com/v1/files/$FIGMA_FILE_ID/nodes?ids=96954:6258&depth=1" \
  | jq -r '.nodes[].document.children[] | "\(.id)  \(.name)"'
```

```
0:1          🟩 color
96954:6258   🟩 spacing
     ↓
96967:499    Spacing-Overview        ← the node id that goes in the config
```

Put those ids in `figma.mcp.nodes`, save each node's dump verbatim as
`dumps/<name>.json`, and **commit `dumps/`** — that is what makes the extraction
reproducible.

---

## Minimum config

```jsonc
{
  "figma": {
    "fileKey": "kQ8mR2xJ7vNbL4wYtZcHpA",        // the segment after /design/ in the URL
    "mcp": { "nodes": ["96967:499", "0:1"] }
  },
  "tokensPath": "tokens/tokens.json",
  "targets": [{ "type": "web", "out": "src/tokens" }]
}
```

Every option is documented inline in `scripts/tokens.config.example.json`. Leave
`layers` / `aliasLinking` / `modeSelectors` alone on a first run — the default is
export-everything.

---

## Reading verify output

**`other` is not an error.** It holds what the extractor could not classify, so
it is not exported. Most entries read `(consumed by a typography composite)` —
parts already folded into a text style, which is **normal**. But a token you
expected showing up there means the extractor needs work, not that the token is
unimportant.

**`(unassigned)` under layers is not an error either** — no glob matched, and it
still gets exported. It only disappears when a target selects specific layers.

**`aliasLinking`** — check the `linked / ambiguous / unmatched` ratio before you
trust it. A clean design system lands at or near 100%. A large ambiguous count
means the palette repeats values and the link is a coin flip; leave it off there.

---

## Troubleshooting

| Message | Cause | Fix |
|---|---|---|
| `Cannot find module .../verify.mjs` | `$S` is wrong | see "Running the scripts yourself" |
| `You currently have nothing selected` | you passed a page id, not a frame id | see "Finding node ids" |
| `get_metadata` only shows the cover page | known MCP limitation on some files | list pages over REST |
| `403` from REST `/variables` | `file_variables:read` is Enterprise-only | read variables through MCP |
| `Identifier collision in …` | two token names flatten to one identifier | design renames one; don't patch the generator |
| `the selection matched 0 tokens` | a glob in `layers`/`include` matches nothing | `verify.mjs` lists the namespaces that exist |
| `aliasLinking is strict and N …` | the palette repeats values | turn off `strict`, or drop `aliasLinking` |
| `mode "dark" ... not in tokens.json` | that mode was never extracted | a mode is its own pass — `references/modes.md` |
| an Effect landed in `other` | the stack has a layer that is not a drop/inner shadow | deliberate refusal — see Shadows |

If `selftest.mjs` passes but the project doesn't, the problem is the config or
the dumps, not the skill.

---

## Confirmed limits

**The team's Figma plan is Organization, not Enterprise.** The
`file_variables:read` scope is Enterprise-only, so `GET /v1/files/:key/variables`
is unavailable for both reading and writing.

| To do this | Use |
|---|---|
| read Variables | MCP `get_variable_defs` |
| read published styles | REST `/v1/files/:key/styles` |
| list pages / frames | REST `/v1/files/:key?depth=1` |
| write Variables back into Figma | native DTCG JSON import (the `dtcg` target) |

**The REST path produces no shadows** — `fetch-rest.mjs` reads published
FILL/TEXT styles only, so a REST-driven CI silently gets zero shadow tokens.

---

## Test status

**This is the only place this is recorded.** Do not copy the numbers elsewhere —
there used to be three copies, and two of them were stuck on pre-v1.1.0 results
claiming Flutter was verified when it had never been checked.

| What | Status |
|---|---|
| `selftest.mjs` | 134 assertions, all passing |
| Web (`tokens.ts`) | `tsc --strict` clean, against a 615-colour production set |
| Flutter | `dart analyze` → `No issues found` (details below) |
| Tailwind v4 | checked against a 225-token production design system — **byte-exact** |
| Tailwind v3 | checked against a production `tailwind.config.js` — 40/41 utilities match |
| DTCG | **never read by a downstream tool** |
| alias linking | 261/261 linked, zero ambiguous, no dangling `var()` |

The selftest runs the real CLIs in a temp directory and asserts on real output:
colour normalization, `Font(...)` / `Effect(...)` resolution, identifier
collisions, per-namespace splitting, layer selection, alias linking (including
the ambiguous, strict and dangling cases), modes, sync rollback on a failed
verify (`tokens.json` byte-identical, generated code untouched), a dark-only
change showing up in the diff, and `--check` both in sync and after tampering.

**Flutter** — generated from a production token set (615 colours, 72 dimensions,
51 text styles, 4 shadows), `dart analyze` reports `No issues found`. That covers
both paths added in v1.1.0: `AppShadows` (`List<BoxShadow>`) and
`AppTypographyScale` (the class renamed because it collided with the text styles).

**Tailwind v4** — generated from a production design system (225 semantic
tokens) and compared with the team's hand-written `insure.css`: the
`@theme inline` block matches **225/225**, and with `colorFormat: "hex"` the
`:root` block is byte-identical on all 225 lines. Adopting the pipeline moves
nothing on screen. Only 3 tokens differ — ones the project added itself that do
not exist in Figma.

**Tailwind v3** — generated from a production project's 42 tokens, then the
`.cjs` file was `require`d and compared with its hand-written
`theme.extend.colors`: **40 of 41** utilities match, values included. Eleven of
them differ only in spelling, because the project uses `_` in its keys
(`primary-soft_light`) where the generator uses `-` — adopting it renames those
utilities in components, which is what `figma-rename` is for. The last one
differs because the config key is spelled `grey` while the variable it points
at is spelled `gray`.

**DTCG** — the output matches the spec and passes the selftest assertions, but
no downstream tool has actually read it. The first team to try it should report
back.

**Known, not fixed (v4)** — the mode override block writes a shadow root var
that no v4 utility reads, since `@theme` carries the literal. v3 sidesteps this
by pointing at the root var directly; v4 could adopt the same treatment later.

**There is no agent-behaviour eval yet.** `selftest.mjs` tests that the *scripts*
are correct; it does not test that the skill fires at the right moment or walks
every step. Those are different things.

---

## How shadows work (v1.1.0)

Figma hands effects over as strings, stacked layers joined by `; `:

```
Effect(type: DROP_SHADOW, color: color/shadow/md/edge, offset: (0, shadow/edge/offset-y), radius: shadow/edge/radius, spread: 0); Effect(...)
```

They become `shadow` tokens whose `$value` is an **array of layers** — never
flattened to one. Each layer keeps its `colorRef`, so the output can point back
at the colour token:

```css
--shadow-md: 0 0 1px 0 var(--color-shadow-md-edge), 0 8px 24px -4px var(--color-shadow-md-ambient);
```

**It refuses rather than guesses:** a stack containing anything that is not a
drop/inner shadow (a `LAYER_BLUR`, say) sends the whole token to `other`,
because emitting only the shadow layers would render something the designer
never drew. Flutter skips inset shadows and names them in a `// SKIPPED`
comment, since `BoxShadow` has no inset.

The `Effect(...)` grammar is inferred from two sample files. An unfamiliar field
will not produce a wrong value — the token lands in `other`, where verify prints
it.

---

## Colliding symbol names

A design system with both a `typography/font-size/*` dimension scale and text
styles wants the symbol `typography` twice. The text styles keep it; the scale
becomes `typographyScale` (`AppTypographyScale` in Dart). The rename is
deterministic and only fires on a real clash.

A collision the suffix does not resolve still throws — this narrows the failure,
it does not hide it.

---

## Changing the skill

```bash
node skills/figma-token-export/scripts/selftest.mjs    # must pass before and after
```

What it covers is listed under [Test status](#test-status).

**Adding a target:** write `scripts/lib/targets/<name>.mjs` exporting
`generate<Name>(set, target) → [{ file, contents }]`, then register it in
`generate.mjs` and `verify.mjs`. Details in `references/tokens-schema.md`.

**Adding a token group:** edit `EXPORTED_GROUPS` in `scripts/lib/dtcg.mjs` — one
place. filter / modes / diff / verify all walk that list.

Bump the version in `scripts/package.json`. It is stamped into every generated
file's header, and when output looks wrong the first question is always "which
version produced this?"

---

## Read next

| File | About |
|---|---|
| `skills/figma-token-export/figma-token-export.md` | the operating manual — read it in full before changing anything |
| `references/extraction-mcp.md` | choosing nodes that cover every token |
| `references/extraction-rest.md` | REST, scopes, CI |
| `references/modes.md` | light/dark |
| `references/layers.md` | exporting one layer, and Figma collections |
| `references/alias-linking.md` | semantic → primitive |
| `references/tokens-schema.md` | the `tokens.json` contract, and adding a target |
| `references/target-web.md` · `target-flutter.md` | output shape and theme wiring |
