# B1 上报材料：请放开 `billion-context-dsh` 的 peer 上限到 0.1.6

用途：给上游 `github.com/Tyan66666/billion-context-dsh` 提 Issue/PR 用。
下面【英文正文】可直接粘贴；【中方核查记录】是这条结论的证据来源，供你自己引用。

---

## 结论（一句话）

peer 上限 `<0.1.6-0` **没有对应的已知破坏** —— 插件运行期消费的 8 个值导出、22 个类型名在
`dsh-v0.1.6-alpha.1` 上**全部还在**，`dsh.bundle.patch` 清单字段与 `cordis.patch.yml` 层机制也没变。
所以这更像是**保守封顶**（发版时还没验 0.1.6），而不是已踩到的坑。请求：放开上限 + 跑一遍 CI。

## 中方核查记录（可作证据附上）

核查对象：`dsh-v0.1.6-alpha.1` = commit `0a15e36e7f82b6ed45af6fa9759f29b40dcd965d`（2026-09-15），
相对 0.1.5-rc.2 线超前 666 提交。

**① 运行期值导入（全部存在，两版都在）**

| 包 | 符号 | 位置 |
|---|---|---|
| `@deepseek-ai/dsh-session` | `deriveEventMessage` | `packages/core/session/src` |
| `@deepseek-ai/dsh-llm` | `createUserMessage` | `packages/llm/llm/src` |
| `@deepseek-ai/dsh-tools` | `defineTool`、`ToolArgsError` | `packages/core/tools/src` |
| `@deepseek-ai/dsh-compaction` | `CompactionId`、`compactCheckpointSource`、`toolPairingBalancedAfter`、`toolPairingBalancedBefore` | `packages/compaction/compaction/src` |
| `@deepseek-ai/dsh-settings` | `SettingsConflictError` | `packages/settings/settings/src` |

来源文件：插件的 `src/region.ts`、`src/commands.ts`、`src/host-tokens.ts`、`src/tools.ts`、`src/nudge.ts`。

**② 类型导入抽查（22 个，0 缺失）**
`EpochHeader`、`SurfaceIntent`、`SessionLogOffset`、`SessionSeqCursor`、`SessionSeedEventState`、
`SessionEventMap`、`AgentCancelCause`、`SessionSeq`（session）；
`PreparedAdapterCall`、`ImageAttachmentAccessResolver`、`LlmImageRequestPricing`、`ContextSnapshotSection`、
`LlmResolvedModelInfo`、`ModelModality`、`ResolvedRetryPolicy`、`ReasoningEffortId`、`LlmAttemptId`、
`LlmCallConfigAdapterDefaults`（llm）；`ToolDefinition`、`ToolRunContext`（tools）。

**③ 装载机制未变**
`packages/boot/app-boot/src/profile.ts` 仍认 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`；
`packages/bundle/*/package.json` 仍用同一个 `patch` 键。插件的 `dsh.bundle.patch` 声明继续有效。

**④ 无服务名冲突**
0.1.6 新增的 `@deepseek-ai/dsh-compaction-image-offload` 是 `inject = ['agents','sessions']`，
**不 provide `compaction`**；`ctx.provide('compaction')` 仍只有 `compaction-basic`（`packages/compaction/compaction/src/index.ts:114`）。
插件 `cordis.patch.yml` 里 `- id: compaction-basic / disabled: true` 指向的行在 0.1.6 的
`packages/bundle/base/cordis.patch.yml:320-321` 仍然在位。

**⑤ 会话格式代未变**
`packages/session/session-format-catalog/src/generated.ts` 的 `currentVersion: 3` 两版相同
⇒ 补丁式往 rawOutput 里存 block-ledger 字段的既有约定（v0.2.22 的 `abae044`）不受格式代际影响。

**⑥ 仍需真跑才能排除的残留风险（别当成"没问题"）**
- **插件的 13 个文件用了 `session.snapshotEvents()`、3 个文件用了 `session.eventAt()`**，而这两个接口在
  0.1.6 的 release note 里被列为**弃用**（`snapshotEvents`、`eventAt`、`ownEvents`）。
  已核实：**弃用 ≠ 删除**，两版都在（0.1.6 `packages/core/session/src/index.ts:632/646/663`，
  签名与 0.1.5 完全相同）。但这说明插件确实压在一个正在退场的接口上 ——
  这正是对方应该真跑 CI 而不是只改一行 peer 范围的理由。
- 存在 ≠ 语义相同：`packages/core/session` +356/−82、`packages/core/tools` +775/−109，
  类型**存在性**已验，**类型兼容性**（`.d.ts` 结构性变化）没验 —— 真正的闸门是用 0.1.6 的
  类型定义跑一遍 `tsc`。
- 插件挂在 **host plane** 且禁掉 `compaction-basic`；0.1.6 重组了 compaction 组（新增 image-offload、
  tool-result-pruner 配置项）。
- `packages/llm/llm-deepseek` 被重构为 `protocols/chat-completions/` + `protocols/messages/`，
  **且 DeepSeek 官方端点默认改用 Messages 协议** —— 若插件有依赖具体 provider 行为的逻辑需回归。

---

## 【英文正文】可直接粘贴

**Title:** `peerDependencies` upper bound `<0.1.6-0` blocks install on dsh 0.1.6-alpha.1 — requested surface appears intact

**Body:**

> Hi — thanks for the plugin. I'd like to run it against dsh `0.1.6-alpha.1`
> (tag `dsh-v0.1.6-alpha.1`, commit `0a15e36e7f`, 2026-09-15; ~666 commits ahead of the
> `0.1.5-rc.2` line), but `peerDependencies` caps five dsh packages at `>=0.1.5-alpha.1 <0.1.6-0`:
>
> ```
> @deepseek-ai/dsh-compaction, dsh-session, dsh-llm, dsh-tools, dsh-settings
> ```
>
> The same upper bound is present on `main` at `v0.2.23`, so I can't resolve it by upgrading.
>
> **I audited the surface this plugin actually consumes against `dsh-v0.1.6-alpha.1`, and everything is still exported:**
>
> Runtime (value) imports, all present:
> - `@deepseek-ai/dsh-session` → `deriveEventMessage`
> - `@deepseek-ai/dsh-llm` → `createUserMessage`
> - `@deepseek-ai/dsh-tools` → `defineTool`, `ToolArgsError`
> - `@deepseek-ai/dsh-compaction` → `CompactionId`, `compactCheckpointSource`, `toolPairingBalancedAfter`, `toolPairingBalancedBefore`
> - `@deepseek-ai/dsh-settings` → `SettingsConflictError`
>
> Type-only imports (22 sampled): `EpochHeader`, `SurfaceIntent`, `SessionLogOffset`, `SessionSeqCursor`,
> `SessionSeedEventState`, `SessionEventMap`, `AgentCancelCause`, `SessionSeq`, `PreparedAdapterCall`,
> `ImageAttachmentAccessResolver`, `LlmImageRequestPricing`, `ContextSnapshotSection`,
> `LlmResolvedModelInfo`, `ModelModality`, `ResolvedRetryPolicy`, `ReasoningEffortId`, `LlmAttemptId`,
> `LlmCallConfigAdapterDefaults`, `ToolDefinition`, `ToolRunContext` — 0 missing.
>
> Mechanism-level checks also pass: `dsh.bundle.patch` / `cordis.patch.yml` layering is unchanged in
> `packages/boot/app-boot/src/profile.ts`; the `- id: compaction-basic / disabled: true` row this
> plugin's patch targets still exists in the 0.1.6 base bundle; and the new
> `@deepseek-ai/dsh-compaction-image-offload` package **does not** provide the `compaction` service
> (`inject = ['agents','sessions']`), so it does not collide with `compaction-acp`. Session format
> generation is unchanged (`currentVersion: 3`).
>
> So the cap looks precautionary rather than a known break. Could you widen it — e.g.
> `>=0.1.5-alpha.1 <0.1.7-0` — and cut a release after running CI/e2e against `0.1.6-alpha.1`?
>
> Remaining risk I could not rule out from static inspection, and which a CI run would settle:
> existence ≠ identical semantics. `packages/core/session` changed +356/−82 and
> `packages/core/tools` +775/−109 between these versions, so a `tsc` pass against 0.1.6's `.d.ts`
> (not just symbol presence) is the real gate. Also worth a regression look: the plugin mounts at the
> host plane and disables `compaction-basic`, while 0.1.6 restructured the compaction group; and
> `dsh-llm-deepseek` was split into `protocols/chat-completions/` + `protocols/messages/`, adding a
> new Messages protocol path.
>
> Happy to run whatever matrix you'd like and report back.

---

## 放行后本机怎么验（三级，从便宜到贵）

1. **类型闸门**（最便宜、信息量最大）：把插件的 peer 上限在本地 fork 改宽，对着 0.1.6 的 `.d.ts`
   跑 `tsc --noEmit`。这一步就能把"存在但类型已变"全抓出来。
2. **组合挂载**：在隔离 profile（复制 `~/.dsh/profiles/web` 到临时目录，bundles 指向 0.1.6 的
   `dsh-base`/`dsh-web-app`）启动，确认 `compaction-acp` 挂上且 `compaction-basic` 被禁，
   `acp_status` 工具在。
3. **真会话回归**：用一个历史会话压一次，确认 block-ledger 字段仍写进 `rawOutput` 而不是顶层成员
   （v0.2.22 的 `abae044` 修的就是这个），且会话日志在 0.1.6 宿主上仍可打开。
