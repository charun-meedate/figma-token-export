// Target: W3C Design Tokens Community Group JSON.
//
// This is the interchange format — Style Dictionary, Tokens Studio, and
// Figma's own native "import variables from JSON" all read it. Emit it when
// another tool, another repo, or Figma itself is the consumer.
//
// Note the internal tokens.json is DTCG-*flavoured* but flat and lossy-free;
// this file is the strict, nested, spec-shaped projection of it.
import { normalizeHex } from '../dtcg.mjs';

function setDeep(root, pathSegments, value) {
  let node = root;
  for (const segment of pathSegments.slice(0, -1)) {
    if (typeof node[segment] !== 'object' || node[segment] === null || '$value' in node[segment]) {
      // A group name that collides with a token name would silently swallow
      // one of them; surface it instead.
      if (node[segment] !== undefined) {
        throw new Error(
          `Token path conflict at "${pathSegments.join('/')}": "${segment}" is used as both a token and a group.`,
        );
      }
      node[segment] = {};
    }
    node = node[segment];
  }
  node[pathSegments.at(-1)] = value;
}

function extensions(token) {
  // The DTCG spec has no mode concept, so modes go in $extensions rather than
  // being invented into $value — a consumer that ignores extensions still
  // reads a valid single-mode token file.
  const figma = token.$figma ? { 'com.figma': token.$figma } : {};
  const modes = token.$modes ? { 'com.figma.modes': token.$modes } : {};
  const all = { ...figma, ...modes };
  return Object.keys(all).length ? { $extensions: all } : {};
}

export function generateDtcg(set, target) {
  const root = {
    $description: `Design tokens exported from Figma (${set.$meta?.fileKey ?? 'unknown file'}).`,
  };

  for (const [name, token] of Object.entries(set.color)) {
    // DTCG spells an alias as `{group.token}` — the interchange format keeps
    // the reference, so a tool downstream (or a re-import into Figma) sees the
    // same structure the design file has.
    const aliasOf = target.aliasMap?.get(name);
    setDeep(root, name.split('/'), {
      $type: 'color',
      $value: aliasOf ? `{${aliasOf.split('/').join('.')}}` : normalizeHex(token.$value),
      ...extensions(token),
      ...(aliasOf ? { $description: `Resolves to ${normalizeHex(token.$value)}` } : {}),
    });
  }

  for (const [name, token] of Object.entries(set.dimension)) {
    setDeep(root, name.split('/'), {
      $type: 'dimension',
      $value: { value: token.$value, unit: target.dimensionUnit === 'rem' ? 'rem' : 'px' },
      ...extensions(token),
    });
  }

  for (const [name, token] of Object.entries(set.shadow ?? {})) {
    const unit = target.dimensionUnit === 'rem' ? 'rem' : 'px';
    setDeep(root, name.split('/'), {
      // The spec allows an array for a stacked shadow, which is exactly what
      // Figma's multi-effect tokens are.
      $type: 'shadow',
      $value: token.$value.map((layer) => ({
        // A layer whose colour came from a variable keeps the reference, so a
        // consumer re-importing this into Figma gets the link back.
        color: layer.colorRef && set.color?.[layer.colorRef]
          ? `{${layer.colorRef.split('/').join('.')}}`
          : normalizeHex(layer.color),
        offsetX: { value: layer.offsetX, unit },
        offsetY: { value: layer.offsetY, unit },
        blur: { value: layer.blur, unit },
        spread: { value: layer.spread, unit },
        inset: layer.inset === true,
      })),
      ...extensions(token),
    });
  }

  for (const [name, token] of Object.entries(set.typography)) {
    const v = token.$value;
    setDeep(root, name.split('/'), {
      $type: 'typography',
      $value: {
        fontFamily: v.fontFamily,
        fontSize: { value: v.fontSize, unit: 'px' },
        fontWeight: v.fontWeight ?? 400,
        // The spec's lineHeight is a unitless multiplier; the px value Figma
        // reports is kept in $extensions so nothing is lost on a round trip.
        lineHeight: v.lineHeight != null && v.fontSize ? Number((v.lineHeight / v.fontSize).toFixed(4)) : 1,
        letterSpacing: { value: v.letterSpacing ?? 0, unit: 'px' },
      },
      $extensions: {
        'com.figma': { ...(token.$figma ?? {}), lineHeightPx: v.lineHeight ?? null, fontStyleName: v.fontStyleName ?? null },
      },
    });
  }

  return [{ file: target.fileName ?? 'tokens.dtcg.json', contents: `${JSON.stringify(root, null, 2)}\n` }];
}
