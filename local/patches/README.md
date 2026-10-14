# local/patches/ —— 本机 dsh 本地补丁器（7 个）

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
for s in ensure-connstuck ensure-quotamisclass ensure-v0-tier-compat ensure-resume-cooldown ensure-tooljsonrepair; do
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
2. 重启 `dsh-web.service` —— 四个补丁器会在启动前自动重打；用上面的巡检确认全绿。
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
