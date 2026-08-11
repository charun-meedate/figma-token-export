# Figma design tokens → code

<!-- The operating manual for the figma-token-export skill. `SKILL.md` next to
     this file carries the frontmatter Claude Code's loader reads and points
     here; keep the two in sync when the scope of the skill changes. -->


## Contents

- Where the scripts live — resolving `$S`, the most common first-run failure
- Step 0 — pick the extraction path (MCP vs REST, and what the plan tier blocks)
- Step 1 — configure: targets, which layers, which modes, alias linking
- Step 2 — extract: per-node coverage, `Font(...)` and `Effect(...)` composites
- Step 3 — verify before generating: identifier collisions, reading `other`
- Step 4 — generate, and the `--check` CI gate
- The everyday command: `sync`
- Step 5 — wire it into the app
- Pitfalls worth knowing before they cost an afternoon
- Verifying the pipeline itself — `selftest.mjs`
- Reference files

Each step ends with a **Done when** line. Those are the gate between steps: a
step whose condition is not met is not finished, however good the output looks.

The pipeline is three separable steps with one contract between them:

```
Figma ──extract──▶ tokens/tokens.json ──generate──▶ Flutter | Web | DTCG
        (2 paths)   (committed, reviewable)          (committed, generated)
```

`tokens.json` is the contract. Extraction can be swapped — MCP, REST, the
Enterprise Variables API if the plan is ever upgraded — without any
generator changing, and a new target is one file in `lib/targets/`. Commit both
`tokens.json` and the generated code: the token diff is what a designer and a
developer can actually review together, and the generated diff is what proves
the change landed.

Keep `tokens.json` the only source of token values in the project. The moment
two sources exist, they disagree, and the disagreement surfaces as a bug in a
screen nobody was looking at.

## Where the scripts live

**The scripts ship inside this skill, not in the user's project.** Resolve the
path before running anything, and use it in every command below — a bare
`node scripts/generate.mjs` from a project root fails with "module not found",
which reads like a broken pipeline when it is only a wrong path.

```bash
# installed into the project (install.sh, the usual case)
S=".claude/skills/figma-token-export/scripts"

# or the skill repo checked out next to the project
S="../design-tokens-skill/skills/figma-token-export/scripts"

# or installed for the user only
S="$HOME/.claude/skills/figma-token-export/scripts"

node "$S/verify.mjs"          # confirm the path resolves before going further
```

Everything the scripts read or write — `tokens.config.json`, `tokens.json`,
`dumps/`, generated output — lives in the **project**, resolved relative to
`tokens.config.json`. Only the code lives in the skill. That split is what lets
one skill copy serve several repos, and it is why the config path, not the cwd,
is the anchor.

Put the resolved `$S` into the project's own README when you set this up. The
next person to regenerate tokens will be looking for exactly that line.

## Step 0 — pick the extraction path

Ask which is available before writing any config; the answer changes the whole
setup.

| | MCP `get_variable_defs` | REST |
|---|---|---|
| Reads Figma **Variables** | yes | no — Enterprise-only endpoint |
| Reads published **styles** | indirectly | yes |
| Needs a Figma session/Dev Mode | yes | no |
| Runs unattended in CI | no | yes |
| Breaks when designers restructure a page | no | only in `scrape` mode |

**Default to MCP.** Design systems generally store tokens as Variables, and
`GET /v1/files/:key/variables` needs the `file_variables:read` scope, which
Figma gates to Enterprise plans — it returns 403 on an Organization plan no
matter how the token was minted. REST is the fallback for CI and for machines
with no MCP server, and it can only see what is *published as a style*.

If both are possible, use MCP for the authoring loop and REST in CI, pointed at
the same `tokens.json`. If REST cannot see the tokens at all, keep CI honest
with `generate.mjs --check` (below) instead, and re-extract manually.

**Done when:** the chosen path is named along with the reason it was chosen over
the other, and — for MCP — a check that the Figma session is reachable by
calling `get_variable_defs` on one node and getting a map back.

## Step 1 — configure

Copy `$S/tokens.config.example.json` to the project root as
`tokens.config.json` and edit it. Every path resolves relative to the config
file, so the scripts work from any cwd and from CI.

Pick targets deliberately — one project usually wants one:

- `flutter` — `abstract final class` holders of `static const Color` /
  `double` / `TextStyle`. See `references/target-flutter.md`.
- `web` — `tokens.css` (custom properties, the runtime source of truth) plus a
  typed `tokens.ts` mirror. See `references/target-web.md`.
- `dtcg` — strict W3C Design Tokens JSON, for Style Dictionary, Tokens Studio,
  or importing back into Figma.

`dtcg` also earns its place next to a code target when another repo consumes
the same tokens.

### Which tokens, not just which format

Export-all is the default and is right for a first run. After that, ask what
each target should actually receive: a **product app** wants the semantic layer
(`text/**`, `surface/**`), not 400 primitives it should never reference
directly; a **design-system package** wants everything.

Define the layers once by token-name glob, then select per target:

```json
"layers": {
  "semantic":  ["text/**", "surface/**", "border/**", "icon/**"],
  "primitive": ["color/**", "brand/**", "neutral/**"],
  "scale":     ["spacing/**", "radius/**", "border-width/**"]
},
"targets": [
  { "type": "flutter", "out": "apps/app/lib/tokens", "layers": ["semantic", "scale"] },
  { "type": "flutter", "out": "packages/design_system/lib/src/tokens" }
]
```

Matching is on the **token name**, not the Figma collection —
`get_variable_defs` does not return which collection a variable came from.
That is usually the same information, but confirm the mapping instead of
assuming it: `references/layers.md` shows how to read the real collection names
(`1. Primitive`, `3. Semantic`, …) out of Figma, and covers `include`/`exclude`
globs and the `--layers` CLI override for one-off exports.

Run `node "$S/verify.mjs"` first — it prints every namespace with counts and
an example, which is the vocabulary the globs are written against.

### Which mode(s) — ask the user first

**Ask the user which modes to export, every time.** A mode (light/dark, brand A/B,
compact/comfortable) is a column in a Figma variable collection, and
`get_variable_defs` returns whichever column is active in the file. So a mode
is not a generation flag you can flip later — **each mode needs its own
extraction pass**, and getting one means someone switching the mode in Figma
between calls. Guessing wrong costs a whole round trip.

Ask with `AskUserQuestion` before extracting, offering the modes the file
actually has plus an all/default choice, e.g.:

> **Which modes should the export cover?** (multi-select)
> `Light` · `Dark` · `All modes` · `Default only — the mode currently active in Figma`

To find out which modes exist, ask the user to open the Variables panel, or
call `search_design_system` and read `variableCollectionName` — collections are
where modes live. Treat a file as single-mode until a collection proves
otherwise — a colour called `inverse` is not evidence of a dark mode.

Once the answer is known, one extraction per mode, merged into one token file:

```bash
node "$S/normalize-mcp.mjs" dumps/light/*.json --mode light
node "$S/normalize-mcp.mjs" dumps/dark/*.json  --mode dark --merge
```

The first mode written becomes the default; the rest are stored per token in
`$modes`. Then each target emits the default mode as its main output and every
other mode as an override:

- **web** — `:root { … }` plus a `:root[data-theme="dark"] { … }` block holding
  **only the tokens that actually differ**. Override the selector per mode with
  `"modeSelectors": { "dark": "[data-theme=\"dark\"]" }`.
- **flutter** — a full second class (`AppDarkColors`) in `colors_modes.g.dart`.
  Dart has no cascade, so a partial class would leave the unchanged colours
  undefined; each mode class carries every colour and the app picks one.
- **dtcg** — modes under `$extensions["com.figma.modes"]`; the spec has no mode
  concept, so inventing one into `$value` would produce an invalid file.

Narrow a run without re-extracting: `--modes light`, or `"modes": ["light"]` on
a target. Asking for a mode that was never extracted fails loudly rather than
emitting an empty theme block. `references/modes.md` has the rest.

### Keeping the alias structure, not just the values

In Figma a semantic token *points at* a primitive. `get_variable_defs` resolves
that pointer and returns only the final value, so two tokens arrive with the
same hex and no memory of the link. Generated code inherits the loss:

```css
--palette-brand-500: #e50913;
--color-surface-primary-default: #e50913;   /* not var(--palette-brand-500) */
```

Values are right; the **structure** is not. Overriding a primitive changes
nothing, so a theme has to restate every semantic token.

`aliasLinking` rebuilds the link by matching values:

```json
{ "type": "web", "out": "src/tokens",
  "aliasLinking": { "source": "primitive", "strict": true } }
```

```css
--color-surface-primary-default: var(--palette-brand-primary-500);  /* #e50913 */
```

Flutter emits `static const Color colorSurfacePrimary = AppPaletteColors.paletteBrand_500;`
(still const, so const widget subtrees keep working) and DTCG emits the spec's
`{palette.brand.500}` reference.

**This is an inference, not data from Figma**, so it is built to refuse rather
than guess:

- a value matching **two or more** primitives links to neither and stays a
  literal — there is no way to tell which one the designer pointed at
- a value matching **no** primitive stays a literal
- both cases are counted and printed; `strict: true` turns them into a failed
  run instead
- dimensions are never linked: `spacing/8` and `radius/8` are both `8` and mean
  different things, so value-matching them would invent links

Check the ratio before trusting it — `verify.mjs` prints
`261 linked, 0 ambiguous, 0 unmatched`. A clean design system tends to come out
at or near 100% because its palette has no duplicate values. Anything with a
large ambiguous count means the palette repeats itself, and the link is a coin
flip; leave `aliasLinking` off there.

`references/alias-linking.md` has the details.

**Done when:** `tokens.config.json` exists with a real `fileKey`, at least one
target, and one node id per token group the file actually has; the mode question
has an answer from the user; and every `layers` glob written was checked against
the namespaces `verify.mjs` prints rather than guessed from the token names.

## Step 2 — extract

### MCP path

`get_variable_defs` returns a flat `name → string` map of the variables bound
**inside one node's subtree**. Verified shape:

```json
{
  "text/primary/default": "#030712",
  "spacing/8": "8",
  "body/lg/bold/size": "16",
  "body/font": "Google Sans",
  "Body/lg/bold": "Font(family: \"body/font\", style: body/lg/bold/weight, size: body/lg/bold/size, weight: 700, lineHeight: body/lg/bold/line-height, letterSpacing: body/lg/bold/letter-spacing)"
}
```

Three things follow, and all three are load-bearing:

1. **Coverage is per-node, never per-file.** One call returns only what that
   subtree binds. Call the MCP tool yourself, once per frame — the
   Foundations/Primitives pages plus a screen that exercises the semantic layer
   — write each result verbatim to `dumps/<name>.json` in the project, and pass
   them all to the normalizer. It merges them and *reports* conflicting values
   instead of letting the last file win. Commit `dumps/`: it is what makes the
   extraction reproducible and shows a reviewer which frames the numbers came
   from.

   Ask the user for a node-specific link (right-click a frame → *Copy link to
   selection*) when you do not have one. `node-id=1643-43256` in the URL is the
   node id `1643:43256`. Use node ids that came from a link or from the REST
   page listing; when the MCP page listing looks empty, list the pages over
   REST before concluding the file has no tokens — see the pitfall below.
2. **Numbers arrive as strings** (`"8"`), colours usually without alpha.
3. **Type variables arrive as a `Font(...)` string** whose fields reference
   other variables by name. The normalizer resolves those references and then
   moves the consumed parts (`body/lg/bold/size`, …) out of the dimension
   bucket, so they cannot masquerade as spacing tokens.
4. **Effect variables arrive as `Effect(...)` strings**, several of them joined
   by `; ` when the shadow stacks. They become `shadow` tokens whose `$value`
   is the array of layers, each keeping the colour token it referenced so the
   output can point back at it (`var(--color-shadow-md-edge)`) rather than
   freezing a hex no theme can reach. A stack containing something that is not
   a drop/inner shadow — a layer blur, say — is refused whole and parked in
   `other`: emitting only the shadow layers would render something the designer
   never drew. Flutter skips inset shadows and names them in a comment,
   because `BoxShadow` has no inset.

```bash
node "$S/normalize-mcp.mjs" dumps/*.json
```

Full walkthrough, including how to choose the nodes: `references/extraction-mcp.md`.

### REST path

```bash
FIGMA_ACCESS_TOKEN=figd_... node "$S/fetch-rest.mjs"
```

Reads published FILL styles → colours and TEXT styles → typography. For files
that document tokens as canvas artefacts instead, `figma.rest.scrape` supports
two patterns (`card`, `px-rows`) — powerful, and the first thing to break when
a designer reorganises a page. Details and the token scope to mint:
`references/extraction-rest.md`.

**Done when:** every page the file has is accounted for — each one either has a
dump in `dumps/`, or a stated reason it binds no tokens. Listing the pages is
what makes that checkable: `get_metadata` under-reports on some files, so read
them over REST (`GET /v1/files/:key?depth=1`) and compare that list against
`dumps/`. A count of colours alone does not tell you a whole page was missed.

## Step 3 — verify before generating

```bash
node "$S/verify.mjs" [--baseline tokens/tokens.prev.json]
```

This is not ceremony. It runs the real generators in memory — over exactly what
each target will emit after filtering — to catch the one failure mode that is
invisible downstream: two Figma names that flatten to the same identifier
(`text/primary/default` and `text/primary-default` both become
`textPrimaryDefault`). A collision that reaches disk reads as a token that
"went missing" — much harder to trace back.

The same check covers the *file-level* symbols, not only per-group ones. A
design system with a `typography/font-size/*` dimension scale **and** text
styles wants the name `typography` twice; the text styles keep it and the
scale becomes `typographyScale` (`AppTypographyScale` in Dart). That rename is
deterministic and only fires on a real clash — nothing in Figma is wrong there,
so failing the export would punish the design file for a codegen detail.

It also prints the namespace and layer breakdown, and everything parked in
`other`, which is where anything unclassified goes rather than being silently
dropped. Read that list; a token you expected to see there means the extractor
needs work, not that the token is unimportant.

With `--baseline`, it diffs against the previous `tokens.json` and prints
added/removed/changed — paste that into the PR description.

**Done when:** `verify.mjs` exits 0, and every entry it lists under `other` has
been read and sorted into one of two buckets — a part a composite consumed
(expected), or a token that should have been exported (a bug to report, not to
skim past). Report both counts.

## Step 4 — generate

```bash
node "$S/generate.mjs"                    # all targets
node "$S/generate.mjs" --target web       # one target
node "$S/generate.mjs" --layers semantic  # one layer, overrides every target
```

Codegen never touches the network. It is fast, offline, deterministic, and
diffable — which is what makes the CI gate possible:

```bash
node "$S/generate.mjs" --check      # exits 1 if generated code ≠ tokens.json
```

Run `--check` in CI on every PR. It catches the two things that actually
happen: someone hand-edited a generated file, and someone updated `tokens.json`
without regenerating. The comparison ignores the header, so a re-extraction
timestamp alone is not drift.

## The everyday command: `sync`

Steps 2–4 are what happens the *first* time. After that, a designer changes
Figma and someone needs to know what moved — that is one command:

```bash
node "$S/sync.mjs" dumps/*.json              # one mode
node "$S/sync.mjs" dumps/light dumps/dark    # one directory per mode, first is the default
node "$S/sync.mjs" --rest                    # extract over REST instead of dumps
```

It snapshots the current `tokens.json`, re-extracts, **prints the token diff**,
runs verify as a gate, regenerates, and lists which generated files materially
changed:

```
[sync] changes vs previous tokens/tokens.json:
  ~ color text/primary/default: "#030712FF" -> "#111827FF"
  ~ color surface/raised [dark]: "#0B0B0CFF" -> "#111214FF"
  + dimension spacing/12 = 12
  - color color/legacy/accent (was "#FF5900FF")
[sync] 2 changed, 1 added, 1 removed
```

That diff is the answer to "what do I have to update?" — paste it into the PR.

Two properties worth relying on:

- **It never leaves `tokens.json` updated with stale generated code.** Verify
  runs before generate; if verify fails, the token file is restored from the
  snapshot and no generated file is touched. If generate fails part-way, the
  tokens are restored and the code rebuilt from them.
- **It refuses partial rebuilds.** `--target`, `--layers`, `--modes` and
  friends are rejected with a message pointing at `generate.mjs`, because
  regenerating one target against an updated shared token file leaves the
  others stale — the exact state sync exists to prevent.

The baseline it writes (`tokens/tokens.prev.json`) belongs in `.gitignore`; the
diff belongs in the PR description, and the baseline is recoverable from the
committed `tokens.json` anyway.

**Done when:** every file each target declared is on disk, and
`generate.mjs --check` exits 0 immediately afterwards. Where the project has the
toolchain, the generated code is compiled too — `tsc --strict` for web,
`dart analyze` for Flutter — because a file that generates cleanly can still
fail to compile, and finding that out here is cheaper than in the app.

## Step 5 — wire it into the app

Generated files are values, not a theme. Keeping them dumb is deliberate — it
means a Figma rename can never break hand-written theme logic. The wiring
(Flutter `ThemeExtension`, dark mode, a web theme layer) lives in the app, and
is described in `references/target-flutter.md` and `references/target-web.md`.

Leave the project with a README that records the resolved `$S`, the Figma file
key, and the node ids each dump came from. Without it the next regeneration
starts by rediscovering all three.

**Done when:** the project README carries those three things, and the theme
wiring references the generated symbols rather than restating their values.

## Pitfalls worth knowing before they cost an afternoon

- **Leave semantic decisions to design.** If the Figma file has two pages
  claiming to define the same semantic colour, extraction records the conflict
  and stops. Someone in design owns that answer.
- **Flutter's `height` is a multiplier, not pixels.** Figma reports line height
  in px; the generator divides by font size. Copying the px value straight into
  `TextStyle(height:)` silently produces enormous line spacing.
- **Alpha belongs in the stored value.** `tokens.json` always stores
  `#RRGGBBAA` so no target has to guess. Figma's per-fill `opacity` is folded
  in during REST extraction.
- **A `0` dimension needs no unit in CSS** but still needs `0.0` in Dart.
  Both generators handle it; a hand-written shortcut will not.
- **Fix the source, then regenerate.** If generated output is wrong, the bug is
  in a generator or in `tokens.json`. A fix edited into the output survives
  only until the next `generate`.
- **A mode is an extraction, not a flag.** `get_variable_defs` returns the mode
  active in the file, so dark mode cannot be added later without going back to
  Figma. Ask which modes are wanted before the first extraction.
- **Extraction resolves aliases away.** Matching values look like coincidence
  in `tokens.json`; they are usually a semantic token pointing at a primitive.
  See `aliasLinking` above before concluding the design system is flat.
- **A page listing from `get_metadata` can be incomplete.** On at least one
  production file it reports only the cover page even though other pages exist.
  When it looks empty, ask for a node-specific link rather than concluding the
  tokens are not there.

## Verifying the pipeline itself

```bash
node "$S/selftest.mjs"
```

Runs the whole chain against a fixture in a temp directory and asserts on real
output — colour normalization, `Font(...)` resolution, identifier collisions,
per-namespace splitting, layer selection, alias linking (including the
ambiguous and strict cases), and that `--check` both passes when in sync and
fails when tampered with. Run it after touching anything in `scripts/`.

Validated against two production Figma files:

- 511 colours / 37 dimensions / 33 text styles — `dart analyze` clean,
  `tsc --strict` clean, no identifier collisions. Alias linking there reports
  **4 linked, 125 ambiguous**, because that palette defines the same value
  under several names — the correct answer is to leave `aliasLinking` off.
- 615 colours across a primitive and a semantic collection — **261 of 261**
  semantic colours linked with zero ambiguity, no dangling `var()`, and every
  reference chain resolving back to the value in `tokens.json`.

The gap between those two numbers is the whole reason alias linking refuses
rather than guesses.

## Reference files

- `references/extraction-mcp.md` — choosing nodes, multi-dump merging, what MCP cannot see
- `references/extraction-rest.md` — token scope, styles vs scraping, CI setup
- `references/modes.md` — light/dark and other modes: asking, extracting per mode, theme output
- `references/layers.md` — exporting one layer (primitive/semantic/component), Figma collections, glob syntax
- `references/alias-linking.md` — restoring semantic → primitive references that extraction flattens
- `references/tokens-schema.md` — the `tokens.json` contract, and how to add a target
- `references/target-flutter.md` — output shape and wiring into `ThemeExtension`
- `references/target-web.md` — CSS var strategy, theming, TypeScript usage
