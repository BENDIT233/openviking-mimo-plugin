<div align="center">

# OpenViking Memory for Xiaomi MiMo

把 [OpenViking](https://github.com/volcengine/OpenViking)（OV）长期语义记忆接入
**小米 MiMo 桌面端**（MiMoCode 引擎，进程内 ESM 插件）。

![version](https://img.shields.io/badge/version-0.1.1-blue)
![host](https://img.shields.io/badge/host-Xiaomi_MiMo-orange)
![plugin](https://img.shields.io/badge/plugin-@mimo--ai%2Fplugin_0.1.14-8A2BE2)
![tools](https://img.shields.io/badge/tools-native_ov__*,_no_MCP_SDK-1f6feb)
![platform](https://img.shields.io/badge/platform-Windows-lightgrey)
![license](https://img.shields.io/badge/license-MIT-green)

装好后无需手动操作：每次提问前自动召回相关记忆，会话首个请求注入用户画像，
对话回合自动沉淀回记忆库；同时把 OpenViking 的全部工具暴露为 MiMo **原生工具**。

</div>

## 特性

| 能力 | MiMo 钩子 | 说明 |
| --- | --- | --- |
| **每轮语义召回** | `chat.message` | 按当前提问语义召回相关记忆，作为 synthetic part 注入模型请求体 |
| **用户画像注入** | `experimental.chat.system.transform` | 注入 `profile.md` + preferences / entities 索引，按内容幂等，不重复推送 |
| **URI 守卫** | `tool.execute.before` | 拒绝 `read` / `glob` / `grep` / `edit` / `write` / `bash` 把 `viking://` 当本地路径，改路由到 `ov_*` 工具 |
| **对话捕获 + 提交** | `session.post` | 直接消费引擎给的完整 trajectory（**不需要解析任何日志文件**），去重后写库并提交 |
| **兜底提交与去重重置** | `experimental.session.compacting` | 压缩前 best-effort 提交；清空捕获去重集（压缩会重写消息列表） |
| **会话终结提交** | `event` (`session.deleted`) | 会话删除时提交已捕获内容 |
| **原生工具面** | `tool` | 15 个 `ov_*` 工具，直接走 OV 的 `/mcp` JSON-RPC（**无 MCP SDK 依赖**） |
| **技能** | — | `skills/openviking-memory`，注入记忆使用纪律与 `ov_*` 工具路由 |

两条硬保证：

- **fail-open** —— OV 不可达、超时、任何钩子抛错都不会影响用户这一轮。
  每个钩子体都包了 try/catch，原生工具永远**返回错误字符串而不是抛异常**。
  （`test/verify.mjs` 第 9 节逐钩子实证：OV 指向死端口时 `chat.message` /
  `system.transform` / `session.post` 均不抛错，`ov_health` 返回字符串。）
- **不回流** —— 注入的 `<openviking-context>` 块在捕获前被剥离，
  `synthetic` / `ignored` 的 part 直接丢弃。**注入内容永远不会写回记忆库**
  （已在真实回合上，对**实际发往 OV 的请求体**断言过，而非只看钩子日志）。

## 为什么这个端口和 Kimi 端口差别很大

MiMo 插件是**进程内 ESM 模块**，不是 stdin/stdout 子进程。因此本插件没有
hook 启动器、没有 wire 日志解析器、没有 stdio↔HTTP MCP 代理：

| | Kimi Code 端口 | 本端口（MiMo） |
| --- | --- | --- |
| 插件形态 | 子进程 + `kimi.plugin.json` hooks 表 | 进程内 ESM，`export default { id, server }` |
| 注册方式 | 插件清单声明 hooks | `mimocode.jsonc` 的 `plugin: ["./plugin/openviking.js"]` |
| 启动器 | `ov-hook.cmd`（无 node，复用 Electron） | 不需要（宿主自己 `import()`） |
| 注入通道 | stdout JSON `{"message": ...}` | 直接改 `output.parts` / `output.system` |
| 捕获来源 | 解析宿主 `wire.jsonl`（384 行解析器） | `session.post` 直接给完整 trajectory |
| 工具面 | 打包 stdio→HTTP MCP 代理进程 | 原生 `tool()` + `fetch` 直连 `/mcp` |

## 宿主契约（均已在本机实证）

下表每一行都在 MiMo 桌面端（`desktop-30e55a4`）上跑通，并记出验证方式。
"实证"列指的是 `test/verify.mjs` 的检查点编号。

| MiMo 钩子 / API | 对应 OV 能力 | 实证 |
| --- | --- | --- |
| `chat.message` → `output.parts.push({type:"text", synthetic:true, id, sessionID, messageID})` | 每轮语义召回 | 第 4 节：断言 recall 块出现在 **mock provider 收到的原始请求体**里，且块内有真实检索内容（3022 字符），用户原文仍在；第 2b 节：`session.post` 的最终 trajectory 里也带着该 synthetic part |
| `experimental.chat.system.transform` → `output.system.push(block)` | 用户画像 | 第 3/5b 节：system message 41635 字符；两轮内 session-start 块恰好出现 1 次 |
| `tool.execute.before` → `output.cancel=true` + `output.cancelReason` | `viking://` URI 守卫 | 第 5 节：单测 + 端到端（`cancelReason` 出现在**后续请求体**里） |
| `session.post` → `input.trajectory`（完整 `TrajectoryMessage[]`）+ `input.outcome` | 捕获 + 提交 | 第 2b 节：**引擎在自己进程内**把 `outcome: "completed"`、无 error、`["user","assistant"]` 的完整 trajectory、以及**注入后的 system prompt 与 synthetic recall part** 一并交给钩子；第 7 节：真实回合写入 5 个去重键，实际向 OV 上传 3 条消息并 commit |
| `experimental.session.compacting` | 压缩前 flush + 去重重置 | 第 10 节：先产生 2 个去重键，调用后归零，OV session id 不变 |
| `event`（`session.deleted`） | 会话终结提交 | 与 `session.post` 共用提交路径 |
| `tool` → `{ ov_x: tool({description, args: zodShape, execute}) }` | 15 个原生工具 | 第 1/3 节：工具注册齐全；`required` / `enum` / `description` 在模型实际收到的 JSON Schema 里存活 |
| `POST <OV>/mcp`（JSON-RPC 2.0 over streamable HTTP） | 工具调用 | 第 8 节：`ov_health` / `ov_list` / `ov_tree` / `ov_find` 对线上 OV 返回真实内容 |
| `GET /skill`（引擎的技能扫描） | 技能 | 第 5c 节：引擎发现 `openviking-memory` 并返回解析后的 description 与正文 |

### 三个踩过的坑（写在这里是因为它们都会静默失败）

1. **`.default(undefined)` 会让引擎在第一次模型请求前崩掉。**
   OV 用"不在 `required` 里"来表示可选参数，而 zod 4 的 `.default()` 会把它变成
   **必填**（实测），`.default(undefined)` 更会写入 `defaultValue: undefined`，
   于是引擎的 JSON Schema 生成器执行 `JSON.parse(JSON.stringify(undefined))`
   并抛 `"undefined" is not valid JSON` —— **整个回合直接失败**，且报错与插件无关。
   正确做法：可选一律 `.optional()`，服务端默认值作为 `.meta({default})` 携带。
2. **`session.post` 的 part 带 `synthetic` / `ignored` 标记。**
   召回块就是以 synthetic part 下发的。捕获时必须先按标记丢弃，
   否则注入内容会被当成用户原话写回记忆库（双重防线：标记丢弃 + `sanitizeCapturedText`）。
3. **引擎会缓存每个会话的 system 数组。**
   所以"每会话只注入一次"不能靠一次性布尔标志实现 —— 那样在引擎
   重建 system prompt 时画像会永久消失。改为**按内容幂等**：
   数组里已有 session-start 块就跳过，否则推送（用已缓存块，不再请求 OV）。

4. **只有 `plugin` 条目里的插件钩子会真正触发。**
   引擎自己的 glob 确实会*发现* `<configDir>/plugin/*.js` 与
   `<configDir>/plugins/*.js`（`/config` 的 `plugin` 数组里能看到它们），
   但钩子只对**显式写在 `plugin` 数组里**的条目派发 —— 自动发现到的文件
   会被加载成模块，其 `server()` 却不会被登记为钩子源。所以
   `scripts/install.mjs` 会主动写入 `plugin` 条目，而不是依赖自动发现。

5. **`tool.execute.before` 按注册顺序链式执行，且共享同一个 `output`。**
   排在前面的插件先跑并直接改 `output`，后面的插件看到的是已改过的值。
   这本身没问题（守卫是幂等的），但意味着一个钩子的效果不能被另一个
   插件可靠地"旁观"，测试也不能据此断言。

## 安装

### 前置条件

- **小米 MiMo 桌面端**（实测 Windows，引擎 `desktop-30e55a4`）。
- **可访问的 OpenViking 服务**，凭据位于 `~/.openviking/ovcli.conf`。
- **`@mimo-ai/plugin` 0.1.14 与 `zod` 能在配置目录解析到。**
  MiMo 桌面端通常会装好（`~/.config/mimocode/node_modules/`）。
  若没有，插件会**静默注册 0 个工具** —— 这是最容易踩的安装问题，
  `scripts/install.mjs` 会主动检查并警告。

本插件**不 vendor 共享运行时到 `~/.openviking/`，也不在运行时读它** ——
`lib/` 是本仓库自带的共享运行时副本，卸载其他 agent 集成不会影响本插件。

### 安装步骤

```bash
# 1) 把 lib/ plugin/ skills/ 复制到 MiMo 配置目录，并（可选）写入 plugin 条目
ELECTRON_RUN_AS_NODE=1 "C:/Program Files/Xiaomi MiMo/Xiaomi MiMo.exe" \
  scripts/install.mjs --write-config
```

脚本会：

1. 复制 `lib/` → `<configDir>/lib/`，`plugin/` → `<configDir>/plugin/`
   （**必须复制，不能软链接** —— Node 按模块 realpath 解析，链接过去就找不到 `@mimo-ai/plugin`）；
2. 复制 `skills/openviking-memory/` → `<configDir>/skills/`；
3. 若 `<configDir>/package.json` 不存在，写一个 `{"type":"module"}`
   （否则每个插件文件都会被先当 CommonJS 解析一遍并告警）；
4. 把 `"./plugin/openviking.js"` 加进 `mimocode.jsonc` 的 `plugin` 数组
   （**文本插入，保留 JSONC 注释**；不加 `--write-config` 则只打印待粘贴的片段）。

`<configDir>` 默认 `~/.config/mimocode`（可用 `--config-dir` / `MIMOCODE_CONFIG_DIR` 覆盖）。
手动安装等价于在 `~/.config/mimocode/mimocode.jsonc` 里写：

```jsonc
{
  "plugin": ["./plugin/openviking.js"]
}
```

相对路径是相对**配置文件所在目录**解析的。

> **必须写进 `plugin` 数组。** 引擎的自动发现 glob 会把
> `<configDir>/plugin/*.js` 也列进 `/config` 的 `plugin` 数组，但**只有显式
> 条目会收到钩子回调**——自动发现到的模块会被加载，`server()` 却不登记为钩子源。
> 本机实证：两个 `plugin` 条目都会收到 `session.post`，多出来的自动发现文件不会。

**重启 MiMo**（插件按进程加载）。

### 验证安装

```bash
ELECTRON_RUN_AS_NODE=1 "C:/Program Files/Xiaomi MiMo/Xiaomi MiMo.exe" test/verify.mjs
```

期望结尾为 `N/N checks passed`（本机为 **115/115**）。该脚本会自建临时配置目录、
启动真实引擎、跑通回合，**不会碰**你真实的 `~/.config/mimocode`。

另有**守卫行为矩阵**（33 条，覆盖各类路径参数、误报反例与 shell 形态）：

```bash
ELECTRON_RUN_AS_NODE=1 "C:/Program Files/Xiaomi MiMo/Xiaomi MiMo.exe" test/guard-matrix.mjs
```

（脚本会在 `.tmp-test/` 下自建一份 lib/plugin 副本再加载——模块的 import
是按 realpath 解析的，所以必须先有能解析 `zod` 的 `node_modules` 在旁边。
该目录已加进 `.gitignore`，运行结束即可删。）

| 节 | 内容 |
| --- | --- |
| 1 | 插件加载，15 个 `ov_*` 工具注册齐全 |
| 2 / 2b | 真实回合完成；**引擎自己交给钩子的** `outcome`/trajectory/system prompt |
| 3 | 模型实际收到的 JSON Schema（`required` / `enum` / `description` 存活） |
| 4 | 召回块出现在**模型实际收到的请求体**里 |
| 5 / 5b / 5b2 | URI 守卫单测 + 端到端；画像按内容幂等；失败后重试 |
| 5c | 本地清单（用桌面端规则校验）+ 引擎发现技能 |
| 6 | 捕获映射、防回流、去重、真实 add+commit |
| 7 | 真实回合的 hook state + **实际发给 OV 的字节** |
| 8 / 8b | 对线上 OV 调用 `ov_health` / `ov_list` / `ov_tree` / `ov_find`；凭据文件热更新 |
| 9 | OV 全挂时每个钩子都不抛错、工具返回字符串 |
| 10 | 压缩钩子 flush 并重置去重账本 |

装上后新开会话问一句「回顾一下我之前关于这个脚本的偏好」，能引用历史偏好即成功。

## 配置

### 连接与鉴权

凭证解析链（由共享运行时决定）：
`OPENVIKING_*` 环境变量 → `~/.openviking/ovcli.conf` → `~/.openviking/ov.conf`。

`ovcli.conf` 最小形态：

```json
{
  "url": "https://ov.example.com",
  "api_key": "..."
}
```

局域网端点（例如 `http://192.168.1.10:1933`）同样可用。

### 行为开关

MiMo 插件是**进程内**模块，因此环境变量是真正透传的
（不像 Kimi 端口的 hook 子进程需要白名单）—— 在启动 MiMo 的环境里设置即可。

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `OPENVIKING_MEMORY_ENABLED` | `true` | 总开关 |
| `OPENVIKING_AUTO_RECALL` | `true` | 每轮语义召回 |
| `OPENVIKING_AUTO_CAPTURE` | `true` | 自动捕获 |
| `OPENVIKING_RECALL_LIMIT` | `10` | 召回条数 |
| `OPENVIKING_RECALL_TOKEN_BUDGET` | `2000` | 召回 token 预算 |
| `OPENVIKING_SCORE_THRESHOLD` | `0.35` | 相关度阈值 |
| `OPENVIKING_PROFILE_TOKEN_BUDGET` | `6000` | 画像块 token 预算 |
| `OPENVIKING_COMMIT_TURN_THRESHOLD` | `8` | 累计多少轮提交一次 |
| `OPENVIKING_TIMEOUT_MS` | `15000` | OV 调用超时 |
| `OPENVIKING_DEBUG` | `false` | 写调试日志 |
| `OPENVIKING_DEBUG_LOG` | `~/.openviking/logs/mimo-hooks.log` | 日志路径 |
| `OPENVIKING_BYPASS_SESSION_PATTERNS` | 空 | 按 glob 跳过特定会话 |
| `OPENVIKING_URL` / `OPENVIKING_API_KEY` | — | 覆盖凭证文件 |

### 凭证文件热更新

插件是**进程内长驻**的，没有子进程可以重启。因此原生工具层每次调用前都会
重新快照凭证文件（mtime + size，路径集与共享 stdio 代理一致），一有变化就
重建 MCP 会话并重解析配置——**改完 `ovcli.conf` 不必重启 MiMo**，下一个工具
调用即生效（第 8b 节用两个 stub 端点实证：改写文件后下一次调用由新端点应答）。

### `clientId = "mimo"` 及其路径后果

所有对外标识都由 `clientId` 派生，本插件固定为 `"mimo"`：

| 产物 | 路径 / 值 |
| --- | --- |
| OV 会话 id | `mimo-<MiMo sessionID>`（`deriveAgentSessionId("mimo-", input)`） |
| hook 状态 | `~/.openviking/hook-state/mimo/<sessionID>.json` |
| 调试日志 | `~/.openviking/logs/mimo-hooks.log` |
| User-Agent | `openviking-memory-mimo/0.1.1` |

`mimo-` 前缀 + 把 `{sessionId}` 传进 `recallForPrompt` 是 **OV 的硬要求**，
不是可选优化：服务端据此开启查询扩展与跨轮去重账本。

hook state 里存 `ovSessionId` / `capturedKeys`（去重键）/ `capturedSinceCommit`。
命名空间按 agent 隔离，所以它和 Kimi、mcode、Codex 端口互不干扰。

## `viking://` 守卫行为

`viking://` 是 OpenViking 的虚拟路径，**不是本地文件系统路径**。

| 工具 | 参数里出现 `viking://` | 结果 |
| --- | --- | --- |
| `read` / `view_image` | `filePath` | **拦截**，提示改用 `ov_read` |
| `glob` / `grep` | `path` / `pattern` / 任意路径字段 | **拦截**，提示改用 `ov_glob` / `ov_grep` |
| `edit` / `write` | `filePath` | **拦截**，提示改用 `ov_edit` / `ov_write` |
| `bash` | 把 URI 当路径用（`cat viking://…`、`> viking://…`、`--file viking://…`） | **拦截** |
| `bash` | 仅在命令文本里提到（`echo "see viking://x"`） | **放行** |
| `write` | 仅在**内容**里提到（要写一份提及 URI 的文档） | **放行** —— 否则文件永远建不出来 |

拦截通过 `output.cancel = true` + `output.cancelReason` 实现（引擎实证：
工具体不执行，`cancelReason` 到达模型）。

## 原生工具

15 个工具，统一 `ov_` 前缀以避免与 MiMo 内建工具（`read` / `grep` / `glob` /
`write` / `edit` / `bash`）冲突：

| 工具 | 用途 |
| --- | --- |
| `ov_find` / `ov_search` | 语义检索（`search` 支持 `mode: list\|context`、查询扩展、token 预算） |
| `ov_read` / `ov_list` / `ov_tree` | 读文件 / 列目录 / 目录树 |
| `ov_grep` / `ov_glob` | 精确文本 / 文件名匹配 |
| `ov_remember` | 存对话事实 |
| `ov_write` / `ov_edit` | 写 / 定点改 `viking://` 文件 |
| `ov_add_resource` | 添加资源（URL / sitemap / 文件，异步处理） |
| `ov_list_watches` / `ov_cancel_watch` | 查看 / 取消自动刷新订阅 |
| `ov_forget` | 永久删除（不可逆） |
| `ov_health` | 健康检查 |

工具定义是**数据而非代码**：`plugin/ov-tools.schema.json` 由脚本从线上 OV 抓取。

```bash
# 重新抓取（OV 升级后 schema 变了就重跑，diff 可审查）
ELECTRON_RUN_AS_NODE=1 "C:/Program Files/Xiaomi MiMo/Xiaomi MiMo.exe" \
  scripts/capture-tool-schemas.mjs
```

`plugin/tools.mjs` 在加载时把 OV 的 JSON Schema 转成 zod raw shape：
`string`/`integer`/`number`/`boolean`/`enum`/`array`/`object` 都覆盖，
`description` 通过 `.describe()` 透传，未识别类型降级为 `z.unknown()`
（未来 OV 加参数只会降级一个参数，不会让插件加载失败）。

## 排障

| 内容 | 位置 |
| --- | --- |
| 调试日志 | `~/.openviking/logs/mimo-hooks.log`（设 `OPENVIKING_DEBUG=1`） |
| hook 状态 | `~/.openviking/hook-state/mimo/<sessionID>.json` |
| 插件加载日志 | MiMo 主进程日志（`Loading plugin` / `failed to load plugin`） |

| 现象 | 排查 |
| --- | --- |
| 完全没有注入 | 确认重启过 MiMo；检查 `<configDir>/plugin/openviking.js` 存在；设 `OPENVIKING_DEBUG=1` 看日志 |
| 工具列表里没有 `ov_*` | **`@mimo-ai/plugin` 解析不到**（最常见），或插件没写进 `plugin` 数组（自动发现不算）。跑 `scripts/install.mjs` 看警告并在配置目录 `npm install @mimo-ai/plugin@0.1.14` |
| 第一个回合就报 `"undefined" is not valid JSON` | 是工具 schema 的 `.default(undefined)` 陷阱（见上文"踩过的坑"），确认用的是本仓库的 `tools.mjs` |
| 捕获为 0 | 查 hook state 的 `capturedKeys`；确认 OV 可达（`ov_health`） |
| 注入块进了记忆库 | 确认 `plugin/capture.mjs` 是唯一捕获路径，且 synthetic 标记逻辑未被改动 |
| 改了 `ovcli.conf` 不生效 | 工具层会自动热更新（第 8b 节）；若仍不生效，确认改的是 `OPENVIKING_CLI_CONFIG_FILE` 指向的那份文件 |

## 已知限制

- **Plugins 页面（UI 安装）走不通。** 桌面端从 marketplace 读取插件时要求
  `manifestSha256` + `sig` + `keyid` 三件套并验证签名
  （`app.asar/out/main/index.mjs` 内 `plugins.manifest(manifest, sha256, sig, keyid)`
  → `crypto.verify`），本地第三方插件**无法产生**这个签名。因此本仓库的
  `mimo-plugin.json` 是**声明式的原生格式描述**（用桌面端自己的校验规则验证过，
  见 `scripts/validate-manifest.mjs`），**实际激活路径是 `plugin:` 条目 + 技能目录**。
  本项目**不声称**能从 Plugins 页面一键安装。
- **技能需要手动放到配置目录。** Skills live under `<configDir>/skills/`, which the
  engine's own `{skill,skills}/**/SKILL.md` glob scans per config directory —
  verified: `GET /skill` returns the parsed entry with its description and body.
  But the Plugins-page install path cannot place it there for you (see above), so
  `scripts/install.mjs` does the copy.
- **画像按内容幂等，而非"整会话只投一次"。** 引擎会缓存 system 数组，
  正常情况下画像只推一次；但引擎重建 system prompt（checkpoint / rebuild）后
  插件会重新补上——这是**有意为之**（否则画像永久丢失），代价是重建时可能
  再花一次画像 token。
- **不处理 MiMo 的 `compaction.prune` / checkpoint 摘要注入。**
  压缩产生的摘要若以非 synthetic part 形式进入 trajectory，会被当作助手文本捕获。
- **`bash` 守卫是启发式。** Bash 没有 schema，URI 是否"当路径用"靠动词/重定向/
  标志判断（`plugin/uri-guard.mjs`）。已覆盖常见形态并显式排除了误报
  （纯提及、写文档正文），但无法穷尽 shell 语法。
- **Windows 上无法用软链接安装。** 跨盘 junction 被拒（`Y:` → `C:` 实测失败），
  同盘链接又会让 `@mimo-ai/plugin` 解析失败（realpath 规则）——所以必须复制。
- **未在本机验证的项**：MiMo 的 TUI 界面渲染、`--pure` 模式下的行为、
  非 Windows 平台的链接/权限语义。

## 项目结构

```
.
├── mimo-plugin.json              # MiMo 原生插件清单（声明式；用桌面端规则验证）
├── integration.json              # OV 侧集成记录（11 个官方字段 + provenance）
├── plugin/
│   ├── openviking.js             # 引擎插件入口：export default { id, server }
│   ├── capture.mjs               # trajectory → 捕获回合（去重键、清洗）
│   ├── uri-guard.mjs             # viking:// 守卫（MiMo 参数形状）
│   ├── tools.mjs                 # 15 个原生 ov_* 工具（数据驱动）
│   ├── mcp-client.mjs            # OV /mcp JSON-RPC 客户端（含 SSE 解析）
│   └── ov-tools.schema.json      # 从线上 OV 抓取的工具 schema
├── lib/                          # 共享运行时（vendored 副本，不引用 ~/.openviking）
├── skills/openviking-memory/
│   ├── SKILL.md                  # 记忆使用纪律与 ov_* 工具路由
│   └── locales/{zh-CN,en-US}.json
├── scripts/
│   ├── install.mjs               # 安装到 MiMo 配置目录 + 写 plugin 条目
│   ├── capture-tool-schemas.mjs  # 重新抓取 ov-tools.schema.json
│   └── validate-manifest.mjs     # 用桌面端规则校验 mimo-plugin.json
├── test/
│   ├── verify.mjs                # 端到端验证（真实引擎 + mock provider + 线上 OV）
│   ├── guard-matrix.mjs          # URI 守卫行为矩阵（含误报反例）
│   └── mock-provider.mjs         # 记录请求体的 OpenAI 兼容 mock provider
└── README.md
```

## 版本历史

| 版本 | 日期 | 说明 |
| --- | --- | --- |
| 0.1.1 | 2026-09-22 | 测试隔离修复：`test/verify.mjs` 用进程内 `MIMOCODE_HOME` 把引擎钉在临时 home，不再扫到本机真实全局配置目录（插件已全局在役后曾致工具重复注册 30/15，属测试环境假象）；顺带修掉 DB 句柄未关导致的清理失败 |
| 0.1.0 | 2026-09-21 | 首版：画像注入 + 语义召回 + URI 守卫 + trajectory 捕获提交 + 15 个原生工具 + skill；本机 115/115 实证通过 |

## 致谢

- [OpenViking](https://github.com/volcengine/OpenViking) —— 长期语义记忆服务本身。
- [Xiaomi MiMo](https://mimo.xiaomi.com/coder) —— 宿主 agent，`@mimo-ai/plugin` 插件体系由其提供。
- [openviking-kimi-plugin](https://github.com/BENDIT233/openviking-kimi-plugin) —— 同门 Kimi Code 接入实现，本插件的文档与结构参考来源。
- OV 官方 agent 插件体系 —— 共享运行时（`memory-plugin-shared`）与钩子适配层模式。

## 许可证

[MIT](LICENSE) © 2026 BENDIT233
