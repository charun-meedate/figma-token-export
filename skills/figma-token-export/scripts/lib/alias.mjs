// Rebuilding the alias structure that extraction flattens away.
//
// In Figma a semantic token POINTS at a primitive: `color/surface/primary`
// → `palette/brand/500`. `get_variable_defs` resolves that pointer and returns
// only the final value, so tokens.json holds two tokens with the same hex and
// no memory of the link between them. Generated code inherits the loss: every
// semantic var is a literal, and overriding a primitive changes nothing.
//
// This module reconstructs the link by matching values, which is an INFERENCE,
// not data read from Figma. It is therefore built to refuse rather than guess:
//
//   - a value matching TWO OR MORE primitives links to neither, because there
//     is no way to tell which one the designer pointed at
//   - a value matching NO primitive stays a literal
//   - both cases are reported, and `strict` turns them into a failed run
//
// A literal is always correct; only the theming structure is lost. So the
// fallback is safe, and the reporting is what stops "safe" from becoming
// "silently half-linked".

/**
 * @param {object} set - token set (already filtered to what the target emits)
 * @param {{source: string, strict?: boolean}} options - `source` is the layer name holding primitives
 * @returns {{aliases: Map<string,string>, ambiguous: Array, unmatched: Array, sourceCount: number}}
 */
export function buildAliasMap(set, { source, strict = false } = {}) {
  const aliases = new Map();
  const ambiguous = [];
  const unmatched = [];

  // Only colours alias in practice. Dimensions collide by value constantly
  // (spacing/8 and radius/8 are both 8 and mean different things), so
  // value-matching them would invent links that do not exist.
  const tokens = Object.entries(set.color ?? {});
  const byValue = new Map();
  let sourceCount = 0;

  for (const [name, token] of tokens) {
    if (token.$layer !== source) continue;
    sourceCount++;
    const key = String(token.$value).toUpperCase();
    if (!byValue.has(key)) byValue.set(key, []);
    byValue.get(key).push(name);
  }

  if (sourceCount === 0) {
    throw new Error(
      `aliasLinking: no token carries layer "${source}". Either the layer name is wrong, ` +
        'or this target filtered the primitives out — a target cannot reference tokens it does not emit.',
    );
  }

  for (const [name, token] of tokens) {
    if (token.$layer === source) continue;
    const hits = byValue.get(String(token.$value).toUpperCase());
    if (!hits) {
      unmatched.push({ name, value: token.$value });
    } else if (hits.length > 1) {
      ambiguous.push({ name, value: token.$value, candidates: hits });
    } else {
      aliases.set(name, hits[0]);
    }
  }

  if (strict && (ambiguous.length || unmatched.length)) {
    const lines = [
      ...ambiguous.map((a) => `  ambiguous: ${a.name} (${a.value}) matches ${a.candidates.join(' | ')}`),
      ...unmatched.map((u) => `  no match:  ${u.name} (${u.value})`),
    ];
    throw new Error(
      `aliasLinking is strict and ${ambiguous.length + unmatched.length} token(s) could not be linked:\n${lines.join('\n')}`,
    );
  }

  return { aliases, ambiguous, unmatched, sourceCount };
}

/** One-line summary for the run log. */
export function describeAliasResult({ aliases, ambiguous, unmatched, sourceCount }) {
  return (
    `${aliases.size} linked, ${ambiguous.length} ambiguous, ${unmatched.length} unmatched ` +
    `(against ${sourceCount} primitives)`
  );
}
