#!/usr/bin/env node
// tokens.json -> generated code for every target in tokens.config.json.
//
// Nothing here talks to Figma. Codegen is deliberately a separate step from
// extraction so it stays fast, offline, deterministic, and reviewable in a
// diff — and so `--check` can run as a CI gate proving the committed output
// still matches the committed tokens.
//
// Usage:
//   node generate.mjs [--config path] [--target flutter] [--check]
//                     [--layers semantic,component] [--include "text/**"] [--exclude "**/deprecated/**"]
//                     [--modes light,dark]
//
// Layer/pattern selection defaults to "everything". A CLI selector overrides
// the per-target one in the config for every target in the run.
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadConfig, parseArgs } from './lib/config.mjs';
import { loadTokens, countTokens } from './lib/dtcg.mjs';
import { stampLayers, filterTokens, summarizeLayers } from './lib/filter.mjs';
import { buildAliasMap, describeAliasResult } from './lib/alias.mjs';
import { modesOf, projectMode, overridesForMode, summarizeModes } from './lib/modes.mjs';
import { stripGeneratedHeader } from './lib/diff.mjs';
import { generateFlutter } from './lib/targets/flutter.mjs';
import { generateWeb } from './lib/targets/web.mjs';
import { generateDtcg } from './lib/targets/dtcg.mjs';

const GENERATORS = {
  flutter: generateFlutter,
  web: generateWeb,
  dtcg: generateDtcg,
};

const DEFAULT_TARGET_OPTIONS = {
  flutter: { prefix: 'App', groupColorsByNamespace: false },
  web: { cssPrefix: '', dimensionUnit: 'px', remBase: 16, react: false },
  dtcg: { dimensionUnit: 'px' },
};

async function readIfExists(file) {
  try {
    return await fs.readFile(file, 'utf8');
  } catch {
    return null;
  }
}

async function main() {
  const args = parseArgs();
  const config = await loadConfig(typeof args.config === 'string' ? args.config : undefined);
  const check = Boolean(args.check);

  let set;
  try {
    set = await loadTokens(config.tokensPath);
  } catch (err) {
    throw new Error(
      `Could not read ${path.relative(config.rootDir, config.tokensPath)} (${err.code ?? err.message}). ` +
        'Run the extraction step first: normalize-mcp.mjs or fetch-rest.mjs.',
    );
  }

  const counts = countTokens(set);
  console.log(
    `[generate] tokens.json — ${counts.color} color, ${counts.dimension} dimension, ` +
      `${counts.typography} typography${counts.shadow ? `, ${counts.shadow} shadow` : ''}` +
      `${counts.other ? `, ${counts.other} unclassified (not exported)` : ''}`,
  );

  stampLayers(set, config.layers);
  if (config.layers) {
    const perLayer = [...summarizeLayers(set)].map(([layer, n]) => `${layer}: ${n}`).join(', ');
    console.log(`[generate] layers — ${perLayer}`);
  }

  // CLI selection applies to every target, for one-off exports without
  // editing the config ("just give me the semantic layer").
  const cliModes = splitList(args.modes) ?? splitList(args.mode);
  const allModes = modesOf(set);
  if (allModes.length > 1) {
    console.log(
      `[generate] modes — ${[...summarizeModes(set)].map(([m, i]) => `${m} (${i.role}, ${i.tokens})`).join(', ')}`,
    );
  }

  const cliSelection = {
    layers: splitList(args.layers),
    include: splitList(args.include),
    exclude: splitList(args.exclude),
  };

  const selected = args.target
    ? config.targets.filter((t) => t.type === args.target)
    : config.targets;
  if (selected.length === 0) {
    throw new Error(`No target of type "${args.target}" in ${path.relative(config.rootDir, config.configPath)}.`);
  }

  const sourceLabel = [
    set.$meta?.source ?? 'unknown source',
    set.$meta?.fileKey ? `file ${set.$meta.fileKey}` : null,
    set.$meta?.extractedAt ? `extracted ${set.$meta.extractedAt}` : null,
  ]
    .filter(Boolean)
    .join(' | ');

  const drift = [];
  let written = 0;

  for (const target of selected) {
    const options = { ...DEFAULT_TARGET_OPTIONS[target.type], ...target, sourceLabel };

    const selection = {
      layers: cliSelection.layers ?? target.layers,
      include: cliSelection.include ?? target.include,
      exclude: cliSelection.exclude ?? target.exclude,
    };
    const { set: targetSet, stats } = filterTokens(set, selection);
    if (stats.filtered) {
      const rule = [
        selection.layers?.length ? `layers=${selection.layers.join('+')}` : null,
        selection.include?.length ? `include=${selection.include.join(',')}` : null,
        selection.exclude?.length ? `exclude=${selection.exclude.join(',')}` : null,
      ]
        .filter(Boolean)
        .join(' ');
      console.log(`[generate] ${target.type}: ${rule} → ${stats.kept} kept, ${stats.dropped} dropped`);
      for (const layer of stats.unknownLayers) {
        console.warn(`[generate] WARN ${target.type}: no token carries layer "${layer}" — check the \`layers\` patterns.`);
      }
      if (stats.kept === 0) {
        throw new Error(
          `${target.type}: the selection matched 0 tokens. Run \`node scripts/verify.mjs\` to see which layers and namespaces exist.`,
        );
      }
    }

    // Modes: the default mode drives the main output; every other selected
    // mode becomes a theme block (web) or a mode class (flutter).
    const selectedModes = resolveModes(targetSet, target, cliModes);
    if (selectedModes.extras.length) {
      options.modeBlocks = selectedModes.extras.map((mode) => {
        const projected = projectMode(targetSet, mode, selectedModes.defaultMode);
        const { set: overrides, count } = overridesForMode(targetSet, mode, selectedModes.defaultMode);
        console.log(`[generate] ${target.type}: mode "${mode}" — ${count} token(s) differ from "${selectedModes.defaultMode}"`);
        return {
          mode,
          selector: target.modeSelectors?.[mode] ?? `:root[data-theme="${mode}"]`,
          projected,
          overrides,
          aliasMap: target.aliasLinking ? buildAliasMap(projected, target.aliasLinking).aliases : null,
        };
      });
    }
    if (selectedModes.unknown.length) {
      throw new Error(
        `${target.type}: mode(s) ${selectedModes.unknown.map((m) => `"${m}"`).join(', ')} are not in tokens.json ` +
          `(have: ${selectedModes.available.join(', ') || 'none'}). Extract them first with normalize-mcp --mode <name> --merge.`,
      );
    }

    if (target.aliasLinking) {
      const result = buildAliasMap(targetSet, target.aliasLinking);
      options.aliasMap = result.aliases;
      console.log(`[generate] ${target.type}: aliasLinking — ${describeAliasResult(result)}`);
      for (const a of result.ambiguous.slice(0, 5)) {
        console.warn(`[generate] WARN ambiguous alias, kept literal: ${a.name} (${a.value}) matches ${a.candidates.join(' | ')}`);
      }
      if (result.ambiguous.length > 5) {
        console.warn(`[generate] WARN … and ${result.ambiguous.length - 5} more ambiguous token(s)`);
      }
    }

    const files = GENERATORS[target.type](targetSet, options);

    for (const { file, contents } of files) {
      const outFile = path.join(target.out, file);
      const existing = await readIfExists(outFile);

      if (check) {
        // The header carries a timestamp, so compare everything below it.
        if (stripGeneratedHeader(existing) !== stripGeneratedHeader(contents)) {
          drift.push(path.relative(config.rootDir, outFile));
        }
        continue;
      }

      await fs.mkdir(target.out, { recursive: true });
      await fs.writeFile(outFile, contents);
      written++;
      // "unchanged" ignores the header: a fresh extraction timestamp is not a
      // change to the tokens, and reporting it as one trains people to skim
      // past the list that is supposed to tell them what moved.
      const status =
        existing === null
          ? 'new'
          : stripGeneratedHeader(existing) === stripGeneratedHeader(contents)
            ? 'unchanged'
            : 'updated';
      console.log(`[generate] ${target.type}: ${path.relative(config.rootDir, outFile)} (${status})`);
    }
  }

  if (check) {
    if (drift.length) {
      console.error(
        `[generate] --check FAILED: ${drift.length} generated file(s) do not match tokens.json:\n` +
          drift.map((f) => `  ${f}`).join('\n') +
          '\nRun `node scripts/generate.mjs` and commit the result.',
      );
      process.exit(1);
    }
    console.log('[generate] --check passed: generated code matches tokens.json.');
    return;
  }

  console.log(`[generate] wrote ${written} file(s) across ${selected.length} target(s).`);
}

/**
 * Which modes this target emits.
 *
 * Default is ALL modes present in tokens.json — extracting a mode and then
 * silently not shipping it is the confusing outcome. `--modes` or the target's
 * `modes` narrows it; naming a mode that was never extracted is an error, not
 * an empty theme block.
 */
function resolveModes(set, target, cliModes) {
  const available = modesOf(set);
  const defaultMode = set.$meta?.defaultMode ?? available[0] ?? null;
  const requested = cliModes ?? target.modes ?? null;

  if (!requested) {
    return { defaultMode, available, extras: available.filter((m) => m !== defaultMode), unknown: [] };
  }
  const unknown = requested.filter((m) => !available.includes(m));
  return {
    defaultMode,
    available,
    extras: requested.filter((m) => m !== defaultMode && available.includes(m)),
    unknown,
  };
}

/** `--layers a,b` / `--include x,y` → array; absent → undefined (meaning "no override"). */
function splitList(value) {
  if (typeof value !== 'string') return undefined;
  const items = value.split(',').map((s) => s.trim()).filter(Boolean);
  return items.length ? items : undefined;
}

main().catch((err) => {
  console.error(`[generate] FAILED: ${err.message}`);
  process.exit(1);
});
