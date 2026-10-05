#!/usr/bin/env node
// Contract 3 (plan §1.6 clause 3; test #42): no inherited secret reaches a child process, and none
// appears in the write-log, in packets or in anything else the room writes.
//
// Method: run the room's own commands (admin init, add-seat, serve --once, then the seat commands
// `status` and `wait`) with a deliberately polluted environment (OPENAI_API_KEY and friends set to
// unique canary values), then
//   1. outputs  - scan every byte the room produced (room directory, seat outbox, child stdout and
//                 stderr) for the canary values;
//   2. seat-exit - read the seat command's own environment as it exits, through a probe module
//                 preloaded with NODE_OPTIONS=--import (the probe prints key NAMES only, never
//                 values). Plan clause 3 says `room` clears everything but PATH, SystemRoot, TEMP
//                 and the room's own variables when it starts, so a canary key still present at
//                 exit is a failure of that clause even though the seat command spawns nothing;
//   3. spawnClean - spawn a probe child through lib/spawn.mjs from a polluted parent and assert its
//                 environment holds only whitelisted keys, the explicitly passed one and (on
//                 Windows) the variables libuv re-adds by itself (IMPLICIT_WIN32_VARS).
// Also observed from source: whether lib/seat.mjs imports child_process at all.
//
// What this does NOT prove: that a secret never reached memory of some process, that a key not on
// the canary list did not leak (only planted values are searched), or anything about processes the
// room did not start. Wording: "未观测到".
//
//   node contract/env.mjs [--room <roomDir> --seat <seatDir>] [--run-dir <dir>]
// Without --room a throwaway room is built under testRunsRoot()\env-<random>. Exit 0/1.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { spawnClean, ENV_WHITELIST as SPAWN_WHITELIST, IMPLICIT_WIN32_VARS } from '../lib/spawn.mjs';
import { REPO_ROOT, openRunDir, passThroughEnv, runRoom, createReporter, runCli } from './harness.mjs';

const SEAT_SRC = path.join(REPO_ROOT, 'lib', 'seat.mjs');

// lib/spawn.mjs is the authority on the whitelist (INTERFACES §7 also lists LOCALAPPDATA "only for
// the wake push"; a caller that needs it passes it explicitly).
export const ENV_WHITELIST = [...SPAWN_WHITELIST];
export const CANARY_KEYS = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'CODEX_API_KEY', 'GITHUB_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'ROOM_CANARY_SECRET'];
export const PROBE_MARK = 'ROOM_ENV_PROBE';

export function makeCanaries(keys = CANARY_KEYS) {
  const c = {};
  for (const k of keys) c[k] = `canary-${crypto.randomBytes(6).toString('hex')}-${k.toLowerCase()}`;
  return c;
}

function foldKey(k, platform = process.platform) { return platform === 'win32' ? k.toUpperCase() : k; }

// Pure. Keys of `env` that are neither whitelisted nor explicitly allowed (case-folded on Windows).
// Windows' hidden "=C:"-style variables are ignored.
export function extraEnvKeys(env, allowed = ENV_WHITELIST, explicit = [], platform = process.platform) {
  const ok = new Set([...allowed, ...explicit].map((k) => foldKey(k, platform)));
  return Object.keys(env || {}).filter((k) => !k.startsWith('=') && !ok.has(foldKey(k, platform))).sort();
}

// Pure. Which canary values occur in `text`.
export function findCanaries(text, canaries) {
  const s = String(text);
  return Object.entries(canaries).filter(([, v]) => s.includes(v)).map(([k]) => k);
}

// Pure. Canary key names among `keys` (case-folded on Windows).
export function canaryKeysIn(keys, canaryKeys = CANARY_KEYS, platform = process.platform) {
  const want = new Set(canaryKeys.map((k) => foldKey(k, platform)));
  return keys.filter((k) => want.has(foldKey(k, platform))).sort();
}

// Pure. Pulls the probe records out of a child's stderr.
export function parseProbeLines(text) {
  const rows = [];
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.startsWith(`${PROBE_MARK} `)) continue;
    try { rows.push(JSON.parse(line.slice(PROBE_MARK.length + 1))); } catch { /* not a probe line */ }
  }
  return rows;
}

// The probe preloaded into the seat process. Prints key names at start and at exit on fd 2
// (synchronous, so it survives process.exit()).
export const PROBE_SOURCE = `import fs from 'node:fs';
const emit = (phase) => { try { fs.writeSync(2, '\\n${PROBE_MARK} ' + JSON.stringify({ phase, pid: process.pid, keys: Object.keys(process.env).sort() }) + '\\n'); } catch {} };
emit('start');
process.on('exit', () => emit('exit'));
`;

export function walkFiles(root) {
  const files = [];
  const walk = (d) => {
    let names;
    try { names = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of names) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else if (e.isFile()) files.push(p);
    }
  };
  if (fs.existsSync(root)) walk(root);
  return files;
}

function parseCli(argv) {
  const res = { room: null, seat: null, runDir: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--room') { res.room = argv[++i]; continue; }
    if (a === '--seat') { res.seat = argv[++i]; continue; }
    if (a === '--run-dir') { res.runDir = argv[++i]; continue; }
    throw new Error(`unknown option ${a}`);
  }
  return res;
}

function firstJsonObject(text) {
  for (const line of String(text).split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try { return JSON.parse(t); } catch { /* not this line */ }
  }
  return null;
}

const head = (t, n = 200) => String(t).trim().replace(/\s+/g, ' ').slice(0, n);

export async function main(argv, { out } = {}) {
  const args = parseCli(argv);
  const rep = createReporter(out);
  const { runDir, guard } = openRunDir({ runDir: args.runDir, prefix: 'env' });
  const canaries = makeCanaries();
  const pollutedEnv = passThroughEnv(canaries);
  const transcripts = [];
  const logPath = path.join(runDir, 'env-children.log');
  const run = async (label, argvRoom, env = pollutedEnv) => {
    const r = await runRoom(argvRoom, { env, cwd: runDir, timeoutMs: 60000, guard, log: logPath, label });
    const rec = { label, argv: argvRoom, code: r.code, stdout: r.stdout, stderr: r.stderr };
    transcripts.push(rec);
    return rec;
  };

  // ---- build or reuse a room; every child gets the polluted environment ----
  let roomDir; let seatDir; let outbox;
  if (args.room) {
    roomDir = path.resolve(args.room);
    seatDir = args.seat ? path.resolve(args.seat) : null;
    if (!seatDir) throw new Error('--room needs --seat <seatDir>');
  } else {
    roomDir = path.join(runDir, 'env-room');
    const cwdA = path.join(runDir, 'env-cwdA');
    // The seat working directory is the user's to create: add-seat refuses a missing one (NI-13).
    guard.mkdir(cwdA);
    const steps = [
      ['admin init', ['admin', 'init', '--dir', roomDir, '--id', 'envprobe', '--wall', '600']],
      ['admin add-seat', ['admin', 'add-seat', '--dir', roomDir, '--seat', 'A', '--role', 'participant', '--wait', 'turn_over', '--cwd', cwdA]],
      ['serve --once', ['serve', '--dir', roomDir, '--once']],
    ];
    for (const [label, a] of steps) {
      const r = await run(label, a);
      if (r.code !== 0) rep.fail(`env(setup): ${label} 退出 ${r.code}: ${head(r.stdout + r.stderr)}`);
    }
    seatDir = path.join(roomDir, 'seats', 'A');
  }
  try { outbox = JSON.parse(fs.readFileSync(path.join(seatDir, 'seat.json'), 'utf8')).outbox; } catch { outbox = null; }

  // ---- seat commands under the polluted parent, with the exit probe preloaded ----
  const probeFile = path.join(runDir, 'env-exit-probe.mjs');
  guard.writeFile(probeFile, PROBE_SOURCE);
  const probedEnv = { ...pollutedEnv, NODE_OPTIONS: `--import=${pathToFileURL(probeFile).href}` };
  const status = await run('seat status', ['status', '--seat', seatDir], probedEnv);
  const wait = await run('seat wait', ['wait', '--seat', seatDir, '--timeout', '0'], probedEnv);
  const seatOk = status.code === 0 && /^STATUS/m.test(status.stdout) && wait.code === 0;
  if (seatOk) rep.pass(`env(seat-run): status 与 wait 在污染环境下正常返回（${head(status.stdout.split('\n')[0], 80)} / ${head(wait.stdout.split('\n')[0], 40)}）`);
  else rep.fail(`env(seat-run): 席位命令异常 status=${status.code} wait=${wait.code}: ${head(status.stdout + status.stderr + wait.stdout + wait.stderr)}`);

  // ---- 1. scan everything the room produced for the canary values ----
  const files = [...walkFiles(roomDir), ...(outbox ? walkFiles(outbox) : [])];
  const hits = [];
  for (const f of files) {
    let text;
    try { text = fs.readFileSync(f, 'latin1'); } catch { continue; }
    for (const k of findCanaries(text, canaries)) hits.push(`${k} in ${f}`);
  }
  for (const t of transcripts) for (const k of findCanaries(t.stdout + t.stderr, canaries)) hits.push(`${k} in stdout/stderr of ${t.label}`);
  if (hits.length === 0) rep.pass(`env(outputs): 扫描 ${files.length} 个文件（房间目录 + 发件箱，含 write-log 与 packets）与 ${transcripts.length} 段子进程输出，在字符串扫描方法下未观测到 ${Object.keys(canaries).length} 个注入的 canary 密钥值`);
  else { rep.fail(`env(outputs): 在字符串扫描方法下观测到 canary 值 ${hits.length} 处`); for (const h of hits) rep.detail(h); }

  // ---- observed from source: does the seat command spawn anything? ----
  let seatSrc = '';
  try { seatSrc = fs.readFileSync(SEAT_SRC, 'utf8'); } catch { /* seat source missing */ }
  const importsChildProcess = /child_process/.test(seatSrc);
  const importsSpawn = /spawn\.mjs/.test(seatSrc);
  rep.info(`env(seat-source): lib/seat.mjs ${importsChildProcess ? '导入了 child_process' : '未导入 child_process'}${importsSpawn ? '，经 lib/spawn.mjs 派生子进程' : '，未导入 lib/spawn.mjs'}（源码观测）`);

  // ---- 2. the seat process's own environment at start and at exit ----
  const probes = [status, wait].flatMap((t) => parseProbeLines(t.stderr).map((p) => ({ ...p, label: t.label })));
  const exits = probes.filter((p) => p.phase === 'exit');
  const starts = probes.filter((p) => p.phase === 'start');
  if (exits.length === 0) rep.skip('env(seat-exit): 探针未输出退出时的环境（NODE_OPTIONS --import 未生效？），席位进程自身环境未观测');
  else {
    const inheritedAtStart = [...new Set(starts.flatMap((p) => canaryKeysIn(p.keys)))];
    const leftAtExit = [...new Set(exits.flatMap((p) => canaryKeysIn(p.keys)))];
    const tolerated = [...ENV_WHITELIST, ...(process.platform === 'win32' ? IMPLICIT_WIN32_VARS : []), 'NODE_OPTIONS', ...Object.keys(passThroughEnv())];
    const extrasAtExit = [...new Set(exits.flatMap((p) => extraEnvKeys(Object.fromEntries(p.keys.map((k) => [k, ''])), tolerated)))];
    rep.info(`env(seat-exit): 启动时继承的 canary 变量 ${inheritedAtStart.length}/${CANARY_KEYS.length}（预期：席位命令是 agent 的子进程，会继承）`);
    if (leftAtExit.length === 0) rep.pass(`env(seat-exit): ${exits.length} 个席位进程退出时，在 NODE_OPTIONS 预载探针方法下未观测到继承的 canary 变量${extrasAtExit.length ? `（其他白名单外变量名：${extrasAtExit.join(',')}）` : ''}`);
    else rep.fail(`env(seat-exit): ${exits.length} 个席位进程退出时环境仍含继承的 canary 变量 [${leftAtExit.join(',')}]（方案 §1.6 第 3 条要求 room 启动时清空白名单外环境；本项只记变量名，不记值）`);
  }

  // ---- 3. spawnClean whitelist ----
  const probe = path.join(runDir, 'env-probe.mjs');
  guard.writeFile(probe, 'process.stdout.write(JSON.stringify(process.env));\n');
  const saved = {};
  for (const [k, v] of Object.entries(canaries)) { saved[k] = process.env[k]; process.env[k] = v; }
  try {
    const r = await spawnClean(process.execPath, [probe], { cwd: runDir, env: { ROOM_PROBE_EXPLICIT: '1' }, timeoutMs: 20000, maxOutputBytes: 1 << 20 });
    const env = firstJsonObject(r.stdout);
    if (!env) rep.fail(`env(spawnClean): 子进程未输出可解析的环境 JSON（exit ${r.code} ${r.spawnError || ''}）`);
    else {
      const implicit = process.platform === 'win32' ? [...IMPLICIT_WIN32_VARS] : [];
      const extras = extraEnvKeys(env, [...ENV_WHITELIST, ...implicit], ['ROOM_PROBE_EXPLICIT']);
      const leakedValues = findCanaries(JSON.stringify(env), canaries);
      const implicitSeen = implicit.filter((k) => Object.keys(env).some((e) => e.toUpperCase() === k) && !ENV_WHITELIST.some((w) => w.toUpperCase() === k));
      if (extras.length === 0 && leakedValues.length === 0) rep.pass(`env(spawnClean): 子进程环境 ${Object.keys(env).length} 个变量 [${Object.keys(env).sort().join(',')}]，在 spawnClean 方法下未观测到白名单之外的变量或继承的 canary 值${implicitSeen.length ? `（libuv 自行补入：${implicitSeen.join(',')}）` : ''}`);
      else rep.fail(`env(spawnClean): 白名单外变量 [${extras.join(',')}] canary 值 [${leakedValues.join(',')}]`);
    }
  } catch (e) { rep.fail(`env(spawnClean): 调用失败：${e.message}`); }
  finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }

  rep.raw(logPath);
  rep.raw(roomDir);
  if (outbox) rep.raw(outbox);
  return rep.failed ? 1 : 0;
}

runCli(import.meta.url, main);
