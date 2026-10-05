#!/usr/bin/env node
// dist/export.mjs — command-line wrapper for lib/export.mjs (plan §8.6, §13.1 #12).
//
//   node dist/export.mjs <roomDir> <out.zip> [--redact]
//
// The export itself (public layer only, secret and absolute-path scan, --redact) lives in
// lib/export.mjs so that `room admin export` and hosts that vendor only lib/ (PI-Desktop) can run it.
// Exit codes: 0 exported; 2 blocked by scan hits; 9 error.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { exportRoom, parseExportArgs } from '../lib/export.mjs';

export * from '../lib/export.mjs';

function isMain() {
  if (!process.argv[1]) return false;
  try { return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href; } catch { return false; }
}

if (isMain()) {
  const usage = '用法：node dist/export.mjs <roomDir> <out.zip> [--redact]';
  let opts;
  try { opts = parseExportArgs(process.argv.slice(2)); } catch (e) { process.stderr.write(`ERROR ${e.message}\n${usage}\n`); process.exit(9); }
  if (opts.help || opts.positional.length !== 2) { process.stdout.write(`${usage}\n`); process.exit(opts.help ? 0 : 9); }
  exportRoom({ roomDir: opts.positional[0], out: opts.positional[1], redact: opts.redact, log: (l) => process.stdout.write(`${l}\n`) })
    .then((r) => process.exit(r.ok ? 0 : 2))
    .catch((e) => { process.stderr.write(`ERROR ${e && e.stack ? e.stack : e}\n`); process.exit(9); });
}
