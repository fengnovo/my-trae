# Pi Agent 集成实施计划

**目标**：按已确认方案将 Agent 执行与会话交给 Pi SDK，完成 MyTrae 的 Plan/Build、IDE 工具、项目记忆、联网搜索入口与真实本地模型验收。

**架构**：Pi SDK 1.3.0 在独立 Electron utility process 中运行，使用上游 IPC；Renderer 提供反向工具调用。Pi SessionManager 是会话唯一事实来源，密钥来自现有加密凭据服务，仅在进程间内存传递。行内补全保留现有独立 LLM 服务。

**约束**：保留当前工作目录和用户未提交改动；不提交或推送。禁止自建模型工具循环；禁用 Pi 原生执行工具和未经选择的扩展。规划模式不开放文件修改、记忆写入和命令执行。修改必须经过 IDE 确认，保留未保存编辑器内容，工作区外路径与符号链接越界需要拒绝。

共享契约：`src/vs/platform/ai/common/piAgent.ts`。`IPiAgentHost` 提供 initialize/prompt/abort/session 管理，广播 `IPiSnapshot`，通过 `IPiToolRequest` 与 `completeTool` 反向调用 IDE。`IPiAgentService` 是桌面 IPC 代理。

- [ ] Task 1：`platform/ai/node/piAgentService.ts`、`piAgentMain.ts` 与 Node 测试：使用真实 Pi SDK、内存凭据、会话恢复、流式快照、取消、工具模式与步数限制。验证通过本地模拟 HTTP 模型的 Pi 工具循环，禁止 mock 另写 agent loop。
- [ ] Task 2：`workbench/contrib/ai/browser/piAgentTools.ts` 与浏览器测试：实现工作区读取/搜索/诊断、经确认的修改与命令、修改 checkpoint 与安全回滚、项目记忆、可配置搜索与网页读取。工具边界独立于模型。
- [ ] Task 3：桌面 IPC proxy、Chat 投影、Plan/Build 切换、工具步骤、计划、会话列表、Markdown 与配置入口；加入构建 entry point。验证错误反馈、取消及切换会话不会混流。
- [ ] Task 4：真实 Ollama 端到端验证、目标测试、类型与 lint、打包 smoke；更新原方案 M2/M4/M5 与构建手册，清理独立测试实例。

验收资料放入 `.agent-validation/pi/`。联网搜索使用可配置 JSON 搜索服务，未配置时明确报错；不假装提供搜索结果。M5 的大型代码库向量索引仍单独验收，本次记忆首先采用可编辑持久化文本。
