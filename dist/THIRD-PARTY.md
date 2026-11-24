# Third-Party Components & Licenses

This table is included in release packages as `THIRD-PARTY.md`. `AgentRoundtable` (`room-dev`) itself has **zero runtime npm dependencies**; below are components optionally bundled in distribution packages or installed on demand by the user.

| Component | Version | License | When Installed | License Text | Telemetry / Network |
|---|---|---|---|---|---|
| **Node.js** (win-x64 runtime: `node.exe`, npm, corepack) | Pinned via `dist/build.mjs --node-version` (recorded in `BUILD.json` as `node.version`), verified against official nodejs.org `SHASUMS256.txt` | MIT (Node.js contributors); bundled OpenSSL, ICU, V8, libuv, zlib, and npm under their respective licenses | Bundled in full Windows ZIP packages (omitted with `--no-download`, which uses `node` from `PATH`) | `node/LICENSE` inside the package | Node.js sends no telemetry; `npm` contacts `registry.npmjs.org` only when installing packages |
| **`@earendil-works/pi-coding-agent`** (optional built-in hosted Pi seat) | Resolved by `npm` on opt-in install with version and integrity check | License shipped with that npm package (displayed verbatim on opt-in install) | **Only if you opt in** to hosted Pi seats; omitted otherwise with no impact on embedded seats | `LICENSE` inside the installed package directory | Governed by the package; room supplies API keys in memory only (or Windows DPAPI ciphertext if you explicitly run `admin pi-key --save`) |

## Excluded & First-Party Code

- **Your coding agents** (Codex, Claude Code, Antigravity, Gemini CLI, etc.): never installed, launched, or bundled by `AgentRoundtable`.
- **AgentRoundtable source**: MIT License (repository root `LICENSE`).

## Verification

`BUILD.json` in every packaged release lists the SHA-256 checksum of every bundled file. Compare `node.sha256` against `https://nodejs.org/dist/v<version>/SHASUMS256.txt`.
