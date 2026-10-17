# M1 验收记录

日期：2026-10-17。环境：macOS arm64、Node 24.22.0；上游基线 tag `1.142.0`，commit `d956e8a6ac5d904486557eea07e1d6bd62a4d36f`。按原方案的 M1 标准，本机验收通过。

| 验收项 | 结果与证据 |
| --- | --- |
| Dev 可构建、可运行 | `npm run mytrae:dev`，使用独立 profile；工作台与 MyTrae Chat 自动化检查通过，见 `.agent-validation/m1/dev-entry.log`、`dev-smoke.log`、`dev.png` |
| macOS 安装包 | `npm run mytrae:package:mac` 完整执行上游 `vscode-darwin-arm64`，创建 DMG 并通过 `hdiutil verify` |
| 安装后的应用可运行 | 只读挂载 DMG，用 `ditto` 复制 app 到独立测试目录后卸载镜像；使用全新 profile 启动复制出的 app，工作台与 MyTrae Chat 检查通过，见 `package-smoke.log`、`packaged.png` |
| 名称、图标、身份 | 可执行名 `MyTrae`，Bundle ID `com.mytrae.ide`；产物 `MyTrae.icns` 与仓库品牌图标逐字节一致 |
| 产品配置 | 产物核心遥测为 `false`，市场为 Open VSX，不含内置 Copilot 扩展；见 `artifact-validation.json` |
| 本地签名 | `codesign --verify --deep --strict` 通过，并验证保留 V8 JIT entitlement |
| 回归测试 | 相关账号、引导、扩展管理、connectors 测试 417 passing；AI 目标测试 73 passing |
| 类型、静态检查 | `npm run typecheck-client` 通过；本轮 19 个 TS 文件目标 lint 通过；shell 语法及 `git diff --check` 通过 |

上述日志和截图均在仓库已忽略的 `.agent-validation/m1/` 中，测试 profile 与临时 app 副本在验收后清理。新增回归覆盖：无默认账号时账号 API 不挂起、无默认 Agent 时不弹登录引导、无默认 Agent 时搜索与卸载扩展。已验证删除兼容保护后扩展测试失败，恢复后通过。

## 安装包

- 路径：[MyTrae-1.142.0-darwin-arm64.dmg](../../dist/MyTrae-1.142.0-darwin-arm64.dmg)
- 文件大小：396015511 bytes（约 378 MiB）。
- SHA-256：`94fc2018da85000903633b6489723a10fcf5973a3705019707f9ea2a8099f928`
- 安装：打开 DMG，将 `MyTrae - AI Code IDE.app` 拖入 Applications。
- 重新构建和验收命令见 [构建手册](BUILD.md)。

## 修正的阻塞项

1. `myTrae.ai.focus` 同时由显式 Action 与视图描述注册，导致工作台启动失败。现在由视图描述统一注册。
2. 上游打包强制准备 Copilot SDK shim，但其扩展依赖被打包过滤。本产品没有默认 Copilot，故按产品配置跳过该扩展编译、旧输出与 shim。
3. 删除默认 Copilot 配置后，上游欢迎引导、默认账号及扩展管理有必填假设。现在产品契约允许没有默认 Agent，账号服务及时返回空结果，引导及 Chat 状态安全跳过，扩展搜索与卸载正常工作。
4. macOS Electron 改名会破坏签名；Dev 和 DMG 入口统一重用保留 JIT entitlement 的本地签名脚本。

## 里程碑边界

| 里程碑 | 当前状态 |
| --- | --- |
| M1 基座 | 本机 macOS arm64 的 Dev、品牌和 DMG 安装验收通过 |
| M2 LLM + Chat | 已有 Provider、凭据存储和自有 Chat 代码；本轮未用真实模型请求验收，也未完成全部上下文引用与 Apply 验收 |
| M3–M5 | 尚未按原方案完成补全、Agent、RAG 的端到端验收 |
| M6 发布 | 仍需 Developer ID 签名、公证、更新与团队分发验证 |

Windows/Linux/Web 图标已生成，本轮仅验证 macOS 可执行产物。上游 Chat/Agents 入口和 Agent Host 依赖仍保留；运行时可见 `Unknown channel: agentHostClientProxy` 等调试输出，本轮没有验证其 Agent 流程。已有主入口文件的大段格式差异与用户未提交的 AI 实现一并保留，未自动提交或推送。
