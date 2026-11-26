// Locating codex(.exe) and gating Windows native queue compatibility without ever running a batch shim.
// Every child process goes through lib/spawn.mjs (single-door spawn invariant).
// Resolution order (all acceptable candidates tried in order on Windows so an older Desktop binary
// does not shadow a newer npm-installed @openai/codex):
//   1. CODEX_CLI_PATH env var (real executable, or npm vendor binary next to a Windows shim)
//   2. CODEX_CLI_PATH in $CODEX_HOME/config.toml (real executable, or npm vendor binary next to a Windows shim)
//   3. Codex Desktop bin directory (newest hash dir on Windows; app bundle / Application Support on macOS)
//   4. PATH real executable (.exe/.com on Windows; executable regular file on POSIX)
//   5. Windows npm vendor native binary (@openai/codex-win32-<arch>/vendor/<target>/bin/codex.exe)
//      under PATH directories and %APPDATA%\npm — bypassing codex.cmd shims cleanly.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { buildCleanEnv, spawnClean } from './spawn.mjs';

export const MIN_WIN_CODEX_QUEUE_VERSION = '0.157.0';
export const CODEX_PROBE_TIMEOUT_MS = 10_000;
const MIN_WIN_PARTS = Object.freeze([0, 157, 0]);
const WIN_ARCH_TARGETS = Object.freeze({
  x64: 'x86_64-pc-windows-msvc',
  arm64: 'aarch64-pc-windows-msvc',
});
// Non-secret platform dirs occasionally needed by codex --version on top of ENV_WHITELIST.
const PROBE_EXTRA_KEYS = Object.freeze(['LOCALAPPDATA', 'USERPROFILE', 'CODEX_HOME', 'HOME', 'XDG_CONFIG_HOME', 'TMPDIR']);

function envGet(env, key, platform = process.platform) {
  if (!env || typeof env !== 'object') return undefined;
  if (env[key] !== undefined) return env[key];
  if (platform !== 'win32') return undefined;
  const upper = key.toUpperCase();
  for (const k of Object.keys(env)) if (k.toUpperCase() === upper && env[k] !== undefined) return env[k];
  return undefined;
}

function cleanPathToken(v) {
  if (typeof v !== 'string') return '';
  return v.trim().replace(/^"(.*)"$/, '$1').trim();
}

// Build a strictly whitelisted environment for probing `codex --version` so parent API keys
// (ROOM_PI_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY, etc.) are NEVER passed to the child.
export function buildCodexProbeEnv(baseEnv = process.env, platform = process.platform) {
  const extra = {};
  for (const k of PROBE_EXTRA_KEYS) {
    const val = envGet(baseEnv, k, platform);
    if (val !== undefined && val !== '') extra[k] = val;
  }
  return buildCleanEnv(extra, baseEnv || {});
}

// An existing regular file; on Windows also an .exe/.com extension (never .cmd/.bat shims),
// and on POSIX checked for execute permission (X_OK).
export function acceptableExe(p, { platform = process.platform, isFile } = {}) {
  const clean = cleanPathToken(p);
  if (!clean) return false;
  const P = platform === 'win32' ? path.win32 : path.posix;
  if (platform === 'win32' && !['.exe', '.com'].includes(P.extname(clean).toLowerCase())) return false;
  if (typeof isFile === 'function') return !!isFile(clean);
  try {
    if (!fs.statSync(clean).isFile()) return false;
    if (platform !== 'win32') fs.accessSync(clean, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// Native Windows vendor codex.exe paths beneath an npm prefix / bin directory.
export function npmVendorCodexCandidates(dir, { platform = process.platform, arch = process.arch } = {}) {
  if (platform !== 'win32' || typeof dir !== 'string' || !dir.trim()) return [];
  const target = WIN_ARCH_TARGETS[arch];
  if (!target) return [];
  const clean = cleanPathToken(dir);
  if (!clean) return [];
  const winPkg = `codex-win32-${arch}`;
  return [
    path.win32.join(clean, 'node_modules', '@openai', 'codex', 'node_modules', '@openai', winPkg, 'vendor', target, 'bin', 'codex.exe'),
    path.win32.join(clean, 'node_modules', '@openai', winPkg, 'vendor', target, 'bin', 'codex.exe'),
  ];
}

// Minimal, read-only TOML probe: the first `CODEX_CLI_PATH = "..."` (basic string, backslash
// escapes) or `CODEX_CLI_PATH = '...'` (literal string) line, in any table. No TOML dependency.
export function codexPathFromConfig(configPath) {
  let text;
  try { text = fs.readFileSync(configPath, 'utf8'); } catch { return null; }
  for (const line of text.split(/\r?\n/)) {
    const basic = /^\s*CODEX_CLI_PATH\s*=\s*"((?:[^"\\]|\\.)*)"\s*(?:#.*)?$/.exec(line);
    if (basic) {
      return basic[1].replace(/\\(u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|.)/g, (_, c) => {
        if (c[0] === 'u' || c[0] === 'U') return String.fromCodePoint(parseInt(c.slice(1), 16));
        return { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' }[c] ?? c;
      });
    }
    const literal = /^\s*CODEX_CLI_PATH\s*=\s*'([^']*)'\s*(?:#.*)?$/.exec(line);
    if (literal) return literal[1];
  }
  return null;
}

function shimAdjacentCandidates(rawPath, { platform, arch }) {
  if (platform !== 'win32' || !rawPath) return [];
  const baseName = path.win32.basename(rawPath).toLowerCase();
  if (baseName !== 'codex' && baseName !== 'codex.cmd' && baseName !== 'codex.ps1') return [];
  return npmVendorCodexCandidates(path.win32.dirname(rawPath), { platform, arch });
}

// Return all acceptable codex executable paths in priority order (deduplicated).
export function findCodexCandidates({ env = process.env, platform = process.platform, arch = process.arch, isFile } = {}) {
  const win = platform === 'win32';
  const P = win ? path.win32 : path.posix;
  const ok = (p) => acceptableExe(p, { platform, isFile });
  const out = [];
  const seen = new Set();
  const add = (p) => {
    const clean = cleanPathToken(p);
    if (!clean || !ok(clean)) return;
    const key = win ? clean.toLowerCase() : clean;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(clean);
  };

  const fromEnv = cleanPathToken(envGet(env, 'CODEX_CLI_PATH', platform));
  add(fromEnv);
  for (const c of shimAdjacentCandidates(fromEnv, { platform, arch })) add(c);

  const fromConfig = cleanPathToken(codexPathFromConfig(path.join(codexHome(env, platform), 'config.toml')));
  add(fromConfig);
  for (const c of shimAdjacentCandidates(fromConfig, { platform, arch })) add(c);

  if (win) {
    const local = envGet(env, 'LOCALAPPDATA', platform) || path.join(os.homedir(), 'AppData', 'Local');
    const base = path.join(local, 'OpenAI', 'Codex', 'bin');
    let dirs = [];
    try { dirs = fs.readdirSync(base); } catch { /* not installed through the Desktop app */ }
    const desktop = [];
    for (const d of dirs) {
      const exe = path.join(base, d, 'codex.exe');
      if (ok(exe)) {
        let mtime = 0;
        try { mtime = fs.statSync(exe).mtimeMs; } catch { /* synthetic isFile */ }
        desktop.push({ exe, mtime });
      }
    }
    desktop.sort((a, b) => b.mtime - a.mtime);
    for (const item of desktop) add(item.exe);
  } else if (platform === 'darwin') {
    const home = envGet(env, 'HOME', platform) || os.homedir();
    for (const p of [
      '/Applications/Codex.app/Contents/Resources/codex',
      path.posix.join(home, 'Library', 'Application Support', 'OpenAI', 'Codex', 'bin', 'codex'),
    ]) {
      add(p);
    }
  }

  // Real executable on PATH (skips .cmd/.bat shims on Windows, checks X_OK on POSIX,
  // strips quotes, and collects every matching directory so fallback candidates are preserved).
  if (typeof isFile === 'function' || platform === process.platform) {
    const rawPath = envGet(env, 'PATH', platform) || '';
    const sep = win ? ';' : ':';
    const exts = win ? ['.exe', '.com'] : [''];
    for (const rawDir of String(rawPath).split(sep)) {
      const dir = cleanPathToken(rawDir);
      if (!dir) continue;
      for (const ext of exts) add(P.join(dir, `codex${ext}`));
    }
  }

  // Windows npm-installed native vendor binary fallback (bypasses codex.cmd shims).
  if (win) {
    const rawPath = envGet(env, 'PATH', platform) || '';
    const dirs = String(rawPath).split(';').map(cleanPathToken).filter(Boolean);
    const appData = envGet(env, 'APPDATA', platform);
    if (appData) dirs.push(path.win32.join(appData, 'npm'));
    const seenDirs = new Set();
    for (const dir of dirs) {
      const key = dir.toLowerCase();
      if (seenDirs.has(key)) continue;
      seenDirs.add(key);
      for (const c of npmVendorCodexCandidates(dir, { platform, arch })) add(c);
    }
  }

  return out;
}

// findCodex({ env, platform, arch, isFile }) -> highest-priority absolute path or null.
export function findCodex(opts = {}) {
  const candidates = findCodexCandidates(opts);
  return candidates.length ? candidates[0] : null;
}

export function codexHome(env = process.env, platform = process.platform) {
  return envGet(env, 'CODEX_HOME', platform) || path.join(os.homedir(), '.codex');
}

// Parse `codex --version` stdout (supports prerelease and +build metadata).
export function parseCodexVersion(output) {
  const m = /^\s*codex-cli\s+(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?\s*$/m.exec(String(output || ''));
  if (!m) return null;
  const parts = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (!parts.every((n) => Number.isSafeInteger(n) && n >= 0)) return null;
  return { version: `${parts[0]}.${parts[1]}.${parts[2]}`, parts };
}

export function compareSemver(a, b) {
  for (let i = 0; i < 3; i++) {
    const x = Number(a[i] || 0);
    const y = Number(b[i] || 0);
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

function evaluateWindowsProbe(exe, probeRes) {
  if (probeRes.timedOut) {
    return {
      state: 'blocked',
      reason: 'windows_codex_version_probe_timeout',
      executable: exe,
      version: null,
      transient: true,
    };
  }
  if (!probeRes.ok) {
    return {
      state: 'blocked',
      reason: 'windows_codex_version_probe_failed',
      executable: exe,
      version: null,
      transient: true,
    };
  }
  const parsed = parseCodexVersion(probeRes.output);
  if (!parsed) {
    return {
      state: 'blocked',
      reason: 'windows_codex_version_unreadable',
      executable: exe,
      version: null,
      transient: false,
    };
  }
  if (compareSemver(parsed.parts, MIN_WIN_PARTS) < 0) {
    return {
      state: 'blocked',
      reason: `windows_codex_version_below_minimum:${parsed.version}`,
      executable: exe,
      version: parsed.version,
      transient: false,
    };
  }
  return { state: 'ok', reason: null, executable: exe, version: parsed.version, transient: false };
}

async function runVersionProbe(exe, { env = process.env, platform = process.platform, spawn = spawnClean, probe, timeoutMs = CODEX_PROBE_TIMEOUT_MS } = {}) {
  if (typeof probe === 'function') {
    try {
      const raw = await probe(exe);
      if (raw && typeof raw === 'object') {
        return { ok: !!raw.ok, output: raw.output ?? raw.stdout ?? '', timedOut: !!raw.timedOut };
      }
      if (raw === null || raw === undefined) return { ok: false, output: '', timedOut: false };
      return { ok: true, output: String(raw), timedOut: false };
    } catch {
      return { ok: false, output: '', timedOut: false };
    }
  }
  try {
    const extra = {};
    for (const k of PROBE_EXTRA_KEYS) {
      const val = envGet(env, k, platform);
      if (val !== undefined && val !== '') extra[k] = val;
    }
    const r = await spawn(exe, ['--version'], {
      env: extra,
      source: env || process.env,
      timeoutMs,
      maxOutputBytes: 16 * 1024,
    });
    if (r && r.timedOut) return { ok: false, output: '', timedOut: true };
    if (r && r.code === 0 && !r.spawnError) return { ok: true, output: String(r.stdout || ''), timedOut: false };
    return { ok: false, output: '', timedOut: false };
  } catch {
    return { ok: false, output: '', timedOut: false };
  }
}

// Async version gate via `spawnClean`.
// Windows enforces >= 0.157.0 (fail-closed) because earlier Windows builds lack native queue support.
// POSIX has no minimum-version gate and never blocks wake on an extra `--version` probe.
export async function checkCodexQueueGate({
  exe,
  env = process.env,
  platform = process.platform,
  spawn = spawnClean,
  probe,
  timeoutMs = CODEX_PROBE_TIMEOUT_MS,
} = {}) {
  const clean = cleanPathToken(exe);
  if (!clean) {
    return { state: 'blocked', reason: 'codex_executable_unresolved', executable: null, version: null, transient: false };
  }
  if (platform !== 'win32') {
    let version = null;
    if (typeof probe === 'function') {
      const res = await runVersionProbe(clean, { env, platform, spawn, probe, timeoutMs });
      if (res.ok) {
        const parsed = parseCodexVersion(res.output);
        if (parsed) version = parsed.version;
      }
    }
    return { state: 'ok', reason: null, executable: clean, version, transient: false };
  }
  const probeRes = await runVersionProbe(clean, { env, platform, spawn, probe, timeoutMs });
  return evaluateWindowsProbe(clean, probeRes);
}

// Alias preserved for callers expecting the explicit Async name.
export const checkCodexQueueGateAsync = checkCodexQueueGate;

// Walk all discovered candidates and return the first eligible Codex executable (so an older
// Codex Desktop install does not shadow a newer npm global `@openai/codex` install on Windows).
export async function resolveEligibleCodex({
  env = process.env,
  platform = process.platform,
  arch = process.arch,
  isFile,
  spawn = spawnClean,
  probe,
  timeoutMs = CODEX_PROBE_TIMEOUT_MS,
} = {}) {
  const candidates = findCodexCandidates({ env, platform, arch, isFile });
  if (!candidates.length) {
    return { state: 'unconfigured', reason: 'codex_executable_not_found', executable: null, version: null, transient: false, checked: 0 };
  }
  if (platform !== 'win32') {
    const res = await checkCodexQueueGate({ exe: candidates[0], env, platform, spawn, probe, timeoutMs });
    return { ...res, checked: 1 };
  }
  let firstBlocked = null;
  let firstTransient = null;
  for (let i = 0; i < candidates.length; i += 1) {
    const res = await checkCodexQueueGate({ exe: candidates[i], env, platform, spawn, probe, timeoutMs });
    if (res.state === 'ok') return { ...res, checked: i + 1 };
    if (!firstBlocked) firstBlocked = res;
    if (res.transient && !firstTransient) firstTransient = res;
  }
  return { ...(firstTransient || firstBlocked), checked: candidates.length };
}

// Single shared status helper used by `lib/doctor.mjs` and `lib/service.mjs`.
export const codexWakeStatus = resolveEligibleCodex;
