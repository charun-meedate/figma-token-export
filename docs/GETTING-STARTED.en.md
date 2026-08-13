# How to use it — for people who want Figma tokens in their code

> [ภาษาไทย](GETTING-STARTED.md) · English
> Maintaining the skill itself / want to know how it works inside →
> [MAINTAINING.en.md](MAINTAINING.en.md)

You don't run any scripts. **Claude Code does that for you.** You say what you
want and answer the one question it asks back. This guide covers what to say and
what you get.

## In this guide

1. [One-time setup](#one-time-setup)
2. [First run — tell Claude what you want](#first-run--tell-claude-what-you-want)
3. [Claude will ask you one thing — about modes](#claude-will-ask-you-one-thing--about-modes)
4. [What you get](#what-you-get)
5. [When design changes the Figma file](#when-design-changes-the-figma-file)
6. [Two rules](#two-rules)
7. [If Claude says it's stuck](#if-claude-says-its-stuck)

---

## One-time setup

1. Make sure you can open the Figma file you want to export
2. Install the skill into your project — once per project:

```bash
git clone <url-of-this-repo> ~/dev/design-tokens-skill
~/dev/design-tokens-skill/install.sh ~/dev/my-project
```

That's it. Everything else is a conversation with Claude Code in that project.

---

## First run — tell Claude what you want

Open Claude Code in the project and type something like this, **with the Figma
link**:

> Pull the design tokens from this file into the project, as CSS + TypeScript.
> https://www.figma.com/design/kQ8mR2xJ7vNbL4wYtZcHpA/Design-system?node-id=59-862

Say which output you want: **CSS + TypeScript** (web) · **Dart** (Flutter) ·
**standard JSON** (for other tooling, or to import back into Figma).

### A good link points at a frame

A plain page link usually isn't enough — Figma only lets tools read the
variables bound inside the node you name. The way to get a link that always
works:

> In Figma → right-click the **documentation frame** (e.g. `Spacing-Overview`) →
> **Copy link to selection**

Do that for every page that holds tokens: colour · typography · spacing ·
radius · shadow. Sending them all at once is the fastest path.

If you don't know what pages the file has, just ask: "list the pages in this
Figma file". Claude can find them if the project has a Figma token configured.

---

## Claude will ask you one thing — about modes

**"Which modes do you want — just light, or dark too?"**

Answer this properly up front. Figma only hands over one mode at a time, so
getting dark means someone switching the mode in Figma during extraction —
**it cannot be added later without going back to Figma.** A wrong answer costs a
full round trip.

---

## What you get

Claude will summarise something like:

```
615 colours, 72 sizes, 51 text styles, 4 shadows
Files: src/tokens/tokens.css, src/tokens/tokens.ts
```

**Using them (web):**

```ts
import { colorVar, spacing, boxShadowVar } from './tokens/tokens';

<div style={{ background: colorVar.colorSurfacePrimaryDefault, padding: spacing.md }} />
```

```html
<!-- every text style ships a ready-made class -->
<h1 class="typography-heading-heading-1-bold">Heading</h1>
```

**The one rule to remember:** use the `Var` ones (`colorVar`, `boxShadowVar`).
They can be re-themed at runtime. The non-`Var` ones are frozen values — only
reach for those where a CSS variable genuinely cannot go (canvas, inline SVG).

On Flutter you get `AppColors`, `AppSpacing`, `AppTypography`, `AppShadows`.

---

## When design changes the Figma file

Type:

> sync the tokens from Figma again

Claude re-extracts and **tells you what moved**:

```
~ colour text/primary/default: #030712 → #111827
+ size spacing/12 = 12
- colour color/legacy/accent (gone)
```

**Paste that into the PR.** It is the answer to "what do I have to update?",
which is exactly what a reviewer wants to know.

If anything was removed (`-`), check whether code still uses it.

---

## Two rules

**1. Never hand-edit a generated file** (`tokens.css`, `tokens.ts`, `*.g.dart`).
The next sync overwrites it. If a value looks wrong, tell Claude what's wrong and
let it fix the source.

**2. Never type colour or size values by hand alongside the tokens.** Two
sources always drift apart, and the drift shows up as a bug in a screen nobody
was looking at.

---

## If Claude says it's stuck

| It says | It means | What you do |
|---|---|---|
| it needs a frame-level link | the link you gave is a bare page with no tokens bound to it | right-click the frame → Copy link to selection |
| token names collide | two Figma names flatten to the same name in code | design has to rename one in Figma — it cannot be fixed in code |
| N variables it couldn't classify, in `other` | mostly parts already folded into a text style — **normal** | skim the list; if something you expected is there, say so |
| dark mode needs another extraction | a mode cannot be added afterwards | have someone switch Figma to dark and run it again |
| fewer tokens than you expected | not every page was linked yet | send links for the remaining pages |

---

## Going deeper

- How the skill works, running the scripts yourself, changing the skill →
  [MAINTAINING.en.md](MAINTAINING.en.md)
- Every option each target supports → [MAINTAINING.en.md](MAINTAINING.en.md)
