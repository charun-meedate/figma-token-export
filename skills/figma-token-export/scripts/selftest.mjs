#!/usr/bin/env node
// End-to-end self test: fixture MCP dump -> tokens.json -> flutter + web + dtcg.
//
// Runs the real CLIs in a throwaway directory and asserts on the produced
// files, so a change to naming, colour normalization, or a generator that
// breaks the contract fails here rather than in someone's design system.
//
//   node selftest.mjs
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const SCRIPTS = path.dirname(fileURLToPath(import.meta.url));

const failures = [];
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ok  ${label}`);
  } else {
    failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

async function main() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'figma-token-export-'));
  console.log(`[selftest] workspace: ${dir}`);

  await fs.writeFile(
    path.join(dir, 'tokens.config.json'),
    JSON.stringify(
      {
        figma: { fileKey: 'SELFTESTFILEKEY0000000' },
        tokensPath: 'tokens/tokens.json',
        layers: {
          semantic: ['text/**', 'surface/**', 'border/**'],
          primitive: ['color/**', 'spacing/**', 'radius/**'],
        },
        targets: [
          { type: 'flutter', out: 'lib/tokens', prefix: 'Ds' },
          { type: 'web', out: 'web/tokens', dimensionUnit: 'px' },
          { type: 'dtcg', out: 'tokens' },
        ],
      },
      null,
      2,
    ),
  );

  const config = path.join(dir, 'tokens.config.json');
  const fixture = path.join(SCRIPTS, 'fixtures/mcp-variable-defs.json');

  console.log('[selftest] normalize-mcp');
  const normalized = await run('node', [path.join(SCRIPTS, 'normalize-mcp.mjs'), fixture, '--config', config]);
  process.stdout.write(indent(normalized.stdout));

  const tokens = JSON.parse(await fs.readFile(path.join(dir, 'tokens/tokens.json'), 'utf8'));
  check('colour is normalized to #RRGGBBAA', tokens.color['text/primary/default']?.$value === '#030712FF', tokens.color['text/primary/default']?.$value);
  check('short alpha hex is preserved', tokens.color['color/mono/black-10']?.$value === '#0000001A', tokens.color['color/mono/black-10']?.$value);
  check('numeric variable becomes a dimension', tokens.dimension['spacing/8']?.$value === 8);
  check('Font() composite is resolved', tokens.typography['body/lg/bold']?.$value.fontFamily === 'Google Sans');
  check('composite size is resolved through its reference', tokens.typography['body/lg/bold']?.$value.fontSize === 16);
  check('composite weight is numeric', tokens.typography['body/lg/bold']?.$value.fontWeight === 700);
  check('composite line-height is resolved', tokens.typography['body/lg/bold']?.$value.lineHeight === 22);
  check(
    'typography parts do NOT leak into dimension',
    tokens.dimension['body/lg/bold/size'] === undefined,
    JSON.stringify(Object.keys(tokens.dimension)),
  );
  check('consumed parts are recorded, not dropped', tokens.other['body/lg/bold/size'] !== undefined);
  check('unclassifiable value lands in other', tokens.other['elevation/shadow/soft'] !== undefined);

  const md = tokens.shadow?.['elevation/md']?.$value;
  check('Effect() composite becomes a shadow token', Array.isArray(md), JSON.stringify(tokens.shadow ?? {}).slice(0, 120));
  check('stacked effects stay separate layers', md?.length === 2, String(md?.length));
  check('shadow offset/radius/spread resolve through references', md?.[1]?.offsetY === 8 && md?.[1]?.blur === 24 && md?.[1]?.spread === -4, JSON.stringify(md?.[1]));
  check('shadow colour is normalized to #RRGGBBAA', md?.[0]?.color === '#0000001A', md?.[0]?.color);
  check('shadow keeps the colour token it referenced', md?.[0]?.colorRef === 'color/mono/black-10', md?.[0]?.colorRef);
  check('inner shadow is kept, flagged inset', tokens.shadow?.['elevation/inner']?.$value?.[0]?.inset === true);
  check('a non-shadow effect is refused, not half-parsed', tokens.shadow?.['elevation/blurred'] === undefined && tokens.other['elevation/blurred'] !== undefined);
  check(
    'shadow parts stay usable as dimensions',
    tokens.dimension['shadow/radius/md']?.$value === 24,
    JSON.stringify(Object.keys(tokens.dimension)),
  );

  check('layer is stamped into tokens.json', tokens.color['text/primary/default']?.$layer === 'semantic', tokens.color['text/primary/default']?.$layer);
  check('primitive layer is stamped', tokens.color['color/mono/black']?.$layer === 'primitive');
  check('typography with no matching pattern is unassigned', tokens.typography['body/lg/bold']?.$layer === null);

  console.log('[selftest] verify');
  const verified = await run('node', [path.join(SCRIPTS, 'verify.mjs'), '--config', config]);
  process.stdout.write(indent(verified.stdout));
  check('verify exits 0', true);

  console.log('[selftest] generate');
  const generated = await run('node', [path.join(SCRIPTS, 'generate.mjs'), '--config', config]);
  process.stdout.write(indent(generated.stdout));

  const dart = await fs.readFile(path.join(dir, 'lib/tokens/colors.g.dart'), 'utf8');
  check('Dart colour uses 0xAARRGGBB', dart.includes('Color(0xFF030712)'), firstMatch(dart, /Color\(0x[0-9A-F]+\)/));
  check('Dart identifier is camelCase from the full path', dart.includes('textPrimaryDefault'));
  check('Dart class uses the configured prefix', dart.includes('abstract final class DsColors'));

  const dims = await fs.readFile(path.join(dir, 'lib/tokens/dimensions.g.dart'), 'utf8');
  check('dimensions are split per namespace', dims.includes('class DsSpacing') && dims.includes('class DsRadius'));
  check('numeric leaf gets a legal identifier', dims.includes('static const double n8 = 8.0;'), firstMatch(dims, /static const double \w+ = [\d.]+;/));

  const type = await fs.readFile(path.join(dir, 'lib/tokens/typography.g.dart'), 'utf8');
  check('height is a ratio, not px', type.includes('height: 1.375'), firstMatch(type, /height: [\d.]+/));
  check('weight maps to a FontWeight const', type.includes('FontWeight.w700'));

  const css = await fs.readFile(path.join(dir, 'web/tokens/tokens.css'), 'utf8');
  check('CSS var is kebab-case', css.includes('--text-primary-default: #030712;'), firstMatch(css, /--text-primary-default:[^;]+;/));
  check('alpha colour uses rgb(... / a)', /--color-mono-black-10: rgb\(0 0 0 \/ 0\.1\d*\);/.test(css), firstMatch(css, /--color-mono-black-10:[^;]+;/));
  check('dimension carries a unit', css.includes('--spacing-8: 8px;'));

  check(
    'shadow becomes a stacked box-shadow, colour by var()',
    css.includes('--elevation-md: 0 0 1px 0 var(--color-mono-black-10), 0 8px 24px -4px var(--color-mono-black-10);'),
    firstMatch(css, /--elevation-md:[^;]+;/),
  );
  check('inset shadow keeps the inset keyword', /--elevation-inner: inset 0 2px 4px 0 /.test(css), firstMatch(css, /--elevation-inner:[^;]+;/));

  const ts = await fs.readFile(path.join(dir, 'web/tokens/tokens.ts'), 'utf8');
  check('TS exports literal and var maps', ts.includes('export const color') && ts.includes('export const colorVar'));
  check('TS omits the React constraint by default', !ts.includes('React.CSSProperties'));
  check(
    'TS shadow literal resolves colours (a var() would not work inline)',
    /elevationMd: "0 0 1px 0 rgb\(0 0 0 \/ 0\.1\d*\), 0 8px 24px -4px rgb/.test(ts),
    firstMatch(ts, /elevationMd: "[^"]+"/),
  );
  check('TS shadow var map points at the custom property', ts.includes('elevationMd: "var(--elevation-md)"'));

  const dartShadow = await fs.readFile(path.join(dir, 'lib/tokens/shadows.g.dart'), 'utf8');
  check('Dart shadow is a const List<BoxShadow>', dartShadow.includes('static const List<BoxShadow> elevationMd = ['));
  check('Dart shadow layer carries offset/blur/spread', dartShadow.includes('offset: Offset(0.0, 8.0), blurRadius: 24.0, spreadRadius: -4.0'), firstMatch(dartShadow, /BoxShadow\([^)]*\)/));
  check('Dart names the inner shadow it cannot express', dartShadow.includes('SKIPPED (inner shadow') && dartShadow.includes('elevation/inner'));
  check('Dart omits the inset token from the class', !dartShadow.includes('elevationInner ='));

  const dtcg = JSON.parse(await fs.readFile(path.join(dir, 'tokens/tokens.dtcg.json'), 'utf8'));
  check('DTCG nests by path segment', dtcg.text?.primary?.default?.$value === '#030712FF');
  check('DTCG dimension carries value+unit', dtcg.spacing?.['8']?.$value?.unit === 'px');
  check('DTCG lineHeight is a multiplier', dtcg.body?.lg?.bold?.$value?.lineHeight === 1.375);
  check('DTCG shadow is an array of layers', Array.isArray(dtcg.elevation?.md?.$value) && dtcg.elevation.md.$value.length === 2);
  check('DTCG shadow keeps the colour as a reference', dtcg.elevation?.md?.$value?.[0]?.color === '{color.mono.black-10}', dtcg.elevation?.md?.$value?.[0]?.color);
  check('DTCG shadow lengths carry value+unit', dtcg.elevation?.md?.$value?.[1]?.blur?.value === 24 && dtcg.elevation.md.$value[1].blur.unit === 'px');

  console.log('[selftest] generate --check on unchanged output');
  await run('node', [path.join(SCRIPTS, 'generate.mjs'), '--config', config, '--check']);
  check('--check passes when output is in sync', true);

  console.log('[selftest] generate --check after tampering');
  await fs.writeFile(path.join(dir, 'lib/tokens/colors.g.dart'), `${dart}\n// drift\n`);
  let checkFailed = false;
  try {
    await run('node', [path.join(SCRIPTS, 'generate.mjs'), '--config', config, '--check']);
  } catch {
    checkFailed = true;
  }
  check('--check fails when output drifted', checkFailed);

  console.log('[selftest] layer selection');
  const semanticOnly = await run('node', [
    path.join(SCRIPTS, 'generate.mjs'), '--config', config, '--target', 'web', '--layers', 'semantic',
  ]);
  process.stdout.write(indent(semanticOnly.stdout));
  const filteredCss = await fs.readFile(path.join(dir, 'web/tokens/tokens.css'), 'utf8');
  check('--layers keeps the selected layer', filteredCss.includes('--text-primary-default'));
  check('--layers drops the other layer', !filteredCss.includes('--color-mono-black'), firstMatch(filteredCss, /--color-mono-black[^;]*;/));
  check('--layers drops unassigned tokens too', !filteredCss.includes('--body-lg-bold-font-size'));

  const excluded = await run('node', [
    path.join(SCRIPTS, 'generate.mjs'), '--config', config, '--target', 'web', '--exclude', 'color/**',
  ]);
  process.stdout.write(indent(excluded.stdout));
  const excludedCss = await fs.readFile(path.join(dir, 'web/tokens/tokens.css'), 'utf8');
  check('--exclude removes matching tokens', !excludedCss.includes('--color-mono-black'));
  check('--exclude keeps everything else', excludedCss.includes('--text-primary-default') && excludedCss.includes('--spacing-8'));

  let emptySelectionFailed = false;
  try {
    await run('node', [path.join(SCRIPTS, 'generate.mjs'), '--config', config, '--target', 'web', '--include', 'nothing/**']);
  } catch {
    emptySelectionFailed = true;
  }
  check('a selection matching 0 tokens fails loudly', emptySelectionFailed);

  let badLayerRejected = false;
  await fs.writeFile(
    path.join(dir, 'badlayer.config.json'),
    JSON.stringify({
      figma: { fileKey: 'SELFTESTFILEKEY0000000' },
      tokensPath: 'tokens/tokens.json',
      layers: { semantic: ['text/**'] },
      targets: [{ type: 'web', out: 'web/tokens2', layers: ['semantik'] }],
    }),
  );
  try {
    await run('node', [path.join(SCRIPTS, 'generate.mjs'), '--config', path.join(dir, 'badlayer.config.json')]);
  } catch {
    badLayerRejected = true;
  }
  check('a typo in target.layers is rejected by config validation', badLayerRejected);

  // Put the unfiltered output back, so a failure below is never confused with
  // leftover state from the filtering assertions.
  await run('node', [path.join(SCRIPTS, 'generate.mjs'), '--config', config]);

  console.log('[selftest] alias linking');
  // A tiny set where semantic values mirror primitives: one unambiguous link,
  // one value that two primitives share, one that matches nothing.
  await fs.writeFile(
    path.join(dir, 'alias.json'),
    JSON.stringify({
      'palette/brand/500': '#ff5900',
      'palette/gray/900': '#111111',
      'palette/gray/900-copy': '#111111',
      'color/surface/primary': '#ff5900',
      'color/content/base': '#111111',
      'color/border/odd': '#abcdef',
    }),
  );
  const aliasConfig = path.join(dir, 'alias.config.json');
  await fs.writeFile(
    aliasConfig,
    JSON.stringify({
      figma: { fileKey: 'SELFTESTFILEKEY0000000' },
      tokensPath: 'tokens/alias-tokens.json',
      layers: { semantic: ['color/**'], primitive: ['palette/**'] },
      targets: [
        { type: 'web', out: 'aliasweb', aliasLinking: { source: 'primitive' } },
        { type: 'flutter', out: 'aliasdart', prefix: 'Al', groupColorsByNamespace: true, aliasLinking: { source: 'primitive' } },
        { type: 'dtcg', out: 'aliasdtcg', aliasLinking: { source: 'primitive' } },
      ],
    }),
  );
  await run('node', [path.join(SCRIPTS, 'normalize-mcp.mjs'), path.join(dir, 'alias.json'), '--config', aliasConfig]);
  const aliasGen = await run('node', [path.join(SCRIPTS, 'generate.mjs'), '--config', aliasConfig]);
  process.stdout.write(indent(aliasGen.stdout));

  const aliasCss = await fs.readFile(path.join(dir, 'aliasweb/tokens.css'), 'utf8');
  check('unambiguous alias becomes a var() reference', aliasCss.includes('--color-surface-primary: var(--palette-brand-500);'), firstMatch(aliasCss, /--color-surface-primary:[^;]+;/));
  check('ambiguous alias falls back to a literal', /--color-content-base: #111111;/.test(aliasCss), firstMatch(aliasCss, /--color-content-base:[^;]+;/));
  check('unmatched token stays a literal', aliasCss.includes('--color-border-odd: #abcdef;'));
  check('primitives themselves are never aliased', aliasCss.includes('--palette-brand-500: #ff5900;'));

  const aliasDart = await fs.readFile(path.join(dir, 'aliasdart/colors.g.dart'), 'utf8');
  check(
    'Dart alias references the primitive across classes',
    aliasDart.includes('static const Color colorSurfacePrimary = AlPaletteColors.paletteBrand_500;'),
    firstMatch(aliasDart, /static const Color colorSurfacePrimary = [^;]+;/),
  );
  check('Dart alias keeps a const expression (usable in const widgets)', !/colorSurfacePrimary = (?!AlPaletteColors|Color\()/.test(aliasDart));

  const aliasDtcg = JSON.parse(await fs.readFile(path.join(dir, 'aliasdtcg/tokens.dtcg.json'), 'utf8'));
  check('DTCG alias uses {group.token} syntax', aliasDtcg.color?.surface?.primary?.$value === '{palette.brand.500}', aliasDtcg.color?.surface?.primary?.$value);

  let strictFailed = false;
  await fs.writeFile(
    path.join(dir, 'alias-strict.config.json'),
    JSON.stringify({
      figma: { fileKey: 'SELFTESTFILEKEY0000000' },
      tokensPath: 'tokens/alias-tokens.json',
      layers: { semantic: ['color/**'], primitive: ['palette/**'] },
      targets: [{ type: 'web', out: 'aliasstrict', aliasLinking: { source: 'primitive', strict: true } }],
    }),
  );
  try {
    await run('node', [path.join(SCRIPTS, 'generate.mjs'), '--config', path.join(dir, 'alias-strict.config.json')]);
  } catch {
    strictFailed = true;
  }
  check('strict mode fails when any token cannot be linked', strictFailed);

  let danglingRejected = false;
  await fs.writeFile(
    path.join(dir, 'alias-dangling.config.json'),
    JSON.stringify({
      figma: { fileKey: 'SELFTESTFILEKEY0000000' },
      tokensPath: 'tokens/alias-tokens.json',
      layers: { semantic: ['color/**'], primitive: ['palette/**'] },
      targets: [{ type: 'web', out: 'aliasdangle', layers: ['semantic'], aliasLinking: { source: 'primitive' } }],
    }),
  );
  try {
    await run('node', [path.join(SCRIPTS, 'generate.mjs'), '--config', path.join(dir, 'alias-dangling.config.json')]);
  } catch {
    danglingRejected = true;
  }
  check('aliasing a layer the target filters out is rejected', danglingRejected);

  console.log('[selftest] modes');
  // Two dumps of the same tokens, as Figma returns them with light and then
  // dark active. `surface/base` flips; `brand/500` is the same in both.
  // `elevation/md` is the same Effect() in both, but the colour it points at
  // flips — so the shadow itself has to differ per mode.
  const modeShadow = 'Effect(type: DROP_SHADOW, color: color/content/base, offset: (0, 2), radius: 4, spread: 0)';
  await fs.writeFile(
    path.join(dir, 'mode-light.json'),
    JSON.stringify({ 'palette/brand/500': '#ff5900', 'color/surface/base': '#ffffff', 'color/content/base': '#111111', 'spacing/8': '8', 'elevation/md': modeShadow }),
  );
  await fs.writeFile(
    path.join(dir, 'mode-dark.json'),
    JSON.stringify({ 'palette/brand/500': '#ff5900', 'color/surface/base': '#111111', 'color/content/base': '#ffffff', 'spacing/8': '8', 'elevation/md': modeShadow }),
  );
  const modeConfig = path.join(dir, 'mode.config.json');
  await fs.writeFile(
    modeConfig,
    JSON.stringify({
      figma: { fileKey: 'SELFTESTFILEKEY0000000' },
      tokensPath: 'tokens/mode-tokens.json',
      layers: { semantic: ['color/**'], primitive: ['palette/**', 'spacing/**'] },
      targets: [
        { type: 'web', out: 'modeweb', modeSelectors: { dark: '[data-theme="dark"]' } },
        { type: 'flutter', out: 'modedart', prefix: 'Md' },
        { type: 'dtcg', out: 'modedtcg' },
      ],
    }),
  );
  await run('node', [path.join(SCRIPTS, 'normalize-mcp.mjs'), path.join(dir, 'mode-light.json'), '--config', modeConfig, '--mode', 'light']);
  const mergeOut = await run('node', [
    path.join(SCRIPTS, 'normalize-mcp.mjs'), path.join(dir, 'mode-dark.json'), '--config', modeConfig, '--mode', 'dark', '--merge',
  ]);
  process.stdout.write(indent(mergeOut.stdout));

  const modeTokens = JSON.parse(await fs.readFile(path.join(dir, 'tokens/mode-tokens.json'), 'utf8'));
  check('default mode is recorded', modeTokens.$meta.defaultMode === 'light');
  check('default value stays in $value', modeTokens.color['color/surface/base'].$value === '#FFFFFFFF');
  check('second mode lands in $modes', modeTokens.color['color/surface/base'].$modes?.dark === '#111111FF');
  check('a token identical in both modes still records the mode', modeTokens.color['palette/brand/500'].$modes?.dark === '#FF5900FF');

  const modeGen = await run('node', [path.join(SCRIPTS, 'generate.mjs'), '--config', modeConfig]);
  process.stdout.write(indent(modeGen.stdout));

  const modeCss = await fs.readFile(path.join(dir, 'modeweb/tokens.css'), 'utf8');
  check('default mode fills :root', /:root \{[\s\S]*--color-surface-base: #ffffff;/.test(modeCss));
  check('extra mode gets its own block with the configured selector', modeCss.includes('[data-theme="dark"] {'));
  check('theme block carries only what differs', /\[data-theme="dark"\] \{[\s\S]*--color-surface-base: #111111;/.test(modeCss));
  check(
    'theme block omits tokens identical in both modes',
    !/\[data-theme="dark"\] \{[^}]*--palette-brand-500/.test(modeCss),
    firstMatch(modeCss, /\[data-theme="dark"\] \{[^}]*\}/),
  );

  const modeDart = await fs.readFile(path.join(dir, 'modedart/colors_modes.g.dart'), 'utf8');
  check('Dart gets a full class per extra mode', modeDart.includes('abstract final class MdDarkColors'));
  check('Dart mode class carries every colour, not just the changed ones', modeDart.includes('paletteBrand_500') && modeDart.includes('colorSurfaceBase'));
  check('Dart mode class uses the mode value', /colorSurfaceBase = Color\(0xFF111111\)/.test(modeDart), firstMatch(modeDart, /colorSurfaceBase = [^;]+;/));

  check(
    'a shadow whose colour flips per mode lands in $modes',
    modeTokens.shadow?.['elevation/md']?.$modes?.dark?.[0]?.color === '#FFFFFFFF',
    JSON.stringify(modeTokens.shadow?.['elevation/md']?.$modes ?? null),
  );
  check(
    'the theme block overrides the shadow too',
    /\[data-theme="dark"\] \{[\s\S]*--elevation-md: 0 2px 4px 0 var\(--color-content-base\)/.test(modeCss),
    firstMatch(modeCss, /\[data-theme="dark"\] \{[^}]*\}/),
  );
  const modeDartShadow = await fs.readFile(path.join(dir, 'modedart/shadows.g.dart'), 'utf8');
  check('Dart gets a full shadow class per extra mode', modeDartShadow.includes('abstract final class MdDarkShadows'));
  check('Dart mode shadow uses the mode colour', /MdDarkShadows[\s\S]*Color\(0xFFFFFFFF\)/.test(modeDartShadow), firstMatch(modeDartShadow, /MdDarkShadows[\s\S]{0,200}/));

  const modeDtcg = JSON.parse(await fs.readFile(path.join(dir, 'modedtcg/tokens.dtcg.json'), 'utf8'));
  check('DTCG keeps modes in $extensions', modeDtcg.color?.surface?.base?.$extensions?.['com.figma.modes']?.dark === '#111111FF');

  const oneMode = await run('node', [path.join(SCRIPTS, 'generate.mjs'), '--config', modeConfig, '--target', 'web', '--modes', 'light']);
  process.stdout.write(indent(oneMode.stdout));
  const lightOnlyCss = await fs.readFile(path.join(dir, 'modeweb/tokens.css'), 'utf8');
  check('--modes light drops the dark block', !lightOnlyCss.includes('data-theme="dark"'));

  let unknownModeFailed = false;
  try {
    await run('node', [path.join(SCRIPTS, 'generate.mjs'), '--config', modeConfig, '--target', 'web', '--modes', 'sepia']);
  } catch {
    unknownModeFailed = true;
  }
  check('asking for a mode that was never extracted fails loudly', unknownModeFailed);

  let mergeWithoutBaseFailed = false;
  try {
    await run('node', [
      path.join(SCRIPTS, 'normalize-mcp.mjs'), path.join(dir, 'mode-dark.json'),
      '--config', modeConfig, '--out', path.join(dir, 'tokens/nonexistent.json'), '--mode', 'dark', '--merge',
    ]);
  } catch {
    mergeWithoutBaseFailed = true;
  }
  check('--merge without an existing token file fails loudly', mergeWithoutBaseFailed);

  console.log('[selftest] sync');
  // sync gets its own project directory: it snapshots and rolls back the whole
  // token file, so it must not share state with the assertions above.
  const syncDir = path.join(dir, 'syncproject');
  await fs.mkdir(path.join(syncDir, 'dumps/light'), { recursive: true });
  await fs.mkdir(path.join(syncDir, 'dumps/dark'), { recursive: true });
  const syncConfig = path.join(syncDir, 'tokens.config.json');
  await fs.writeFile(
    syncConfig,
    JSON.stringify({
      figma: { fileKey: 'SELFTESTFILEKEY0000000' },
      tokensPath: 'tokens/tokens.json',
      layers: { semantic: ['color/**'], primitive: ['palette/**', 'spacing/**'] },
      targets: [{ type: 'web', out: 'src/tokens' }],
    }),
  );
  const syncDump = path.join(syncDir, 'dumps/base.json');
  const writeSyncDump = (obj) => fs.writeFile(syncDump, JSON.stringify(obj));
  const sync = (argv) =>
    run('node', [path.join(SCRIPTS, 'sync.mjs'), ...argv], { cwd: syncDir });

  await writeSyncDump({ 'palette/brand/500': '#ff5900', 'color/surface/base': '#ffffff', 'spacing/8': '8' });
  const firstSync = await sync(['dumps/base.json']);
  check('first run says there is nothing to diff against', firstSync.stdout.includes('first extraction'));
  check('first run hints about gitignoring the baseline', firstSync.stdout.includes('tokens.prev.json to .gitignore'));
  check('first run generates output', firstSync.stdout.includes('src/tokens/tokens.css'));

  const secondSync = await sync(['dumps/base.json']);
  check('re-running with the same dump reports no token changes', secondSync.stdout.includes('no token changes'));
  check('re-running reports the output unchanged', secondSync.stdout.includes('generated output unchanged'));

  await writeSyncDump({ 'palette/brand/500': '#d40810', 'color/surface/base': '#ffffff', 'radius/4': '4' });
  const changedSync = await sync(['dumps/base.json']);
  check('diff shows a changed value with both sides', changedSync.stdout.includes('~ color palette/brand/500: "#FF5900FF" -> "#D40810FF"'), firstMatch(changedSync.stdout, /~ color[^\n]*/));
  check('diff shows an added token', changedSync.stdout.includes('+ dimension radius/4 = 4'));
  check('diff shows a removed token', changedSync.stdout.includes('- dimension spacing/8 (was 8)'));
  check('diff prints a one-line summary', changedSync.stdout.includes('1 changed, 1 added, 1 removed'));
  check('changed run lists the generated files that moved', changedSync.stdout.includes('materially changed'));
  const baselineAfter = JSON.parse(await fs.readFile(path.join(syncDir, 'tokens/tokens.prev.json'), 'utf8'));
  check('baseline holds the PREVIOUS tokens, not the new ones', baselineAfter.color['palette/brand/500'].$value === '#FF5900FF');

  // Rollback: a dump whose names collide once flattened.
  const goodTokens = await fs.readFile(path.join(syncDir, 'tokens/tokens.json'), 'utf8');
  const goodCss = await fs.readFile(path.join(syncDir, 'src/tokens/tokens.css'), 'utf8');
  await writeSyncDump({ 'palette/brand/500': '#d40810', 'color/surface/base': '#ffffff', 'color/surface-base': '#eeeeee' });
  let syncFailed = false;
  let failOutput = '';
  try {
    await sync(['dumps/base.json']);
  } catch (err) {
    syncFailed = true;
    failOutput = `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
  check('a token file that would not generate aborts the sync', syncFailed);
  check('the abort still printed the diff first', failOutput.includes('changes vs previous'));
  check('the abort explains what was restored', failOutput.includes('restored from the baseline'));
  check('tokens.json is byte-identical after a rollback', (await fs.readFile(path.join(syncDir, 'tokens/tokens.json'), 'utf8')) === goodTokens);
  check('generated code is untouched after a rollback', (await fs.readFile(path.join(syncDir, 'src/tokens/tokens.css'), 'utf8')) === goodCss);

  // Multi-mode via one directory per mode.
  await fs.writeFile(path.join(syncDir, 'dumps/light/c.json'), JSON.stringify({ 'palette/brand/500': '#ff5900', 'color/surface/base': '#ffffff' }));
  await fs.writeFile(path.join(syncDir, 'dumps/dark/c.json'), JSON.stringify({ 'palette/brand/500': '#ff5900', 'color/surface/base': '#111111' }));
  await fs.rm(path.join(syncDir, 'tokens'), { recursive: true, force: true });
  const modeSync = await sync(['dumps/light', 'dumps/dark']);
  check('mode directories are detected, first one is the default', modeSync.stdout.includes('2 mode(s): light, dark (default: light)'));
  const syncedModes = JSON.parse(await fs.readFile(path.join(syncDir, 'tokens/tokens.json'), 'utf8'));
  check('sync merged the second mode into $modes', syncedModes.color['color/surface/base'].$modes?.dark === '#111111FF');
  check('sync emitted the theme block', (await fs.readFile(path.join(syncDir, 'src/tokens/tokens.css'), 'utf8')).includes('data-theme="dark"'));

  // The bug this locks in: a change that only exists in a non-default mode.
  await fs.writeFile(path.join(syncDir, 'dumps/dark/c.json'), JSON.stringify({ 'palette/brand/500': '#ff5900', 'color/surface/base': '#0a0a0a' }));
  const modeDiffSync = await sync(['dumps/light', 'dumps/dark']);
  check(
    'a dark-only change is visible in the diff',
    modeDiffSync.stdout.includes('~ color color/surface/base [dark]: "#111111FF" -> "#0A0A0AFF"'),
    firstMatch(modeDiffSync.stdout, /~ color[^\n]*/),
  );

  const exitCodeOf = async (argv) => {
    try {
      await sync(argv);
      return 0;
    } catch (err) {
      return err.code;
    }
  };
  check('no input at all is a usage error', (await exitCodeOf([])) === 2);
  check('mixing files and directories is a usage error', (await exitCodeOf(['dumps/base.json', 'dumps/light'])) === 2);
  check('a partial-rebuild flag is refused', (await exitCodeOf(['dumps/light', '--target', 'web'])) === 2);

  // verify --baseline still works after diffAgainst moved into lib/diff.mjs.
  const baselineVerify = await run('node', [
    path.join(SCRIPTS, 'verify.mjs'), '--config', syncConfig, '--baseline', 'tokens/tokens.prev.json',
  ], { cwd: syncDir });
  check('verify --baseline still prints a diff', /changes vs baseline|no changes vs baseline/.test(baselineVerify.stdout));

  console.log('[selftest] namespace vs fixed-symbol collision');
  // A real design system shape: a `typography/font-size/*` dimension scale AND
  // text styles. Both want the symbol "typography". This shipped broken once —
  // two `export const typography` in one file, which does not compile.
  await fs.writeFile(
    path.join(dir, 'tyns.json'),
    JSON.stringify({
      'typography/font-size/lg': '16',
      'typography/line-height/lg': '24',
      // Not referenced by any composite, so these stay dimensions — which is
      // what makes the namespace want the symbol "typography".
      'typography/font-size/display': '42',
      'typography/paragraph-spacing/body': '0',
      'typography/font-family/body': 'Inter',
      'typography/font-weight/bold': 'Bold',
      'body/lg/bold':
        'Font(family: "typography/font-family/body", style: typography/font-weight/bold, size: typography/font-size/lg, weight: 700, lineHeight: typography/line-height/lg, letterSpacing: 0)',
    }),
  );
  const tynsConfig = path.join(dir, 'tyns.config.json');
  await fs.writeFile(
    tynsConfig,
    JSON.stringify({
      figma: { fileKey: 'SELFTESTFILEKEY0000000' },
      tokensPath: 'tokens/tyns-tokens.json',
      targets: [
        { type: 'web', out: 'tynsweb' },
        { type: 'flutter', out: 'tynsdart', prefix: 'Tn' },
      ],
    }),
  );
  await run('node', [path.join(SCRIPTS, 'normalize-mcp.mjs'), path.join(dir, 'tyns.json'), '--config', tynsConfig]);
  await run('node', [path.join(SCRIPTS, 'generate.mjs'), '--config', tynsConfig]);

  const tynsTs = await fs.readFile(path.join(dir, 'tynsweb/tokens.ts'), 'utf8');
  check('text styles keep the plain `typography` symbol', /^export const typography = \{/m.test(tynsTs));
  check('the colliding dimension scale is renamed, not dropped', tynsTs.includes('export const typographyScale = {'), firstMatch(tynsTs, /export const typography\w* = \{/g));
  check('only one `export const typography` is declared', (tynsTs.match(/^export const typography = /gm) ?? []).length === 1);
  check('the renamed scale keeps a matching type', tynsTs.includes('export type TypographyScaleToken'));

  const tynsDart = await fs.readFile(path.join(dir, 'tynsdart/dimensions.g.dart'), 'utf8');
  check('Dart renames the colliding dimension class too', tynsDart.includes('abstract final class TnTypographyScale'), firstMatch(tynsDart, /abstract final class \w+/));

  console.log('[selftest] collision detection');
  await fs.writeFile(path.join(dir, 'collide.json'), JSON.stringify({ 'text/primary/default': '#111111', 'text/primary-default': '#222222' }));
  let collisionCaught = false;
  try {
    await run('node', [path.join(SCRIPTS, 'normalize-mcp.mjs'), path.join(dir, 'collide.json'), '--config', config, '--out', path.join(dir, 'tokens/collide.json')]);
    await run('node', [
      path.join(SCRIPTS, 'generate.mjs'),
      '--config', config,
      '--target', 'flutter',
    ], { env: { ...process.env } });
  } catch {
    collisionCaught = true;
  }
  // The collision only exists in the alternate file; assert the generator
  // rejects it directly instead of relying on the default tokens path.
  const { generateFlutter } = await import(path.join(SCRIPTS, 'lib/targets/flutter.mjs'));
  try {
    generateFlutter(
      {
        color: { 'text/primary/default': { $value: '#111111FF' }, 'text/primary-default': { $value: '#222222FF' } },
        dimension: {},
        typography: {},
      },
      { prefix: 'Ds', sourceLabel: 'selftest' },
    );
    collisionCaught = false;
  } catch (err) {
    collisionCaught = /collision/i.test(err.message);
  }
  check('flattening collision is rejected, not silently merged', collisionCaught);

  await fs.rm(dir, { recursive: true, force: true });

  if (failures.length) {
    console.error(`\n[selftest] ${failures.length} failure(s):\n${failures.map((f) => `  ${f}`).join('\n')}`);
    process.exit(1);
  }
  console.log('\n[selftest] all checks passed');
}

function indent(text) {
  return text.split('\n').filter(Boolean).map((l) => `    ${l}\n`).join('');
}

function firstMatch(text, re) {
  return text.match(re)?.[0] ?? '(not found)';
}

main().catch((err) => {
  console.error(`[selftest] ERROR: ${err.stderr ?? err.message}`);
  process.exit(1);
});
