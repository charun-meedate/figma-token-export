// Loads and validates tokens.config.json.
//
// Every path in the config is resolved relative to the config file itself, so
// the scripts can be run from any working directory (and from CI) without a
// cwd convention that people will get wrong.
import fs from 'node:fs/promises';
import path from 'node:path';

const CONFIG_NAME = 'tokens.config.json';

const VALID_TARGETS = new Set(['flutter', 'web', 'dtcg']);

const DEFAULTS = {
  tokensPath: 'tokens/tokens.json',
  rawDir: 'build/figma-raw',
};

/** Walks up from `startDir` looking for tokens.config.json. */
export async function findConfigPath(startDir = process.cwd()) {
  let dir = path.resolve(startDir);
  for (;;) {
    const candidate = path.join(dir, CONFIG_NAME);
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) {
        throw new Error(
          `${CONFIG_NAME} not found in ${startDir} or any parent directory. ` +
            'Copy tokens.config.example.json to your project root and edit it.',
        );
      }
      dir = parent;
    }
  }
}

export async function loadConfig(explicitPath) {
  const configPath = explicitPath ? path.resolve(explicitPath) : await findConfigPath();
  const rootDir = path.dirname(configPath);

  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(configPath, 'utf8'));
  } catch (err) {
    throw new Error(`Could not parse ${configPath}: ${err.message}`);
  }

  const config = { ...DEFAULTS, ...parsed };
  const errors = [];

  const layerNames = Object.keys(config.layers ?? {});
  if (config.layers !== undefined) {
    if (typeof config.layers !== 'object' || Array.isArray(config.layers)) {
      errors.push('`layers` must be an object of { layerName: [glob, …] }.');
    } else {
      for (const [name, patterns] of Object.entries(config.layers)) {
        if (!Array.isArray(patterns) || patterns.some((p) => typeof p !== 'string')) {
          errors.push(`layers.${name} must be an array of glob strings.`);
        }
      }
    }
  }

  if (!Array.isArray(config.targets) || config.targets.length === 0) {
    errors.push('`targets` must be a non-empty array — pick at least one of: flutter, web, dtcg.');
  } else {
    config.targets.forEach((target, i) => {
      if (!VALID_TARGETS.has(target.type)) {
        errors.push(`targets[${i}].type "${target.type}" is not one of: ${[...VALID_TARGETS].join(', ')}.`);
      }
      if (!target.out) {
        errors.push(`targets[${i}] ("${target.type}") is missing \`out\`.`);
      }
      for (const key of ['include', 'exclude', 'layers', 'modes']) {
        if (target[key] !== undefined && !Array.isArray(target[key])) {
          errors.push(`targets[${i}].${key} must be an array of strings.`);
        }
      }
      if (target.modeSelectors !== undefined) {
        if (typeof target.modeSelectors !== 'object' || Array.isArray(target.modeSelectors)) {
          errors.push(`targets[${i}].modeSelectors must be an object of { modeName: "css selector" }.`);
        } else if (target.type !== 'web') {
          errors.push(`targets[${i}].modeSelectors only applies to the web target ("${target.type}" has no CSS selectors).`);
        }
      }
      if (target.tailwind !== undefined) {
        // The major version, not a boolean: v3 and v4 need entirely different
        // output, and v4 syntax in a v3 project generates no utilities and no
        // error — a half-working state nobody would think to look for.
        if (target.tailwind !== 3 && target.tailwind !== 4) {
          errors.push(
            `targets[${i}].tailwind must be 3 or 4 — the two majors need different output ` +
              '(4: @theme blocks in tokens.css; 3: tokens.tailwind.cjs for theme.extend).',
          );
        } else if (target.type !== 'web') {
          errors.push(`targets[${i}].tailwind only applies to the web target ("${target.type}" emits no CSS or Tailwind config).`);
        }
      }
      if (target.colorFormat !== undefined) {
        if (!['hex', 'rgb'].includes(target.colorFormat)) {
          errors.push(`targets[${i}].colorFormat must be "hex" or "rgb" (default), not ${JSON.stringify(target.colorFormat)}.`);
        } else if (target.type !== 'web') {
          errors.push(`targets[${i}].colorFormat only applies to the web target ("${target.type}" has its own colour syntax).`);
        }
      }
      // A layer name that is not defined would silently select nothing —
      // catch the typo here rather than shipping an empty token file.
      for (const layer of target.layers ?? []) {
        if (layerNames.length && !layerNames.includes(layer)) {
          errors.push(
            `targets[${i}].layers references "${layer}", which is not defined in \`layers\` (have: ${layerNames.join(', ') || 'none'}).`,
          );
        }
      }
      if ((target.layers ?? []).length && layerNames.length === 0) {
        errors.push(`targets[${i}].layers is set but no top-level \`layers\` map is defined.`);
      }

      const alias = target.aliasLinking;
      if (alias !== undefined) {
        if (typeof alias !== 'object' || Array.isArray(alias) || !alias.source) {
          errors.push(`targets[${i}].aliasLinking must be an object with a \`source\` layer name, e.g. { "source": "primitive" }.`);
        } else if (layerNames.length && !layerNames.includes(alias.source)) {
          errors.push(
            `targets[${i}].aliasLinking.source is "${alias.source}", which is not a defined layer (have: ${layerNames.join(', ')}).`,
          );
        } else if (!layerNames.length) {
          errors.push(`targets[${i}].aliasLinking needs a top-level \`layers\` map to know which tokens are primitives.`);
        }
        // Linking to primitives this target does not emit produces dangling
        // references, so catch the contradiction in config rather than output.
        if (alias?.source && (target.layers ?? []).length && !target.layers.includes(alias.source)) {
          errors.push(
            `targets[${i}] excludes layer "${alias.source}" via \`layers\` but aliasLinking points at it — ` +
              'add it to `layers`, or drop aliasLinking for this target.',
          );
        }
      }
    });
  }

  if (errors.length) {
    throw new Error(`Invalid ${configPath}:\n- ${errors.join('\n- ')}`);
  }

  return {
    ...config,
    configPath,
    rootDir,
    tokensPath: path.resolve(rootDir, config.tokensPath),
    rawDir: path.resolve(rootDir, config.rawDir),
    targets: config.targets.map((t) => ({ ...t, out: path.resolve(rootDir, t.out) })),
  };
}

/** Minimal flag parser: `--key value` and `--flag`. */
export function parseArgs(argv = process.argv.slice(2)) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const item = argv[i];
    if (item.startsWith('--')) {
      const key = item.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        args[key] = true;
      } else {
        args[key] = next;
        i++;
      }
    } else {
      args._.push(item);
    }
  }
  return args;
}
