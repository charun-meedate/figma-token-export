#!/usr/bin/env node
// Checks tokens.json before anyone generates code from it, and optionally
// diffs it against a baseline copy to show what a re-extraction changed.
//
// The identifier check runs the real generators in memory. That is the only
// way to be sure two Figma token names will not collapse into one Dart/TS
// field — a collision that reaches disk looks like a token that "went
// missing", which is a much worse bug to chase.
//
// Usage:
//   node verify.mjs [--config path] [--baseline tokens/tokens.prev.json]
import path from 'node:path';
import { loadConfig, parseArgs } from './lib/config.mjs';
import { loadTokens, countTokens, EXPORTED_GROUPS } from './lib/dtcg.mjs';
import { stampLayers, summarizeLayers, summarizeNamespaces, filterTokens } from './lib/filter.mjs';
import { buildAliasMap, describeAliasResult } from './lib/alias.mjs';
import { modesOf, summarizeModes } from './lib/modes.mjs';
import { diffTokenSets, formatDiffLines } from './lib/diff.mjs';
import { generateFlutter } from './lib/targets/flutter.mjs';
import { generateWeb } from './lib/targets/web.mjs';
import { generateDtcg } from './lib/targets/dtcg.mjs';

const GENERATORS = { flutter: generateFlutter, web: generateWeb, dtcg: generateDtcg };

function validateStructure(set) {
  const problems = [];

  for (const [name, token] of Object.entries(set.color)) {
    if (!/^#[0-9A-F]{8}$/.test(String(token.$value))) {
      problems.push(`color "${name}" is not normalized to #RRGGBBAA (got ${JSON.stringify(token.$value)})`);
    }
  }
  for (const [name, token] of Object.entries(set.dimension)) {
    if (typeof token.$value !== 'number' || !Number.isFinite(token.$value)) {
      problems.push(`dimension "${name}" is not a finite number (got ${JSON.stringify(token.$value)})`);
    }
  }
  for (const [name, token] of Object.entries(set.typography)) {
    const v = token.$value ?? {};
    if (!v.fontFamily) problems.push(`typography "${name}" has no fontFamily`);
    if (typeof v.fontSize !== 'number') problems.push(`typography "${name}" has no numeric fontSize`);
    if (v.lineHeight == null) problems.push(`typography "${name}" has no lineHeight — line spacing will fall back to the font default`);
  }
  for (const [name, token] of Object.entries(set.shadow ?? {})) {
    if (!Array.isArray(token.$value) || token.$value.length === 0) {
      problems.push(`shadow "${name}" is not a non-empty array of layers`);
      continue;
    }
    token.$value.forEach((layer, i) => {
      const where = `shadow "${name}" layer ${i + 1}`;
      if (!/^#[0-9A-F]{8}$/.test(String(layer.color))) {
        problems.push(`${where} colour is not normalized to #RRGGBBAA (got ${JSON.stringify(layer.color)})`);
      }
      for (const field of ['offsetX', 'offsetY', 'blur', 'spread']) {
        if (typeof layer[field] !== 'number' || !Number.isFinite(layer[field])) {
          problems.push(`${where} has a non-numeric ${field} (got ${JSON.stringify(layer[field])})`);
        }
      }
      // A colourRef pointing at a token that no longer exists would generate a
      // var() nothing defines — a shadow that silently renders transparent.
      if (layer.colorRef && !set.color[layer.colorRef]) {
        problems.push(`${where} references colour "${layer.colorRef}", which is not in tokens.json`);
      }
    });
  }
  return problems;
}

async function main() {
  const args = parseArgs();
  const config = await loadConfig(typeof args.config === 'string' ? args.config : undefined);
  const set = await loadTokens(config.tokensPath);
  const counts = countTokens(set);

  console.log(
    `[verify] ${path.relative(config.rootDir, config.tokensPath)} — ` +
      `${counts.color} color, ${counts.dimension} dimension, ${counts.typography} typography, ${counts.shadow} shadow, ${counts.other} other`,
  );

  const problems = validateStructure(set);

  // What exists, before anyone writes a filter for it. Namespaces are the
  // vocabulary the `layers` globs are written against.
  console.log('[verify] namespaces (first path segment):');
  for (const [ns, info] of [...summarizeNamespaces(set)].sort((a, b) => b[1].count - a[1].count)) {
    console.log(`  ${ns.padEnd(16)} ${String(info.count).padStart(4)}  [${[...info.groups].join(', ')}]  e.g. ${info.sample}`);
  }

  const modes = modesOf(set);
  if (modes.length > 1) {
    console.log(`[verify] modes (default: ${set.$meta?.defaultMode ?? '?'}):`);
    for (const [mode, info] of summarizeModes(set)) {
      console.log(`  ${mode.padEnd(16)} ${String(info.tokens).padStart(4)}  ${info.role === 'default' ? 'tokens' : 'differ from default'}`);
      if (info.role === 'override' && info.tokens === 0) {
        problems.push(`mode "${mode}" changes no token — it was extracted from the same Figma mode as the default.`);
      }
    }
  } else if (modes.length === 1) {
    console.log(`[verify] single mode: ${modes[0]}`);
  }

  stampLayers(set, config.layers);
  if (config.layers) {
    console.log('[verify] layers:');
    for (const [layer, count] of summarizeLayers(set)) {
      console.log(`  ${layer.padEnd(16)} ${String(count).padStart(4)}`);
    }
    const unassigned = [...summarizeLayers(set)].find(([layer]) => layer === '(unassigned)');
    if (unassigned) {
      const names = EXPORTED_GROUPS
        .flatMap((g) => Object.entries(set[g]).filter(([, t]) => !t.$layer).map(([n]) => n))
        .slice(0, 10);
      console.log(`  unassigned examples: ${names.join(', ')}${unassigned[1] > 10 ? ', …' : ''}`);
      console.log('  (unassigned tokens are still exported unless a target selects specific layers)');
    }
  } else {
    console.log('[verify] no `layers` configured — every target exports all tokens.');
  }

  for (const target of config.targets) {
    // Check the identifiers of what this target will ACTUALLY emit: a
    // collision between two layers does not matter if only one is exported.
    const { set: targetSet, stats } = filterTokens(set, {
      layers: target.layers,
      include: target.include,
      exclude: target.exclude,
    });
    const scope = stats.filtered ? ` (${stats.kept} of ${stats.kept + stats.dropped} tokens)` : '';
    try {
      GENERATORS[target.type](targetSet, { prefix: 'App', cssPrefix: '', dimensionUnit: 'px', sourceLabel: 'verify' });
      console.log(`[verify] ${target.type}: identifiers OK${scope}`);
    } catch (err) {
      problems.push(`${target.type} codegen would fail: ${err.message}`);
    }
    if (target.aliasLinking) {
      try {
        const result = buildAliasMap(targetSet, target.aliasLinking);
        console.log(`[verify] ${target.type}: aliasLinking — ${describeAliasResult(result)}`);
        for (const a of result.ambiguous.slice(0, 5)) {
          console.warn(`  ambiguous (kept literal): ${a.name} = ${a.value} → ${a.candidates.join(' | ')}`);
        }
        for (const u of result.unmatched.slice(0, 5)) {
          console.warn(`  no primitive matches: ${u.name} = ${u.value}`);
        }
      } catch (err) {
        problems.push(`${target.type} aliasLinking: ${err.message}`);
      }
    }
    // The one thing generate throws on that nothing else checks: a target
    // naming a mode that was never extracted. Catching it here means sync's
    // verify gate stops it before any file is written.
    for (const mode of target.modes ?? []) {
      if (!modes.includes(mode)) {
        problems.push(
          `${target.type} selects mode "${mode}" but tokens.json has ${modes.length ? modes.map((m) => `"${m}"`).join(', ') : 'no modes'}.`,
        );
      }
    }
    if (stats.filtered && stats.kept === 0) {
      problems.push(`${target.type} selection matches 0 tokens — check its layers/include/exclude.`);
    }
    for (const layer of stats.unknownLayers) {
      problems.push(`${target.type} selects layer "${layer}" but no token carries it.`);
    }
  }

  if (counts.other) {
    console.log(`[verify] ${counts.other} variable(s) in "other" are NOT exported:`);
    for (const [name, token] of Object.entries(set.other)) {
      console.log(`  ${name} = ${JSON.stringify(token.$value)} (${token.$note ?? 'unclassified'})`);
    }
  }

  for (const warning of set.$meta?.warnings ?? []) {
    console.warn(`[verify] extraction warning: ${warning}`);
  }

  if (args.baseline) {
    const baseline = await loadTokens(path.resolve(config.rootDir, String(args.baseline)));
    const lines = formatDiffLines(diffTokenSets(baseline, set));
    console.log(lines.length ? `[verify] changes vs baseline:\n${lines.join('\n')}` : '[verify] no changes vs baseline.');
  }

  if (problems.length) {
    console.error(`[verify] ${problems.length} problem(s):\n${problems.map((p) => `  ${p}`).join('\n')}`);
    process.exit(1);
  }
  console.log('[verify] OK');
}

main().catch((err) => {
  console.error(`[verify] FAILED: ${err.message}`);
  process.exit(1);
});
