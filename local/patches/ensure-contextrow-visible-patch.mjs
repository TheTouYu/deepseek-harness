#!/usr/bin/env node
/**
 * dsh context-row visibility 补丁器 —— 让注入的上下文消息重新出现在对话视图（零依赖，独立运行）。
 *
 * 病（用户可见症状）：浏览器对话视图里看不到自动注入的上下文消息——记忆召回横幅、
 * AGENTS.md 指令更新、skill 注入、插件注入、压缩提醒等；必须切到「轨迹」视图才能看到全部消息。
 *
 * 根因（2026-10-14 定位，源码侧 packages/client/ui-chat/src/client/contract/chat-visibility.ts）：
 *   isVisibleChatNode(node) 把整类 `context` 节点从 chat 行里剔除，只给
 *   tool-addition / tool-removal 开了例外：
 *     node.kind !== 'context'
 *       || node.data.content.some(b => b.type === 'tool-addition' || b.type === 'tool-removal')
 *   注入消息在 ui-chat 侧一律建 kind:'context' 节点（conversation-nodes/message.ts，source.kind !== 'user'），
 *   只有「被 next-turn 认领、会开启回合」的那类会被 buildViewNode 升级成 turn-trigger（可见）。
 *   实测注入位置是**回合内的步骤边界**（tool/result → step/end → step/start(1/N) → user/message），
 *   不是回合起点 ⇒ waking=false ⇒ 永远被剔除。
 *
 * 回归点：该文件由上游 776efdf321「fix(ui-chat): hide infrastructure rows and retain turn triggers」
 *   （2026-09-17 提交 / 09-18 合入，作者 lsdsjy）**新建**，初版就写死 `kind !== 'context'`；
 *   7e5f906945（09-21）只加了 tool 变更例外。此后（含 rel/dsh-0.1.7-rc.2 合并点 477b4f4205）再无改动。
 *
 * 修法（用户 2026-10-15 选定 A 案）：删掉 context 那一支，恢复 0.1.7 前的可见行为。
 *   system-prompt 行与 permission 命令仍隐藏；轨迹视图是独立投影，本来就不受此判据约束。
 *   依据：契约层 context-producer.ts 明确要求「本 UI 不认识的 producer 也要保持可见」（opaque 兜底
 *   已实现），可见性闸门却把整类节点丢掉——本补丁让两层语义重新一致。
 *
 * 幂等：目标含补丁标记则跳过；dsh 升级（npm 覆盖）后自动重打。接入 dsh-web.service 的 ExecStartPre。
 *
 * 用法：
 *   node ensure-contextrow-visible-patch.mjs            # 检查并补丁（默认）
 *   node ensure-contextrow-visible-patch.mjs --check    # 只检查（0=健康 1=需补丁）
 */
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const checkOnly = process.argv.slice(2).includes('--check')
const HOME = process.env.HOME
const base = `${process.env.DSH_INSTALL_ROOT ?? `${HOME}/.local/lib/node_modules`}/@deepseek-ai/dsh/node_modules/@deepseek-ai`

const MARKER = '// ponytail: context-rows-visible'
const PKG = `${base}/dsh-client-ui-chat`

/** 编译产物里的单行判据（三个 tab 缩进，逐字节取自 0.2.0-rc.2 的 lib/client.js:7719）。 */
const OLD_RETURN = '\t\t\treturn node.visibility === "visible" && node.kind !== "system-prompt" && (node.kind !== "context" || node.data.content.some((block) => block.type === "tool-addition" || block.type === "tool-removal")) && !(node.kind === "command" && node.data.name === "permission");'
const NEW_RETURN = `\t\t\t${MARKER}: 注入的上下文行（记忆召回/指令更新/skill/插件注入）恢复显示；
\t\t\t// 只保留 system-prompt 与 permission 两类基础设施行的排除。轨迹视图不受影响（独立投影）。
\t\t\treturn node.visibility === "visible" && node.kind !== "system-prompt" && !(node.kind === "command" && node.data.name === "permission");`

const EDITS = [
  {
    file: `${PKG}/lib/client.js`,
    what: 'isVisibleChatNode',
    old: OLD_RETURN,
    new: NEW_RETURN,
  },
  {
    // 只改注释，纯文档一致性；缺文件不阻断（旧版可能没有 .d.ts）。
    file: `${PKG}/lib/types/client/contract/chat-visibility.d.ts`,
    what: 'doc comment',
    optional: true,
    old: ' * Exclude system prompts, ordinary Context, and permission commands from visible Chat rows.\n * Context containing tool changes retains its notice row.',
    new: ` * Exclude system prompts and permission commands from visible Chat rows.\n * ${MARKER}\n * Injected Context rows stay visible (restores pre-0.1.7 behaviour).`,
  },
]

function fail(msg) {
  console.error(`ensure-contextrow-visible-patch: ${msg}`)
  process.exit(1)
}

for (const e of EDITS) {
  if (!existsSync(e.file)) {
    if (e.optional === true) { console.log(`ensure-contextrow-visible-patch: skip — 缺少可选目标 ${e.file}`); continue }
    fail(`target not found: ${e.file}`)
  }
  let content
  try { content = readFileSync(e.file, 'utf8') } catch (err) { fail(`cannot read ${e.file}: ${err.message}`) }
  if (content.includes(MARKER)) {
    console.log(`ensure-contextrow-visible-patch: OK — patch already present (${e.file})`)
    continue
  }
  if (checkOnly) {
    console.log(`ensure-contextrow-visible-patch: MISSING — patch needed (${e.file})`)
    process.exit(1)
  }
  const n = content.split(e.old).length - 1
  if (n !== 1) fail(`anchor not unique (found ${n}) for [${e.what}] in ${e.file} — dsh may have changed layout; review this script`)
  const patched = content.replace(e.old, e.new)
  if (e.file.endsWith('.js')) {
    const tmp = join(tmpdir(), `dsh-ctxrow-check-${process.pid}.js`)
    try {
      writeFileSync(tmp, patched, 'utf8')
      execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' })
    } catch (err) {
      fail(`syntax check failed: ${err.stderr?.toString().slice(0, 300) || err.message}`)
    }
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backup = `${e.file}.bak-contextrow-${stamp}`
  try {
    renameSync(e.file, backup)
    writeFileSync(e.file, patched, 'utf8')
  } catch (err) {
    fail(`write failed: ${err.message} (backup kept at ${backup})`)
  }
  console.log(`ensure-contextrow-visible-patch: patched ${e.file}\n  site: ${e.what}\n  backup: ${backup}`)
}
