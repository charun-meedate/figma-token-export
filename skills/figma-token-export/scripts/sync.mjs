#!/usr/bin/env node
// One command for the everyday case: a designer changed Figma, and a developer
// needs to know what moved and get the regenerated code.
//
//   node sync.mjs dumps/*.json                 one mode
//   node sync.mjs dumps/light dumps/dark       one directory per mode, first = default
//   node sync.mjs --rest                       extract over REST instead of MCP dumps
//
// It runs the existing steps in order — extract, diff, verify, generate — and
// prints the token diff BEFORE the verify gate, so a failed run still tells you
// which Figma change caused it.
//
// The invariant worth protecting: a sync run never leaves tokens.json updated
// while the generated code is stale. Any failure restores tokens.json from the
// snapshot taken at the start, so the repo ends up exactly as it began.
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { loadConfig, parseArgs } from './lib/config.mjs';
import { loadTokens, countTokens } from './lib/dtcg.mjs';
import { diffTokenSets, formatDiffLines, summarizeDiff, stripGeneratedHeader } from './lib/diff.mjs';

const run = promisify(execFile);
const SCRIPTS = path.dirname(fileURLToPath(import.meta.url));

// Flags that would regenerate only part of the output. Refused rather than
// forwarded: updating the shared tokens.json while rebuilding one target
// leaves the others stale, which is the exact state sync exists to prevent.
const PARTIAL_FLAGS = ['target', 'layers', 'include', 'exclude', 'modes', 'out', 'check'];

function usage(message) {
  console.error(
    `${message}\n\n` +
      'Usage:\n' +
      '  node sync.mjs <dump.json...>            extract one mode from these dumps\n' +
      '  node sync.mjs <dir> [<dir>...]          one directory per mode, first is the default\n' +
      '  node sync.mjs --rest                    extract over the Figma REST API instead\n' +
      '\nOptions: --config <path>  --mode <name>  --merge\n',
  );
  process.exit(2);
}

function indent(text) {
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => `    ${line}\n`)
    .join('');
}

/** Runs one of the sibling CLIs, streaming its output indented under a step label. */
async function step(script, argv) {
  try {
    const { stdout, stderr } = await run('node', [path.join(SCRIPTS, script), ...argv]);
    process.stdout.write(indent(stdout));
    if (stderr.trim()) process.stdout.write(indent(stderr));
  } catch (err) {
    process.stdout.write(indent(err.stdout ?? ''));
    process.stdout.write(indent(err.stderr ?? ''));
    throw new Error(`${script} failed`);
  }
}

/**
 * Sorts the positional arguments into either a list of dump files or a list of
 * per-mode directories. Mixing the two is refused: it is ambiguous which files
 * belong to which mode, and guessing would silently mis-assign values.
 */
async function classifyInputs(positionals) {
  if (positionals.length === 0) return null;

  const stats = await Promise.all(
    positionals.map(async (item) => {
      try {
        return { item, isDir: (await fs.stat(item)).isDirectory() };
      } catch {
        return usage(`Input not found: ${item}`);
      }
    }),
  );

  const dirs = stats.filter((s) => s.isDir);
  if (dirs.length === 0) return { kind: 'files', files: positionals };
  if (dirs.length !== stats.length) {
    return usage('Mixed files and directories. Pass either dump files (one mode) or one directory per mode.');
  }

  const modeDirs = [];
  for (const { item } of stats) {
    const files = (await fs.readdir(item))
      .filter((f) => f.endsWith('.json'))
      .sort()
      .map((f) => path.join(item, f));
    if (files.length === 0) return usage(`No .json dumps in ${item}`);
    modeDirs.push({ mode: path.basename(item), files });
  }
  return { kind: 'modeDirs', dirs: modeDirs };
}

/** Snapshot of every generated file's meaningful content, keyed by absolute path. */
async function snapshotOutputs(targets) {
  const snapshot = new Map();
  for (const target of targets) {
    let names;
    try {
      names = await fs.readdir(target.out);
    } catch {
      continue; // first run: the directory does not exist yet
    }
    for (const name of names) {
      const file = path.join(target.out, name);
      if (!(await fs.stat(file)).isFile()) continue;
      snapshot.set(file, stripGeneratedHeader(await fs.readFile(file, 'utf8')));
    }
  }
  return snapshot;
}

function changedOutputs(before, after, rootDir) {
  const changed = [];
  for (const [file, contents] of after) {
    if (before.get(file) !== contents) changed.push(path.relative(rootDir, file));
  }
  return changed.sort();
}

async function main() {
  const args = parseArgs();

  for (const flag of PARTIAL_FLAGS) {
    if (args[flag] !== undefined) {
      usage(
        `--${flag} is not accepted by sync: it would regenerate only part of the output while updating the ` +
          'shared tokens.json, leaving the rest stale. Run generate.mjs directly for a partial rebuild.',
      );
    }
  }

  const config = await loadConfig(typeof args.config === 'string' ? args.config : undefined);
  const configArgs = typeof args.config === 'string' ? ['--config', args.config] : [];
  const rel = (p) => path.relative(config.rootDir, p) || path.basename(p);

  const inputs = await classifyInputs(args._);
  if (!inputs && !args.rest) {
    usage('Nothing to extract: pass dump files, per-mode directories, or --rest.');
  }
  if (inputs && args.rest) {
    usage('--rest extracts from the Figma API; do not also pass dump files.');
  }

  // ---- snapshot, so any failure below can put everything back ----
  const baselinePath = config.tokensPath.replace(/\.json$/, '.prev.json');
  let baseline = null;
  let firstRun = false;
  try {
    baseline = await loadTokens(config.tokensPath);
    await fs.copyFile(config.tokensPath, baselinePath);
  } catch {
    firstRun = true;
    console.log(`[sync] no existing ${rel(config.tokensPath)} — first extraction, nothing to diff against.`);
  }

  const outputsBefore = await snapshotOutputs(config.targets);

  let restored = false;
  const restore = async () => {
    if (firstRun) {
      // A failed first run must not leave a half-trusted token file behind:
      // the next sync would snapshot it as its baseline.
      await fs.rm(config.tokensPath, { force: true });
    } else {
      await fs.copyFile(baselinePath, config.tokensPath);
    }
    restored = true;
  };

  try {
    // ---- extract ----
    if (args.rest) {
      console.log('[sync] extract — Figma REST API');
      await step('fetch-rest.mjs', configArgs);
    } else if (inputs.kind === 'files') {
      console.log(`[sync] extract — ${inputs.files.length} dump file(s) → ${rel(config.tokensPath)}`);
      const modeArgs = typeof args.mode === 'string' ? ['--mode', args.mode] : [];
      if (args.merge) modeArgs.push('--merge');
      await step('normalize-mcp.mjs', [...inputs.files, ...configArgs, ...modeArgs]);
    } else {
      console.log(
        `[sync] extract — ${inputs.dirs.length} mode(s): ${inputs.dirs.map((d) => d.mode).join(', ')} ` +
          `(default: ${inputs.dirs[0].mode})`,
      );
      for (const [i, dir] of inputs.dirs.entries()) {
        const modeArgs = ['--mode', dir.mode, ...(i > 0 ? ['--merge'] : [])];
        await step('normalize-mcp.mjs', [...dir.files, ...configArgs, ...modeArgs]);
      }
    }

    // ---- diff, before the gate so a failure still shows what changed ----
    const current = await loadTokens(config.tokensPath);
    if (baseline) {
      const diff = diffTokenSets(baseline, current);
      if (diff.entries.length) {
        console.log(`[sync] changes vs previous ${rel(config.tokensPath)}:`);
        console.log(formatDiffLines(diff).join('\n'));
        console.log(`[sync] ${summarizeDiff(diff)}`);
      } else {
        console.log(`[sync] no token changes — Figma matches ${rel(config.tokensPath)}.`);
      }
    } else {
      const counts = countTokens(current);
      console.log(
        `[sync] extracted ${counts.color} color, ${counts.dimension} dimension, ` +
          `${counts.typography} typography${counts.shadow ? `, ${counts.shadow} shadow` : ''}.`,
      );
    }

    // ---- verify is the gate: nothing is generated from a token file that fails ----
    console.log('[sync] verify');
    await step('verify.mjs', configArgs);

    // ---- generate ----
    console.log('[sync] generate');
    try {
      await step('generate.mjs', configArgs);
    } catch (err) {
      // generate writes target by target, so a throw can leave some files new
      // and some stale. Restore the tokens and rebuild from them — codegen is
      // deterministic and offline, so this puts every file back.
      console.error('[sync] generate failed — restoring and rebuilding from the previous tokens…');
      await restore();
      if (!firstRun) {
        try {
          await step('generate.mjs', configArgs);
        } catch {
          console.error(
            `[sync] the rebuild also failed. ${rel(config.tokensPath)} is back to its previous content; ` +
              'regenerate manually before committing.',
          );
        }
      }
      throw err;
    }

    const outputsAfter = await snapshotOutputs(config.targets);
    const changed = changedOutputs(outputsBefore, outputsAfter, config.rootDir);
    if (changed.length) {
      console.log(`[sync] ${changed.length} generated file(s) materially changed:`);
      for (const file of changed) console.log(`  ${file}`);
      console.log('[sync] done — review the diff above, then commit the dumps, tokens and generated files together.');
    } else {
      console.log('[sync] generated output unchanged (header timestamps only) — nothing to commit.');
    }

    if (firstRun) {
      console.log(`[sync] note: add ${rel(baselinePath)} to .gitignore — sync writes it as a diff baseline.`);
    }
  } catch (err) {
    const rebuiltAfterGenerateFailure = restored;
    if (!restored) await restore();

    console.error(`[sync] ABORTED: ${err.message} (see the output above).`);
    if (firstRun) {
      console.error(`[sync] ${rel(config.tokensPath)} removed — the run left nothing behind.`);
    } else if (rebuiltAfterGenerateFailure) {
      console.error(`[sync] ${rel(config.tokensPath)} restored and the generated code rebuilt from it.`);
    } else {
      console.error(`[sync] ${rel(config.tokensPath)} restored from the baseline; generated code left untouched.`);
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`[sync] FAILED: ${err.message}`);
  process.exit(1);
});
