#!/usr/bin/env node
// What a project declares today, measured against tokens.json.
//
// Every project that predates this pipeline has its colours written somewhere
// by hand — a `:root` block, a Dart holder class. Adopting the pipeline starts
// with one question nobody can answer by reading: how much of that already
// matches the design system, and what would change if it were generated?
//
// Across six production projects the answer ranged from 225/225 to 5/52, and
// two of them had copied the same wrong values from each other. That is not a
// number anyone should be reconstructing by hand each time.
//
// This reports; it does not gate. `--strict` exits 1 when anything drifted,
// for a team that wants CI to hold the line once it is green.
//
// Usage:
//   node audit.mjs src/styles.css lib/theme/app_colors.dart [--config path] [--strict]
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadConfig, parseArgs } from './lib/config.mjs';
import { loadTokens, normalizeHex } from './lib/dtcg.mjs';
import { toKebab } from './lib/naming.mjs';

/**
 * Declarations a file makes, as `{ name, raw }`.
 *
 * Only two readers, because these are the two shapes the team actually has:
 * CSS custom properties and Dart `static const Color`. A file the reader does
 * not recognise is reported as skipped rather than silently contributing
 * nothing to the totals.
 */
const READERS = {
  '.css': (text) =>
    [...text.matchAll(/(?:^|[\s;{])--([A-Za-z0-9_-]+)\s*:\s*([^;}]+)/g)].map((m) => ({
      name: m[1],
      raw: m[2].trim(),
    })),
  '.dart': (text) =>
    [...text.matchAll(/static\s+const\s+(?:Color\s+)?(\w+)\s*=\s*Color\(0x([0-9a-fA-F]{8})\)/g)].map((m) => ({
      name: m[1],
      // Dart is 0xAARRGGBB; every other value in this pipeline is #RRGGBBAA.
      raw: `#${m[2].slice(2)}${m[2].slice(0, 2)}`,
    })),
};

/** Kebab spelling used to match a declaration against a token path. */
function kebab(name) {
  return toKebab(name.replace(/_/g, '-'));
}

/**
 * Tokens whose name ends with the declaration's name.
 *
 * `--primary-default` matches `colors/primary/default`, and the suffix rule is
 * what lets it match without knowing which collection prefix the design system
 * chose. Two matches is ambiguous and is reported as such: picking one would be
 * inventing the mapping the audit exists to measure.
 */
function matchByName(declName, tokenIndex) {
  const wanted = kebab(declName);
  const hits = tokenIndex.filter(({ kebabName }) => kebabName === wanted || kebabName.endsWith(`-${wanted}`));
  if (hits.length === 0) return null;
  const exact = hits.filter(({ kebabName }) => kebabName === wanted);
  const chosen = exact.length ? exact : hits;
  return { candidates: chosen, ambiguous: chosen.length > 1 };
}

async function main() {
  const args = parseArgs();
  const inputs = args._;
  if (inputs.length === 0) {
    console.error('Usage: node audit.mjs <file...> [--config path] [--strict]');
    process.exit(2);
  }

  const config = await loadConfig(typeof args.config === 'string' ? args.config : undefined);
  const set = await loadTokens(config.tokensPath);

  const tokenIndex = Object.entries(set.color).map(([name, token]) => ({
    name,
    kebabName: kebab(name),
    value: String(token.$value).toUpperCase(),
  }));
  const byValue = new Map();
  for (const entry of tokenIndex) {
    if (!byValue.has(entry.value)) byValue.set(entry.value, []);
    byValue.get(entry.value).push(entry.name);
  }

  const matched = [];
  const drifted = [];
  const unknown = [];
  const unreadable = [];

  for (const file of inputs) {
    const reader = READERS[path.extname(file).toLowerCase()];
    if (!reader) {
      console.warn(`[audit] skipped ${path.basename(file)} — no reader for ${path.extname(file)} (css, dart)`);
      continue;
    }
    const declarations = reader(await fs.readFile(file, 'utf8'));
    console.log(`[audit] ${path.relative(config.rootDir, file)}: ${declarations.length} declaration(s)`);

    for (const { name, raw } of declarations) {
      const where = `${path.basename(file)} --${name}`;
      const hex = normalizeHex(raw);
      if (!hex) {
        // oklch(), var(), calc(): a value this cannot convert is not a value
        // this can compare. Guessing would be worse than saying so.
        unreadable.push({ where, name, raw });
        continue;
      }
      const named = matchByName(name, tokenIndex);
      const sameValue = byValue.get(hex) ?? null;

      if (named && !named.ambiguous) {
        const token = named.candidates[0];
        if (token.value === hex) matched.push({ where, name, token: token.name, hex });
        else drifted.push({ where, name, token: token.name, code: hex, figma: token.value });
      } else if (named?.ambiguous) {
        const exactValue = named.candidates.find((c) => c.value === hex);
        if (exactValue) matched.push({ where, name, token: exactValue.name, hex });
        else drifted.push({ where, name, token: named.candidates.map((c) => c.name).join(' | '), code: hex, figma: '(หลายตัว)' });
      } else if (sameValue) {
        // The value exists in the design system under a name this project does
        // not use — a rename away from being a real token.
        matched.push({ where, name, token: sameValue[0], hex, valueOnly: true });
      } else {
        unknown.push({ where, name, hex });
      }
    }
  }

  const total = matched.length + drifted.length + unknown.length + unreadable.length;
  console.log(`\n[audit] ${total} declaration(s) read`);
  console.log(`  matched     ${String(matched.length).padStart(4)}  name and value agree with tokens.json`);
  console.log(`  drifted     ${String(drifted.length).padStart(4)}  the token exists, the value does not agree`);
  console.log(`  unknown     ${String(unknown.length).padStart(4)}  no token by that name or that value`);
  console.log(`  unreadable  ${String(unreadable.length).padStart(4)}  a colour this cannot convert (oklch, var, calc)`);

  if (drifted.length) {
    console.log('\n[audit] drifted — the code and the design system disagree:');
    for (const d of drifted) console.log(`  ~ ${d.where}  code=${d.code}  figma=${d.figma}  (${d.token})`);
  }
  const renames = matched.filter((m) => m.valueOnly);
  if (renames.length) {
    console.log('\n[audit] right value, different name — a rename away from being a real token:');
    for (const m of renames) console.log(`  = ${m.where}  ${m.hex}  →  ${m.token}`);
  }
  if (unknown.length) {
    console.log('\n[audit] not in the design system at all — take these to design:');
    for (const u of unknown) console.log(`  ✗ ${u.where}  ${u.hex}`);
  }
  if (unreadable.length) {
    console.log('\n[audit] could not be compared:');
    for (const u of unreadable) console.log(`  ? ${u.where}  ${u.raw}`);
  }

  if (args.strict && drifted.length) {
    console.error(`\n[audit] --strict: ${drifted.length} declaration(s) drifted from tokens.json.`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`[audit] FAILED: ${err.message}`);
  process.exit(1);
});
