// Name transforms shared by every target generator.
//
// Token names are slash-paths as they appear in Figma ("text/primary/default",
// "body/lg/bold", "spacing/8"). Each target needs a different spelling of the
// same path, and every one of them must stay collision-free — two Figma tokens
// that flatten to one identifier would silently overwrite each other.

/** Splits a token path into clean segments: "body/lg/bold" -> ["body","lg","bold"]. */
export function segments(name) {
  return name
    .split(/[/\s]+/)
    .flatMap((s) => s.split('-').filter(Boolean))
    .filter(Boolean)
    .map((s) => s.replace(/%/g, 'pct').replace(/\./g, '_'));
}

/**
 * camelCase identifier for Dart/TS fields.
 * A segment starting with a digit is prefixed with "_" — "spacing/8" -> "spacing_8"
 * (bare "8" is not a legal identifier in either language).
 */
export function toCamel(name, { dropSegments = 0 } = {}) {
  const parts = segments(name).slice(dropSegments);
  let out = '';
  for (const part of parts) {
    if (/^\d/.test(part)) {
      out += out === '' ? `n${part}` : `_${part}`;
    } else if (out === '') {
      out += part.toLowerCase();
    } else {
      out += part[0].toUpperCase() + part.slice(1).toLowerCase();
    }
  }
  return out;
}

/** kebab-case for CSS custom properties: "text/primary/default" -> "text-primary-default". */
export function toKebab(name, { dropSegments = 0 } = {}) {
  return segments(name).slice(dropSegments).join('-').toLowerCase();
}

/** PascalCase for class names: "border-width" -> "BorderWidth". */
export function toPascal(name) {
  return segments(name)
    .map((p) => p[0].toUpperCase() + p.slice(1).toLowerCase())
    .join('');
}

/** First path segment — used to split a flat token map into namespaces. */
export function namespaceOf(name) {
  return name.split('/')[0];
}

/**
 * Keeps a namespace-derived symbol out of the way of a fixed one.
 *
 * A design system with a `typography/font-size/*` dimension scale AND text
 * styles wants two symbols called "typography" — the scale and the styles.
 * Nothing in Figma is wrong there, so failing the export would be punishing the
 * design file for a codegen detail. The fixed name (the text styles, the
 * colours) keeps the plain spelling and the namespace scale takes the suffix.
 *
 * A collision the suffix does not resolve still throws in
 * `assertUniqueIdentifiers` — this narrows the failure, it does not hide it.
 */
export function avoidReserved(name, reserved, suffix = 'Scale') {
  return reserved.has(name) ? `${name}${suffix}` : name;
}

/**
 * Throws on any identifier produced by two different token names.
 * Call this before writing a file, never after — a collision that reaches disk
 * looks like a missing token, which is a much harder bug to trace back here.
 * @param {Array<[string, string]>} pairs - [tokenName, identifier]
 */
export function assertUniqueIdentifiers(pairs, label) {
  const seen = new Map();
  const clashes = [];
  for (const [tokenName, identifier] of pairs) {
    if (seen.has(identifier)) {
      clashes.push(`  "${seen.get(identifier)}" and "${tokenName}" both map to "${identifier}"`);
    }
    seen.set(identifier, tokenName);
  }
  if (clashes.length) {
    throw new Error(`Identifier collision in ${label}:\n${clashes.join('\n')}`);
  }
}
