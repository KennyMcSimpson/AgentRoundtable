// lib/driver.mjs + `node room.mjs drive`: optional seat-side client driver (Codex-only).
// Verifies module isolation, the three negative gates (--model required, --effort required,
// permission-skip / sandbox-bypass / unsupported --runner refused with zero fake CLI spawns),
// argument ordering before `resume <threadId> -`, controlled environment forwarding, and a
// multi-turn fake-Codex round covering both in-turn manual submit (idempotent skip) and auto-submit.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { testRunsRoot, randomHex } from '../lib/common.mjs';
import { createRoom, addSeat, openRoom, seatClient } from '../lib/api.mjs';
import {
  validateDriveArgs, buildCodexExecArgs, buildDriverChildEnv, parseCodexJsonOutput,
} from '../lib/driver.mjs';
import { CliError } from '../lib/seat.mjs';
import { spawnClean } from '../lib/spawn.mjs';
import { main as checkWritesMain } from '../contract/check-writes.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ROOM_MJS = path.join(ROOT, 'room.mjs');
const SYNTHETIC_THREAD_ID = '01a0f000-0000-7000-8000-000000000001';

const roots = [];
after(async () => {
  for (const r of roots) await fs.promises.rm(r, { recursive: true, force: true });
});

function base() {
  const b = path.join(testRunsRoot(), `driver-${randomHex(5)}`);
  fs.mkdirSync(b, { recursive: true });
  roots.push(b);
  return b;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 12_000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await sleep(50);
  }
}

function writeCountingFakeCli(dir) {
  const countFile = path.join(dir, 'fake-spawn-count.txt');
  const scriptPath = path.join(dir, 'fake-codex-noop.mjs');
  fs.writeFileSync(scriptPath, [
    "import fs from 'node:fs';",
    `const cf = ${JSON.stringify(countFile)};`,
    "const prev = fs.existsSync(cf) ? Number(fs.readFileSync(cf, 'utf8')) : 0;",
    "fs.writeFileSync(cf, String(prev + 1), 'utf8');",
    'process.exit(0);',
    '',
  ].join('\n'), 'utf8');
  return {
    scriptPath,
    spawnCount: () => (fs.existsSync(countFile) ? Number(fs.readFileSync(countFile, 'utf8')) : 0),
  };
}

test('lib/driver.mjs stays on the seat client side and never imports service, admin, or lobby', () => {
  const driverSrc = fs.readFileSync(path.join(ROOT, 'lib', 'driver.mjs'), 'utf8');
  assert.doesNotMatch(driverSrc, /['"]\.\/(service|admin|lobby|http)\.mjs['"]/);
  const serviceSrc = fs.readFileSync(path.join(ROOT, 'lib', 'service.mjs'), 'utf8');
  assert.doesNotMatch(serviceSrc, /driver\.mjs/, 'the room service never loads lib/driver.mjs');
});

test('negative gate 1: missing --model is refused before touching the CLI binary', async () => {
  assert.throws(() => validateDriveArgs({ effort: 'max' }), (e) => e instanceof CliError && /--model/.test(e.message));
  assert.throws(() => validateDriveArgs({ model: '   ', effort: 'max' }), (e) => e instanceof CliError && /--model/.test(e.message));

  const b = base();
  const roomDir = path.join(b, 'rooms', 'neg1');
  const cwdA = path.join(b, 'seats', 'A');
  fs.mkdirSync(cwdA, { recursive: true });
  await createRoom({ dir: roomDir, id: 'neg1', preset: 'discussion' });
  await addSeat({ dir: roomDir, seat: 'A', role: 'lead', agent: 'codex-cli', cwd: cwdA });
  const fake = writeCountingFakeCli(b);

  const res = await spawnClean(process.execPath, [
    ROOM_MJS, 'drive', '--seat', path.join(roomDir, 'seats', 'A'),
    '--effort', 'max', '--codex-exe', fake.scriptPath,
  ], { timeoutMs: 15_000 });
  assert.equal(res.code, 9, res.stderr);
  assert.match(res.stderr, /requires an explicit --model/);
  assert.equal(fake.spawnCount(), 0, 'fake CLI was never spawned');
});

test('negative gate 2: missing --effort is refused before touching the CLI binary', async () => {
  assert.throws(() => validateDriveArgs({ model: 'codex-test-model' }), (e) => e instanceof CliError && /--effort/.test(e.message));
  assert.throws(() => validateDriveArgs({ model: 'codex-test-model', effort: true }), (e) => e instanceof CliError && /--effort/.test(e.message));

  const b = base();
  const roomDir = path.join(b, 'rooms', 'neg2');
  const cwdA = path.join(b, 'seats', 'A');
  fs.mkdirSync(cwdA, { recursive: true });
  await createRoom({ dir: roomDir, id: 'neg2', preset: 'discussion' });
  await addSeat({ dir: roomDir, seat: 'A', role: 'lead', agent: 'codex-cli', cwd: cwdA });
  const fake = writeCountingFakeCli(b);

  const res = await spawnClean(process.execPath, [
    ROOM_MJS, 'drive', '--seat', path.join(roomDir, 'seats', 'A'),
    '--model', 'codex-test-model', '--codex-exe', fake.scriptPath,
  ], { timeoutMs: 15_000 });
  assert.equal(res.code, 9, res.stderr);
  assert.match(res.stderr, /requires an explicit --effort/);
  assert.equal(fake.spawnCount(), 0, 'fake CLI was never spawned');
});

test('negative gate 3: permission-skip flags, unsafe sandboxes, and unsupported runners are refused', async () => {
  const badArgvs = [
    ['--dangerously-skip-permissions'],
    ['--dangerously-bypass-approvals-and-sandbox'],
    ['--full-auto'],
    ['--yolo'],
    ['--ask-for-approval', 'never'],
    ['--ask-for-approval=never'],
    ['-a', 'never'],
  ];
  for (const __argv of badArgvs) {
    assert.throws(
      () => validateDriveArgs({ model: 'codex-test-model', effort: 'max', __argv }),
      (e) => e instanceof CliError && /skipping permission confirmation/.test(e.message),
      `refused ${__argv.join(' ')}`,
    );
  }
  assert.throws(
    () => validateDriveArgs({ model: 'codex-test-model', effort: 'max', 'ask-for-approval': 'never' }),
    (e) => e instanceof CliError && /--ask-for-approval/.test(e.message),
  );
  assert.throws(
    () => validateDriveArgs({ model: 'codex-test-model', effort: 'max', a: 'never' }),
    (e) => e instanceof CliError && /-a/.test(e.message),
  );
  for (const badWait of [true, false, '', '   ', 'abc', -1, NaN]) {
    assert.throws(
      () => validateDriveArgs({ model: 'codex-test-model', effort: 'max', 'wait-timeout': badWait }),
      (e) => e instanceof CliError && /--wait-timeout/.test(e.message),
      `refused --wait-timeout ${String(badWait)}`,
    );
  }
  for (const pm of ['bypassPermissions', 'bypass-permissions', 'dontAsk', 'skip', '']) {
    assert.throws(
      () => validateDriveArgs({ model: 'codex-test-model', effort: 'max', 'permission-mode': pm }),
      (e) => e instanceof CliError && /permission-mode/.test(e.message),
      `refused --permission-mode ${pm}`,
    );
  }
  assert.throws(
    () => validateDriveArgs({ model: 'codex-test-model', effort: 'max', sandbox: 'danger-full-access' }),
    (e) => e instanceof CliError && /--sandbox/.test(e.message),
  );
  assert.throws(
    () => validateDriveArgs({ model: 'codex-test-model', effort: 'max', runner: 'claude-code' }),
    (e) => e instanceof CliError && /--runner/.test(e.message),
  );

  const b = base();
  const roomDir = path.join(b, 'rooms', 'neg3');
  const cwdA = path.join(b, 'seats', 'A');
  fs.mkdirSync(cwdA, { recursive: true });
  await createRoom({ dir: roomDir, id: 'neg3', preset: 'discussion' });
  await addSeat({ dir: roomDir, seat: 'A', role: 'lead', agent: 'codex-cli', cwd: cwdA });
  const seatDir = path.join(roomDir, 'seats', 'A');
  const fake = writeCountingFakeCli(b);

  for (const extra of [
    ['--dangerously-skip-permissions'],
    ['--permission-mode', 'bypassPermissions'],
    ['--dangerously-bypass-approvals-and-sandbox'],
    ['--ask-for-approval', 'never'],
    ['--ask-for-approval=never'],
    ['-a', 'never'],
    ['--wait-timeout'],
    ['--wait-timeout', 'abc'],
    ['--sandbox', 'danger-full-access'],
    ['--runner', 'claude-code'],
  ]) {
    const res = await spawnClean(process.execPath, [
      ROOM_MJS, 'drive', '--seat', seatDir,
      '--model', 'codex-test-model', '--effort', 'max', '--codex-exe', fake.scriptPath,
      ...extra,
    ], { timeoutMs: 15_000 });
    assert.equal(res.code, 9, `${extra.join(' ')} -> ${res.stderr}`);
  }
  assert.equal(fake.spawnCount(), 0, 'fake CLI was never spawned across any forbidden flag');
});

test('buildCodexExecArgs places all options before resume <threadId> -, rejects dirty thread_id, and buildDriverChildEnv filters keys', () => {
  const first = buildCodexExecArgs({ cwd: 'D:/work/seat-b', model: 'codex-test-model', effort: 'max' });
  assert.equal(first[0], 'exec');
  assert.equal(first[first.length - 1], '-');
  assert.ok(!first.includes('resume'));

  const resumed = buildCodexExecArgs({
    cwd: 'D:/work/seat-b', model: 'codex-test-model', effort: 'max', sandbox: 'read-only', threadId: SYNTHETIC_THREAD_ID,
  });
  const resumeIdx = resumed.indexOf('resume');
  assert.ok(resumeIdx > 0, 'resume subcommand present');
  assert.deepEqual(resumed.slice(resumeIdx), ['resume', SYNTHETIC_THREAD_ID, '-'], 'nothing trails after resume <id> -');
  for (const flag of ['--json', '--sandbox', '-m', '--cd']) {
    const idx = resumed.indexOf(flag);
    assert.ok(idx >= 0 && idx < resumeIdx, `${flag} precedes resume`);
  }
  assert.ok(resumed.includes('model_reasoning_effort="max"'));
  for (const dirtyId of ['--dangerously-bypass-approvals-and-sandbox', '-a', 'id with space', '']) {
    assert.throws(
      () => buildCodexExecArgs({ cwd: 'D:/work/seat-b', model: 'codex-test-model', effort: 'max', threadId: dirtyId }),
      (e) => e instanceof CliError && /invalid codex thread_id/.test(e.message),
      `rejected dirty threadId ${dirtyId}`,
    );
  }

  const childEnv = buildDriverChildEnv({
    USERPROFILE: 'D:\\u',
    APPDATA: 'D:\\u\\Roaming',
    LOCALAPPDATA: 'D:\\u\\Local',
    CODEX_HOME: 'D:\\u\\codex',
    TMP: 'D:\\tmp',
    TEMP: 'D:\\tmp',
    TEST_FAKE_API_SECRET: 'dummy-secret-not-forwarded',
  });
  assert.equal(childEnv.CODEX_HOME, 'D:\\u\\codex');
  assert.equal(childEnv.APPDATA, 'D:\\u\\Roaming');
  assert.equal(childEnv.TMP, 'D:\\tmp');
  assert.ok(!('TEST_FAKE_API_SECRET' in childEnv));

  const parsed = parseCodexJsonOutput([
    JSON.stringify({ type: 'thread.started', thread_id: SYNTHETIC_THREAD_ID }),
    JSON.stringify({ type: 'item.completed', thread_id: '--dangerously-bypass-approvals-and-sandbox', item: { type: 'agent_message', text: '草稿一' } }),
    JSON.stringify({ type: 'thread.started', thread_id: '01a0f000-0000-7000-8000-999999999999' }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '最终发言' } }),
  ].join('\n'));
  assert.deepEqual(parsed, { threadId: SYNTHETIC_THREAD_ID, replyText: '最终发言' });

  const parsedDirtyOnly = parseCodexJsonOutput([
    JSON.stringify({ type: 'thread.started', thread_id: '--yolo' }),
    JSON.stringify({ type: 'thread.started', thread_id: 'bad space id' }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '无合法会话号仍可交卷' } }),
  ].join('\n'));
  assert.deepEqual(parsedDirtyOnly, { threadId: null, replyText: '无合法会话号仍可交卷' });
});

test('multi-turn drive with fake Codex CLI: in-turn artifacts+submit is idempotent, second turn resumes and auto-submits, ROOM_CLOSED exits 0', async () => {
  const b = base();
  const roomDir = path.join(b, 'rooms', 'drv1');
  const cwdA = path.join(b, 'seats', 'A');
  const cwdB = path.join(b, 'seats', 'B');
  fs.mkdirSync(cwdA, { recursive: true });
  fs.mkdirSync(cwdB, { recursive: true });

  await createRoom({ dir: roomDir, id: 'drv1', preset: 'implement-review', wall: 600 });
  await addSeat({ dir: roomDir, seat: 'A', role: 'lead', agent: 'generic', wait: 'background', cwd: cwdA });
  await addSeat({ dir: roomDir, seat: 'B', role: 'executor', agent: 'codex-cli', cwd: cwdB });

  const logFile = path.join(b, 'fake-codex-calls.jsonl');
  const fakeCodexPath = path.join(b, 'fake-codex.mjs');
  const seatBDir = path.join(roomDir, 'seats', 'B');
  fs.writeFileSync(fakeCodexPath, [
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    "import { spawnSync } from 'node:child_process';",
    `const logFile = ${JSON.stringify(logFile)};`,
    `const roomMjs = ${JSON.stringify(ROOM_MJS)};`,
    `const seatDir = ${JSON.stringify(seatBDir)};`,
    `const threadId = ${JSON.stringify(SYNTHETIC_THREAD_ID)};`,
    "const stdin = fs.readFileSync(0, 'utf8');",
    "const prevCalls = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\\n').filter(Boolean).length : 0;",
    'const turnNum = prevCalls + 1;',
    'fs.appendFileSync(logFile, JSON.stringify({',
    '  turnNum,',
    '  argv: process.argv.slice(2),',
    '  cwd: process.cwd(),',
    '  hasSecret: Boolean(process.env.TEST_DRIVER_FAKE_SECRET),',
    '  codexHome: process.env.CODEX_HOME || null,',
    '  tmp: process.env.TMP || null,',
    '  promptHead: stdin.slice(0, 240),',
    "}) + '\\n', 'utf8');",
    'const m = /attempt=([A-Za-z0-9_-]+)/.exec(stdin);',
    'const attemptId = m ? m[1] : null;',
    'if (turnNum === 1 && attemptId) {',
    "  fs.writeFileSync(path.join(process.cwd(), 'hello.txt'), 'governed output\\n', 'utf8');",
    "  const r1 = spawnSync(process.execPath, [roomMjs, 'artifacts', '--seat', seatDir, '--attempt', attemptId, '--declare', 'hello.txt', '--baseline', 'none'], { encoding: 'utf8', windowsHide: true });",
    "  if (r1.status !== 0) { process.stderr.write(r1.stderr || r1.stdout || 'artifacts failed'); process.exit(2); }",
    "  const sp = path.join(process.cwd(), `speech-${attemptId}.md`);",
    "  fs.writeFileSync(sp, '已完成 hello.txt 并冻结产物', 'utf8');",
    "  const r2 = spawnSync(process.execPath, [roomMjs, 'submit', '--seat', seatDir, '--attempt', attemptId, '--file', sp], { encoding: 'utf8', windowsHide: true });",
    "  if (r2.status !== 0) { process.stderr.write(r2.stderr || r2.stdout || 'submit failed'); process.exit(2); }",
    '  process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: threadId }) + "\\n");',
    '  process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "回合内已自行交卷，外层不应重复提交" } }) + "\\n");',
    '} else {',
    '  process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: threadId }) + "\\n");',
    '  process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "执行者会议回合自动交卷发言" } }) + "\\n");',
    '}',
    '',
  ].join('\n'), 'utf8');

  const room = await openRoom({ roomDir, tickMs: 40 });
  const fakeCodexHome = path.join(b, 'fake-codex-home');
  fs.mkdirSync(fakeCodexHome, { recursive: true });
  let driveChild = null;
  let driveOut = '';
  let driveErr = '';

  try {
    await room.admin('task', { text: '实现 hello.txt 并评审' });
    await room.admin('start', { order: ['A', 'B', 'A'] });

    driveChild = spawn(process.execPath, [
      ROOM_MJS, 'drive',
      '--seat', seatBDir,
      '--runner', 'codex-cli',
      '--model', 'codex-test-model',
      '--effort', 'max',
      '--codex-exe', fakeCodexPath,
    ], {
      cwd: cwdB,
      env: {
        ...process.env,
        ROOM_DEV_HOME: b,
        CODEX_HOME: fakeCodexHome,
        TMP: b,
        TEMP: b,
        TEST_DRIVER_FAKE_SECRET: 'fake-secret-must-be-stripped',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    driveChild.stdout.on('data', (c) => { driveOut += c.toString('utf8'); });
    driveChild.stderr.on('data', (c) => { driveErr += c.toString('utf8'); });

    const A = seatClient({ roomDir, seatId: 'A' });

    // B handles Work turn automatically via drive (in-turn artifacts + submit). Wait for A's first Meet turn.
    const wA1 = await until(async () => { const r = await A.wait({ once: true }); return r.status === 'TURN' ? r : null; });
    assert.ok(wA1, `A gets meet turn 1; driveOut=${driveOut} driveErr=${driveErr}`);
    assert.equal((await A.submit({ attemptId: wA1.fields.attempt, text: '开题：请执行者说明产物' })).status, 'ACCEPTED');

    // B handles Meet turn automatically via drive (resume + JSONL auto-submit). Wait for A's second Meet turn.
    const wA2 = await until(async () => { const r = await A.wait({ once: true }); return r.status === 'TURN' ? r : null; });
    assert.ok(wA2, `A gets meet turn 2; driveOut=${driveOut} driveErr=${driveErr}`);
    assert.equal((await A.submit({ attemptId: wA2.fields.attempt, text: '复核完毕' })).status, 'ACCEPTED');

    // Summary turn on A: give pass verdict on B's frozen artifact and submit summary.
    const wSum = await until(async () => { const r = await A.wait({ once: true }); return r.status === 'TURN' ? r : null; });
    assert.ok(wSum, 'A gets summary turn');
    const frozenEvt = room.events().find((e) => e.type === 'artifacts_frozen' && e.seatId === 'B');
    assert.ok(frozenEvt, 'B froze its artifact');
    assert.equal((await A.verdict({ attemptId: wSum.fields.attempt, value: 'pass', artifact: frozenEvt.manifestSha, text: '通过' })).status, 'ACCEPTED');
    assert.equal((await A.submit({ attemptId: wSum.fields.attempt, text: '汇总：全部通过' })).status, 'ACCEPTED');
    assert.ok(await until(() => room.view().phase === 'done'), 'round reached done');

    // Close the room so `drive` observes ROOM_CLOSED and exits 0.
    await room.admin('close', {});
    const exitCode = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`drive did not exit after close: out=${driveOut} err=${driveErr}`)), 10_000);
      if (driveChild.exitCode !== null) { clearTimeout(t); resolve(driveChild.exitCode); return; }
      driveChild.once('exit', (code) => { clearTimeout(t); resolve(code); });
    });
    assert.equal(exitCode, 0, `drive exit code 0 (stderr=${driveErr})`);
    assert.match(driveOut, /DRIVE_ALREADY_SUBMITTED/, 'turn 1 skipped duplicate auto-submit');
    assert.match(driveOut, /ACCEPTED/, 'turn 2 auto-submitted');
    assert.match(driveOut, /ROOM_CLOSED/, 'drive printed farewell ROOM_CLOSED');

    const rejected = room.events().filter((e) => e.type === 'submission_rejected');
    assert.deepEqual(rejected, [], 'zero duplicate/rejected submissions');
    const bMsgs = room.events().filter((e) => e.type === 'submission_accepted' && e.seatId === 'B');
    assert.equal(bMsgs.length, 2);
    assert.match(bMsgs[1].text, /执行者会议回合自动交卷发言/);

    const calls = fs.readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(calls.length, 2, 'fake Codex ran twice');
    assert.ok(!calls[0].argv.includes('resume'), 'turn 1 started a new Codex session');
    const rIdx = calls[1].argv.indexOf('resume');
    assert.ok(rIdx > 0, 'turn 2 resumed the session');
    assert.deepEqual(calls[1].argv.slice(rIdx), ['resume', SYNTHETIC_THREAD_ID, '-']);
    assert.ok(calls[1].argv.indexOf('-m') < rIdx, '-m placed before resume');
    assert.ok(calls[1].argv.indexOf('--cd') < rIdx, '--cd placed before resume');
    assert.equal(calls[0].hasSecret, false, 'arbitrary secret env stripped');
    assert.equal(calls[0].codexHome, fakeCodexHome, 'CODEX_HOME forwarded');

    const writeLines = [];
    const writeCheckCode = checkWritesMain([roomDir], { out: (l) => writeLines.push(l) });
    assert.equal(writeCheckCode, 0, writeLines.join('\n'));
  } finally {
    if (driveChild && driveChild.exitCode === null) driveChild.kill();
    await room.close();
  }
});
