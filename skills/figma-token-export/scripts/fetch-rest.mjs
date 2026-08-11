#!/usr/bin/env node
// Extraction path B (fallback): Figma REST API -> tokens.json
//
// Use this when the MCP path is unavailable — CI, no Figma desktop/Dev Mode
// session, or a machine without the MCP server configured. It needs only a
// personal access token with `file_content:read`.
//
// It does NOT call /v1/files/:key/variables: that endpoint requires the
// Enterprise-only `file_variables:read` scope and 403s on Organization plans.
// Instead it reads what a plain read token can see:
//
//   mode "styles" (default, works on any file whose tokens are PUBLISHED styles)
//     GET /v1/files/:key/styles          -> style key -> name -> node_id
//     GET /v1/files/:key/nodes?ids=...   -> resolved fills (FILL) and .style (TEXT)
//
//   mode "scrape" (opt-in, for files that document tokens as canvas artefacts)
//     "card"     — an INSTANCE named like a token, containing a TEXT node whose
//                  characters are the resolved hex (e.g. "{hex-value}")
//     "px-rows"  — a table row FRAME with a direct "<N>px" TEXT child
//     Scraping depends on canvas conventions and breaks when a designer
//     restructures the page. Prefer "styles", and prefer MCP over both.
//
// Usage:
//   FIGMA_ACCESS_TOKEN=... node fetch-rest.mjs [--config path] [--out path] [--keep-raw]
import path from 'node:path';
import { loadConfig, parseArgs } from './lib/config.mjs';
import { figmaGet, fetchNodes, saveRaw } from './lib/figma-client.mjs';
import { emptyTokenSet, normalizeHex, applyOpacity, writeTokens, countTokens } from './lib/dtcg.mjs';
import { stampLayers, summarizeLayers } from './lib/filter.mjs';

function findDescendant(node, predicate) {
  if (predicate(node)) return node;
  for (const child of node.children ?? []) {
    const found = findDescendant(child, predicate);
    if (found) return found;
  }
  return null;
}

function rgbaToHex8({ r, g, b, a }) {
  const byte = (v) => Math.round(Math.max(0, Math.min(1, v)) * 255);
  const hex = [byte(r), byte(g), byte(b), byte(a ?? 1)].map((n) => n.toString(16).padStart(2, '0'));
  return `#${hex.join('')}`.toUpperCase();
}

// ---------- mode: published styles ----------

async function extractFromStyles(fileKey, rawDir, keepRaw, set, warnings) {
  const stylesResponse = await figmaGet('/files/:key/styles', fileKey);
  if (keepRaw) await saveRaw(rawDir, 'styles', stylesResponse);

  const styles = stylesResponse.meta?.styles ?? [];
  const fillStyles = styles.filter((s) => s.style_type === 'FILL');
  const textStyles = styles.filter((s) => s.style_type === 'TEXT');
  console.log(`[fetch-rest] published styles: ${fillStyles.length} FILL, ${textStyles.length} TEXT`);

  const nodeIds = [...fillStyles, ...textStyles].map((s) => s.node_id);
  if (nodeIds.length === 0) {
    warnings.push('No published FILL or TEXT styles found — this file probably keeps tokens as Variables only, so use the MCP path or configure "scrape".');
    return;
  }

  const nodes = await fetchNodes(fileKey, nodeIds);
  if (keepRaw) await saveRaw(rawDir, 'style-nodes', nodes);

  for (const style of fillStyles) {
    const doc = nodes[style.node_id]?.document;
    const fill = doc?.fills?.find((f) => f.type === 'SOLID' && f.visible !== false);
    if (!fill) {
      warnings.push(`FILL style "${style.name}" has no solid fill (gradient or image?) — skipped.`);
      continue;
    }
    const name = style.name.toLowerCase();
    set.color[name] = {
      $type: 'color',
      $value: applyOpacity(rgbaToHex8(fill.color), fill.opacity),
      $figma: { nodeId: style.node_id, styleKey: style.key },
    };
  }

  for (const style of textStyles) {
    const typeStyle = nodes[style.node_id]?.document?.style;
    if (!typeStyle) {
      warnings.push(`TEXT style "${style.name}" had no resolved style block — skipped.`);
      continue;
    }
    set.typography[style.name.toLowerCase()] = {
      $type: 'typography',
      $value: {
        fontFamily: typeStyle.fontFamily,
        fontWeight: typeStyle.fontWeight,
        fontStyleName: typeStyle.fontPostScriptName ?? null,
        fontSize: typeStyle.fontSize,
        lineHeight: typeStyle.lineHeightPx ?? null,
        letterSpacing: typeStyle.letterSpacing ?? 0,
      },
      $figma: { nodeId: style.node_id, styleKey: style.key },
    };
  }
}

// ---------- mode: canvas scraping ----------

function collectCards(node, hexTextName, out) {
  if (node.type === 'INSTANCE' && node.name.includes('/')) {
    const hexNode = findDescendant(node, (n) => n.type === 'TEXT' && n.name === hexTextName);
    if (hexNode?.characters) {
      out.push({ name: node.name, nodeId: node.id, hex: hexNode.characters.trim() });
    }
    return; // token cards do not nest token cards
  }
  for (const child of node.children ?? []) collectCards(child, hexTextName, out);
}

function collectPxRows(node, out) {
  if (node.type === 'FRAME') {
    const label = (node.children ?? []).find(
      (c) => c.type === 'TEXT' && /^\d+(\.\d+)?px$/.test((c.characters ?? '').trim()),
    );
    if (label) {
      out.push({ nodeId: node.id, value: Number(label.characters.trim().replace('px', '')) });
      return; // do not descend into a matched row
    }
  }
  for (const child of node.children ?? []) collectPxRows(child, out);
}

async function extractByScraping(fileKey, rules, rawDir, keepRaw, set, warnings) {
  for (const [i, rule] of rules.entries()) {
    const nodeIds = rule.nodes ?? [];
    if (nodeIds.length === 0) {
      warnings.push(`scrape rule #${i} has no "nodes" — skipped.`);
      continue;
    }
    const nodes = await fetchNodes(fileKey, nodeIds);
    if (keepRaw) await saveRaw(rawDir, `scrape-${rule.pattern}-${i}`, nodes);

    let added = 0;
    for (const nodeId of nodeIds) {
      const doc = nodes[nodeId]?.document;
      if (!doc) {
        warnings.push(`scrape rule #${i}: node ${nodeId} not found in the file.`);
        continue;
      }

      if (rule.pattern === 'card') {
        const cards = [];
        collectCards(doc, rule.hexTextName ?? '{hex-value}', cards);
        for (const card of cards) {
          const hex = normalizeHex(card.hex);
          if (!hex) {
            warnings.push(`scrape rule #${i}: card "${card.name}" has unparseable hex "${card.hex}".`);
            continue;
          }
          const name = card.name.toLowerCase();
          if (set.color[name] && set.color[name].$value !== hex) {
            warnings.push(`Conflicting colour for "${name}": ${set.color[name].$value} vs ${hex} (node ${card.nodeId}). Kept the first.`);
            continue;
          }
          set.color[name] = { $type: 'color', $value: hex, $figma: { nodeId: card.nodeId } };
          added++;
        }
      } else if (rule.pattern === 'px-rows') {
        const namespace = rule.namespace;
        if (!namespace) {
          warnings.push(`scrape rule #${i} ("px-rows") needs a "namespace" — skipped.`);
          continue;
        }
        const rows = [];
        collectPxRows(doc, rows);
        for (const row of rows) {
          const name = `${namespace}/${row.value}`;
          if (set.dimension[name]) continue; // pages often repeat the scale in a second column
          set.dimension[name] = { $type: 'dimension', $value: row.value, $figma: { nodeId: row.nodeId } };
          added++;
        }
      } else {
        warnings.push(`scrape rule #${i}: unknown pattern "${rule.pattern}" (expected "card" or "px-rows").`);
      }
    }
    console.log(`[fetch-rest] scrape rule #${i} (${rule.pattern}): ${added} tokens`);
  }
}

// ---------- main ----------

async function main() {
  const args = parseArgs();
  const config = await loadConfig(typeof args.config === 'string' ? args.config : undefined);
  const fileKey = config.figma?.fileKey;
  if (!fileKey) throw new Error('`figma.fileKey` is missing from tokens.config.json.');

  const rest = config.figma.rest ?? {};
  const keepRaw = Boolean(args['keep-raw'] ?? rest.keepRaw);
  const outPath = typeof args.out === 'string' ? path.resolve(args.out) : config.tokensPath;

  const warnings = [];
  const set = emptyTokenSet({
    source: 'figma-rest',
    fileKey,
    extractedAt: new Date().toISOString(),
    warnings,
  });

  if (rest.styles !== false) {
    await extractFromStyles(fileKey, config.rawDir, keepRaw, set, warnings);
  }
  if (Array.isArray(rest.scrape) && rest.scrape.length) {
    await extractByScraping(fileKey, rest.scrape, config.rawDir, keepRaw, set, warnings);
  }

  const counts = countTokens(set);
  if (counts.color + counts.dimension + counts.typography === 0) {
    throw new Error(
      'Extracted 0 tokens. This file most likely stores tokens as Variables, which REST cannot read on ' +
        'a non-Enterprise plan. Use the MCP path (references/extraction-mcp.md).',
    );
  }

  stampLayers(set, config.layers);
  await writeTokens(outPath, set);
  console.log(
    `[fetch-rest] wrote ${path.relative(config.rootDir, outPath)} — ` +
      `${counts.color} color, ${counts.dimension} dimension, ${counts.typography} typography`,
  );
  if (config.layers) {
    console.log(`[fetch-rest] layers — ${[...summarizeLayers(set)].map(([l, n]) => `${l}: ${n}`).join(', ')}`);
  }
  for (const warning of warnings) console.warn(`[fetch-rest] WARN ${warning}`);
}

main().catch((err) => {
  console.error(`[fetch-rest] FAILED: ${err.message}`);
  process.exit(1);
});
