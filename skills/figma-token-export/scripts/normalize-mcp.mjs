#!/usr/bin/env node
// Extraction path A (preferred): Figma MCP `get_variable_defs` -> tokens.json
//
// `get_variable_defs` returns a FLAT map of variable name -> string value for
// the variables bound anywhere inside ONE node's subtree. Real output:
//
//   {
//     "color/mono/black": "#000000",
//     "text/primary/default": "#030712",
//     "spacing/8": "8",
//     "radius/2": "2",
//     "body/font": "Google Sans",
//     "body/lg/bold/size": "16",
//     "body/lg/bold/weight": "Bold",
//     "body/lg/bold/line-height": "22",
//     "Body/lg/bold": "Font(family: \"body/font\", style: body/lg/bold/weight, size: body/lg/bold/size, weight: 700, lineHeight: body/lg/bold/line-height, letterSpacing: body/lg/bold/letter-spacing)"
//   }
//
// Two consequences drive this script:
//
// 1. Coverage is per-node, not per-file. One call never returns every token.
//    So this script takes MANY dumps and merges them, and reports conflicts
//    rather than letting the last file silently win.
// 2. Composite type variables arrive as a `Font(...)` STRING whose fields
//    reference other variables by name. They are resolved against the merged
//    map here, and their referenced parts are moved out of the color/dimension
//    buckets so "body/lg/bold/size" does not masquerade as a spacing token.
//    Effect (shadow) variables arrive the same way — as `Effect(...)` strings,
//    several of them separated by "; " when the effect stacks:
//
//      "shadow-md": "Effect(type: DROP_SHADOW, color: color/shadow/md/edge, offset: (0, shadow/edge/offset-y), radius: shadow/edge/radius, spread: 0); Effect(type: DROP_SHADOW, color: color/shadow/md/ambient, offset: (0, shadow/offset-y/md), radius: shadow/radius/md, spread: shadow/ambient/spread)"
//
//    Unlike Font parts, the parts an Effect consumes are NOT moved to `other`:
//    the generated CSS points back at the colour token by `var()`, so removing
//    it would leave a dangling reference, and `shadow/radius/md` is a perfectly
//    usable dimension in its own right.
//
// Modes: one dump is always ONE mode, because `get_variable_defs` resolves to
// whichever mode is active in the file. So a light/dark system is two runs —
// the first writes the default mode, the second merges its values into
// `$modes` on the tokens already there:
//
//   node normalize-mcp.mjs dumps/light/*.json --mode light
//   node normalize-mcp.mjs dumps/dark/*.json  --mode dark --merge
//
// Usage:
//   node normalize-mcp.mjs dumps/*.json [--config path] [--out path]
//                          [--mode <name>] [--merge]
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadConfig, parseArgs } from './lib/config.mjs';
import { emptyTokenSet, normalizeHex, writeTokens, countTokens, loadTokens, EXPORTED_GROUPS } from './lib/dtcg.mjs';
import { stampLayers, summarizeLayers } from './lib/filter.mjs';
import { modesOf, summarizeModes } from './lib/modes.mjs';

const FONT_COMPOSITE = /^Font\((.*)\)$/s;
const EFFECT_COMPOSITE = /^Effect\(.*\)$/s;
const EFFECT_LAYER = /^Effect\((.*)\)$/s;

/** Splits "a: 1, b: \"x\", c: y" into field pairs without breaking on commas inside quotes. */
function parseCompositeFields(body) {
  const fields = {};
  for (const part of body.split(/,\s*(?=[A-Za-z][A-Za-z0-9]*\s*:)/)) {
    const match = part.match(/^\s*([A-Za-z][A-Za-z0-9]*)\s*:\s*(.*?)\s*$/s);
    if (match) fields[match[1]] = match[2];
  }
  return fields;
}

/** Resolves a composite field: strips quotes, then follows a variable reference if the name exists. */
function resolveField(rawValue, variables, referenced, depth = 0) {
  const literal = rawValue.replace(/^"(.*)"$/s, '$1').trim();
  if (depth < 5 && Object.hasOwn(variables, literal)) {
    referenced.add(literal);
    return resolveField(variables[literal], variables, referenced, depth + 1);
  }
  return literal;
}

/**
 * Like resolveField, but also reports the variable name the field pointed at.
 *
 * The name is what lets a shadow keep Figma's structure in the output: the
 * generated CSS says `var(--color-shadow-md-edge)` rather than a hex literal,
 * so re-theming the shadow colour re-themes the shadow. Only the FIRST hop is
 * reported — that is the token the designer actually referenced.
 */
function resolveRef(rawValue, variables) {
  const literal = String(rawValue ?? '').replace(/^"(.*)"$/s, '$1').trim();
  if (!Object.hasOwn(variables, literal)) return { value: literal, ref: null };
  return { value: resolveField(variables[literal], variables, new Set()), ref: literal };
}

/**
 * One `Effect(type: …, color: …, offset: (x, y), radius: …, spread: …)` layer.
 * Returns null when the effect is not a shadow (a blur, say) — the caller then
 * refuses the whole token rather than emitting half of it.
 */
function parseEffectLayer(raw, variables) {
  const match = raw.trim().match(EFFECT_LAYER);
  if (!match) return null;
  const fields = parseCompositeFields(match[1]);

  const type = (fields.type ?? '').trim().toUpperCase();
  if (type !== 'DROP_SHADOW' && type !== 'INNER_SHADOW') return null;

  const color = resolveRef(fields.color, variables);
  const hex = normalizeHex(color.value);
  if (!hex) return null;

  // offset arrives as "(x, y)"; either component can itself be a variable.
  const offset = String(fields.offset ?? '').trim().replace(/^\(|\)$/g, '');
  const [rawX, rawY] = offset.split(',');
  const offsetX = asNumber(resolveRef(rawX ?? '0', variables).value) ?? 0;
  const offsetY = asNumber(resolveRef(rawY ?? '0', variables).value) ?? 0;
  const blur = asNumber(resolveRef(fields.radius ?? '0', variables).value) ?? 0;
  const spread = asNumber(resolveRef(fields.spread ?? '0', variables).value) ?? 0;

  return {
    color: hex,
    ...(color.ref ? { colorRef: color.ref } : {}),
    offsetX,
    offsetY,
    blur,
    spread,
    inset: type === 'INNER_SHADOW',
  };
}

/** Splits "Effect(…); Effect(…)" into layers without breaking on the comma inside `offset: (0, 4)`. */
function splitEffects(value) {
  return value.split(/;\s*(?=Effect\()/);
}

function asNumber(value) {
  if (value == null || value === '') return null;
  const cleaned = String(value).replace(/px$/i, '').trim();
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function isColorValue(value) {
  return /^#[0-9a-f]{3,8}$/i.test(value) || /^rgba?\(/i.test(value);
}

async function readDump(file) {
  const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
  // Accept either the bare map, or a wrapper like { "variables": {...} } / MCP
  // tool-result envelopes people sometimes save straight out of the transcript.
  const candidate =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed.variables ?? parsed.result ?? parsed)
      : null;
  if (!candidate || typeof candidate !== 'object') {
    throw new Error(`${file} is not a variable map (expected an object of name -> value)`);
  }
  const flat = {};
  for (const [key, value] of Object.entries(candidate)) {
    if (typeof value === 'string' || typeof value === 'number') flat[key] = String(value);
  }
  if (Object.keys(flat).length === 0) {
    throw new Error(`${file} contained no name -> value string pairs`);
  }
  return flat;
}

/**
 * Folds a freshly extracted mode into the token file that already exists,
 * writing each token's value under `$modes[mode]`.
 *
 * Divergence between modes is reported, never smoothed over: a token present
 * in one mode and missing from another is a real difference in the Figma file
 * — usually a variable that only one collection defines — and the person
 * reading the diff should see it.
 */
async function mergeModeInto(outPath, incoming, mode, warnings, config) {
  let base;
  try {
    base = await loadTokens(outPath);
  } catch {
    throw new Error(
      `--merge needs an existing ${path.basename(outPath)} to merge into. ` +
        'Run the default mode first, without --merge.',
    );
  }

  const defaultMode = base.$meta?.defaultMode ?? null;
  if (!defaultMode) {
    warnings.push(
      `${path.basename(outPath)} has no $meta.defaultMode — it was written before modes existed. ` +
        `Treating its values as mode "${mode === 'default' ? 'base' : 'default'}".`,
    );
    base.$meta.defaultMode = 'default';
  }
  if (mode === base.$meta.defaultMode) {
    throw new Error(`"${mode}" is already the default mode of this token file; merging it into itself would do nothing.`);
  }

  let merged = 0;
  let added = 0;
  for (const group of EXPORTED_GROUPS) {
    for (const [name, token] of Object.entries(incoming[group])) {
      const existing = base[group][name];
      if (existing) {
        existing.$modes = { ...(existing.$modes ?? {}), [mode]: token.$value };
        merged++;
      } else {
        // Only this mode defines it. Keep it, with the same value in both
        // slots, so no generator ends up with an undefined default.
        base[group][name] = { ...token, $modes: { [mode]: token.$value } };
        added++;
        warnings.push(`"${name}" exists in mode "${mode}" but not in "${base.$meta.defaultMode}".`);
      }
    }
    for (const [name, token] of Object.entries(base[group])) {
      if (!incoming[group][name] && token.$modes?.[mode] === undefined) {
        warnings.push(`"${name}" is missing from mode "${mode}" — it will fall back to the default value.`);
      }
    }
  }

  base.$meta = {
    ...base.$meta,
    extractedAt: new Date().toISOString(),
    warnings: [...(base.$meta.warnings ?? []), ...warnings],
    modeInputs: { ...(base.$meta.modeInputs ?? {}), [mode]: incoming.$meta.inputs },
  };
  console.log(`[normalize-mcp] merged mode "${mode}": ${merged} token(s) updated, ${added} new to this mode`);
  void config;
  return base;
}

async function main() {
  const args = parseArgs();
  const inputs = args._;
  if (inputs.length === 0) {
    console.error('Usage: node normalize-mcp.mjs <dump.json...> [--config path] [--out path]');
    process.exit(2);
  }

  const config = await loadConfig(typeof args.config === 'string' ? args.config : undefined);
  const outPath = typeof args.out === 'string' ? path.resolve(args.out) : config.tokensPath;

  // ---- merge every dump, recording disagreements instead of overwriting ----
  const variables = {};
  const provenance = {};
  const warnings = [];
  for (const file of inputs) {
    const dump = await readDump(file);
    for (const [name, value] of Object.entries(dump)) {
      if (Object.hasOwn(variables, name) && variables[name] !== value) {
        warnings.push(
          `Conflicting value for "${name}": "${variables[name]}" (${provenance[name]}) vs "${value}" (${path.basename(file)}). Kept the first.`,
        );
        continue;
      }
      variables[name] = value;
      provenance[name] = path.basename(file);
    }
    console.log(`[normalize-mcp] ${path.basename(file)}: ${Object.keys(dump).length} variables`);
  }

  // ---- pass 1: composite type variables, collecting the parts they consume ----
  const referenced = new Set();
  const typography = {};
  for (const [name, value] of Object.entries(variables)) {
    const composite = value.match(FONT_COMPOSITE);
    if (!composite) continue;
    const fields = parseCompositeFields(composite[1]);
    const family = resolveField(fields.family ?? '', variables, referenced);
    const styleName = fields.style ? resolveField(fields.style, variables, referenced) : null;
    const size = asNumber(fields.size ? resolveField(fields.size, variables, referenced) : null);
    const weight = asNumber(fields.weight ? resolveField(fields.weight, variables, referenced) : null);
    const lineHeight = asNumber(fields.lineHeight ? resolveField(fields.lineHeight, variables, referenced) : null);
    const letterSpacing = asNumber(fields.letterSpacing ? resolveField(fields.letterSpacing, variables, referenced) : null);

    if (!family || size == null) {
      warnings.push(`Typography "${name}" is missing family or size — check the source variable.`);
    }
    typography[name.toLowerCase()] = {
      $type: 'typography',
      $value: {
        fontFamily: family || null,
        fontWeight: weight ?? 400,
        fontStyleName: styleName,
        fontSize: size,
        lineHeight,
        letterSpacing: letterSpacing ?? 0,
      },
    };
    referenced.add(name);
  }

  // ---- pass 1b: effect (shadow) composites ----
  // Refused rather than half-parsed: a token whose stack contains anything that
  // is not a drop/inner shadow (a layer blur, a background blur) has no
  // box-shadow equivalent, and emitting only the shadow layers would silently
  // change how it looks. Those land in `other`, where verify prints them.
  const shadows = {};
  const badEffects = new Set();
  for (const [name, value] of Object.entries(variables)) {
    if (!EFFECT_COMPOSITE.test(value)) continue;
    const layers = splitEffects(value).map((raw) => parseEffectLayer(raw, variables));
    if (layers.length === 0 || layers.some((layer) => layer === null)) {
      badEffects.add(name);
      warnings.push(`Effect "${name}" has a layer this pipeline cannot express as a shadow — kept in "other".`);
      continue;
    }
    shadows[name] = { $type: 'shadow', $value: layers };
  }

  // ---- pass 2: everything else ----
  const set = emptyTokenSet({
    source: 'figma-mcp:get_variable_defs',
    fileKey: config.figma?.fileKey ?? null,
    inputs: inputs.map((f) => path.basename(f)),
    extractedAt: new Date().toISOString(),
    warnings,
  });
  set.typography = typography;
  set.shadow = shadows;

  for (const [name, value] of Object.entries(variables)) {
    if (Object.hasOwn(shadows, name)) continue;
    if (badEffects.has(name)) {
      set.other[name] = { $type: 'unknown', $value: value, $note: 'effect with a non-shadow layer' };
      continue;
    }
    if (referenced.has(name)) {
      if (!Object.hasOwn(typography, name.toLowerCase())) {
        set.other[name] = { $type: 'unknown', $value: value, $note: 'consumed by a typography composite' };
      }
      continue;
    }
    if (isColorValue(value)) {
      const hex = normalizeHex(value);
      if (hex) {
        set.color[name] = { $type: 'color', $value: hex };
      } else {
        set.other[name] = { $type: 'unknown', $value: value, $note: 'unparseable colour' };
      }
      continue;
    }
    const numeric = asNumber(value);
    if (numeric != null) {
      set.dimension[name] = { $type: 'dimension', $value: numeric };
      continue;
    }
    set.other[name] = { $type: 'unknown', $value: value, $note: 'unclassified string variable' };
  }

  const mode = typeof args.mode === 'string' ? args.mode : null;
  let output = set;

  if (args.merge) {
    if (!mode) throw new Error('--merge needs --mode <name>: it merges this dump in as that mode.');
    output = await mergeModeInto(outPath, set, mode, warnings, config);
  } else if (mode) {
    // First mode written becomes the default — the one every generator uses
    // unless asked for another.
    output.$meta.defaultMode = mode;
  }

  // Stamp `$layer` into tokens.json so the layering is visible in review, not
  // only applied invisibly at generation time.
  stampLayers(output, config.layers);
  await writeTokens(outPath, output);

  const counts = countTokens(output);
  if (modesOf(output).length > 1) {
    console.log(
      `[normalize-mcp] modes — ${[...summarizeModes(output)]
        .map(([name, info]) => `${name} (${info.role}, ${info.tokens} tokens)`)
        .join(', ')}`,
    );
  }
  if (config.layers) {
    console.log(`[normalize-mcp] layers — ${[...summarizeLayers(output)].map(([l, n]) => `${l}: ${n}`).join(', ')}`);
  }
  console.log(
    `[normalize-mcp] wrote ${path.relative(config.rootDir, outPath)} — ` +
      `${counts.color} color, ${counts.dimension} dimension, ${counts.typography} typography, ` +
      `${counts.shadow} shadow, ${counts.other} other`,
  );
  if (counts.other) {
    console.log('[normalize-mcp] "other" holds variables that were not classified — review them, they are not exported.');
  }
  for (const warning of warnings) console.warn(`[normalize-mcp] WARN ${warning}`);
}

main().catch((err) => {
  console.error(`[normalize-mcp] FAILED: ${err.message}`);
  process.exit(1);
});
