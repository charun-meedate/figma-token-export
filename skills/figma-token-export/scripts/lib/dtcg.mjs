// The canonical in-memory token model, plus the readers/writers around it.
//
// Both extraction paths (MCP and REST) produce this shape, and every target
// generator consumes only this shape. That is the whole point of the pipeline:
// swapping how tokens are read out of Figma must never touch codegen.
//
//   {
//     $meta:      { source, fileKey, extractedAt, warnings[] },
//     color:      { "text/primary/default": { $type:"color",      $value:"#030712FF" } },
//     dimension:  { "spacing/8":            { $type:"dimension",  $value: 8 } },
//     typography: { "body/lg/bold":         { $type:"typography", $value:{ fontFamily, fontWeight, fontSize, lineHeight, letterSpacing } } },
//     shadow:     { "shadow-md":            { $type:"shadow",     $value:[{ color, colorRef, offsetX, offsetY, blur, spread, inset }] } },
//     other:      { "<name>":               { $type:"unknown",    $value: <raw>, $note } }
//   }
//
// A shadow `$value` is an ARRAY because Figma stacks effects: one edge shadow
// plus one ambient shadow is one token with two layers, and flattening them to
// a single layer would change how it looks.
//
// `other` exists so nothing is ever dropped silently. A token the extractor
// could not classify shows up there and in the run summary instead of vanishing.
import fs from 'node:fs/promises';
import path from 'node:path';

export const TOKEN_GROUPS = ['color', 'dimension', 'typography', 'shadow', 'other'];

/**
 * The groups that become code. `other` is deliberately excluded — it holds what
 * the extractor could not classify. Every place that walks token groups uses
 * this list, so adding a group is one edit here rather than a hunt through
 * filter/modes/diff/verify for repeated `['color','dimension','typography']`.
 */
export const EXPORTED_GROUPS = ['color', 'dimension', 'typography', 'shadow'];

export function emptyTokenSet(meta = {}) {
  return {
    $meta: { warnings: [], ...meta },
    color: {},
    dimension: {},
    typography: {},
    shadow: {},
    other: {},
  };
}

/** A `{...set, color:{}, …}` skeleton: same $meta, empty exported groups, `other` carried over. */
export function emptyLike(set) {
  const out = { ...set, other: set.other };
  for (const group of EXPORTED_GROUPS) out[group] = {};
  return out;
}

/**
 * Normalizes any Figma colour spelling to #RRGGBBAA.
 * Alpha is explicit in the stored value so no target has to guess it.
 */
export function normalizeHex(input) {
  if (input == null) return null;
  let value = String(input).trim();

  const rgba = value.match(/^rgba?\(([^)]+)\)$/i);
  if (rgba) {
    const parts = rgba[1].split(/[,\s/]+/).filter(Boolean);
    const [r, g, b] = parts.slice(0, 3).map((n) => clampByte(Number(n)));
    const a = parts[3] === undefined ? 255 : clampByte(Number(parts[3]) * (String(parts[3]).includes('%') ? 2.55 : 255));
    return `#${[r, g, b, a].map(hex2).join('').toUpperCase()}`;
  }

  value = value.replace('#', '').toUpperCase();
  if (value.length === 3) value = value.split('').map((c) => c + c).join('');
  if (value.length === 4) value = value.split('').map((c) => c + c).join('');
  if (value.length === 6) return `#${value}FF`;
  if (value.length === 8) return `#${value}`;
  return null;
}

function clampByte(n) {
  return Math.max(0, Math.min(255, Math.round(Number.isFinite(n) ? n : 0)));
}

function hex2(n) {
  return n.toString(16).padStart(2, '0');
}

/** Figma stores opacity separately from the swatch; fold it into the stored alpha. */
export function applyOpacity(hex8, opacity) {
  if (opacity == null || opacity >= 1) return hex8;
  const rgb = hex8.slice(1, 7);
  return `#${rgb}${hex2(clampByte(opacity * 255))}`.toUpperCase();
}

/**
 * Loads tokens.json and tolerates the two shapes seen in the wild:
 * a flat `color` map, or `color` split into named sub-groups
 * (`color.global` / `color.alias` / `color.semantic`, as older hand-rolled
 * pipelines wrote it). Sub-groups are flattened — namespacing is recovered
 * from the token path at generation time.
 */
export async function loadTokens(tokensPath) {
  const raw = JSON.parse(await fs.readFile(tokensPath, 'utf8'));
  const set = emptyTokenSet(raw.$meta ?? {});

  for (const group of TOKEN_GROUPS) {
    const node = raw[group];
    if (!node) continue;
    for (const [key, value] of Object.entries(node)) {
      if (value && typeof value === 'object' && '$value' in value) {
        set[group][key] = value;
      } else if (value && typeof value === 'object') {
        // A sub-group: merge its children up one level.
        for (const [childKey, childValue] of Object.entries(value)) {
          if (childValue && typeof childValue === 'object' && '$value' in childValue) {
            set[group][childKey] = childValue;
          }
        }
      }
    }
  }
  return set;
}

export async function writeTokens(tokensPath, set) {
  await fs.mkdir(path.dirname(tokensPath), { recursive: true });
  await fs.writeFile(tokensPath, `${JSON.stringify(set, null, 2)}\n`);
}

/** Groups a flat token map by first path segment, preserving insertion order. */
export function groupByNamespace(tokens) {
  const groups = new Map();
  for (const [name, token] of Object.entries(tokens)) {
    const ns = name.split('/')[0];
    if (!groups.has(ns)) groups.set(ns, {});
    groups.get(ns)[name] = token;
  }
  return groups;
}

export function countTokens(set) {
  return Object.fromEntries(TOKEN_GROUPS.map((g) => [g, Object.keys(set[g] ?? {}).length]));
}
