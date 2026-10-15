# local/patches/ —— 本机 dsh 本地补丁器（本目录 9 个 `.mjs` + 1 个外挂守卫 = 10 条接线）

> 台账序列号（下表的 #）按**接线引入顺序**编号，因此含外挂的 `ensure-profile-version.mjs`（#6）；
> 目录里的 `.mjs` 现有 9 个（#5 `plugin-identity`、#7 `tooljsonrepair`、#8 `contextrow`、
> #9 `identity-dedup`、#10 `sendmessage-disambiguation` 是后加的，其中 #5/#6 只在下面「升级到 0.2.0-rc.2」一节有文字记录）。

> 这一批补丁原住在 `dsh-routing-suite`（已弃用）。现在**就住在本 fork**（`TheTouYu/deepseek-harness`）的 `local/patches/`，
> 与官方树同仓、随分支一起推送 —— 不再需要一个单独的补丁仓库。

它们改的是**全局安装里的 dsh 产物**
（`~/.npm-dlabal/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/<pkg>/lib/index.js`），
`npm i -g @deepseek-ai/dsh` / dsh 升级会**整体覆盖** ⇒ 每个补丁配一个**幂等补丁器**，接在
`~/.config/systemd/user/dsh-web.service` 的 `ExecStartPre`，启动前自动重打。

**普查口径**（2026-09-14 全量普查，不是抽样）：整个 `~/.npm-dlabal/lib/node_modules` 搜
`*.bak*` / `*.orig` / `*.rej` / `*.patch` / `*.reference-*`，**再**扫安装树里 mtime 晚于安装时刻
（2026-09-11 23:25）的全部文件；两侧命中同一批 = 4 个包。另确认系统里没有第二份 dsh 安装副本。

| # | 补丁器 | 目标包 | 修的什么 | 健康判定 | 备份 |
|---|---|---|---|---|---|
| 1 | `ensure-connstuck-patch.mjs` | `dsh-llm-deepseek` | undici 全局 keep-alive 池留下"半死" socket → 网络抖动后每次重试复用死连接、直到 300s idle watchdog，**重连永久卡死**。改为每次新连接（`agent: false` + 10s connect 超时）；v3 补回 v1/v2 误删的 `brandString` import（症状：一调工具就 TRANSPORT） | marker（v3） | `.bak-connstuckfix-*` |
| 2 | `ensure-quotamisclass-patch.mjs` | `dsh-llm-pi-ai` + `dsh-llm-deepseek` | 401/403 一律判 AUTH ⇒ 中转站余额不足（403 insufficient balance / 预扣费 / 剩余额度）被 UI 误报 "API key invalid"。改为只 401 判 AUTH、403 余额类判 QUOTA | `// ponytail: billing/quota 403s` | `.bak-quotafix-*` ×2 |
| 3 | `ensure-v0-tier-compat-patch.mjs` | `dsh-session-format-v0-to-v1` | v0→v1 迁移器用**冻结的已发布成员清单**严格校验 `compaction/summary`，而本机历史会话由带 ACP（billion-context-dsh）的构建写入、多带 7 个成员（tier/kernelBlockId/topic/parentBlockIds/directMessageIds/effectiveMessageIds/verifiedReadings）⇒ **542 个 v0 会话全部打不开**。必须补进**第二个参数 optional**（第三个 opaque 不授予成员资格；试错产物留作 `.reference-wrong-slot-opaque-*`） | 跑**真校验器探针**，不看 marker | `.bak-v0tier-*` ×2、`.bak-wave2-*` |
| 4 | `ensure-resume-cooldown-patch.mjs` | `dsh-api-session-controller` | 预设挂载失败 ⇒ 该会话 resume 必失败，而 `resumeObserved` **先 `composeAgent` 再 `agents.resume`**、失败即释放去重槽位 ⇒ 客户端无退避重试的每一次都要重挂整套组合（实测 80 req/s × 0.47s CPU = 空闲实例 **825.1s/805s = 102.5%** 一核 13 分钟，日志零行）。加 `RESUME_FAILURE_COOLDOWN_MS = 1000` 失败闸门 + 失败赋名 | 行为签名 + **真 `import()`** | `.bak-resumecool-*`；原始件 `.bak-20260914-storm`；手工版 `.bak-handpatched-20260914` |
| 7 | `ensure-tooljsonrepair-patch.mjs` | `dsh-llm-deepseek` | 模型漏转义内层引号（`{"command":"echo "hi""}`）⇒ `content_block_stop` 收口把非法 JSON 交付给工具、`message_stop` 预校验抛 `MALFORMED_RESPONSE` **判死整个 turn**（0.1.5 是容忍原文让模型自纠，属行为回归；宿主全史 39/139,329 ≈ 1/3500）。收口处改调**收窄的错误位置驱动修复器**：只在 V8 报 "Expected ',' or '}' after property value" 时转义候选引号，最多 8 轮，其余一律原样放行交给 retryPolicy | marker + 两个注入点都在位 | `.bak-tooljsonrepair-*` |
| 8 | `ensure-contextrow-visible-patch.mjs` | `dsh-client-ui-chat` | 对话视图**看不到任何注入的上下文消息**（记忆召回、指令更新、skill/插件注入、压缩提醒），必须切「轨迹」才看得到。根因：`isVisibleChatNode` 把整类 `context` 节点剔除（只给 tool-addition/removal 例外），而注入消息在 chat 侧一律建 `context` 节点、只有「开启回合」的才升级成可见的 `turn-trigger`；实测注入落在**回合内步骤边界** ⇒ 永远被剔除。删掉该支，恢复 0.1.7 前行为（system-prompt / permission 仍隐藏） | marker（`// ponytail: context-rows-visible`） | `.bak-contextrow-*` ×2 |
| 9 | `ensure-identity-dedup-patch.mjs` | `dsh-web-app` | persona 里与宿主 `harness:identity` **重复的第二句身份**（`You are a coding agent powered by the {{model}} model.`，用户 2026-10-14 裁决删除）。4 处（根 `cordis.patch.yml` 的 `system-prompt.personaPrefix` + 3 个 presets 的 `persona.prefix`，两种 YAML 标量形态）一律改空串；persona `suffix`（cwd 行）不动 | 该键解析为空串 + `# ponytail: persona-identity-dedup` 注释（三态见下文，另验 `verify/identity-dedup/test-identity-dedup.mjs`） | 无（纯配置行，回滚 = 还原该行 / 重装该包） |
| 10 | `ensure-sendmessage-disambiguation-patch.mjs` | `dsh-tool-subagent-control` + `dsh-tool-subagent` + `dsh-subagent` + `dsh-experimental-agent-team` | **同名双工具遮蔽**：subagent-control 全局版与 agent-team per-agent 版都注册 `send_message`（参数 `agent_id` vs `target`），Team 会话里后者遮蔽前者 ⇒ 模型拿 subagent 的 UUID childId 调用必报 `active teammate "…" not found`（决策模型 Lead 会话实证，D133）。改法：全局版改名 `message_agent` + subagent 续聊承诺/子代理引导文本/按名查找同步改名 + agent-team 版对 UUID target 追加错误引导 | `--check` 9 锚点三态；headless 真会话行为读数 | `.bak-sendmsg-*` ×9 |

## 接线（`~/.config/systemd/user/dsh-web.service`）

每条都包一层**缺文件保护**：`local/patches/` 是 git 工作区的一部分，
一旦有人 `git checkout` 到别的分支（例如去改上游 PR 分支），这些文件会从工作区消失 ——
那时必须**跳过补丁而不是让宿主起不来**：

```ini
ExecStartPre=/bin/bash -c 'f=/home/h/app/deepseek-harness/local/patches/ensure-connstuck-patch.mjs; if [ -f "$f" ]; then exec /usr/sbin/node "$f"; else echo "local-patches: $f missing (branch switched?) — skipped" >&2; fi'
# 另三条同形：ensure-quotamisclass / ensure-v0-tier-compat / ensure-resume-cooldown
```

巡检（0=健康 / 1=需重打）：

```bash
for s in ensure-connstuck ensure-quotamisclass ensure-v0-tier-compat ensure-resume-cooldown ensure-plugin-identity ensure-tooljsonrepair ensure-contextrow ensure-identity-dedup ensure-sendmessage-disambiguation; do
  node /home/h/app/deepseek-harness/local/patches/$s-patch.mjs --check; echo "$s exit=$?"
done
```

## 约定与陷阱

- **`--check`：0 = 健康，1 = 缺失/需重打**；可直接当闸门/巡检用。
- **备份命名**：`<target>.bak-<原因>-<ISO 时间戳>`，写在目标文件旁边，`cp` 回去即回滚。
- **失败语义**：补丁 1/2/3 在"锚点找不到"时**返回非 0 ⇒（经上面的包装）会阻止 dsh 启动**；
  补丁 4 **刻意相反**（可用性优先）：默认放行并落 `/var/tmp/dsh-resume-cooldown-patch.status` 留痕，
  要阻止启动才加 `--strict`。
- **⚠ 位置即契约**：`ExecStartPre` 按**绝对路径**引用脚本。2026-09-14 实测踩过两次：
  ① 把被引用的文件只提交到分支、再 `git checkout main` → 工作区文件消失 → `node` 退出 1 → **dsh 起不来**；
  ② 仓库停用时引用它的 unit 没有同批迁移 → 悬空路径留在启动路径上。
  判据：**任何被 unit / 脚本按路径引用的文件，都必须常驻当前分支的工作区；搬迁时 unit 必须同批改。**

## 升级 dsh 之后要做什么

1. `npm i -g @deepseek-ai/dsh@<新版本>`（注意：`latest` 标签可能比 `next` 旧，别把小版本装回去）。
2. 重启 `dsh-web.service` —— 九个补丁器（`apply-all.sh` 列表）会在启动前自动重打；用上面的巡检确认全绿。
3. 某个补丁器报 `STALE`（锚点找不到）时：**先人工核对上游是否已自行修复**——
   已修复就摘掉该 `ExecStartPre` 并删脚本；未修复再按新布局更新锚点（脚本里的 `old`/`new` 是自解释的）。
4. unit 备份：`~/.config/systemd/user/dsh-web.service.bak-20260914-patchwiring`（首次接线）、
   `.bak-20260914-patchhome`（从 routing-suite 搬出）、`.bak-20260914-patchfork`（搬到本 fork）。

## 巡检记录

**2026-09-14（升级判定）：本机无可升级目标。**

- `npm view @deepseek-ai/dsh dist-tags` → `next=0.1.5-rc.2`（= 本机已装）、
  `latest=0.1.5-rc.1` —— **`latest` 比 `next` 旧，按 `latest` 装等于降级**（这条每次都值得重看一眼）。
- `git fetch origin master` → `origin/master = c291e7961a`（`release-0.1.5-sync-master`，**未前进**）；
  本地 `master = a0d0dfff35` = 上游 + 本提交（补丁脚本与本文档）。
- 四个补丁器 `--check` **全部 exit=0**；宿主 `dsh-web.service` 的 `ExecStartPre` **4 条在位**，
  `ActiveState=active`。

**⚠️ 生效范围（内存 vs 磁盘）**：补丁 4 落盘 `20:31:11`，宿主 3100 进程起于 `16:49:32`
⇒ **运行中的宿主内存里仍是未打补丁的旧代码**，下次 `systemctl --user restart dsh-web.service`
才生效（重启前该实例遇预设挂载失败仍会 resume 风暴）。沙箱 3102 / 3105 / 3106 / 3109 都是
补丁之后启动的，均已含补丁。

**判据（方向别写反）**：`stat -c %Y /proc/<pid>`（进程创建时刻）与目标文件 mtime 比大小 ——
**进程晚于补丁 = 内存含补丁**。2026-09-14 我把这个判据写反过一次，整列输出全反，
差点得出"宿主已含补丁"的相反结论。

**2026-09-16（升级判定）：出现可升级目标 `0.1.6-alpha.1`，但仍不能装。**

- `npm` dist-tags → `alpha=0.1.6-alpha.1`、`next=0.1.5-rc.2`（= 本机已装）、`latest=0.1.5-rc.1`
  —— **latest 依旧比 next 旧**，装必须点名 `@0.1.6-alpha.1`。
- `git fetch origin master` → `origin/master = 0d1f50007f`（**前进了 666 提交**），新 tag
  `dsh-v0.1.6-alpha.1 = 0a15e36e7f`（2026-09-15）。engines / packageManager / 会话格式代际均未变。
- **四个补丁器已在 0.1.6-alpha.1 上干跑通过**（假 HOME，不碰全局安装）：pre-check 全 MISSING、
  apply 全 0、post-check 全 0、`node --check` 全通过；上游**没有**自行修复其中任何一个。
  干跑另暴露两处 0.1.6 新路径未覆盖：`/v1/messages` 端点（补丁 1）与 messages transport 的
  401/403 分类器（补丁 2）。
- **装不了的硬阻塞**：`billion-context-dsh` 的 peerDependencies 把 5 个 dsh 包封顶在 `<0.1.6-0`
  （远端 v0.2.23 仍如此）；另 memo-river 预设第 285–288 行挂了 0.1.6 已删的
  `@deepseek-ai/dsh-workflow-worker-thread`（替代品 `dsh-workflow-ptc`）。
- 完整盘点、阻塞细节与执行清单：`.upgrade/UPGRADE-NOTES-20260916.md`。
- 全局安装**未改动**（仍 0.1.5-rc.2，四补丁 `--check` 全绿）。

**2026-09-16（升级判定）：官方出了 `dsh-v0.1.6-alpha.1`，本机决定暂不升级。**

- 新 tag `dsh-v0.1.6-alpha.1`（`0a15e36e7f`，2026-09-15）已出现，`origin/master` 前进到 `0d1f50007f`
  （比本机基线 `c291e7961a` 多 666 提交）；npm 上它挂在 **`alpha`** 标签（`latest` 仍比 `next` 旧，这一条每次都要重看）。
- **四个补丁器已用假 HOME 干跑过 0.1.6-alpha.1**：pre-check 四个全 MISSING，apply + post-check 四个全 exit=0
  ⇒ 补丁在新版本上**依然可用**，且上游一个都没自行修复。
- **干跑暴露两个覆盖缺口**（0.1.6 起 DeepSeek 默认改用 Messages 协议，而本机默认 provider 就是内置
  `deepseek-official` ⇒ 这两条缺口直接落在**主路径**上）：补丁 1 未覆盖 `/v1/messages` 端点；
  补丁 2 未覆盖 `protocols/messages/transport.ts` 的 401/403 分类器。
- 升级还牵动另外 4 项本机自有组件（memo-river 的 `agent/session-start` 事件在 0.1.6 被删、
  preset-composer 能力目录、ACP 插件 peer 上限、memo-river 预设）——完整清单与判据见
  `.upgrade/UPGRADE-NOTES-20260916.md`。
- **判定：等官方出更稳定的版本再升。**

## 与本仓库上游的关系

本分支（`master`）比 `origin/master`（官方）多的是**本地提交**：这些补丁脚本与本文档。
要与官方同步时：

```bash
git fetch origin master && git rebase origin/master   # 或 git merge origin/master
```

上游 PR 分支 `fix/resume-failure-cooldown`（resume 闸门的平台侧修复）是另一条线，
因官方不接受外部 PR，改以 Discussion #6622 报出：<https://github.com/deepseek-ai/deepseek-harness/discussions/6622>

## 2026-10-14 升级到 0.2.0-rc.2 + 安装根迁移 + 新增第 5/6 补丁器

- **安装根迁移**：全局 dsh 从 `~/.npm-dlabal/lib/node_modules` 迁到
  `~/.local/lib/node_modules` 后，四个老补丁器的硬编码路径全体失联
  （既没接线也没生效，静默失效多时）。本日改为自适应：
  `$DSH_INSTALL_ROOT` 优先，缺省 `~/.local/lib/node_modules`；个别脚本支持 `--root`/`--target`。
- **上游 dsh-v0.2.0-rc.2 已合并进本 fork master**（merge commit 4e238def86）。
  四个老补丁器在 0.2.0 上重新干跑：全部 MISSING（上游一个都没修），apply 后全绿。
  v0-tier-compat 的探针在 0.2.0 上实测复现 `SessionFormatError: ... member "tier"`——542 个 v0 会话打不开的病还在。
  唯一例外：quotamisclass 的 dsh-llm-deepseek 侧分类点（`function httpErrorCode(`）在 0.2.0
  已不存在（协议改 Messages），该锚点 skip 不算红；dsh-llm-pi-ai 侧仍在打。
- **新增 `ensure-plugin-identity-patch.mjs`（第 5 个）**：app-boot `initProfile` 生成的
  profile package.json 只有 name 没 version，而 plugin-package-inventory-deepseek 的
  `identityFromManifest` 要求双非空并抛错 → profile 挂相对 `.mjs` 行时每轮请求
  REQUEST_EXTENSION 全炸（2026-10-14 生产事故）。补丁 = 匿名路径 version 缺失降级
  "0.0.0" + initProfile 模板补 version。fork 源码同构修复在 816e974451。
- **第 6 个防线**：`ensure-profile-version.mjs`（位于 dsh-plugins/dsh-preset-composer/scripts/）
  扫 `~/.dsh/profiles/*/package.json` 自动补 version——防宿主/插件管理器再次重写丢字段。
- **接线统一**：`~/.config/systemd/user/dsh-web.service.d/local-patches.conf` 的
  ExecStartPre 调 `apply-all.sh`（本目录，逐个跑、缺席目标 exit 2 不阻断启动——可用性优先）。
- **0.2.0 已上游修复、相应本地补丁退役**：dsh-client-patches 0001（Firefox
  `hasIntrinsicConstructor` 兼容）——0.2.0 改为双侧 `Function.prototype.toString.call(...)`
  比较，SpiderMonkey 格式天然通过；实测安装版 client.js 与纯净 tarball 逐字节一致。

## 2026-10-14 新增第 7 个补丁器：`ensure-tooljsonrepair-patch.mjs`

**病**：模型偶发漏转义内层引号（`{"command":"echo "hi""}`），`translate()` 在 `content_block_stop`
把 `block.json` 原样收进 `arguments`，`message_stop` 对每个 tool-call 逐个 `JSON.parse`，
失败即 `malformed("tool input is invalid JSON")` ⇒ `MALFORMED_RESPONSE`，**整个 turn 判死**。
0.1.5 的主循环 `parseArguments` 容忍非法 JSON（catch 透传原文 → 工具报错 → 模型自纠），
1.7 起的 Messages 适配器在 message_stop **抢先预校验** ⇒ 行为回归。
宿主全史实测 39 / 139,329 次工具调用 ≈ 1/3500（`.compat/scan-bad-args.mjs`），单次即打断会话。

**为什么必须在收口处修**：下游 `dsh-llm` 的 `BlockAssembler.push` 遇 `block-end` 直接
`partial.block = chunk.block`（快照优先于逐片累积的 `toolCallArguments`）——
交付给工具的字符串在 `content_block_stop` 那一刻就定型了，在 `message_stop` 处再改已经晚了。

**修复的收窄口径**（宁可整轮失败，绝不把猜出来的参数交给工具）：
- 只在 V8 报 `Expected ',' or '}' after property value in JSON at position N` 时动手。
  **数组**漏逗号报的是 `after array element`，类别不同 ⇒ 天然被排除
  （否则 `["a" "b"]` 会被悄悄并成一个元素）。
- 报错位置是引号时，只在这条引号**连闭合引号都没有**（不可能当新成员键）时才断定
  「前面的引号才是漏转义的那个」；有闭合引号即语义不明（漏逗号/漏冒号都可能）⇒ 不猜。
- 候选引号必须未被转义（前面反斜杠个数为偶）；最多 8 轮；任一条不满足即原样返回。
- 原样返回 ⇒ 下游照旧 `MALFORMED_RESPONSE`，由 provider `retryPolicy` 兜底重发
  （`retryableCodes` 需含 `MALFORMED_RESPONSE`，prod 档 maxRetries: 8）。

**验收（三层，全部可重跑）**，脚本在 `dsh-plugins/.scratch/invalidjson/`：
1. 配置级 `verify-config-accept.mjs` 16/16：直接读 `~/.dsh/profiles/web/cordis.patch.yml` 真文件，
   喂进安装树真实的 `Config → plainOptions → resolveRetryPolicy` 三段链；负面（未知 mode /
   未知 key / 重复码 / 空码表 / initial>max）全被拒，证明闸门非空转。
2. 算法级 `test-repair-algorithm.mjs` 22/22：从**打过补丁的真实文件**里抽函数逐案跑
   （5 个正面修成模型本意；11 个负面——合法 JSON / 漏逗号 / 漏冒号 / 数组漏逗号 / 尾逗号 /
   多花括号 / 截断 / 未闭合字符串——全部逐字节原样返回，一个都没偷偷修）。
3. 端到端 `test-adapter-e2e.mjs` 16/16：自签 TLS 本地服务发真 SSE 流，
   真 `DeepSeekAdapter.stream()` 跑完 parseSse → translate → 收口。
   同一份用例对**上游原文件**再跑一次做对照：原文件 canonical 案判死
   `MALFORMED_RESPONSE`，补丁后修成 `{"command":"echo \"hi\""}` 且不抛；
   合法入参两侧都逐字节恒等；结构病两侧都判死且吐出的仍是原文。

**升级演练（照 README「升级 dsh 之后」做）**：把纯净 `.bak-*` 拷回覆盖 ⇒ `--check` 报 MISSING(1)
⇒ `bash apply-all.sh` 七项全 OK ⇒ `--check` 0，三层验收重跑全绿。即 npm 升级覆盖补丁后，
启动前 `ExecStartPre` 会自动重打，无需人工。

**遗留**：上游源码同构病仍在 `packages/llm/llm-deepseek/src/translate.ts`（message_stop 的
`JSON.parse(content.arguments)` 预校验）——本补丁只覆盖安装树产物；若要走上游通道，
可照 quotamisclass 的先例提 Discussion。

## 2026-10-15 新增第 8 个补丁器：`ensure-contextrow-visible-patch.mjs`

**症状（用户报）**：浏览器对话视图里看不到自动注入的上下文消息——自动召回的记忆横幅、AGENTS.md
指令更新、skill/插件注入、压缩提醒全都不见了；点「轨迹」视图才能看到全部消息。

**根因（源码 `packages/client/ui-chat/src/client/contract/chat-visibility.ts`）**：
`isVisibleChatNode(node)` 把整类 `context` 节点从 chat 行剔除，只给
`tool-addition`/`tool-removal` 开了例外：

```ts
return node.visibility === 'visible'
  && node.kind !== 'system-prompt'
  && (node.kind !== 'context'
    || node.data.content.some(b => b.type === 'tool-addition' || b.type === 'tool-removal'))
  && !(node.kind === 'command' && node.data.name === 'permission')
```

上游本身是自洽的：`conversation-nodes/message.ts` 对 `source.kind !== 'user'` 的消息一律建
`kind:'context'` 节点（`visibility` 默认 `'visible'`，没有第二道闸），只有「被 next-turn 认领、
**开启**回合」的那类会被 `buildViewNode` 升级成 `turn-trigger`（可见）。但实测注入位置是
**回合内的步骤边界**——`tool/result → step/end → step/start(1/N) → user/message(memo-river)`，
不是回合起点 ⇒ `waking=false` ⇒ 永远被剔除。四个消费点全在 chat 侧：
`chat-snapshot-builder` / `turn-navigation` / `turn-process-presentation` / `process-groups`；
**轨迹视图 `ui-trajectory` 是独立投影，不引用该判据**，这解释了「轨迹里全有」。

**回归点**：该文件由上游 `776efdf321`「fix(ui-chat): hide infrastructure rows and retain turn
triggers」（lsdsjy，2026-09-17 提交 / 09-18 合入）**新建**，初版就写死 `node.kind !== 'context'`；
`7e5f906945`（09-21）只加了 tool 变更例外。此后（含 `rel/dsh-0.1.7-rc.2` 合并点 `477b4f4205`）
上游**再无改动、未修**。

**修法（2026-10-15 用户选定 A 案）**：删掉 `context` 那一支，恢复 0.1.7 之前的可见行为；
`system-prompt` 行与 `permission` 命令仍隐藏。依据：契约层 `context-producer.ts` 明确要求
「本 UI 不认识的 producer 也要保持可见」（opaque 兜底已实现），可见性闸门却把整类节点丢掉——
本补丁让两层语义重新一致。落点是客户端产物
`dsh-client-ui-chat/lib/client.js:7718`（单行判据，全安装树唯一副本）+ 同步 `.d.ts` 文档注释。

**验收（四层，全绿）**：
1. 静态：`node --check` 过；marker 各 1；`diff -u` 对备份 = 1 行换 3 行（1 删 1 改 + 2 行注释）。
2. 幂等：`--check` 前 1（MISSING）→ 打完 0；`apply-all.sh` 八项全 OK。
3. 判据级 A/B（`local/patches/verify/contextrow/test-visible.mjs`，**从补丁后的真实字节里抽出函数执行**，
   喂真实会话数据造的节点）：9/9 PASS；行为变化恰好 2 项——记忆召回与指令更新由「隐藏」转「可见」
   （tool 变更本来就是例外，system-prompt / permission / 显式 `visibility:'hidden'` 仍隐藏）。
4. 浏览器级 A/B（沙箱 3105 + chromedriver，**同一会话、同一沙箱，只换安装树产物**）：
   纯净 0 行「上下文注入」/ 补丁 3 行（正好对应会话里的 `agent-instructions` + `runtime-context`
   + `memo-river` 三条注入），正文长度 4070 → 4164。

**升级演练**：还原纯净产物 → `--check` 1 → `apply-all.sh` 八项 OK → `--check` 0 → 浏览器复验仍 3 行。

## 2026-10-15 新增 `ensure-identity-dedup-patch.mjs`（本目录第 8 个 / 台账序列 #9）

**病（用户 2026-10-14 裁决）**：宿主 `harness:identity` 已经给出身份行（"You are an AI agent
powered by DeepSeek Harness"），`dsh-web-app` 的 patch 配置又往 persona 追加一句同义身份
`You are a coding agent powered by the {{model}} model.` —— 两句重复，后一句冗余，删。
该句同族共 8 个位点（记忆河 D136）：river-acp / river-acp-dev 的 `compose.source.json` +
`cordis.patch.yml` 4 处、memo-river bundle 1 处、**上游包 `dsh-web-app` 4 处**；本补丁器只覆盖后者
（其余位点当晚已手改，`grep -c` 复核 0 命中——但它们**没有补丁器**，见文末遗留）。

**落点（4 处，两种 YAML 标量形态；键路径是解析后实测，不是猜的）**：

| 文件 | 键路径 | 上游形态 | 改后 |
|---|---|---|---|
| `cordis.patch.yml` | `$[0].config.personaPrefix` | `>-` 块标量两行 | `personaPrefix: ''` |
| `presets/cordis.patch.yml` | `$[0].insert[0].config.plugins[0].config.prefix` | `>-` 块标量两行 | `prefix: ''` |
| `presets/ptc.patch.yml` | 同上 | 单行标量 | `prefix: ''` |
| `presets/standard.patch.yml` | 同上 | 单行标量 | `prefix: ''` |

persona 的 `suffix`（`Your working directory is {{cwd}}.`）与其余 30+ 个 plugin 行不受影响。
锚点/替换串**逐字节取自 0.2.0-rc.2 的 npm tarball**（从 `~/.npm/_cacache` 还原的纯净件，
`sha512-pCIMPLfTKVfY942dP4eJSDVw7iUw86pemzfOr/e5DWP7CdCKTfvA82kP0RJAKJcyKJd8s679hqtCue/p4P20Dg==`）
——不凭记忆写锚点，这是本类配置补丁最容易翻车的地方（D136 记过：同一份配置里 `\n` 转义的双引号形态
与单引号裸串形态并存，必须按形态分别锚定）。

**状态语义**（`--check` 只诊断、绝不写盘）——比老补丁器多一档 **SKIP**，因为这里「站点整块消失」
是**可能合法**的上游变化（上游自己删掉 persona prefix 也等于达成目的）：

| 态 | 判据 | 退出码 |
|---|---|---|
| OK | 该键的值已是空串（`''` / `""` 都认） | 0 |
| MISSING | 锚点命中（= 上游原样） | 1（非 `--check` 时执行替换，并在键上方插一行 `# ponytail: persona-identity-dedup` 注释） |
| STALE | 键还在但值非空、锚点未命中（上游改写了那句身份句） | 1 |
| SKIP | 该键整块不存在 | 1（警告：人工确认后可摘掉本条） |
| — | 目标文件不存在（目录布局变了） | 2 |

**验收（可重跑，不碰真实安装树）**：
`node /home/h/deepseek-harness/local/patches/verify/identity-dedup/test-identity-dedup.mjs` —— 23 项全绿：

- A 真实安装树 `--check` = 0（四处全 OK）；
- B 正向 A/B：拿**纯净 tarball 原样**铺进 mock 安装根（脚本支持 `--root`）⇒ `--check` MISSING×4 / exit 1
  ⇒ apply 后 OK×4；apply 产物与真实安装树 **YAML 语义逐键相等**（`yaml` + `js-yaml` 两个独立解析器都验），
  且**去掉 marker 注释行后逐字节相等**（证明补丁没碰别的字节）；
- C STALE（改写身份句）/ D SKIP（整块删掉）都 exit 1 且不写盘；E 目标不存在 = exit 2；F 连打两次不写盘。

**为什么不做备份文件**：改的是一行配置值（`>-` 两行 → 空串一行），`.bak-*` 只会污染包目录；
回滚 = 重装该包或还原该行。

**遗留（不在本补丁器范围）**：`~/.dsh/preset-bundles/{river-acp,river-acp-dev,qxqy-river}/` 里的
4 个身份句位点没有补丁器覆盖（当前已手改为 0 命中）——预设 bundle 重建/迁移时会静默回来；
memo-river bundle 那处在仓里（`dsh-memo-river/bundle/`，且安装侧是指向仓源的符号链接），随 git 走。

## 2026-10-16 新增 `ensure-sendmessage-disambiguation-patch.mjs`（本目录第 9 个 / 台账序列 #10）

**病（决策模型项目 Lead 会话实证，preset-composer 桶 D133/D134）**：`dsh-tool-subagent-control`
与 `dsh-experimental-agent-team` 各注册一个 `send_message`（参数 `agent_id` vs `target`）。
agent-team 版按 per-agent 通道遮蔽全局版后，subagent 工具描述仍承诺「returns a subagent id you
can continue with send_message」——模型照做必报 `active teammate "<uuid>" not found`。

**改法（4 包 6 文件 9 锚点）**：全局版改名 `message_agent`（含 interrupt_agent 描述同步）；
subagent 工具续聊承诺、子代理回消息引导文本（bundle+源两份）、运行时按名查找
`get("send_message")`→`get("message_agent")` 同步改名；agent-team 版 `resolveActiveMember`
的 UUID 形状 target 追加错误引导「continue a subagent with message_agent({agent_id})」。
改名顺带修复 Team 会话 guidance 失效（按名查找此前拿到无标记的 agent-team 版）。

**状态语义**：`--check` 0=健康 1=需重打 2=目标异常（巡检口径），退出码判定 CHECK 优先于 anomalies 放行。
**验收（③级行为读数）**：`dsh headless` 真会话模型自报 `message_agent | agent_id,message`；真建
continuable 子代理后子会话文件 `message_agent({ agent_id` ×2、旧文本 0 残留。
**注意**：本补丁器 2026-10-15 曾误落 `~/app/dsh-stack/patches/`（换机安装器，非运行时 home），
2026-10-16 迁至本目录并接入 apply-all.sh 第 10 项，dsh-stack 侧已 revert。
