// Layer selection — choosing WHICH tokens get exported.
//
// Design systems are layered: primitives (`color/blue/500`) that nobody should
// reference directly, semantic aliases (`text/primary/default`) that everyone
// should, and sometimes a component layer (`button/primary/bg`). Most apps want
// only the semantic layer in code; a design-system package wants all of them.
//
// Figma expresses that layering as **variable collections** ("1. Primitive",
// "2. Alias", "3. Semantic"). `get_variable_defs` does NOT return the
// collection a variable came from — it returns a flat name -> value map — so
// layers here are matched on the token NAME instead. In practice that is the
// same information: a file whose collections are layered names its tokens
// layered too. references/layers.md covers how to read the real collection
// names out of Figma to confirm the mapping before trusting it.
//
// Patterns are globs over slash-separated token paths:
//   "color/**"         every token under color/
//   "color/*"          exactly one segment below color/
//   "*/primary/**"     any first segment, then primary/
//   "text/primary"     exact match

import { EXPORTED_GROUPS, emptyLike } from './dtcg.mjs';

const REGEX_SPECIAL = /[.+^${}()|[\]\\?]/;

/** Compiles one glob to an anchored RegExp, scanning so `**` needs no placeholder. */
function compile(pattern) {
  let source = '';
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        source += '.*';
        i++;
      } else {
        source += '[^/]*';
      }
    } else if (REGEX_SPECIAL.test(char)) {
      source += `\\${char}`;
    } else {
      source += char;
    }
  }
  // Case-insensitive: Figma names are inconsistently cased ("Body/lg/bold"),
  // and a filter that silently misses on case is a filter nobody trusts.
  return new RegExp(`^${source}$`, 'i');
}

export function compilePatterns(patterns = []) {
  return patterns.map((p) => ({ pattern: p, re: compile(p) }));
}

export function matchesAny(name, compiled) {
  return compiled.some(({ re }) => re.test(name));
}

/**
 * Stamps `$layer` on every token from a `{ layerName: [patterns] }` map.
 * First matching layer wins, so order the config from most to least specific.
 * Unmatched tokens get `$layer: null` — visible, never guessed at.
 */
export function stampLayers(set, layerConfig) {
  if (!layerConfig || Object.keys(layerConfig).length === 0) return set;

  const layers = Object.entries(layerConfig).map(([name, patterns]) => ({
    name,
    compiled: compilePatterns(patterns),
  }));

  for (const group of EXPORTED_GROUPS) {
    for (const token of Object.values(set[group])) {
      token.$layer = null;
    }
    for (const [name, token] of Object.entries(set[group])) {
      const hit = layers.find((layer) => matchesAny(name, layer.compiled));
      if (hit) token.$layer = hit.name;
    }
  }
  return set;
}

/** Tokens per layer, plus the unassigned ones — the input to any "what exists?" report. */
export function summarizeLayers(set) {
  const summary = new Map();
  for (const group of EXPORTED_GROUPS) {
    for (const token of Object.values(set[group])) {
      const key = token.$layer ?? '(unassigned)';
      summary.set(key, (summary.get(key) ?? 0) + 1);
    }
  }
  return summary;
}

/** Distinct first path segments with counts — what to look at before writing patterns. */
export function summarizeNamespaces(set) {
  const summary = new Map();
  for (const group of EXPORTED_GROUPS) {
    for (const name of Object.keys(set[group])) {
      const ns = name.split('/')[0];
      const entry = summary.get(ns) ?? { count: 0, groups: new Set(), sample: name };
      entry.count++;
      entry.groups.add(group);
      summary.set(ns, entry);
    }
  }
  return summary;
}

/**
 * Returns a filtered copy. Selection order: layers → include → exclude.
 * An omitted selector means "everything", so the default stays export-all.
 *
 * Returns `{ set, stats }`; stats says what each rule dropped, because a filter
 * that silently matches nothing looks exactly like a design system with no
 * tokens in that layer.
 */
export function filterTokens(set, { layers, include, exclude } = {}) {
  const wantLayers = layers && layers.length ? new Set(layers) : null;
  const includeCompiled = include && include.length ? compilePatterns(include) : null;
  const excludeCompiled = exclude && exclude.length ? compilePatterns(exclude) : null;

  if (!wantLayers && !includeCompiled && !excludeCompiled) {
    return { set, stats: { filtered: false, kept: null, dropped: 0, unknownLayers: [] } };
  }

  const out = emptyLike(set);
  const seenLayers = new Set();
  let kept = 0;
  let dropped = 0;

  for (const group of EXPORTED_GROUPS) {
    for (const [name, token] of Object.entries(set[group])) {
      if (token.$layer) seenLayers.add(token.$layer);

      const layerOk = !wantLayers || wantLayers.has(token.$layer);
      const includeOk = !includeCompiled || matchesAny(name, includeCompiled);
      const excludeOk = !excludeCompiled || !matchesAny(name, excludeCompiled);

      if (layerOk && includeOk && excludeOk) {
        out[group][name] = token;
        kept++;
      } else {
        dropped++;
      }
    }
  }

  const unknownLayers = wantLayers ? [...wantLayers].filter((layer) => !seenLayers.has(layer)) : [];
  return { set: out, stats: { filtered: true, kept, dropped, unknownLayers } };
}
