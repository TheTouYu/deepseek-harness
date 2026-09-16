# local/patches/ —— 本机 dsh 本地补丁器（4 个）

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
for s in ensure-connstuck ensure-quotamisclass ensure-v0-tier-compat ensure-resume-cooldown; do
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
