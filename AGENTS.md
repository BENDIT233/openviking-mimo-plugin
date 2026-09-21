# AGENTS.md — openviking-mimo-plugin

OpenViking 长期记忆插件，接 **小米 MiMo 桌面端**（MiMoCode 引擎，进程内 ESM 插件）。

## 这个仓库的硬约束

1. **`lib/` 是共享运行时的 vendored 副本，不要改。**
   它是 OV 官方 `memory-plugin-shared` 的同源 23 模块谱系。改了它，
   下次与上游同步就会冲突。需要新能力时在 `plugin/` 里包一层。
   同样地：**运行时绝不引用 `~/.openviking/agent-integrations/...`** ——
   vendoring 的全部意义就是卸载别的 agent 集成不会连带弄坏本插件。

2. **不要新增 npm 依赖。** 只用 `@mimo-ai/plugin` 与 `zod`（宿主已提供，
   从 `<configDir>/node_modules` 解析）。特别是**不要引入 MCP SDK** ——
   `plugin/mcp-client.mjs` 用 `fetch` 直接说 `/mcp` 的 JSON-RPC。

3. **每个钩子必须 fail-open。** 钩子体一律包 try/catch 并只记日志。
   原生工具的 `execute` 永远**返回错误字符串而不是抛异常**。
   违反这条会让用户在 OV 挂掉时连正常对话都用不了。

4. **`clientId` 固定为 `"mimo"`。** OV 由它派生
   `~/.openviking/hook-state/mimo/`、`~/.openviking/logs/mimo-hooks.log`
   与 UA `openviking-memory-mimo/<version>`。会话 id 必须带 `mimo-` 前缀，
   且要把 `{sessionId}` 传给 `recallForPrompt`（服务端查询扩展 +
   跨轮去重账本依赖它）。

5. **长驻进程必须自己处理凭证轮换。** 插件没有子进程边界可以重启，
   所以工具层每次调用前重新快照 `ovcli.conf`（路径集取自共享的
   `defaultCredentialPaths`，与 stdio 代理保持一致），变化时重建 MCP 会话。
   改这条时务必同步跑第 8b 节。

## 宿主契约里最容易踩的五个坑

改动钩子前请先读这五条，它们都会**静默**失败：

1. **`plugin` 数组条目 vs 自动发现。**
   引擎的 glob 会*发现* `<configDir>/plugin/*.js`，但**只有显式写在
   `mimocode.jsonc` 的 `plugin` 数组里的条目会收到钩子回调**。
   自动发现到的模块会被加载，`server()` 却不登记为钩子源。
   实证：两个 `plugin` 条目都收到 `session.post`，第三个自动发现文件不会。

2. **`.default(undefined)` 会让引擎在第一次模型请求前崩掉。**
   zod 4 里 `.default(x)` 会把字段变成**必填**（实测），`.default(undefined)`
   还会写入 `defaultValue: undefined`，引擎的 JSON Schema 生成器随即执行
   `JSON.parse(JSON.stringify(undefined))` 并抛 `"undefined" is not valid JSON`。
   可选参数一律 `.optional()`，服务端默认值只作为 `.meta({default})` 携带。

3. **`session.post` 的 part 带 `synthetic` / `ignored` 标记。**
   召回块就是以 synthetic part 下发的。捕获前必须先按标记丢弃，
   否则注入内容会被当用户原话写回记忆库。

4. **引擎缓存每个会话的 system 数组。**
   "每会话只注入一次"不能靠一次性布尔标志 —— 引擎重建 system prompt 时
   画像会永久消失。`injectProfile` 按**内容**幂等（数组里已有就跳过）。

5. **`tool.execute.before` 按注册顺序链式执行，共享同一个 `output`。**
   排在前的插件先跑并直接改 `output`。不要假设自己能旁观别的插件的效果，
   测试也不要据此断言（用请求体或 `session.post` 的最终 trajectory）。

## 目录职责

```
plugin/openviking.js   钩子编排：召回 / 画像 / 守卫 / 捕获提交，全部 fail-open
plugin/capture.mjs     trajectory → 捕获回合（synthetic 丢弃、渲染、去重键）
plugin/uri-guard.mjs   viking:// 守卫的 MiMo 参数形状（bash 用启发式）
plugin/tools.mjs       15 个原生 ov_* 工具，由 JSON schema 数据驱动
plugin/mcp-client.mjs  OV /mcp JSON-RPC 客户端（含 SSE 解析）
plugin/ov-tools.schema.json  生成的，不要手改
lib/                   vendored 共享运行时（只读）
skills/openviking-memory/     技能 + locales
scripts/               安装、抓 schema、校验清单
test/                  端到端验证
```

## 命令

本机**没有系统 node**，一律用 MiMo 自带的 Electron：

```bash
E="C:/Program Files/Xiaomi MiMo/Xiaomi MiMo.exe"

# 跑验证（改完必须跑；期望 115/115）
ELECTRON_RUN_AS_NODE=1 "$E" test/verify.mjs

# 守卫行为矩阵（期望 33/33）—— 改动 uri-guard.mjs 时必须跑
ELECTRON_RUN_AS_NODE=1 "$E" test/guard-matrix.mjs

# 只跑某几节
ELECTRON_RUN_AS_NODE=1 "$E" test/verify.mjs --filter "capture"
ELECTRON_RUN_AS_NODE=1 "$E" test/verify.mjs --keep     # 保留临时目录排查

# OV 升级后重抓工具 schema（diff 可审查）
ELECTRON_RUN_AS_NODE=1 "$E" scripts/capture-tool-schemas.mjs

# 校验 mimo-plugin.json（用桌面端自己的规则）
ELECTRON_RUN_AS_NODE=1 "$E" scripts/validate-manifest.mjs

# 安装到 MiMo 配置目录
ELECTRON_RUN_AS_NODE=1 "$E" scripts/install.mjs --write-config
```

## 测试纪律

- `test/verify.mjs` 会自建临时配置目录、启动**真实引擎**，
  **绝不修改**用户真实的 `~/.config/mimocode/mimocode.jsonc`，
  也不创建 `auth.json`、不重启 MiMo。
- 断言要针对**可观测的产物**：模型实际收到的请求体、
  `session.post` 在引擎进程内看到的最终 trajectory、实际发给 OV 的字节。
  不要只断言"钩子日志说它跑了"。
- 防回流（注入内容不得写回记忆库）是**载荷性质**，必须在真实回合上、
  对真实上传字节断言。
- 新增能力时同步更新本节与 README 的宿主契约表，并标出验证方式。
