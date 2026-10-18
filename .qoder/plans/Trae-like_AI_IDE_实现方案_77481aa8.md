# Trae-like AI IDE 实现方案（基于 VS Code OSS Fork）

## 1. 技术选型与总体架构

**基座**：Fork `microsoft/vscode`（锁定一个稳定 release tag，如 1.9x.x），构建基于其自带 gulp 流水线。

**架构分层**（自底向上）：

```
┌─────────────────────────────────────────────┐
│  Workbench UI 层（深度定制）                  │
│  AI Chat 面板 / Agent 面板 / Diff 预览 / 状态栏 │
├─────────────────────────────────────────────┤
│  AI 能力层（新增 workbench contrib）           │
│  InlineCompletion / Chat / Agent / Apply     │
├─────────────────────────────────────────────┤
│  AI 核心服务层（新增 service）                 │
│  LLM Provider 抽象 / 上下文引擎 / 工具执行器    │
├─────────────────────────────────────────────┤
│  索引层（独立 utility process）                │
│  文件监听 / tree-sitter 分块 / 向量检索         │
├─────────────────────────────────────────────┤
│  VS Code OSS 内核（尽量不改，保持可同步上游）    │
└─────────────────────────────────────────────┘
```

**核心原则**：所有 AI 功能放在 `src/vs/workbench/contrib/ai/` 新目录下，遵循 VS Code 的 contribution/service 注册机制，最大限度不改动上游文件，保证后续可 rebase 同步官方更新。

## 2. 仓库与代码组织

- 单仓库 monorepo：`my-trae` 初始化为 vscode fork（`git remote add upstream microsoft/vscode`，上游同步走独立分支 `main-vendor` 定期 merge/tag）
- 新增目录规划：
  - `src/vs/workbench/contrib/ai/browser/` — Chat 面板、Agent 面板、Diff 应用 UI
  - `src/vs/workbench/contrib/ai/common/` — 类型定义、prompt 模板、协议
  - `src/vs/workbench/contrib/ai/electron-sandbox/` — 索引进程、Key 安全存储
  - `src/vs/platform/ai/` — LLM Provider 抽象、模型注册表（platform 层 service）
  - `extensions/ai-core/` — 备选：若某功能用扩展 API 即可实现，优先放扩展（降低侵入）
- `product.json` 定制：产品名、图标、内置扩展白名单、去除微软遥测与官方扩展市场绑定（改用 Open VSX 或自建市场）

## 3. 关键子系统设计

### 3.1 LLM 接入层（用户直连多模型）
- 新增 `ILLMService`（platform service），Provider 适配器模式：`OpenAICompatibleProvider`（覆盖 OpenAI/DeepSeek/Qwen/Moonshot 等）+ `AnthropicProvider`，SSE 流式解析统一为增量 token 事件
- 模型注册表：内置模型清单（id、context window、价格、能力标签），用户可自定义 endpoint/model
- API Key 管理：Electron `safeStorage` 加密后存 `storage.json`，绝不落明文；设置页提供配置 UI
- 请求管理：并发队列、指数退避重试、按功能路由模型（补全用快模型、Agent 用强模型）

### 3.2 代码补全（Inline Completion）
- 实现 `InlineCompletionsProvider` 注册到 VS Code 内建补全通道（复用原生 ghost text UI 与接受逻辑，零 UI 改造成本）
- 上下文组装：光标前后 N 行 + 同文件相关片段 + 最近编辑历史 + LSP 符号摘要；通过 RAG 补充跨文件 import 相关片段
- 性能：300ms 防抖 + 请求取消（新按键即 abort）+ 本地结果缓存；补全请求与 Chat 请求走独立队列互不阻塞

### 3.3 AI 对话面板（Chat）
- WebviewView 挂在侧边栏（React 或原生 DOM，MVP 建议原生 DOM 减少构建复杂度），支持 Markdown/代码高亮渲染
- 上下文引用：`@文件`、`#选区`、`@代码库`（触发 RAG），聊天可读取当前编辑器状态
- Apply 能力：回复中的代码块提供「插入」「应用 Diff」按钮；Diff 应用走独立服务：模型生成 → 与当前文件做 fuzzy 匹配定位 → 内嵌 diff 编辑器预览 → 用户确认后写入
- 会话持久化：本地 JSONL 存储，可恢复历史

### 3.4 智能体模式（Agent/Builder）
- ReAct 循环：LLM tool-calling → 工具执行 → 结果回填 → 直到完成或用户中断
- 内置工具集（每个工具独立、可测试）：
  - `read_file` / `list_dir` / `search_code`（走索引层）
  - `write_file` / `edit_file`（diff 模式，需用户确认，可配置自动批准策略）
  - `run_terminal_command`（复用 VS Code 终端 service，默认逐条确认，危险命令黑名单 + 确认 UI）
  - `get_diagnostics`（读取 LSP 报错，支撑"自动修复编译错误"闭环）
- 安全机制：所有写操作默认确认门；每次 Agent 会话前创建 checkpoint（git stash 或快照目录），支持一键回滚
- 执行过程 UI：步骤流（thought/action/observation）可视化，支持中途插话纠偏

### 3.5 代码库索引与 RAG
- 独立 Electron utility process 运行索引，避免阻塞 UI 线程
- 流程：文件 watcher（复用 VS Code file watcher）→ tree-sitter 按 AST 分块（函数/类粒度，fallback 滑窗）→ 调用用户配置的 Embedding API（OpenAI 兼容）→ 向量+元数据存 `sqlite-vec`（单文件、零依赖部署）
- 检索：向量相似度 + 文件名/路径 BM25 混合排序；`.gitignore` 默认排除，索引随文件变更增量更新
- 消费方：Chat 的 `@代码库`、Agent 的 `search_code` 工具、补全的跨文件上下文

### 3.6 构建、打包与分发
- 构建：沿用 vscode gulp 流水线（`yarn && yarn gulp vscode-darwin-arm64` 等），封装 npm scripts
- 打包：vscode 自带打包产物 + electron-builder 做签名/公证（内部工具可先跳过公证）
- 更新：MVP 阶段手动发版；后续接入 `update-server`（私有静态服务 + `updateMode`）
- 遥测：全部关闭/移除

## 4. 里程碑（建议 6 期，可按人力压缩）

| 里程碑 | 目标 | 验收标准 |
|---|---|---|
| M1 基座 | Fork 跑通、品牌定制、可构建可运行 | 本地起 Dev 版 + 打出安装包，名称/图标已替换 |
| M2 LLM + Chat | Provider 抽象、Key 管理、Chat MVP（流式+Markdown+上下文引用） | 配 Key 后可对话，@文件 引用生效 |
| M3 补全 | Inline Completion 全链路 | Tab 接受 ghost text，延迟 < 1.5s |
| M4 Agent | 工具集 + ReAct 循环 + 确认门 + checkpoint 回滚 | "修复这个报错并跑测试"类任务可端到端完成 |
| M5 索引 RAG | 索引进程 + sqlite-vec + 混合检索接入 Chat/Agent/补全 | 中大型仓库索引 < 5min，检索可用 |
| M6 发布 | 打包脚本、内部发版流程、文档 | 团队成员可安装使用，崩溃/日志可收集 |

## 5. 测试与质量

- AI 核心服务（Provider、上下文引擎、工具执行器）纯 TS 单元测试（沿用 vscode 的 mocha 体系）
- 工具执行器用 mock workspace 做集成测试；Agent 循环用录制回放（record/replay LLM 响应）做确定性测试
- 每次 rebase 上游后跑 vscode 自带 smoke test

## 6. 主要风险与对策

- **上游同步冲突**：严格把改动隔离在 contrib/ai 与 platform/ai 新目录 + 仅 patch 式修改入口注册点；每月小步同步而非累积大同步
- **构建链复杂**：M1 专门预留时间吃透 vscode 构建，产出《构建手册》
- **Agent 稳定性**：从"确认门全开"起步，逐步放宽自动批准；checkpoint 机制兜底
- **许可证**：VS Code 源码 MIT 可商用；注意产品名/图标不得使用微软商标；扩展市场需用 Open VSX

## 7. 假设

- 开发环境 macOS（darwin arm64），Node 版本按 vscode 仓库 `.nvmrc` 要求
- Embedding 复用用户配置的 OpenAI 兼容 Key，不引入本地小模型（后续可扩展 Ollama）
- 无服务端组件；账号/计费/同步均不做
- 语言优先级：TypeScript/JS、Python 的 tree-sitter 分块优先支持，其余走滑窗 fallback


## 8. 接入的大模型配置如下
```
{
  "providers": {
    "ollama": {
      "baseUrl": "http://127.0.0.1:11434/v1",
      "api": "openai-completions",
      "apiKey": "ollama",
      "compat": {
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false
      },
      "models": [
        {
          "id": "qwen3.5:9b",
          "name": "Qwen3.5 9B Local",
          "reasoning": false,
          "contextWindow": 8192,
          "maxTokens": 4096
        }
      ]
    }
  }
}
```

## 9. 2026-10-17 Pi 架构修订（优先于前述自研 Agent 设计）

按用户确认，M4 直接使用开源 `@earendil-works/pi-coding-agent@1.3.0`。Pi 在独立 Electron utility process 中负责模型调用、工具循环、上下文压缩与 JSONL 会话；IDE 通过 IPC 提供工具、Diff、确认和面板，不再自研 ReAct 循环。行内补全继续独立使用已有 LLM 服务。

- Chat 允许只读问答；Plan 允许调查和 `update_plan`，计划写入 Pi 会话条目；Build 才能提出文件修改、命令和项目记忆写入，均须 IDE 明确确认。
- 禁用 Pi 原生 Shell/文件工具和自动发现的可执行扩展。API Key 来自已有加密凭据服务，进程内存传递，不写入 Pi auth.json。
- 文件读取包含未保存编辑器文本；修改展示真实 Diff，使用 workspace edit 保留撤销。首次修改前保留内存 checkpoint；回滚拒绝覆盖后续用户修改，不使用 git stash/reset。checkpoint 仅当前会话有效，终端副作用不纳入回滚。
- 执行面板显示工具结果、计划、会话与取消，不展示内部推理。中途纠偏先停止再发送。
- `remember` / `search_memory` 保存与检索工作区隔离的可编辑文本；`web_search` 使用配置的 SearxNG JSON 服务，未配置明确返回错误；`web_fetch` 读取公共网页。
- 当前 `search_code` 为有界文字搜索，不能替代 M5 向量索引。

实施计划：[Pi 集成计划](../../mytrae/plans/2026-10-17-pi-integration.md)。使用说明：[Pi Agent](../../mytrae/docs/PI-AGENT.md)。确定性测试运行真实 Pi SDK 接本地 HTTP 模型服务，覆盖工具续跑、模式限制、取消、恢复和步数边界；另以本机 Ollama 验证真实 IDE 流程。

M1 已完成前轮独立验收；M2 Markdown/上下文与 M4 Pi 接入已完成本轮验收（Task 1-4 全绿，含打包版 Ollama 端到端）。M3 行内补全已完成端到端验收（2026-10-17，证据见 `.agent-validation/completion/`）：ghost text 正常渲染、Tab 接受、5 个延迟样本 1090-1260ms 全部 < 1.5s（本机 Ollama，300ms 防抖计入），单元测试 26 例、typecheck/eslint 全绿。验收中修复两处真机问题：sanitize 增加模型回显行前缀剥离；补全 range 改为光标处零宽插入（默认整词替换区间会被编辑器可见性过滤隐藏，导致 ghost text 不出现）。补全模型选型注意：qwen3.5:9b 经 /v1 端点输出全部落入 reasoning、content 为空，不能用作补全模型，验收改用 qwen2.5-coder:1.5b。

M5 代码索引已完成验收（2026-10-17，证据见 `.agent-validation/index/`）。实现相对原设计有两处降级：向量存储用 `node:sqlite` + L2 归一化 float32 BLOB 暴力扫描替代 sqlite-vec（12000 chunk 内扫描毫秒级，暂无性能压力）；分块用自研声明边界 + 缩进/花括号启发式 chunker 替代 tree-sitter。检索为向量 + BM25（内存倒排）+ 路径匹配三路 RRF（k=60）融合。验收数据：`src/vs` 大库首建 4.39min（1215 文件 / 12000 chunk，< 5min 预算，bge-m3 实测 ~47 chunks/s，嵌入输入截断 1200 字符）；小库检索相关性 4/4 命中预期文件；node 套件 32 例 + Electron 套件 135 例、typecheck/eslint 全绿；真机冒烟（launch skill 隔离实例）确认 utility process 在工作台内完成首建与持久化（32 文件 / 265 chunk / dim 1024），settings 变更无需重载即可重建索引。验收过程中修复四处真实缺陷：generation 双重递增导致索引永不执行、fuse 融合分排序方向颠倒、fuse 按存储序而非融合分回填结果、小 chunk 合并的行数语义错误。遗留：MyTrae Chat 视图将请求路由到内置 Copilot 模型而非配置的 `myTrae.provider`（属 M4 Chat 域问题），导致 `search_code` 未能在真机 UI 走通端到端，该路径现由服务端 e2e 与工具接线单测覆盖。

M6 打包发布已完成验收（2026-10-18，证据见 `.agent-validation/release/`）：`npm run mytrae:package:mac` 产出 MyTrae-1.142.0-darwin-arm64.dmg + sha256，校验通过；打包版 e2e（DMG 挂载 → Playwright 管道驱动）验证 Pi agent 回合与代码索引 utility process 均在打包产物内正常工作（`indexReady: true`、`searchCodeAnswered: true`、无 fatal errors）；BUILD.md §5.1 已补充发版流程、签名公证占位、崩溃收集说明（本地 Crashpad，不外发）与日志路径。签名、公证和自动更新服务仍为外部接入事项，本次验收完成 macOS 本机可用的打包基线。
