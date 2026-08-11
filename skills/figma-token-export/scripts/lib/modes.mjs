// Modes — light/dark, brand A/brand B, compact/comfortable.
//
// Figma models a mode as a column in a variable collection. `get_variable_defs`
// resolves to whichever mode is active in the file and returns ONE column, so
// a multi-mode file needs one dump per mode. That is a property of the tool,
// not a choice this pipeline makes, and it drives the whole shape below:
//
//   tokens.json holds the default mode in `$value`, exactly as a single-mode
//   file always did, and every other mode in `$modes`:
//
//     "color/surface/base": {
//       "$type": "color",
//       "$value": "#FFFFFFFF",              // the default mode
//       "$modes": { "dark": "#000000FF" }   // every other mode
//     }
//
// Old single-mode token files keep working untouched — no `$modes` key means
// one mode, and every generator reads `$value` as before.
import { EXPORTED_GROUPS, emptyLike } from './dtcg.mjs';

/** Every mode name in the set: the default first, then the extras in first-seen order. */
export function modesOf(set) {
  const defaultMode = set.$meta?.defaultMode ?? null;
  const extras = [];
  for (const group of EXPORTED_GROUPS) {
    for (const token of Object.values(set[group] ?? {})) {
      for (const mode of Object.keys(token.$modes ?? {})) {
        if (mode !== defaultMode && !extras.includes(mode)) extras.push(mode);
      }
    }
  }
  return defaultMode ? [defaultMode, ...extras] : extras;
}

/** The value a token takes in `mode`, falling back to the default when it does not vary. */
export function valueForMode(token, mode, defaultMode) {
  if (!mode || mode === defaultMode) return token.$value;
  return token.$modes?.[mode] ?? token.$value;
}

/** True when the token actually differs in `mode` — the override set for a theme block. */
export function variesInMode(token, mode, defaultMode) {
  if (!mode || mode === defaultMode) return false;
  const value = token.$modes?.[mode];
  if (value === undefined) return false;
  return JSON.stringify(value) !== JSON.stringify(token.$value);
}

/**
 * A view of the set as it looks in one mode: every `$value` replaced by that
 * mode's value. Generators that only understand one mode (and the alias
 * resolver) take this and need no mode awareness at all.
 */
export function projectMode(set, mode, defaultMode) {
  if (!mode || mode === defaultMode) return set;
  const out = emptyLike(set);
  for (const group of EXPORTED_GROUPS) {
    for (const [name, token] of Object.entries(set[group] ?? {})) {
      out[group][name] = { ...token, $value: valueForMode(token, mode, defaultMode) };
    }
  }
  return out;
}

/** Only the tokens that differ in `mode` — what a theme override block contains. */
export function overridesForMode(set, mode, defaultMode) {
  const out = emptyLike(set);
  let count = 0;
  for (const group of EXPORTED_GROUPS) {
    for (const [name, token] of Object.entries(set[group] ?? {})) {
      if (variesInMode(token, mode, defaultMode)) {
        out[group][name] = { ...token, $value: token.$modes[mode] };
        count++;
      }
    }
  }
  return { set: out, count };
}

/** Per-mode counts for the run log: how many tokens each mode actually changes. */
export function summarizeModes(set) {
  const defaultMode = set.$meta?.defaultMode ?? null;
  const summary = new Map();
  for (const mode of modesOf(set)) {
    if (mode === defaultMode) {
      let total = 0;
      for (const group of EXPORTED_GROUPS) total += Object.keys(set[group] ?? {}).length;
      summary.set(mode, { role: 'default', tokens: total });
    } else {
      summary.set(mode, { role: 'override', tokens: overridesForMode(set, mode, defaultMode).count });
    }
  }
  return summary;
}
