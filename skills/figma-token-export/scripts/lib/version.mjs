// The skill's own version, stamped into every generated file's header.
//
// A team runs several projects off one shared skill, and those projects update
// it at different times. When generated output looks wrong, the first question
// is "which version produced this?" — the header answers it without anyone
// having to guess from the file's shape.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function read() {
  try {
    const pkg = path.resolve(fileURLToPath(new URL('../package.json', import.meta.url)));
    return JSON.parse(fs.readFileSync(pkg, 'utf8')).version ?? 'unknown';
  } catch {
    // A missing or unreadable package.json must never break codegen — the
    // version is documentation, not behaviour.
    return 'unknown';
  }
}

export const SKILL_VERSION = read();
