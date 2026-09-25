# 迁移清单 v2 —— DSH 0.1.5-rc.2 → 0.1.7-rc.2

> 合并 2026-09-16（0.1.6 的 6 项）与 2026-09-25（0.1.7 的新增面）两次评估。
> 执行顺序见文末「三步走」。**先读「不可逆项」，那是唯一真正需要小心的部分。**

## 一、不可逆项（这三条决定了为什么要先演练）

| # | 事项 | 为什么不可逆 | 缓解 |
|---|---|---|---|
| I-1 | ~~会话日志 v0/v3 → V4~~ **【已实测解除】** | 实测：在 rc.2 上打开一条 v0 会话后，目录里**追加**了 `session.v4.jsonl.zstd`，而原 `session.jsonl.zstd` **逐字节未变**（`cmp` 通过）。⇒ **迁移是追加新代、不覆盖旧代**，与 `AGENTS.md` 的承诺一致，**降级可读**。 | 仍建议备份，但不再是「不可逆」项 |
| I-2 | **`settings.yaml` 仅导入一次** | 0.1.7 起设置由当前 Profile 的插件配置保存；旧文件「仅尝试导入一次」。本机那份含 9 个中转站 + 4 个模型配置，一次没弄对就没有第二次自动机会。 | 备份 `~/.dsh/settings.yaml`；导入后逐项核对（尤其 `llm-pi-ai.providers` 与 `agent-defaults`） |
| I-3 | **旧目录预设不再被任何代码读取** | `$DSH_HOME/.agent-presets/<id>/` 在 0.1.7 完全失效（官方原话 *Nothing reads that directory any more*）。记忆河流的唯一载体就在那儿。 | bundle 已生成（见下）；**删旧目录只能在 bundle 安装并验证之后** |

## 二、迁移矩阵

| # | 组件 | 0.1.7 要做什么 | 状态 |
|---|---|---|---|
| 1 | 全局 dsh 安装（live `0.1.5-rc.2`） | 升到 `0.1.7-rc.2`。命令必须写明确版本号：**`npm i -g @deepseek-ai/dsh@0.1.7-rc.2`** —— `latest` 仍指 `0.1.5-rc.3`，裸装等于降级 | 待做 |
| 2 | 四个本地补丁器 | 补丁 3 已通过；补丁 **1/2/4 锚点失效**（rc.2 里 Chat Completions 端点消失、只剩唯一 fetch 点）。移植锚点 | 进行中 |
| 3 | memo-river 预设（目录，19 行） | → bundle `local/presets/memo-river/`；`workflow-worker-thread` → `workflow-ptc` 已改 | bundle 已生成待装 |
| 4 | plugin-dev 预设（目录，23 行） | → bundle `local/presets/plugin-dev/`；已移除 4 条 preset-composer 行、资产重命名 | bundle 已生成待装 |
| 5 | `dsh-preset-composer` | 从 profile 的 deps 与 bundles 移除（**用户决策：丢掉**） | 待做 |
| 6 | `dsh-memo-river` 插件源码 | **无需改动**：`agent/created` 握手守卫 9-16 已加并验证 | ✅ 完成 |
| 7 | `dsh-agent-messaging` | 代码无破坏点命中；核对 peer 范围与 bundle 声明 | 待核 |
| 8 | `dsh-memo-tuner`（panel，client 侧） | 客户端 Session 多实例共存改了 API/slot；核对 client 插件 | 待核 |
| 9 | `dsh-browser-panel` / `dsh-longrun-sentinel` | 有 symlink 但**不在 profile deps 里**，需确认是否仍被使用 | 待核 |
| 10 | `billion-context-dsh`（ACP） | peer 上限 `<0.1.6-0`（上游 v0.2.26 仍未放开）。0.1.7 起 DSH **可对确切版本授予例外** ⇒ 不再硬阻塞。注意它用了弃用的 `snapshotEvents`/`eventAt`（**弃用非删除，两版都在**） | 待决 |
| 11 | `skill-switches.mjs`（profile insert） | 客户端 slot/API 变化需核对 | 待核 |
| 12 | 配置改写 | 自定义 `spill-policy.maxInlineBytes` → **`maxInlineTokens`**；工作区文件读取统一 `readBytes` | 待核 |
| 13 | Agent 预设入口变化 | 设置页移除「复制/删除/打开目录」；预设改由 bundle 声明 | 已知 |

## 三、已确立的事实（省去重复调查）

- **包名核对**：两个预设共引用 25 个 `@deepseek-ai/dsh-*`，rc.2（312 个包）里**只缺 1 个** —— `dsh-workflow-worker-thread`。
- **挂载位陷阱**：web-app bundle 在**宿主层**把 `workflow-ptc` / `tool-workflow` / `tool-ralph` / `tool-subagent*` 都设了 `disabled: true`；这些**只在 preset 层挂载**才是对的（官方 `packages/bundle/web-app/presets/cordis.patch.yml:118`）。`ptcRuntime` 由 base bundle 在宿主层提供。
- **事件面**：rc.2 的 agent 事件为 `agent/{created,disposed,error,pre-step,request,request-error,status,turn-stopping,assistant-stream}` —— **`agent/session-start` 已不存在**（被 `agent/created` 取代，payload 逐字段相同）。
- **DeepSeek 适配器现在只用 Messages API**：`dsh-llm-deepseek` 产物里 `chat/completions` 0 处命中，只剩唯一 fetch 点（`lib/index.js:2183`）。这直接影响补丁 1/2 的锚点。
- **bundle 格式**（官方 SKILL）：`package.json` 带 `dsh.bundle.patch`，patch 里 insert 一条 `@deepseek-ai/dsh-agent-preset` 声明；用 `plugin_manager` 的 `install_bundle`（target = bundle 绝对目录）安装，**不要用 shell 复现安装步骤**。

## 四、三步走

**第 1 步（进行中）** 迁移 + 补丁
- [x] 插件全量盘点与逐条判定
- [x] 两个预设 → bundle，内容逐行一致、YAML 可解析
- [x] 清掉 `probe-settings` 悬空链接
- [ ] 补丁 1/2/4 锚点移植（子代理）→ 我复验：rc.2 四个全 0 **且** live 0.1.5 四个仍全 0
- [ ] 本清单定稿

**第 2 步** 沙箱副本演练（**完全不动运行中的系统**）
- [ ] 复制 `~/.dsh`（sessions / settings.yaml / profiles / .agent-presets）到沙箱
- [ ] 用 0.1.7-rc.2 起一个独立 HOME 的实例，装两个 bundle
- [ ] **最大未知：bundle 里 `./memo-river.mjs` 这类相对路径在新加载器下如何解析** —— 必须实测
- [ ] 跑 settings.yaml 导入并逐项核对
- [ ] 取一条 v0 会话跑 V4 迁移，确认可打开、内容完整
- [ ] 记录每一步的实际输出（这是升级当天的脚本）

**第 3 步** 真实升级
- [ ] 备份 `~/.dsh`（sessions 优先）
- [ ] `npm i -g @deepseek-ai/dsh@0.1.7-rc.2`
- [ ] 重启 `dsh-web.service`（四个补丁器会在 `ExecStartPre` 自动重打）
- [ ] `--check` 四个补丁器 + 切换预设 + 核对设置
- [ ] **验证通过后才删旧目录预设**

## 五、回滚方案

- 全局安装可降级：`npm i -g @deepseek-ai/dsh@0.1.5-rc.2`（**但会话一旦迁到 V4 就读不回来** ⇒ 会话必须靠备份恢复）
- profile 改动用 `.bak-<原因>-<时间戳>` 命名（本机既有约定）
- 补丁器各自的 `.bak-*` 是回滚点
- **唯一无法靠降级回滚的是 I-1（会话迁移）** —— 所以 `~/.dsh/sessions` 的备份是整个方案的地基。

## 六、演练环境（已就绪）

- **rc.2 沙箱安装**：`/home/h/app/deepseek-harness/.compat/rehearsal/prefix`（`npm i --prefix … --cache .npmcache @deepseek-ai/dsh@0.1.7-rc.2`，520 包 / 43s，exit 0）。
  新机制包齐备：`dsh-agent-preset`、`dsh-agent-preset-registry`、`dsh-client-ui-agent-preset`、`dsh-plugin-manager`、`dsh-ptc-runtime`、`dsh-ptc-runtime-node`、`dsh-workflow-ptc`。
- ⚠️ **该安装有 5 个包的 install script 被 npm 的 allowScripts 策略拦下**：`@deepseek-ai/dsh-subprocess-local`（postinstall `ensure-spawn-helper.mjs`）、`node-pty`、`koffi`、`protobufjs`、`@google/genai`。
  ⇒ 演练里若子进程/PTY 相关能力异常，**先怀疑这一条**，用 `npm install-scripts approve <pkg>` 放行后重装，别误判成 0.1.7 的缺陷。
- **`DSH_HOME` 是官方支持的环境变量**（`packages/boot/app-boot` 用其解析 `$DSH_HOME/profiles/<name>`），演练用 `DSH_HOME=<沙箱>` 隔离，**不必伪造整个 HOME**。
- **会话版本扫描工具**：`.upgrade/tools/session-versions.mjs`（流式解压只读首行）。注意两种命名并存：旧 `session.jsonl.zstd` / 新 `session.<代>.jsonl.zstd`；只按旧名扫会漏掉全部新会话（这个坑我踩过一次）。

## 七、首次真实启动实测（rc.2 + 本机 profile）

命令：`DSH_HOME=.compat/rehearsal/DSH_HOME .compat/rehearsal/prefix/node_modules/.bin/dsh --profile web --port 3199 --no-open`

**结果：起来了。** 输出 `dsh web: http://127.0.0.1:3199/?token=…`。两条关键行为：

1. **`billion-context-dsh` 被兼容性检查拦下，但只是「跳过」而不是致命** ——
   ```
   dsh: skipping profile bundle "billion-context-dsh": Error: Plugin billion-context-dsh@0.2.21 is
   incompatible with dsh 0.1.7-rc.2: peerDependencies {…<0.1.6-0…}. Running it may cause crashes or
   data loss. … grant the exact-version exemption … with `dsh plugin allow-version` …
   dsh: warning: 1 entry did not activate
   ```
   ⇒ **所谓「ACP 插件阻塞升级」不成立**：它不影响启动，官方给了 `dsh plugin allow-version` 精确版本豁免。
   这也印证了 09-25 的判断——B1 从硬阻塞降级为可绕过的摩擦。
2. `spill-local` 报 `EROFS: mkdtemp '/var/tmp/dsh-spill-XXXXXX'` —— 这是**演练沙箱的 `TMPDIR` 只读**造成的伪失败；
   宿主 unit 里 `Environment=TMPDIR=/var/tmp` 是可写的，升级后不受影响。

**仍待验证**（演练的剩余部分）：装 preset bundle 后 `./memo-river.mjs` 相对路径能否解析、settings.yaml 导入是否完整、v0/v3 会话读取与代数追加行为。

## 八、补丁适配（已完成）

三个补丁器改为**变体锚点**（`variants` + 恰好命中一次：0 命中与 2 命中都失败），老变体全保留 ⇒ live 0.1.5-rc.2 与 0.1.6 仍可重打。

**复核证据（我自己跑的）**：rc.2 假 HOME 四个 `--check` exit=0；live 只读四个 `--check` exit=0；
`find /home/h/.npm-dlabal -newermt '2026-09-25'` 为空（live 零写入），四产物 mtime 仍是 09-11/09-12/09-14。

- **补丁 1** 新增 rc.2 变体：import 头（`getOrCreateAnonymousUserId`）、调用点 `${messagesApiRoot(connection.baseURL)}/messages`
  → rc.2 产物里 `await fetch(` **归零**（09-16 发现的覆盖缺口已补）。
- **补丁 2** 新增 `providerError`（rc.2:1745）与 `DeepSeekFilesError`（rc.2:584）两个分类点，加 `requires` 版本门；
  rc.2 已无 `httpErrorCode`（Chat Completions 端点消失）→ 带门跳过并打印说明。
- **补丁 4** 新增 rc.2 成功路径变体（多了 `this.liveAgent(sessionId) ??` 兜底，这就是 0 命中的原因）；
  顺带修掉 `healthy()` 探针把 `ERR_PACKAGE_PATH_NOT_EXPORTED` 误判为「文件坏了」的真 bug。
- **已知局限（非回归）**：补丁 2 以 Marker 幂等，**已带旧 marker 的产物会短路** ⇒ 新增的两个分类点
  只在 npm 覆盖后的全新产物上全量生效（升级路径正好满足）。

## 九、会话数据实况（实测，非推测）

- **542 个 v0**（旧布局 `session.jsonl.zstd`）+ **120 个 v3**（新布局 `session.<代>.jsonl.zstd`），共 662 个文件 / 651 个会话目录。
- **11 个目录里两代并存**（例：`session-182bd997…` 同时有 54MB 的 v0 与 18MB 的 v3 + `session.lock`）。
  ⇒ 代数**追加而非覆盖**，与 `AGENTS.md`「never move, overwrite, or delete committed generations」一致。
  **这把 I-1「会话迁移不可逆」的风险显著下调**（旧文件仍在盘上），但仍需在演练里对副本实测确认。
- ⚠️ 演练取样时注意：`setup-rehearsal.mjs` 按文件大小挑样本，会挑到很大的会话（几十 MB），
  拷贝与启动加载都变慢；若要快，改用较小的样本。

## 十、演练结果（2026-09-25，第 2 步已跑通主体）

### 10.1 关键未知已解答：相对路径以「profile 目录」为基准

bundle 声明里的 `name: './x.mjs'` **不是**相对于 bundle 目录，而是相对于 **profile 目录**解析（实测报错：
`Cannot find module '…/profiles/web/memo-river.mjs' imported from …/profiles/web/`）。
⇒ 官方指引「Resolve assets from installed packages rather than a preset directory」是**必须遵守**的，不是建议。

**修法（已验证可用）**：把资产做成可解析的本地包，用包名引用。
- `local/presets/packages/memo-river-plugin/`（`@local/dsh-memo-river-plugin`，内容 = mtime 缓存击穿 wrapper）
- `local/presets/packages/memory-disclosure/`（`@local/dsh-memory-disclosure`）
- profile 的 `package.json` deps 加 `link:` 四行（两个 preset bundle + 两个资产包），
  **并在 `profiles/web/node_modules/@local/` 建同名 symlink**（只改 package.json 不建链接会报
  `Cannot find package '@local/…'`——这一步漏了会白跑一轮）。

### 10.2 预设迁移通过（正向证据）

- 装 bundle 后启动成功：`dsh web: http://127.0.0.1:3194/?token=…`。
- **正向判据**：故意制造端口冲突逼出 `logs/startup-*.log` 诊断日志——修好前有 3 条
  `agent preset …: never started` + `ERR_MODULE_NOT_FOUND`；修好后**预设相关错误为零**。
- **更强证据**：沙箱里出现了 `DSH_HOME/memo-river/50d29236c1297d2c/knowledge_base.sqlite` 与日志
  ⇒ 预设里的插件**真的启动并执行了**，bundle → 包 → 插件的链路端到端打通。
- 副产物：`billion-context-dsh` 的 profile 行也被单独 disable（`disable profile plugin row
  "plugin-entry-billion-context-dsh"`），没有级联失败。

### 10.3 settings.yaml 导入：改名而非删除，且**内容完整迁移**（I-2 风险下调）

启动后 `settings.yaml` **不复存在**，取而代之 `settings.yaml.imported`（10606 字节，与原文一致）。
⇒ 一次性导入的实态是**改名保留**，原文仍在盘上可回溯。

**生效值已逐项核对**（`dsh --profile web --dump-config` 的组合树 vs 源文件）：
- 9 个中转站 `baseURL` 全部在组合树里（aijws / scnet / 146.235.228.17 / 1seey / a6api / commandcode / ginka / maoapi / d1api）；
- `llm-deepseek` 的 4 个模型全部在（含 `deepseek-v4.1-flash-expires-on-0910`）。

⚠️ 但「默认模型列表移除 V4 Flash 与 V4 Flash Vision Exp」这条仍需在真机确认：本机 `agent-defaults` 用的正是
`deepseek-v4-flash-vision-exp`——组合树里它作为**显式配置**仍在，未被砍掉；要确认的是升级后运行时是否仍接受它。

### 10.4 尚待完成

- v0 / v3 会话在 rc.2 上的**实际读取与代数追加行为**（本次未打开任何会话，沙箱 sessions 无新代产生）。
- `local/presets/` 需要纳入版本控制（目前是未跟踪目录），否则升级当天可能找不到 bundle。
- 升级当天的执行脚本（把本次手工步骤固化成脚本）。
