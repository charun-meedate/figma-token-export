---
name: figma-token-export
description: Export design tokens from a Figma file into code — colours, spacing/radius scales, and typography — as Flutter/Dart, web CSS+TypeScript, or W3C DTCG JSON, with a committed tokens.json in between, per-mode (light/dark) output and a CI drift gate. Use when asked to sync Figma tokens to code, set up a design-token pipeline, regenerate tokens after a design update, diff what a designer changed, or when Figma variables need to become a theme, palette, or token file in any codebase.
---

# Figma design tokens → code

**Read `./figma-token-export.md` in full before doing anything else.** It is the
operating manual for this skill: the extraction paths and their plan-gated
limits, the `tokens.json` contract, layer and mode selection, alias linking,
and the failure modes each step is built to surface. Acting on the summary
below alone will produce a token file that looks right and is wrong.

The pipeline, in one line:

```
Figma ──extract──▶ tokens/tokens.json ──generate──▶ Flutter | Web | DTCG
```

Everyday command once a project is set up — extract, diff, verify, regenerate:

```bash
node "$S/sync.mjs" dumps/*.json
```

`$S` is this skill's `scripts/` directory; resolving it correctly is the first
thing the manual covers, and the most common way a first run fails.

Deeper detail lives in `./references/`, loaded on demand:

| file | when |
|---|---|
| [`references/extraction-mcp.md`](references/extraction-mcp.md) | reading Figma Variables through MCP (the default path) |
| [`references/extraction-rest.md`](references/extraction-rest.md) | the REST fallback, CI, and what the plan tier blocks |
| [`references/modes.md`](references/modes.md) | light/dark and other modes — ask the user first |
| [`references/layers.md`](references/layers.md) | exporting only primitives / semantics / components |
| [`references/alias-linking.md`](references/alias-linking.md) | restoring semantic → primitive references |
| [`references/audit.md`](references/audit.md) | adopting the pipeline in a project that already has tokens by hand |
| [`references/tokens-schema.md`](references/tokens-schema.md) | the token file contract, and adding a new target |
| [`references/target-flutter.md`](references/target-flutter.md), [`references/target-web.md`](references/target-web.md) | output shape and how to wire it into an app |

[`evals/`](evals/README.md) holds three behaviour tests built from real failures.
Run them after changing anything in this skill — `scripts/selftest.mjs` proves
the scripts still work, the evals prove the process still gets walked.
