# Adopting the pipeline in a project that already has tokens

Almost no project starts here. It starts with colours already written by hand —
a `:root` block, a Dart holder class — and the question nobody can answer by
reading is how much of that already agrees with the design system.

`audit.mjs` answers it. It reads what the project declares, matches each
declaration against `tokens.json`, and sorts the result into four buckets.

## Contents

- Running it
- Reading the four buckets
- What it refuses to do
- The order the adoption goes in

---

## Running it

```bash
node "$S/audit.mjs" src/styles.css lib/theme/app_colors.dart
node "$S/audit.mjs" src/styles.css --strict      # exit 1 when anything drifted
```

Two readers, matching the two shapes that exist in practice:

| extension | reads |
|---|---|
| `.css` | custom properties in any block — `--primary-default: #e32321;` |
| `.dart` | `static const Color x = Color(0xAARRGGBB)` |

A file with any other extension is named and skipped, not silently counted as
nothing.

Matching runs twice, by name and by value. The name rule is a **suffix** match
on the kebab spelling, so `--primary-default` finds `colors/primary/default`
without anyone telling it which collection prefix the design system chose.
Underscores are treated as hyphens, because a project writing
`primary-soft_light` means the same token as `primary/soft-light`.

## Reading the four buckets

**matched** — name and value agree. Nothing to do.

**drifted** — a token of that name exists and the value does not agree. Both
values are printed. This is the bucket that matters: the screen is not showing
what design drew, and no test in the project would have caught it.

```
~ globals.css --warning-default  code=#F59E0BFF  figma=#EAB308FF  (colors/warning/default)
```

**right value, different name** — the colour is in the design system under a
name the project does not use. Reported separately from `matched` because it is
one rename away from being a real token, and `figma-rename` is the tool for
that. Several project names pointing at one token is the common shape here, and
it means design cannot move them independently later.

**unknown** — neither the name nor the value is in the design system. Take these
to design: either they become tokens, or they were never meant to be.

**unreadable** — a colour this cannot convert. `oklch()`, `var()`, `calc()`.
Reported rather than counted as anything, because a value that cannot be
compared is not a value that agrees.

## What it refuses to do

- **Ambiguity is reported, not resolved.** A name matching two tokens whose
  values both differ prints both candidates rather than picking one — picking
  would invent the mapping this exists to measure.
- **It reports; it does not gate.** Exit 0 unless `--strict`. A first run on a
  real project produces a long list, and a tool that fails the build on day one
  gets removed on day one. Turn on `--strict` once the list is short.
- **It changes nothing.** The output is the input to a conversation with
  design, not a patch.

## The order the adoption goes in

1. **Audit.** Establish the four numbers.
2. **Take `unknown` to design.** Every one either becomes a token in Figma or
   is deliberately left out of the system. This is the slow step, and it is the
   one that makes the rest safe.
3. **Extract and generate** into a scratch directory — do not overwrite yet.
4. **Diff the generated file against the current one.** With `colorFormat` set
   to match how the project already spells colours, the remaining diff is only
   real changes. See `references/target-web.md`.
5. **Swap, in one commit, with the diff in the description.** Every changed
   pixel is a value design already owns, and the diff is the proof.

The drift found in step 1 is the reason to do this at all. Two production
projects in this team carry the same eighteen wrong values, copied from one
another — a shared token file with `generate.mjs --check` in CI is what stops
the third copy.
