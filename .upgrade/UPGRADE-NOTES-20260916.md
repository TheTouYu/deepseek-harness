# 升级准备：0.1.5-rc.2 → 0.1.6-alpha.1（盘点 + 干跑，**尚未执行**）

盘点时间 2026-09-16。结论一句话：**补丁侧已全部验证可用，但本机自定义的 ACP 压缩插件
`billion-context-dsh` 的 peer 上限把 0.1.6 挡在门外；不解决它就不能装。**

> **决定（2026-09-16，用户）**：**先不装，等官方出更稳定的版本再更新。**
> 理由：0.1.6 仍是 `alpha`，`c291e7961a → dsh-v0.1.6-alpha.1` 是 666 提交 / 5 天，
> 且本版含大批破坏性变更（删除 `agent/session-start`、PTC 命名统一、工作流执行器改名、
> 移除 E2B、配置热更新取消回滚）—— 面还在动，现在迁移等于在移动的靶子上做，进 `next`/rc 后大概率重做一遍。
> 在此之前不触碰全局安装，checkout 也不 rebase（保持 `master @ a0d0dfff35` 可随时回退）。
> 上报材料仍备好：`.upgrade/B1-upstream-report.md`（B1 是否解锁不再决定时机，但对方跑 CI 的结论对将来有用）。
>
> **"稳定"的判定标准（下次巡检按此判，别只看一个标签）**：
> ① `npm view @deepseek-ai/dsh dist-tags` 里 `next` 或 `latest` 指向 0.1.6 线（**别再只看 `latest`——它比 `next` 旧过两次**）；
> ② `packages/core/agent/src/runtime-types.ts` 里 `agent/created` 的 payload 与 `@mode` 已稳定（不再改动）；
> ③ 破坏性变更清单（PTC 命名 / 工作流执行器 / E2B / 热更新回滚）在连续两个 tag 之间无新增；
> ④ `billion-context-dsh` 上游 peer 已放开，或已确认放弃它。
>
> **教训（写进判据，防复发）**：09-14 的巡检只查了「`next` 标签 + `origin/master` 是否前进」，
> 得出"本机无可升级目标"；09-16 就被推翻。**判"能不能升"必须双向核对**——
> 除了看上游有没有动，还要反向核对**本机自有组件引用的包名/事件名是否还存在于新版本**。
> 本轮的 6 项迁移清单就是这条盲区里长出来的。

---

## 一、上游情况

| 项 | 值 |
|---|---|
| 新 tag | `dsh-v0.1.6-alpha.1` = `0a15e36e7f82b6ed45af6fa9759f29b40dcd965d`（2026-09-15 10:42:33 +0800，PR #4171） |
| `origin/master` | `0d1f50007f`（PR #4192 worktree-bootfast2），是 tag 的**后继** |
| 版本号 | tag 与 master 的 `package.json` 均为 `0.1.6-alpha.1` |
| 距本机基线 | `c291e7961a..origin/master` = **666 提交**；`..tag` = 661 |
| engines | `^22.19.0 \|\| >=24.0.0`（**未变**）；`packageManager: pnpm@11.7.0`（未变）。本机 node v26.7.0 ✔ |
| npm dist-tags | `alpha=0.1.6-alpha.1`、`next=0.1.5-rc.2`、`latest=0.1.5-rc.1` |

- ⚠ **`latest` 仍比 `next` 旧**，裸 `npm i -g @deepseek-ai/dsh` = 降级。要装必须点名版本。
- **会话格式无新代**：`session-format-catalog/src/generated.ts` 的 `currentVersion: 3` 两版相同，
  本次升级不引入新的 session 代际迁移 ⇒ 历史会话数据侧的迁移风险为零（补丁 3 仍是唯一相关项）。

## 二、包集合 churn（base → tag）

packages 272 → 283。

- **新增 21**：`api/terminal-controller`、`browser-use/browser-use`、`client/ui-settings-unarchive-sessions`、
  `client/ui-sidebar-terminal`、`compaction/compaction-image-offload`、`computer-use/computer-use`、
  `experimental/auto-review`、`experimental/browser-use-{chrome-devtools-mcp,playwright-mcp,runtime,stagehand-native}`、
  `experimental/computer-use-cua-driver-{mcp,native}`、`experimental/ptc-runtime-python`、`mcp/mcp-resources`、
  `ptc-runtime/{ptc-runtime,ptc-runtime-node}`、`ssh/{fs-ssh,sandbox-ssh,ssh,subprocess-ssh}`、`workflow/workflow-ptc`。
- **删除 10**：`client/runtime`、`code-runtime/{code-runtime,code-runtime-worker-thread}`、`e2b/{e2b,fs-e2b,subprocess-e2b}`、
  `experimental/code-runtime-python`、`host/apiproxy`、`session/session-persistence-sqlite`、`workflow/workflow-worker-thread`。
- `@deepseek-ai/dsh` 自身 deps 72 → 73：**+`dsh-mcp-resources`、+`dsh-workflow-ptc`、−`dsh-workflow-worker-thread`**。
- 本机全局安装里仍残留、上游已删的两个包：`dsh-code-runtime`、`dsh-workflow-worker-thread`（0.1.5-rc.2 产物）。

## 二·补 升级必改清单（2026-09-16 深挖 0.1.6 release notes 后的结论）

**这不是"升个版本"，是一次涉及本机 4 个自有组件的迁移。** 按代价从小到大：

| # | 组件 | 改什么 | 代价 | 遗漏后果 |
|---|---|---|---|---|
| 1 | `dsh-memo-river/src/index.ts:322` | `ctx.on('agent/session-start', …)` → `'agent/created'` | **极低**（一个事件名字符串） | **静默失效**：记忆注入不再发生，不报错 |
| 2 | `dsh-preset-composer/lib/capabilities.json` | 能力目录里 `workflow-worker-thread` → `workflow-ptc`；`lib/devguide.js` 事件表同改 | 低（数据/文档） | 生成的预设含已删包 |
| 3 | `local/patches/ensure-connstuck-patch.mjs` | 补 `/v1/messages` 端点锚点 | 低-中 | 断连卡死修复**只在旧协议上有效** |
| 4 | `local/patches/ensure-quotamisclass-patch.mjs` | 补 messages transport 分类器锚点 | 低-中 | 403 余额误报 AUTH 在新默认路径上复发 |
| 5 | `billion-context-dsh` | 放开 peer 上限（+ 对方应跑 tsc 验证弃用接口） | 低 | 组合挂不上 |
| 6 | `~/.dsh/.agent-presets/memo-river/agent.cordis.yml:285-288` | `workflow-worker-thread` → `workflow-ptc` | 低 | 预设挂载失败 |

**关键证据 · #1 的代价为什么极低**：两版的 payload **逐字段相同** ——
base `'agent/session-start'(this: Scoped<Agent>, payload: { agent: Agent; source: SessionStartSource }): void`
（`packages/core/agent/src/runtime-types.ts:316`）
vs tag `'agent/created'(this: Scoped<Agent>, payload: { agent: Agent; source: SessionStartSource; signal?: AbortSignal }): undefined | Promise<undefined>`
（同文件 `:261`）。`agent/session-start` 在 0.1.6 **全仓零命中**（已删除）。
memo-river 的处理函数本就把 payload 标成 `{ agent: AgentLike }` 并全程 try/catch，运行期改一个字符串即可。
语义差异：新事件是 `@mode serial` 且**被 await**（首次模型请求前完成初始化）——对记忆注入反而更早更稳。

**关键证据 · #3/#4 为什么必须做**：0.1.6 的 release note 明确「**DeepSeek 默认改用 Messages 协议**」，
而本机 `settings.yaml` 的默认 provider 就是内置的 `deepseek-official`
（`agent-default-model.provider: deepseek-official`，`agent-defaults.{main,agent,continuable}` 同）。
⇒ 升级后主路径从 `/chat/completions` 切到 `/v1/messages`，**恰好是两个补丁器没覆盖的那条路径**。
（该条另要求「如手动配置了旧官方根地址请移除或改为 `https://api.deepseek.com/anthropic`」——
本机 `baseURL` 只出现在 `llm-pi-ai.providers` 的中转站条目里，**官方根地址未手工配置**，这一项不适用。）

**已核实不受影响**：`snapshotEvents`/`eventAt`/`ownEvents` 是**弃用而非删除**，两版都在
（0.1.6 `packages/core/session/src/index.ts:632/646/663`，签名相同）；会话格式代仍为 3；
`engines` / `packageManager` 未变。

## 三、阻塞点（必须先解决才能装）

### B1 —— `billion-context-dsh` peer 上限卡在 `<0.1.6-0`（硬阻塞）

`/home/h/app/billion-context-dsh`（branch `deployed-dsh-0.1.5` @ `db01861`，version `0.2.21`）
的 peerDependencies 把 5 个 dsh 包封顶：

```
@deepseek-ai/dsh-compaction, dsh-session, dsh-llm, dsh-tools, dsh-settings
  均 >=0.1.5-alpha.1 <0.1.6-0
```

它是**自定义 web profile 的 bundle 之一**（`~/.dsh/profiles/web/package.json` 的
`dsh.profile.bundles` 含 `billion-context-dsh`，且 `node_modules/billion-context-dsh` 是 symlink）。
⇒ 宿主组合会引到 0.1.6 的 dsh 包，**peer 不满足**，是该插件作者主动封顶。

远端 `refs/heads/main` = `4ff9a85` = tag `v0.2.23`，**peer 上限仍是 `<0.1.6-0`**（v0.2.22 亦同）。
即：升到 0.1.6 不是"更新插件"能解决的，需要上游（Tyan66666）放开上限 + 回归验证。

**核查结论：这个上限没有对应的已知破坏，更像发版时的保守封顶。** 证据（详见
`.upgrade/B1-upstream-report.md`）：

- 插件运行期消费的 **8 个值导出全部存在**于 `dsh-v0.1.6-alpha.1`：`deriveEventMessage`（session）、
  `createUserMessage`（llm）、`defineTool`/`ToolArgsError`（tools）、`CompactionId`/
  `compactCheckpointSource`/`toolPairingBalancedAfter`/`toolPairingBalancedBefore`（compaction）、
  `SettingsConflictError`（settings）。来源文件 `src/{region,commands,host-tokens,tools,nudge}.ts`。
- 另抽查 **22 个类型名，0 缺失**（session 8 + llm 11 + tools 2 + compaction 4 中已含）。
- `dsh.bundle.patch` / `cordis.patch.yml` 层机制在 0.1.6 的 `packages/boot/app-boot/src/profile.ts` 未变。
- 无服务名冲突：0.1.6 新增的 `dsh-compaction-image-offload` 是 `inject = ['agents','sessions']`，
  **不 provide `compaction`**；`ctx.provide('compaction')` 仍只有 `compaction-basic`
  （`packages/compaction/compaction/src/index.ts:114`），插件禁它的那行在 0.1.6 的
  `packages/bundle/base/cordis.patch.yml:320-321` 仍在位。
- **残留风险（未排除）**：存在 ≠ 语义相同 —— `packages/core/session` +356/−82、
  `packages/core/tools` +775/−109，真正闸门是用 0.1.6 的 `.d.ts` 跑一遍 `tsc`。

历史里已有 `abae044 (fix) persist block-ledger fields in rawOutput, not as top-level members —
session logs stay openable after a host upgrade (#141) (#142)`，已在本地 HEAD 中。

### B2 —— memo-river 预设挂了已删包（预设挂载失败 ⇒ 就是 resume 风暴的触发条件）

`/home/h/.dsh/.agent-presets/memo-river/agent.cordis.yml:285-288`：

```yaml
- id: workflow-worker-thread
  name: '@deepseek-ai/dsh-workflow-worker-thread'
  config:
    provider: spawn
```

`@deepseek-ai/dsh-workflow-worker-thread` 在 0.1.6 **已删除**，替代品 `@deepseek-ai/dsh-workflow-ptc`。
交叉核对：memo-river 预设引用 24 个 dsh 包，**恰好这 1 个缺失**；plugin-dev 预设引用 14 个，0 缺失。
两者在 live 0.1.5-rc.2 下均 100% 可解析。

修法（照上游写法，`dsh-v0.1.6-alpha.1:packages/preset/agent-presets/presets/cordis/agent.cordis.yml:210-213`
与 `packages/bundle/base/cordis.patch.yml:372-375`）——`config` 字段不变：

```yaml
- id: workflow-ptc
  name: '@deepseek-ai/dsh-workflow-ptc'
  config:
    provider: spawn
```

`workflow-ptc` 的 `static inject = ['subagents','ptcRuntime','sandboxPolicy']`，`ptcRuntime` 由宿主组合提供
（bundle/base 有独立 `- id: ptc-runtime / name: '@deepseek-ai/dsh-ptc-runtime-node'` 行），**预设里不用补**。

> 这一条与补丁 4 是同一个故障链：预设挂不上 → resume 必失败 → 客户端无退避重试 → 组合风暴。
> 装了 0.1.6 而不改这条，等于亲手制造那个已被补丁 4 兜住的场景。

## 四、补丁侧：已干跑验证（四个全部可用）

方法：假 HOME（`.compat/0.1.6-alpha.1/home/...`）装 240 个 live 包 symlink + 4 个目标包换 0.1.6 tarball，
**不碰全局安装**。tarball 在 `.compat/0.1.6-alpha.1/tgz/`，pristine 副本在 `.compat/0.1.6-alpha.1/pristine/`。

| 阶段 | 结果 |
|---|---|
| pre-check（pristine 0.1.6） | 四个全 **exit=1 MISSING**（新装本来就没打） |
| apply（`TMPDIR` 指向 workspace） | 四个全 **exit=0**，各自落 `.bak-*` |
| post-check | 四个全 **exit=0** |
| `node --check` 四个补丁后产物 | 全通过；锚点均唯一 |

补丁 3 的探针在 pristine 上原样复现上游未修错误：
`SessionFormatError: compaction/summary 1 data has unexpected member "tier"`。

**⇒ 上游没有自行修复其中任何一个**：补丁 4（resume 闸门）在 `origin/master` 的
`packages/api/session-controller/src` 里 grep `cooldown|resumeFailures|RESUME_FAILURE` 无命中，
`composeAgent` 仍在 `src/agent.ts:401,414,424`；补丁 2 的 403→AUTH 仍在
`packages/llm/llm-deepseek/src/protocols/chat-completions/adapter.ts:98`。

### 干跑暴露的覆盖缺口（**升级前建议补，非阻塞**）

| # | 位置（补丁后 `dsh-llm-deepseek/lib/index.js`） | 性质 |
|---|---|---|
| 1 | `@2822` `await fetch(\`${connection.baseURL.replace(/\/+$/u,"")}/v1/messages\`, {` | **0.1.6 新增**的 Messages 协议路径，`freshConnectionFetch` 未覆盖（chat 路径 @1393 已覆盖） |
| 2 | `@2398` `if (status === 401 \|\| status === 403 \|\| ["authentication_error","permission_error"].includes(type)) code = "AUTH";` | **0.1.6 新增**的 messages transport 分类器，未覆盖 |
| 3 | `@1478` `FilesApiError` 的 `status === 401 \|\| status === 403 ? "AUTH" : … : "FILES_API"` | 旧版就有的既有缺口，本次未新增 |

补丁 2 的 marker 在两个产物中各 1 个；chat 分类器已改（`@1222 if (status === 401) return "AUTH";`）。
补丁 1 的 `freshConnectionFetch` 共 3 处（定义 @20、chat 调用 @1393、@2822 未覆盖）。

## 五、执行清单（确认要做时按序执行）

**阶段 0 —— 解锁（必须先做）**
1. 处理 B1：向上游 `Tyan66666/billion-context-dsh` 提 peer 上限放宽（或本地 fork 放开 + `pnpm link` 回 profile），
   并在 0.1.5-rc.2 上先跑通；未解锁前**不要**动全局安装。
2. 处理 B2：改 `~/.dsh/.agent-presets/memo-river/agent.cordis.yml:285-288` 为 `workflow-ptc`（文件在 `~/.dsh`，属 workspace 外，需提权或手改）。

**阶段 1 —— 工作区准备（workspace 内，可逆）**
3. 提交或 stash 未提交的 `local/patches/README.md`（rebase 前工作区必须干净）。
4. **把 `packages/client/ui-thinking-keywords/` 挪出 workspace**（它是未跟踪目录，被 pnpm-workspace 的
   `packages/*/*` 收录，其 package.json 有 14 个 lockfile 没有的依赖 ⇒ `--frozen-lockfile` 会先在
   「Recreating node_modules」阶段抹掉 `node_modules` 再报 `ERR_PNPM_OUTDATED_LOCKFILE`，
   `node_modules/.bin/tsc` 随之消失，而 `dsh-memo-river` / `dsh-preset-composer` 的 `scripts/build.sh` 依赖它）。
5. `git rebase origin/master`（或 merge）；`pnpm install --frozen-lockfile`，**退出码必须落文件判定**
   （`... > /tmp/pnpm.log 2>&1; echo $?`，管道给 tail 会吃掉退出码）。
6. 装完把 `ui-thinking-keywords` 挪回、`pnpm run build`（消费 checkout `node_modules/.bin/tsc` 的两个面板要一起重建）。

**阶段 2 —— 全局安装与切换**
7. `npm i -g @deepseek-ai/dsh@0.1.6-alpha.1`（点名版本；`latest` 是 0.1.5-rc.1）。
8. `systemctl --user restart dsh-web.service` —— 4 条 `ExecStartPre` 自动重打补丁；
   再跑四个 `--check` 巡检确认全绿。
9. 任何补丁器报 STALE：**先人工核对上游是否已自行修复**（本次核对结论：都没有），再按新布局更新锚点。

**回滚**
- 工作区：`.upgrade/backup-20260911-232447/`、git 分支本身。
- 全局安装：`cp` 补丁器旁边的 `.bak-*` 可回滚单个文件；整包回滚 `npm i -g @deepseek-ai/dsh@0.1.5-rc.2`。
- unit 备份：`~/.config/systemd/user/dsh-web.service.bak-20260914-*`（3 份）。

## 六、环境限制（做验证时会撞到）

bash 工具跑在 bwrap 里（`--ro-bind / /`、只 bind workspace、`--unshare-pid`、`--tmpfs /tmp`、继承 `TMPDIR=/var/tmp`）：

- `systemctl --user status` 失败（无 dbus）⇒ 看不到 `ActiveState`，服务状态需另找途径确认；
- `ps` 是 PID 命名空间内的，看不到宿主 dsh 进程（"内存是否含补丁"的判据要另找通道）；
- `/home/h/.npm` 等 workspace 外路径只读（`npm view` EROFS，改用 `curl registry.npmmirror.com`）；
- `TMPDIR=/var/tmp` 只读 ⇒ 补丁器的 tmp 语法预检会 EROFS 失败（**在写目标文件之前**，不留部分修改），
  等价于真实条件必须 `TMPDIR=<workspace 内可写目录>`；
- 非 workspace 的 git 仓库 `.git` 只读（`git fetch` 失败，`git ls-remote` 可用）。

## 七、当前状态（未改动任何东西）

- checkout：`master` @ `a0d0dfff35`（= 上游 `c291e7961a` + 1 个本地补丁提交），fork master 已同步该 SHA。
- 全局安装：**仍是 0.1.5-rc.2**，四个补丁器 `--check` 全绿 —— 与盘点前一致，本次只做了只读盘点与
  隔离目录内的干跑，未触碰 `/home/h/.npm-dlabal`。
