# Pi Agent 使用与实现

桌面 MyTrae AI 面板直接使用 Pi Coding Agent SDK 1.3.0。Pi 负责模型工具循环、流式响应、会话 JSONL 和上下文压缩；MyTrae 提供 IDE 工具、确认对话框、Diff、计划与会话界面。没有另写 Agent 循环。SDK 和依赖版本在 package-lock.json 锁定。

## 启动

运行 `npm run mytrae:dev`，打开本地工作区，通过命令 `MyTrae AI: Focus AI Chat` 进入面板。在设置中选择 `myTrae.provider`，填写模型和服务地址；使用 `MyTrae AI: Set API Key` 将 Key 存到已有加密凭据服务。Ollama 不需要真实 Key，示例：

```json
{
  "myTrae.provider": "ollama",
  "myTrae.baseUrl": "http://127.0.0.1:11434/v1",
  "myTrae.model": "qwen3.5:9b",
  "myTrae.agentModel": "qwen3.5:9b",
  "myTrae.agent.contextWindow": 32768,
  "myTrae.maxTokens": 4096,
  "myTrae.agent.maxSteps": 25
}
```

`contextWindow` 声明模型实际可用的上下文，不能替 Ollama 分配容量。Ollama 的 OpenAI 兼容接口需要在服务端配置上下文，例如通过包含 `FROM qwen3.5:9b` 与 `PARAMETER num_ctx 32768` 的 Modelfile 创建专用模型，再将 `agentModel` 指向它。具体见 [Ollama 官方兼容接口文档](https://github.com/ollama/ollama/blob/main/docs/api/openai-compatibility.mdx)。本机原始 `qwen3.5:9b` 实测分配 4096 tokens；较长任务应先调整服务端配置。本次开发没有修改用户的 Ollama 服务或模型配置。

## 操作

- Chat：问答和只读调查；支持附加文件和精确选区，读取当前未保存的编辑器文本。
- Plan：可读工作区并调用 `update_plan`，结构化计划随 Pi 会话保存；不开放写文件、命令和写记忆。
- Build：可提出文件修改与命令，必须逐项确认。文件变更展示 Diff，并保留正常撤销能力。
- Stop：中止 Pi 请求和待确认工具。已经启动的终端进程可能继续运行，可在可见终端停止。
- 会话下拉框、新建与删除：直接操作 Pi session；重载后恢复最近会话。切换前需停止当前操作。
- Roll Back Changes：逐项预览并恢复本会话的文件 checkpoint，拒绝覆盖后续用户修改。终端命令和外部副作用不在回滚范围。

项目记忆使用 `remember` 保存可供未来会话检索的项目事实，通过 `search_memory` 检索。记忆写入需 Build 模式和用户确认；它属于工作区持久数据，不等于向量索引。Pi 会话存于用户数据目录 `User/mytrae/pi/sessions/<workspace>/`，Key 仅传入进程内存，不写入 Pi 的认证文件。自动加载的 Pi 可执行扩展和默认 Shell/文件工具均禁用。

## 联网

设置 `myTrae.agent.searchUrl` 为支持 `q` 和 `format=json` 的 SearxNG 搜索地址；工具 `web_search` 才能返回真实搜索响应。没有配置时明确报错。`web_fetch` 可读取公共 HTTP(S) 页面。请求禁用重定向，限制响应与超时时间，返回有界文本。页面内容只是数据，不能获得额外的工具权限。

## 已知范围

工具限于主工作区；远程工作区尚不支持 Pi。文件读取与搜索有大小和遍历数量限制，拒绝符号链接。终端有 Shell Integration 时返回关联输出与退出状态，否则明确提示到终端查看，不把发送命令当作成功。checkpoint 不跨 IDE 重启，长期操作历史由 Pi 会话保存。

当前 `search_code` 是有界文字搜索。M3 行内补全完整体验与 M5 AST/向量索引、混合检索和 `@codebase` 仍需单独实现与验收。
