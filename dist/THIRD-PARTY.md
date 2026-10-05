# 第三方组件与许可（方案 §8.7，P3 许可表）

本表随发布包一起打入 `THIRD-PARTY.md`。room-dev 自身零运行时依赖（INTERFACES 硬规则 8）；
下面是包里附带的、以及首次使用时可能按用户选择安装的组件。

| 组件 | 版本 | 许可证 | 何时进入你的机器 | 许可证全文 | 遥测 |
|---|---|---|---|---|---|
| Node.js（win-x64 运行时：`node.exe`、npm、corepack） | 由 `dist/build.mjs --node-version` 写死，见包内 `BUILD.json` 的 `node.version`；下载自 nodejs.org 并按官方 `SHASUMS256.txt` 校验 sha256 | MIT（Node.js 贡献者）；其内含的 OpenSSL、ICU、V8、libuv、zlib、npm 等各按自身许可证 | 随包附带（用 `--no-download` 构建的包不附带，启动器改用 PATH 上的 node） | 包内 `node/LICENSE`（Node.js 官方分发自带，列出全部内嵌组件） | Node.js 本身不上报；npm 在安装包时会访问 registry.npmjs.org |
| `@earendil-works/pi-coding-agent`（内置 Pi 席位，可选） | 安装时由 npm 解析；房间在安装前显示版本与 integrity 并校验 | 以该 npm 包自带的 LICENSE 为准（构建时不下载、不转述，安装时原文显示给用户） | **首次使用内置 Pi 席位时，按用户选择安装**；不选就不装，房间其他功能不受影响 | 安装后位于该包目录下的 `LICENSE` | 由该包自身决定；房间把 API key 放在内存里交给它，明文不落盘；用户选择 `admin pi-key --save` 时房间只存 DPAPI 密文（INTERFACES §9） |

## 不在包里的东西

- 用户自己的 agent（Codex、Claude Code 等）：房间不安装、不启动、不附着它们（方案 §1.6）。
- 房间自身代码：MIT（仓库根目录的 `LICENSE`），随包打入 `app/LICENSE`。

## 怎么核对

包内 `BUILD.json` 列出每个条目的 sha256；Node 运行时的来源哈希记在 `node.sha256`，
可与 `https://nodejs.org/dist/v<版本>/SHASUMS256.txt` 对照。
