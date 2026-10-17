# MyTrae 构建手册

本文档只服务于本 fork（MyTrae，基于 VS Code OSS `1.142.0`），与上游 `microsoft/vscode` 的通用开发文档相互独立。
上游的开发说明见仓库根目录的 [`CONTRIBUTING.md`](../../CONTRIBUTING.md) 与 [`README.md`](../../README.md)。

---

## 1. 环境要求

| 项 | 要求 | 说明 |
| --- | --- | --- |
| Node.js | **24.x**（`.nvmrc` 固定 `24.18.0`） | `build/npm/preinstall.ts` 会强制校验主版本号，其它主版本直接失败 |
| npm | `< 13`（当前实测 11.19.1） | preinstall 同样会校验 |
| Python | 3.x | 原生模块（node-gyp）编译需要 |
| Xcode Command Line Tools | 已安装 | macOS 下编译原生依赖需要 |
| 磁盘 | ≥ 10 GB | `node_modules` + `out*` + `.build/electron` |

### 1.1 本机（macOS / Apple Silicon）实测注意事项

以下问题在当前开发机上真实出现过，换机器时按需取用：

1. **Node 24 与系统 Node 冲突**
   通过 `brew install node@24` 安装后， keg-only，不会进入默认 `PATH`。所有构建命令前必须先：

   ```bash
   export PATH=/opt/homebrew/opt/node@24/bin:$PATH
   node -v   # 期望 v24.x
   ```

   > 安装 `node@24` 时 Homebrew 顺带升级了 `simdjson`，导致原先的 `node` 26 出现
   > `dyld: Library not loaded: .../libsimdjson.33.dylib` 而无法启动。
   > 需要恢复时执行 `brew reinstall node`。日常构建统一使用 `node@24` 即可。

2. **全局 `~/.npmrc` 里的 `allow-scripts` 会导致安装失败**
   现象：`npm ci` 报 `EALLOWSCRIPTS`。本项目不修改用户配置，改用参数绕过：

   ```bash
   npm ci --userconfig=/dev/null
   ```

3. **失效的 `GITHUB_TOKEN` 环境变量会污染依赖下载**
   现象：`@vscode/ripgrep` 的 postinstall 从 GitHub 下载二进制时返回 401。绕过方式：

   ```bash
   env -u GITHUB_TOKEN npm ci --userconfig=/dev/null
   ```

4. **Git 代理不可达**
   现象：`Failed to connect to 127.0.0.1 port 7897`。不修改用户 git 配置，按命令临时清空代理：

   ```bash
   git -c http.proxy= -c https.proxy= fetch upstream --depth 1 --tags
   ```

---

## 2. 安装依赖

```bash
export PATH=/opt/homebrew/opt/node@24/bin:$PATH
cd /Users/keen/Desktop/git/my-trae
env -u GITHUB_TOKEN npm ci --userconfig=/dev/null
```

预期结果：约 1592 个包安装完成，`postinstall` 会拉取 Electron `43.7.7` 的头文件用于编译原生模块。

---

## 3. 开发态运行（Dev 构建）

推荐的 fork 入口会准备 Electron 与内置扩展、增量编译客户端及扩展、重签 macOS Dev app 后启动。开发态禁用 GitHub Copilot 扩展：

```bash
export PATH=/opt/homebrew/opt/node@24/bin:$PATH
npm run mytrae:dev
npm run mytrae:dev -- --disable-gpu
```

分步执行（排障时更有用）：

```bash
node build/lib/preLaunch.ts   # 下载 Electron + 编译 out/ + 下载内置扩展
npm run compile               # = gulp compile（客户端）+ 编译 copilot 扩展
npm run build-fast            # 增量更新客户端和内置扩展输出
bash mytrae/tools/resign-dev-app.sh  # Electron 改名后需本地重签
```

启动后 Dev 实例的可执行文件路径由 `product.json` 的 `nameLong` / `nameShort` 推导：
`.build/electron/MyTrae - AI Code IDE.app/Contents/MacOS/MyTrae`。
**改动这两个字段后需要重新执行 `npm run electron`**，否则 `scripts/code.sh` 找不到 app。

其它入口：

```bash
./scripts/code-server.sh    # 浏览器访问的 Server 版
./scripts/code-web.sh       # Web 版
./scripts/test.sh --run <file>   # 运行单元测试
```

---

## 4. 校验与 Lint

```bash
npm run typecheck-client   # tsc -p src/tsconfig.json --noEmit --skipLibCheck（必须带 skipLibCheck，否则 OOM）
npm run eslint             # 全仓库；也可传路径：node build/eslint.ts src/vs/platform/ai
npm run stylelint          # 全仓库；也可传路径：node build/stylelint.ts src/vs/workbench/contrib/ai
npm run hygiene            # 头注释 / 缩进 / 命名等综合检查
npm run valid-layers-check # 分层依赖检查（common 不得依赖 browser 等）
npm run monaco-compile-check
npm run tsec-compile-check # CSP 相关静态检查（禁止 innerHTML 等）
```

按改动范围选择最小验证，优先检查已有任务诊断和目标测试。仅在跨模块改动、构建配置变化或编译问题需要时运行类型检查，不要把全量检查作为每次提交的固定流程。

> **代码风格约定**：单引号、Tab 缩进，但 `localize` / `localize2` 的**文案参数必须用双引号**
> （NLS 提取与规则 `local/code-no-unexternalized-strings` 都依赖这一点）。
> 因此**不要**用 Prettier 默认配置格式化本仓库代码——它会把文案也压成单引号。
> 万一被误格式化，执行修复脚本还原：
>
> ```bash
> node --experimental-strip-types mytrae/tools/restoreLocalizeQuotes.ts
> ```
>
> 面向用户的文案一律走 `localize` / `localize2`，并把模块目录登记进
> `build/lib/i18n.resources.json`（本 fork 已登记 `vs/workbench/contrib/ai`）。

---

## 5. 打包发布

打包任务定义在 [`build/gulpfile.vscode.ts`](../../build/gulpfile.vscode.ts)，命名规则为
`vscode-<platform>-<arch>[-min]`，支持的目标：

| 平台 | 架构 |
| --- | --- |
| `darwin` | `x64`、`arm64` |
| `win32` | `x64`、`arm64` |
| `linux` | `x64`、`arm64`、`armhf` |

```bash
export PATH=/opt/homebrew/opt/node@24/bin:$PATH

npm run gulp vscode                    # 当前平台/架构，未压缩
npm run gulp vscode-min                # 当前平台/架构，压缩（发布用）
npm run gulp vscode-darwin-arm64-min   # 显式指定目标

# M1 macOS arm64 一键构建、本地签名、创建并校验 DMG
npm run mytrae:package:mac
```

产物输出到**仓库的兄弟目录**（`buildRoot = dirname(root)`），例如
`/Users/keen/Desktop/git/VSCode-darwin-arm64/`，其内部为 `MyTrae - AI Code IDE.app`。

补充说明：

- `-min` 会先产出 `out-vscode-min`，再经 esbuild 打包、编译扩展、执行 `packageTask`。
- 仅做「当前平台」时可直接用 `vscode` / `vscode-min`；跨平台打包需在对应 OS 上执行。
- 本 fork 移除了 `product.defaultChatAgent`。打包链据此跳过 Copilot 扩展编译、排除历史输出并跳过 SDK shim；Dev 入口禁用该扩展。应用根目录仍保留上游 Agent Host 依赖，不代表 M4 已完成。
- `mytrae:package:mac` 对产物做 ad-hoc 本地签名并保留 V8 JIT entitlement，输出 `dist/MyTrae-<version>-darwin-arm64.dmg` 与 `.dmg.sha256`。DMG 内包含 app 与 Applications 链接，可拖入 Applications 安装。
- 尚未做 Developer ID 签名、公证或自动更新，外部分发属于 M6。进入 `dist/` 后校验：`shasum -a 256 -c MyTrae-<version>-darwin-arm64.dmg.sha256`。

---

## 6. 品牌与运行时定制

所有品牌信息集中在 [`product.json`](../../product.json)，本 fork 已改：

| 字段 | 值 |
| --- | --- |
| `nameShort` / `nameLong` | `MyTrae` / `MyTrae - AI Code IDE` |
| `applicationName` / `urlProtocol` | `mytrae` |
| `dataFolderName` | `.mytrae`（用户扩展与数据目录 `~/.mytrae`） |
| `darwinBundleIdentifier` | `com.mytrae.ide` |
| `serverApplicationName` / `tunnelApplicationName` | `mytrae-server` / `mytrae-tunnel` |
| `enableTelemetry` / `showTelemetryOptOut` | `false` / `false`（禁用核心遥测；第三方扩展有独立设置） |
| `extensionsGallery` | 指向 **Open VSX**（`https://open-vsx.org/vscode/gallery`） |
| `builtInExtensionsEnabledWithAutoUpdates` | `[]`（不再自动更新 GitHub Copilot Chat） |

品牌图标源文件为 `mytrae/branding/icon.svg`，macOS/Linux/Windows/Web 应用图标与工作台标题栏标识已替换。在 macOS 上重新生成：

```bash
# 依赖 librsvg、ImageMagick 和 macOS 自带 iconutil
npm run mytrae:icons
npm run electron
bash mytrae/tools/resign-dev-app.sh
```

后续品牌与部署事项：

- `webviewContentExternalBaseUrlTemplate` 仍指向 VS Code 的 CDN，离线/内网环境需替换为自建地址。
- 关于页文案与欢迎页（`walkthroughs`、`welcomePage` 相关字段）。

---

## 7. AI 功能：配置与使用

### 7.1 配置 API Key

命令面板执行 **`MyTrae: Set Provider API Key`** → 选择服务商 → 粘贴 Key。
Key 经 `IEncryptionService`（macOS Keychain / Electron safeStorage）加密后写入
应用级存储，**不会**出现在 `settings.json` 中。同一命令可替换或删除已存的 Key。

内置服务商预设（`src/vs/platform/ai/common/modelCatalog.ts`）：
OpenAI、Anthropic、DeepSeek（默认）、通义千问、Moonshot、智谱、Ollama、LM Studio。
其中 Ollama / LM Studio 为本地服务，无需 Key。

### 7.2 主要设置项（`settings.json`，前缀 `myTrae.`）

| 设置 | 默认值 | 说明 |
| --- | --- | --- |
| `myTrae.provider` | `deepseek` | 服务商预设，决定默认 baseUrl 与模型 |
| `myTrae.baseUrl` | `""` | 覆盖预设 baseUrl；OpenAI 兼容端点需带 `/v1` |
| `myTrae.model` | 跟随预设 | 对话模型 |
| `myTrae.completionModel` | `""` | 行内补全模型，留空复用对话模型 |
| `myTrae.agentModel` | `""` | 智能体模型，留空复用对话模型 |
| `myTrae.temperature` | `0.2` | 采样温度 |
| `myTrae.maxTokens` | `4096` | 单次响应上限 |
| `myTrae.embedding.*` | — | 代码库索引用的 embedding 端点（Anthropic 无 embeddings，必须单独配置） |
| `myTrae.completion.*` | — | 补全开关、防抖、前缀行数等 |
| `myTrae.agent.*` | — | 智能体最大步数等 |
| `myTrae.indexing.enabled` | — | 代码库索引开关 |

### 7.3 会话数据

对话会话以 JSONL 持久化在
`<userRoamingDataHome>/mytrae/chat-sessions.jsonl`
（macOS 为 `~/Library/Application Support/MyTrae - AI Code IDE/mytrae/chat-sessions.jsonl`），
最多保留 50 个会话，写入带防抖。

---

## 8. 代码结构（本 fork 新增部分）

```
src/vs/platform/ai/common/          # 平台层：不依赖 workbench / DOM
├── ai.ts                           # 全部对外契约：ILLMService、IAICredentialsService、消息与流式类型
├── aiTransport.ts                  # HTTP 传输（复用 IRequestService，继承系统代理与 TLS 设置）
├── sseStream.ts                    # SSE 事件流（复用上游 base/common/sseParser.ts）
├── openaiCompatibleProvider.ts     # OpenAI 兼容 Provider，含 FIM 补全与 tool_calls 增量
├── anthropicProvider.ts            # Anthropic messages API Provider
├── modelCatalog.ts                 # 内置服务商 / 模型预设
├── aiConfiguration.ts              # 配置项枚举与读取（含预设回退）
├── streamAggregator.ts             # 流式 → 完整响应聚合
└── llmService.ts                   # LLMService：并发闸门 + 指数退避重试 + 端点解析

src/vs/workbench/contrib/ai/
├── common/
│   ├── aiChat.ts                   # IAIChatService 与会话/上下文类型
│   └── prompts.ts                  # 系统提示词与上下文拼装
└── browser/
    ├── ai.contribution.ts          # 组装根：视图容器、命令、设置、单例注册
    ├── aiChatService.ts            # 会话管理 + 流式接收 + JSONL 持久化
    ├── aiChatView.ts               # 侧边栏对话面板（纯 DOM，不使用 innerHTML）
    ├── aiCredentialsService.ts     # API Key 加密存储
    └── media/aiChat.css
```

设计约束（改动时请遵守）：

- `platform/ai/common` 保持零 workbench 依赖，便于在 Server / CLI / Web 各层复用。
- 所有服务通过 `createDecorator` + `registerSingleton(..., InstantiationType.Delayed)` 注册。
- 视图渲染禁止 `innerHTML`（`tsec-compile-check` 会拦截），统一用 `textContent` 与 `DOM.append`。
- 补全与交互请求使用**独立**的并发闸门（补全 2 / 交互 3），重试只在收到首个 token 前发生。

---

## 9. 与上游同步

本仓库以浅历史方式引入上游 tag，`upstream` 指向 `microsoft/vscode`：

```bash
git remote -v                                    # upstream -> https://github.com/microsoft/vscode.git
git -c http.proxy= -c https.proxy= fetch upstream --depth 1 tag 1.143.0
git checkout -b upgrade/1.143.0 FETCH_HEAD       # 或 cherry-pick / rebase 本 fork 的提交
```

**上游修改面（升级时检查）**：

| 文件 | 改动 |
| --- | --- |
| `product.json` | 品牌、遥测、扩展市场 |
| `src/vs/workbench/workbench.common.main.ts` | 末尾新增一行 `import './contrib/ai/browser/ai.contribution.js';` |
| `build/lib/i18n.resources.json` | 新增 `vs/workbench/contrib/ai` 条目 |
| `build/gulpfile.vscode.ts` | 无默认 Chat Agent 时跳过 Copilot 编译、输出与 shim |
| `src/vs/base/common/product.ts` 与账号、引导、扩展管理、Chat 状态相关模块 | 兼容没有默认 Chat Agent 的 OSS 产品 |
| `package.json` | fork 的 Dev、图标、打包入口 |
| `resources/**`、工作台 `code-icon.svg` | 品牌资源 |

fork 功能代码主要为新增文件（`src/vs/platform/ai/**`、`src/vs/workbench/contrib/ai/**`、`mytrae/**`）。升级时保持「新增为主、改动最小」的形态。已有工作台入口的全文件格式差异应单独审查，不混入功能修改。

---

## 10. 常见问题速查

| 现象 | 原因 / 处理 |
| --- | --- |
| `Please use Node.js v24.18.0 or newer with the same major version (24)` | Node 主版本不对，`export PATH=/opt/homebrew/opt/node@24/bin:$PATH` |
| `EALLOWSCRIPTS` | 全局 npmrc 的 `allow-scripts`，加 `--userconfig=/dev/null` |
| `@vscode/ripgrep` 下载 401 | 环境变量 `GITHUB_TOKEN` 失效，用 `env -u GITHUB_TOKEN` |
| `dyld: libsimdjson.33.dylib` | 系统 node 26 损坏，改用 node@24 或 `brew reinstall node` |
| `Failed to connect to 127.0.0.1 port 7897` | git 代理不可达，命令级加 `-c http.proxy= -c https.proxy=` |
| tsc `JavaScript heap out of memory` | 缺少 `--skipLibCheck`，用 `npm run typecheck-client` |
| `scripts/code.sh` 报找不到 app | 改过 `product.json` 的 `nameLong`/`nameShort`，重跑 `npm run electron` |
| ESLint 报大量 `code-no-unexternalized-strings` | 文件被 Prettier 改成双引号，改回单引号（见 §4） |
| 文案丢失翻译 / NLS 提取为空 | `localize` 的文案被改成单引号，跑 `mytrae/tools/restoreLocalizeQuotes.ts` |
| Stylelint 报 `Unknown variable` | 使用了未登记的 CSS 变量，改用 `build/lib/stylelint/vscode-known-variables.json` 中的变量 |

## 11. M1 运行验收

使用独立的 `--user-data-dir`、`--extensions-dir`、`--shared-data-dir` 与未占用的 `--remote-debugging-port` 启动待测应用，目录参数使用绝对路径。Dev 使用仓库 launch 技能或上文 fork 入口；打包版从挂载 DMG 复制出的 app 启动。Electron GUI 进程需移除环境变量 `ELECTRON_RUN_AS_NODE`。

```bash
# 对已启动的独立测试实例检查工作台和 MyTrae Chat 并截屏
node mytrae/tools/smoke.mjs http://127.0.0.1:<port> .agent-validation/m1/workbench.png

# --run 接受模块名；通配必须使用 --runGlob
env -u ELECTRON_RUN_AS_NODE bash scripts/test.sh --runGlob '**/ai/test/common/*.test.js'
```

部分网络环境需要单次显式设置代理，例如 `NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:<port> HTTP_PROXY=http://127.0.0.1:<port> npm run mytrae:package:mac`。Electron 下载即使命中压缩包缓存，也会联网读取校验和，不需要关闭校验。

本次结果见 [M1 验收记录](M1-ACCEPTANCE.md)。

## Pi Agent（2026-10-17）

桌面 Agent 使用锁定的 Pi SDK 1.3.0；详细配置和功能边界见 [PI-AGENT.md](PI-AGENT.md)。`build/next/index.ts` 增加 `vs/platform/ai/node/piAgentMain` 打包入口，`workbench.desktop.main.ts` 注册桌面代理；Web 仍保留原 Chat 服务。Pi 主循环仅在 utility process 运行，原 LLM 服务用于补全，桌面 Chat 不再另存一份历史。

```bash
npm run build-fast -- --client-only
env -u ELECTRON_RUN_AS_NODE bash scripts/test.sh --runGlob 'vs/{platform/ai,workbench/contrib/ai}/test/{common,browser}/**/*.test.js'
env -u ELECTRON_RUN_AS_NODE bash scripts/test.sh --run vs/workbench/contrib/ai/test/electron-browser/piAgentService.test
npm run typecheck-client
npm run eslint -- src/vs/platform/ai src/vs/workbench/contrib/ai
```

Node Host 与网页网络边界测试使用真实 Pi SDK 和确定性 HTTP 服务，单独使用 Node 测试入口运行，避免把 Node SDK 导入浏览器。安装包仍运行 `npm run mytrae:package:mac`；运行打包后的程序需再次验证 Pi utility process 能加载生产依赖。
