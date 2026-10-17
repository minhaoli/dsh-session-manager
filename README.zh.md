# dsh-session-manager

给 DSH 会话做日常维护的 agent 工具 + 本机回环 REST API —— 列出、跨工作区移动、带备份删除、打标签、归档与反归档。

DSH 自带的 GUI 只覆盖了其中一部分（能归档，但没有反归档；没有标签；跨工作区移动要重启）。这个插件把整套能力放到两条共用同一份实现的通道上：

- **Agent 工具** —— 模型可以直接调的六个工具。
- **本机回环 REST API** —— 同样的六个操作走 HTTP，浏览器端插件不必再走 IPC 桥。[`dsh-session-tree`](https://github.com/minhaoli/dsh-session-tree) 就靠它渲染侧栏的标签、拖拽移动和归档菜单。

## 适用版本

| | |
|---|---|
| DSH | `0.2.1-rc.2`（开发与验证所用版本） |
| `@deepseek-ai/cordis` | `~4.0.5` |
| 运行时 | Node.js 22+（DSH 桌面运行时自带） |

更早的 DSH 版本未验证。插件读取 `workspaceRegistry`、`sessionPersistence`、`storageDomain`、`webServer` 四个服务；如果某个版本改名或删掉了其中之一，对应功能会 fail-soft（打一条 warning）而不是把宿主拖崩。

## 安装

```bash
# 从 git 装（推荐）
dsh plugin --profile <你的 profile> add github:minhaoli/dsh-session-manager

# 或者从本地目录装
dsh plugin --profile <你的 profile> add /path/to/dsh-session-manager
```

`<你的 profile>` 填你实际启动的那个 —— Electron 应用是 `desktop`，CLI 模式是 `web` / `headless` / `node`。`desktop` profile 由 Electron 应用独占管理，应用运行时拒绝 `dsh` CLI 写入；请从应用自己的插件管理器安装，或先关掉应用。

包里声明了 `dsh.bundle.patch`，所以 `dsh plugin add` 会顺带把它写进 `dsh.profile.bundles`，下次启动即挂载。如果你是手工拷贝安装，自己补这一行：

```yaml
# ~/.dsh/profiles/<profile>/cordis.patch.yml
- insert:
    - id: session-manager
      name: 'dsh-session-manager'
```

## Agent 工具

六个工具都接收 JSON 参数，返回 `{ ok: true, ... }` 或 `{ ok: false, error }`。

| 工具 | 作用 |
|---|---|
| `session_list` | 列出持久化会话及其工作区、归档状态、标签、标题。过滤参数：`workspaceId`、`path`、`archived`、`tag`。 |
| `session_move` | 跨工作区移动会话。重写日志头 `cwd` 并在磁盘上重命名目录，然后实时更新 registry —— GUI 不用重启就能看到。 |
| `session_delete` | 永久删除会话及其日志目录。传 `backupDir` 会先把每个目录拷一份。 |
| `session_tag` | `set` / `add` / `remove` / `clear` / `drop` / `list` 标签。数据存在 `~/.dsh/session-tags.json`。 |
| `session_archive` | 把会话从所有分组界面隐藏；日志和工作区槽位保留。幂等。 |
| `session_unarchive` | 把归档会话恢复到原位置 —— GUI 缺的就是这个方向。 |

`session_move` 和 `session_delete` 会拒绝「活会话」（模型当前正在跑的那个对话）。

## REST API

只在 `webServer` 服务存在时注册（`web` 和 `desktop` 两种模式）。每个 handler 都转调对应工具的 `execute`，因此两条通道行为完全一致。

所有请求都过 `isLoopbackRequest(req)` 这道闸 —— 非回环来源直接 `403 {"error":"forbidden: loopback-only"}`。没有 token，闸是传输层而不是凭据。挂了本插件就别把 DSH web 服务暴露到 localhost 之外。

| 方法 | 路径 | Body / 说明 |
|---|---|---|
| `GET` | `/api/dsh-session-manager/sessions` | — |
| `GET` | `/api/dsh-session-manager/tags` | — |
| `PUT` | `/api/dsh-session-manager/tags` | `{ "sessionId": "...", "tags": ["a","b"] }` |
| `DELETE` | `/api/dsh-session-manager/tags` | `{ "tags": ["a"] }` —— 从所有会话上摘掉这些标签 |
| `POST` | `/api/dsh-session-manager/sessions/move` | `{ "sessionIds": [...], "targetWorkspaceId": "..." }` 或 `{ ..., "targetPath": "...", "createIfMissing": true }` |
| `POST` | `/api/dsh-session-manager/sessions/delete` | `{ "sessionIds": [...], "backupDir": "..." }`（`backupDir` 可选） |
| `POST` | `/api/dsh-session-manager/sessions/archive` | `{ "sessionId": "..." }` |
| `POST` | `/api/dsh-session-manager/sessions/unarchive` | `{ "sessionId": "..." }` |
| `POST` | `/api/dsh-session-manager/projcache/warm` | —（诊断用：返回标题预热报告） |

状态码：工具返回 `ok: true` 时 `200`；业务失败或 body 格式错 `400`；非回环 `403`；方法不对 `405`；意外抛错 `500`。

请求体上限 1 MB，且必须是 JSON 对象。

```bash
curl -s http://127.0.0.1:3080/api/dsh-session-manager/tags
curl -s -X PUT http://127.0.0.1:3080/api/dsh-session-manager/tags \
  -H 'content-type: application/json' \
  -d '{"sessionId":"abc123","tags":["research","todo"]}'
```

## 几个实现细节

**移动要同步三处。** 物理移动（重写 zstd 头 + 目录改名）之后，还要重新索引 registry 头、调公开的 `attachSession` / `detachSession`，再通过 storage-domain 的表句柄更新投影缓存里的 `identity.cwd`。少任何一步，GUI 都会显示旧路径。

**启动时预热标题。** 冷会话在 `session.list` 里没有标题 —— 持久标题在投影缓存的 checkpoint 里，而 checkpoint 只有该会话在某个进程里被 attach 过才会写。重启后所有没打开过的会话都是冷的，侧栏于是退化成显示目录名。插件在挂载 800 ms 后扫一遍缺标题行的会话，调官方 `coldSnapshot(meta, inheritedEventCount, events)` 把 checkpoint 写回去。

校验既有标题行的「日志尾巴探测」是**关**的（`lib/index.js` 里的 `WARM_TAIL_PROBE = false`）。开着的话每次启动都要把全部会话的日志尾巴读一遍 —— 这是重启后侧栏慢的主因，实测约 620 个会话。代价是：投影缓存写入失败窗口内发生的改名，启动时不再被自动纠正；打开该会话时官方冷读阶梯仍会自愈。要恢复旧行为就把这个常量改成 `true`。

**归档走 registry。** 归档走 `archiveSession()` —— 和 GUI 用的同一个 add-only API。除了显式删除或反归档，插件从不重写归档集合；即便是那两种情况，也走 registry 公开的 `enqueueOperation` / `setState` 写链，保证 registry 的缓存状态一致。

**刻意零 import。** `lib/index.js` 只用 `node:` 内置模块。这个文件插件是通过原生动态 import 加载的，裸模块名只能从 profile 的 `node_modules` 解析；只用内置模块让它可以作为一个独立文件插件被加载（和 `zen-useragent.js` 同样的形态）。

## 配套插件

- [`dsh-session-tree`](https://github.com/minhaoli/dsh-session-tree) —— 消费本 REST API 的侧栏 UI（标签、分组、拖拽移动、删除）。它替换官方 `ui-workspace` bundle，同时安装时要把那一行 disable 掉。
- [`dsh-session-query-vector`](https://github.com/minhaoli/dsh-session-query-vector) —— 会话语义搜索后端。
- [`dsh-session-search`](https://github.com/minhaoli/dsh-session-search) —— 对话内查找栏。
- [`dsh-ui-reload`](https://github.com/minhaoli/dsh-ui-reload) —— 一键重载前端按钮。

## 许可

MIT —— 见 [LICENSE](./LICENSE)。
