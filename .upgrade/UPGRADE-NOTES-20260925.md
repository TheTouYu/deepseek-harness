# 2026-09-25 巡检：官方已出 `0.1.7-rc.2` —— 判据 2/4，且失败的是最重的两条

> 前置：`UPGRADE-NOTES-20260916.md`（0.1.6-alpha.1 的 6 项迁移清单 + 四条"稳定"判据）。
> 本篇是复检，**不要重复 09-16 的调查**。

## 一、上游现状

- 新 tag 序列：`dsh-v0.1.6-alpha.2`(09-17) → `dsh-v0.1.7-alpha.1`(09-22) → `dsh-v0.1.7-alpha.2`(09-22)
  → **`dsh-v0.1.7-rc.1`(09-23) → `dsh-v0.1.7-rc.2`(09-24)**；另有一条 `dsh-v0.1.5-rc.3`(09-22)。
- `origin/master` = `477b4f4205`（Merge PR #5180 `rel/dsh-0.1.7-rc.2`）；`dsh-v0.1.7-rc.2` 是其祖先。
- npm dist-tags：**`next = 0.1.7-rc.2`**、`alpha = 0.1.7-alpha.2`、`latest = 0.1.5-rc.3`
  ⇒ **`latest` 仍指向最旧的线，裸装 `npm i -g @deepseek-ai/dsh` 永远等于降级**（这条陷阱从 09-14 起一直在）。
- 规模：本地基线 `c291e7961a` → rc.2 = **3511 commits**（看 0.1.6-alpha.1 时是 661，涨了 5 倍多）。
- `engines` / `packageManager` 未变（`^22.19.0 || >=24.0.0`、`pnpm@11.7.0`），本机 node v26.7.0 满足。

## 二、四条"稳定"判据的判定

| # | 判据 | 结果 |
|---|---|---|
| ① | `next`/`latest` 指向新线 | ✅ `next = 0.1.7-rc.2` |
| ② | `agent/created` 的 payload 与 `@mode` 定稿 | ✅ 与 0.1.6-alpha.1 **逐字段相同**（`packages/core/agent/src/runtime-types.ts:261`）⇒ 09-16 加的两个事件名都挂的握手守卫**正中靶心** |
| ③ | 破坏性变更在连续两 tag 间无新增 | ⚠️ **rc.1 → rc.2 零新增**（rc.2 release notes 无破坏性段）= 冻结信号出现了；**但从 0.1.6-alpha.1 到现在累积的破坏面很大**（见下） |
| ④ | ACP 插件 peer 放开 | ❌ 上游已到 **v0.2.26**，peer 仍是 `>=0.1.5-alpha.1 <0.1.6-0`（本机装 0.2.21，落后 5 个版本）——**但有了官方逃生口**，见下 §3.5 |

## 三、rc.1 累积的破坏性变更（相对 0.1.6-alpha.1）—— 逐条对照本机

**1. 预设体系整体改版（最大冲击，且不可逆）**
官方 SKILL 原文（`dsh-v0.1.7-rc.2:packages/preset/agent-preset/skills/editing-cordis-compositions/SKILL.md:70`）：
> Nothing reads that directory any more. To migrate one, create a bundle as above whose declaration takes
> `id` from the directory name, `name`, `description`, and `order` from `preset.yml`, and `plugins` from
> `agent.cordis.yml` **verbatim**; check each plugin name against `cordis-composition-reference` because
> **packages renamed since the preset was written fail at activation**.
⇒ `$DSH_HOME/.agent-presets/<id>/`（`preset.yml` + `agent.cordis.yml`）**不再被任何代码读取**。
Agent Note `2026-09-18-declarative-agent-presets.zh.md:23`：「同时保留目录 preset 与声明。两个可写来源会争用标识…
因此 preset 不再有独立路径。」
- **直击**：`~/.dsh/.agent-presets/memo-river/`（记忆河流唯一载体，24 个包引用，其中 `dsh-workflow-worker-thread`
  已在 0.1.6 被删）；以及 `dsh-preset-composer`——**它的产物就是这种目录 ⇒ 功能性作废**。
- 官方迁移法是逐条手写 bundle，**没有自动转换器**；且必须逐个核对包名（改名过的包会在激活时炸）。

**2. Session 日志 → V4**：`packages/session/session-format-catalog/src/generated.ts:17 currentVersion: 4`，
新增 `session-format-v3-to-v4`。v0→v1→v2→v3→v4 链完整，本机 v0 会话**理论可一路迁上来**；
但 **v0-to-v1 包本身又改了（4 文件 +60/−14）** ⇒ 补丁 3 必须重验。

**3. 设置迁移（一次性）**：设置改由当前 Profile 的插件配置保存，**旧 `settings.yaml` 仅尝试导入一次**。
本机那份大 settings.yaml（`llm-pi-ai` 9 个中转站 + `llm-deepseek` 4 个模型 + `agent-defaults` +
`subagent-model-selection`）需要迁移，**只有一次机会**。

**4. 插件 API 迁移**：工作区文件读取统一为 `readBytes`（插件需改旧接口）；自定义 `spill-policy.maxInlineBytes`
→ `maxInlineTokens`；Remote 支持双向流与二进制结果。

**5. ACP 插件的官方逃生口（好消息）**：「插件安装和启动会检查与当前 DSH 版本的兼容性；不兼容时说明原因，
**并可对确切版本授予例外**」⇒ B1 不再是硬阻塞，可以在不改上游 peer 的前提下装。

**6. 其余**：客户端 Session 多实例共存（API/slot 变化）；创造模式移除 Cordis 动态定义；
仅存于自定义事件的附件不再自动读取/导出；官方 DeepSeek 适配器**仅**使用 Messages API（旧 `protocol` 配置与
Chat Completions 地址需迁移）。

## 四、补丁面（必须重跑干跑）

四个目标包在 `0.1.6-alpha.1 → rc.2` 之间**全部又变了**：
`llm-deepseek` 68 文件 / `llm-pi-ai` 30 文件 / `session-format-v0-to-v1` 4 文件 / `session-controller` 66 文件。

- 补丁 4（resume cooldown）上层**仍未修**。
- 09-16 发现的**两个 Messages 协议覆盖缺口**必须重验（补丁 1 未覆盖 `/v1/messages`；补丁 2 未覆盖 messages transport 分类器）。
- 干跑方法见 `UPGRADE-NOTES-20260916.md`（假 HOME + 240 个同胞包 symlink + 四个目标包换新版 tarball；
  **必须 `TMPDIR=<workspace 内可写目录>`**，否则 EROFS 伪失败）。

## 五、结论与建议

判据 2/4，失败的是最重的两条。但性质变了：

- **好消息**：出了 rc（判据①的用意达成）；rc.1→rc.2 **零新增破坏性变更**（冻结信号）；ACP 插件有了官方例外机制。
- **坏消息**：从 0.1.6-alpha.1 至今累积的破坏面是当时的 3～5 倍，且其中**预设体系**与**设置迁移**是
  **一次性、不可逆**的——`dsh-preset-composer` 还因此功能性作废。

⇒ **升级不再是"打四个补丁 + 改六处"，而是一次带数据迁移的平台搬迁。**

建议分两步，不要把两件事混在一起：

1. **现在做（零风险）**：补丁器干跑 + 迁移清单 v2（把 09-16 的 6 项与本次新增项合并、排序）；
   同时把 memo-river 预设按官方配方转成 bundle（**可以先在 0.1.5 上验证转换正确性**，因为 bundle 声明
   与旧目录可以并存于不同路径，不动运行中的系统）。
2. **等 `latest` 指到 0.1.7（GA）再切换**：那时一次性完成 全局安装 + 预设 bundle + settings.yaml 迁移。
