// ctxinject —— 会话级「上下文注入 + 条件触发」插件（v2）
//
// v1 只做「常驻上下文」：每轮把固定文本/笔记文件注入到对话尾部。
// v2 增加**条件触发（自我提醒）**：模型先登记一条 `{id, inject, when}`，
//   之后每个 step 边界求值 `when`，条件满足就把 `inject` 的文字注入回上下文。
//   —— 这就是用户说的"事后执行触发 / 有条件触发"：提醒不是在登记的当下发生，
//      而是在未来某个条件成立的时刻发生。
//   最典型的一幕：模型写一句"任务完成后提醒我改 X"，条件挂在一个进度文件上；
//   等模型自己把那句 DONE 写进文件的那一刻，提醒自动回到它的上下文里。
//
// 注入通道（两条路都走同一个 handler，靠 lastHandled 去重）：
//   · 预设行：ctx 在 agent 作用域链上 → apply 里直接 ctx.on('agent/pre-step', …)。
//   · 会话级热载：私有 scope 不在 agent 作用域链上，收不到 agent/* 事件（evprobe 实测）
//     → 经 `ctxinject_arm` 用 exec.agent 把监听器注册到 **agent.ctx**（事件域本身）。
//
// 为什么只在 pre-step 注入：一条 assistant 消息声明的多个 tool_call 与其 tool/result
// 必须连续，插在中间会被 provider 拒（INVALID_REQUEST: An assistant message with
// 'tool_calls' must be followed by tool messages …）。pre-step 是天然的"批量之间"安全边界，
// 且 loop 会把 decision.messages append 成 user/message 落进历史
// （dsh-agent-loop/lib/index.js:1028）→ 注入的信息后续轮次都还在。
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, readdirSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, dirname, isAbsolute, resolve, sep } from 'node:path'

// ── 子模块加载（热载缓存绕行）────────────────────────────────────────────────
// 不用静态 import 的原因：reload 的 ?v=<mtime-size> 只打在**入口**文件上，静态 import
// 的子模块拿不到 query → 被 Node 缓存 → 改了不生效（实测：子模块永远停在旧值）。
// 这里改用**子模块自己的 mtime-size** 当 query 动态 import。
// ★ 记住：改 lib/ 下任何文件后，必须先 `touch ctxinject.mjs` 再 reload，否则会静默跑旧代码。
import { statSync as _statSync } from 'node:fs'
import { fileURLToPath as _fileURLToPath } from 'node:url'

async function loadSub(rel) {
  const abs = _fileURLToPath(new URL(rel, import.meta.url))
  let v = '0'
  try { const st = _statSync(abs); v = `${st.mtimeMs}-${st.size}` } catch { /* 取不到就不加指纹 */ }
  return import(`${rel}?v=${encodeURIComponent(v)}`)
}

const {
  loadRules, evaluate, runEffects, readSafe,
  loadRuleState, saveRuleState,
  parseArgvAllow,
  renderRuleFire, renderRuleMerge, renderRuleExpired, runActions,
} = await loadSub('./lib/rules.mjs')

export const name = 'ctxinject'
export const inject = ['tools']

/** 常驻上下文的注入块标记。 */
export const MARKER = '⟨ctxinject·上下文注入⟩'
/** 条件触发时的注入块标记。 */
export const FIRE_MARKER = '⟨ctxinject·触发⟩'
/** 一次性自我说明的标记。 */
export const DOCS_MARKER = '⟨ctxinject·用法⟩'
/** 用法说明的版本号：插件能力变了就 +1 —— 会话里注入过旧版说明的会**重新注入一次**新说明。 */
export const DOCS_VERSION = 4

/**
 * agent -> 会话状态。
 *
 * 放在 `globalThis` 而**不是**模块级 WeakMap：热载 reload 会重新求值本模块，
 * 模块级状态被新实例丢掉了，但旧实例注册在 `agent.ctx` 上的 pre-step 监听器
 * **不会随插件 scope 收口**（它挂在事件域本身，不在插件的私有 scope 里）→
 * 新实例若再挂一个，就是两个监听器同时跑，同一个触发器注入两遍。
 * 本会话实测抓到过这次双触发（同一 id、同一毫秒的两条注入块）。
 * 用全局登记后，新实例能看见旧实例记录的 off 函数，arm 时先摘旧监听（见 attach）。
 * 再加一层内容级去重（dedup）兜底：即使监听器漏了，同一步也不会重复注入。
 */
const states = (globalThis[Symbol.for('dsh.ctxinject.registry')] ??= new WeakMap())

/** 内容级去重兜底：key = agent:turn:step:kind[:watchId]。 */
const dedup = (globalThis[Symbol.for('dsh.ctxinject.dedup')] ??= new Set())

/** 本模块实例的 id（每次 reload 变一次），用于诊断「到底有几个监听器在跑」。 */
const INSTANCE_ID = Math.random().toString(36).slice(2, 8)
/** 跨实例共享的调用轨迹：挂在 globalThis 上，所有实例都写同一个数组。 */
const trace = (globalThis[Symbol.for('dsh.ctxinject.trace')] ??= [])

/**
 * 曾经 arm 过的 agent（跨实例共享）。热载 reload 后 apply 会用它**自动重挂**：
 * 否则「reload 但忘了 arm」会静默地继续跑旧代泄漏监听器里的旧代码 —— 本会话实测踩过。
 */
const knownAgents = (globalThis[Symbol.for('dsh.ctxinject.agents')] ??= new Set())

function agentKey(agent) {
  try { return String(agent?.session?.id ?? agent?.id ?? 'agent') } catch { return 'agent' }
}

/** 同一个 (agent,turn,step,kind,id) 只放行一次。 */
function once(key) {
  if (dedup.has(key)) return false
  if (dedup.size > 4000) dedup.clear() // 防无界增长
  dedup.add(key)
  return true
}

function stateOf(agent) {
  let s = states.get(agent)
  if (!s) {
    s = {
      off: null, cfg: null, digest: '', injects: 0, lastAt: null, lastHandled: '', root: '',
      watches: [], fires: 0, docPending: false, docsSeen: 0, store: '', ruleFires: 0, firedRules: {}, expiredRules: {}, disabledRules: {}, seqProgress: {}, maxRuleInjectPerStep: 3, cmdCache: {}, cmdCacheMs: 3000,
    }
    states.set(agent, s)
  }
  return s
}

/**
 * 这条会话的工作目录。
 * 字段来源已查实：dsh-agent-loop/lib/index.js:1536 `context.agent?.session.header.cwd`。
 * 预设行形态**没有人调 arm**，若不在这里兜底，root 恒为 '' → `if (s.root)` 整段跳过
 * → 外部规则永不加载（真机 S22 抓到：文件写对了、命令 exit 0，但一条规则都没求值）。
 */
function agentRoot(agent) {
  const c = agent?.session?.header?.cwd
  return typeof c === 'string' && c ? c : process.cwd()
}

function fileHash(path) {
  const t = readSafe(path)
  return t === null ? null : createHash('sha256').update(t, 'utf8').digest('hex')
}
function fileStatText(path) {
  try {
    const st = statSync(String(path))
    return `${st.size} 字节 / mtime ${new Date(st.mtimeMs).toISOString()}`
  } catch { return null }
}

// ── 正文渲染 ──────────────────────────────────────────────────────────────────
export function renderBlock(cfg, turn, step, notesText) {
  const lines = [MARKER + ` 每轮上下文（自动注入；来源：ctxinject${cfg.label ? '·' + cfg.label : ''}）`]
  lines.push(`· 位置：turn ${turn ?? '?'} / step ${step ?? '?'}`)
  if (cfg.withTime) lines.push(`· 时间：${new Date().toISOString()}`)
  if (cfg.text) lines.push('', '【固定上下文】', cfg.text)
  if (cfg.notes) {
    lines.push('', `【笔记文件 ${cfg.notes}】`)
    lines.push(notesText === null ? '(文件不存在或读不到)' : notesText)
  }
  return lines.join('\n')
}

export function renderFire(w, detail, turn) {
  return [
    `${FIRE_MARKER} 一条你此前登记的「事后提醒」条件已满足。`,
    `· 触发器 id：\`${w.id}\``,
    `· 条件：${detail}`,
    `· 时刻：turn ${turn ?? '?'} / ${new Date().toISOString()}${w.once === false ? '（可重复触发）' : '（一次性，已自动移除）'}`,
    '',
    w.inject,
  ].join('\n')
}

/** 自我说明正文：**启动时注入一次**，让模型知道这个插件存在、能干什么、怎么调。 */
export function renderDocs() {
  return [
    DOCS_MARKER + ' 本会话装了「外部条件 → 上下文/动作」插件（能力名 `ctxinject`）。',
    '一句话：**任何进程把条件写进文件，条件满足时就把提醒注入回你的上下文**（作为 user 消息尾段；不动 system 段、不动工具面 → 前缀缓存零代价）。',
    '',
    '【A · 常驻上下文】`ctxinject_arm({ text?, notes?, root? })`',
    '  每轮注入固定文本 / 笔记文件；内容没变就不重复注入。笔记文件每轮重读 → 改文件即生效。',
    '',
    '【B · 外部规则源（主力用法）】`<root>/.ctxinject/rules.d/*.json`，**一文件一条规则**：',
    '  { "id":"...", "when":{...}, "then":{ "inject":"...", "actions":[...] },',
    '    "once":true, "expires":"2026-01-01T00:00:00Z" }',
    '  · 每个 step 边界读取目录 → 求值 → 触发；坏文件跳过，绝不拖垮 pre-step。',
    '  · `once` 缺省 true（触发即自毁）；`expires` 到期仍未触发会**出声作废**（不会静默消失）。',
    '',
    '【when · 叶子条件】',
    "  file-line     { path, line?(-1 = 最后一行), contains? | equals? | matches?(正则) }",
    "  file-json     { path, ptr:'/a/b', op:'eq|ne|gt|gte|lt|lte|in|exists', value }",
    '  file-changed  { path }                内容变化（基线哈希），变化即触发',
    '  file-exists   { path }                文件出现（取反用 not）',
    '  signal        { dir, topic, consume? } 事件总线：外部往目录写一个以 topic 命名的文件即「发布事件」',
    '  command       { argv, cwd?, expectExit?, stdoutContains?, stdoutMatches?, timeoutMs? }',
    '  turn-every / turn-after / time-after / always    轮次与时间条件',
    '【when · 复合（可任意嵌套）】',
    '  all{of:[]} / any{of:[]} / not{of:{}} / count{of:[],gte:n} / seq{of:[]}（有序：必须先看到 A 再看到 B）',
    '',
    '【then · 动作】`inject`（支持 `{{rule.id}}` / `{{detail}}` 插值），外加 `actions`：',
    '  write{path,content} / disable|enable{ids}（链式开关其它规则）/ emit{dir,topic}（投递信号给别的规则接力）',
    '',
    '【安全闸】`write` 与所有 `path` 都受 root 路径围栏；`command` 还需 arm 时显式',
    '  `allowExec:true` **且** argv 命中白名单 `argvAllow:"node -e,git"` —— **缺省关**，且结果有缓存窗口不重复执行。',
    '',
    '【自省 / 运维】`ctxinject_status`（引擎总状态）/ `ctxinject_watches` / `ctxinject_unwatch({id})` / `ctxinject_disarm`。',
    '  arm 的 `root` 决定规则目录与相对路径基准；`maxRuleInjectPerStep` 限制单步注入条数（超出合并成一个块）。',
    '',
    '【典型场景】CI 跑完写 `signals/ci-done` → 叫醒你；任务 DONE 写进 `progress.md` → 提醒收尾；',
    '  长跑构建把结论写进日志末行 → 提醒跑测试；另一个 agent 写一个 signal → 接力协作。',
  ].join('\n')
}

// ── 去重摘要 ──────────────────────────────────────────────────────────────────
export function digestOf(cfg, notesText) {
  const t = cfg.withTime ? new Date().toISOString().slice(0, 19) : ''
  return createHash('sha256').update(`${cfg.text ?? ''}\u0000${notesText ?? ''}\u0000${t}`, 'utf8').digest('hex')
}

function message(text, form) {
  return Object.freeze({
    role: 'user',
    id: `ctxinject-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`,
    content: Object.freeze([Object.freeze({ type: 'text', text })]),
    // 0.1.7 起 source.kind 必须是产出方自有的非空字符串：通用包装 `kind: 'plugin'`
    // 会被 assertV4SourceRowAdmission 直接拒绝（dsh-session-format-v3-to-v4/src/
    // message-sources.ts:10）。官方同款见 dsh-agent-instructions。
    source: Object.freeze({ kind: 'ctxinject', form: form ?? 'context-inject' }),
  })
}

// ── 条件求值 ──────────────────────────────────────────────────────────────────
/**
 * 求值一条触发器的条件。**可能修改 w**（记基线 / 记状态）——这是刻意的：
 * file-changed 触发后要靠更新 baseline 才能捕捉"下一次"变化。
 * @returns {{fire:boolean, detail?:string}}
 */
export function evalCondition(w, { turn, now }) {
  const c = w.when ?? {}
  switch (c.kind) {
    case 'always':
      return { fire: true, detail: '无条件（always）' }

    case 'file-changed': {
      const cur = fileHash(c.path)
      if (cur === null) return { fire: false }
      if (w.baseline == null) { w.baseline = cur; return { fire: false } }
      if (cur !== w.baseline) {
        const from = w.baseline
        w.baseline = cur
        return { fire: true, detail: `文件内容已变化（${c.path}）：${from.slice(0, 8)} → ${cur.slice(0, 8)}` }
      }
      return { fire: false }
    }

    case 'file-contains': {
      const txt = readSafe(c.path)
      if (txt === null) return { fire: false }
      let hit = false
      if (c.regex === true) {
        try { hit = new RegExp(String(c.pattern), String(c.flags ?? '')).test(txt) } catch { hit = false }
      } else {
        hit = txt.includes(String(c.pattern ?? ''))
      }
      const prev = w.lastState ?? false
      w.lastState = hit
      return hit && !prev ? { fire: true, detail: `文件 ${c.path} 命中「${c.pattern}」` } : { fire: false }
    }

    case 'file-exists': {
      const e = existsSync(String(c.path))
      const prev = w.lastState ?? false
      w.lastState = e
      return e && !prev ? { fire: true, detail: `文件出现：${c.path}` } : { fire: false }
    }

    case 'turn-every': {
      const n = Math.max(1, Number(c.turns) || 1)
      const base = w.lastFiredTurn ?? w.createdTurn ?? 0
      return (turn - base) >= n ? { fire: true, detail: `每 ${n} 轮（上次 turn ${base}）` } : { fire: false }
    }

    case 'turn-after': {
      const n = Math.max(1, Number(c.turns) || 1)
      const base = w.createdTurn ?? turn
      return (turn - base) >= n ? { fire: true, detail: `登记于 turn ${base}，已过 ${n} 轮` } : { fire: false }
    }

    case 'time-after': {
      const ms = Math.max(0, Number(c.ms) || (c.minutes != null ? Number(c.minutes) * 60000 : 0) || (c.seconds != null ? Number(c.seconds) * 1000 : 0))
      const base = w.createdAt ?? now
      return (now - base) >= ms ? { fire: true, detail: `已过 ${Math.round((now - base) / 1000)} 秒（阈值 ${Math.round(ms / 1000)}s）` } : { fire: false }
    }

    default:
      return { fire: false }
  }
}

/** 条件的人类可读描述（列表与登记回执都用它）。 */
export function describeWhen(c) {
  switch (c?.kind) {
    case 'file-changed': return `文件变化 ${c.path}`
    case 'file-contains': return `文件 ${c.path} 出现「${c.pattern}」`
    case 'file-exists': return `文件出现 ${c.path}`
    case 'turn-every': return `每 ${c.turns ?? 1} 轮`
    case 'turn-after': return `再过 ${c.turns ?? 1} 轮`
    case 'time-after': return `再过 ${c.minutes ?? Math.round((c.ms ?? 0) / 60000)} 分钟`
    case 'always': return '立即'
    default: return `未知条件 ${JSON.stringify(c)}`
  }
}

// ── 持久化（best-effort：失败只降级、不抛） ────────────────────────────────────
function serializeWatch(w) {
  return {
    id: w.id, inject: w.inject, when: w.when, once: w.once,
    baseline: w.baseline, lastState: w.lastState,
    createdTurn: w.createdTurn, createdAt: w.createdAt,
    lastFiredTurn: w.lastFiredTurn, lastFiredAt: w.lastFiredAt, fired: w.fired,
  }
}

function persist(s) {
  if (!s.store) return false
  try {
    mkdirSync(dirname(s.store), { recursive: true })
    writeFileSync(s.store, JSON.stringify({ v: 2, watches: s.watches.map(serializeWatch) }, null, 2))
    return true
  } catch { return false }
}

function loadStore(s) {
  if (!s.store) return []
  try {
    const raw = JSON.parse(readFileSync(s.store, 'utf8'))
    return Array.isArray(raw?.watches) ? raw.watches : []
  } catch { return [] }
}

// ── 核心 handler ─────────────────────────────────────────────────────────────
async function handler(payload, next) {
  const decision = await next()
  if (decision?.kind !== 'enter' || payload?.signal?.aborted) return decision
  const agent = payload?.agent
  if (agent === undefined) return decision
  // 惰性建状态：**预设行**形态下没有工具可调（也就没人调 arm），状态在这里建立 —— root 退回 cwd。
  // 自述也必须在这里安排：否则预设形态下模型既没有工具、又不知道这插件存在，
  // 只会看到莫名其妙的注入块。一次性由 docsSeen 保证。
  let s = states.get(agent)
  if (s === undefined) {
    s = stateOf(agent)
    if (s.docsSeen !== DOCS_VERSION) s.docPending = true
  }
  // root 必须落到**这条会话的工作目录**：预设行形态没人 arm，缺这一句则规则永不加载。
  if (!s.root) s.root = agentRoot(agent)

  // 诊断：记录每次 handler 调用（带实例 id）。trace 挂在 globalThis 上，
  // 所有模块实例都往同一个数组写 —— 能一眼看出「同一步有几个监听器在跑」。
  trace.push({ i: INSTANCE_ID, turn: payload.turn, step: payload.step, at: Date.now() })
  if (trace.length > 300) trace.splice(0, trace.length - 300)

  // 同一实例内双重注册（apply 的 ctx 监听 + arm 的 agent.ctx 监听）防护
  const stepKey = `${agentKey(agent)}:${payload.turn}:${payload.step}`
  if (s.lastHandled === stepKey) return decision
  s.lastHandled = stepKey

  const additions = []

  // ① 一次性自我说明（启动时注入）
  if (s.docPending) {
    s.docPending = false
    s.docsSeen = DOCS_VERSION
    if (once(`${stepKey}:docs`)) additions.push(message(renderDocs(), 'docs'))
  }

  // ② 常驻上下文
  const cfg = s.cfg
  if (cfg && (cfg.everyStep || payload.step === 1)) {
    const notesText = readSafe(cfg.notes)
    const digest = digestOf(cfg, notesText)
    if (cfg.everyStep || digest !== s.digest) {
      s.digest = digest
      s.injects += 1
      s.lastAt = new Date().toISOString()
      // once() 是跨实例兜底：reload 残留的旧监听器会走到这里，但注入只落一次
      if (once(`${stepKey}:block`)) additions.push(message(renderBlock(cfg, payload.turn, payload.step, notesText), 'context-inject'))
    }
  }

  // ③ 条件触发
  const now = Date.now()
  if (s.watches.length > 0) {
    const remaining = []
    let dropped = false
    for (const w of s.watches) {
      let r = { fire: false }
      try { r = evalCondition(w, { turn: payload.turn, now }) } catch { r = { fire: false } }
      if (r.fire) {
        if (once(`${stepKey}:fire:${w.id}`)) {
          additions.push(message(renderFire(w, r.detail ?? describeWhen(w.when), payload.turn), 'condition-fire'))
        }
        w.fired = (w.fired ?? 0) + 1
        w.lastFiredTurn = payload.turn
        w.lastFiredAt = new Date(now).toISOString()
        s.fires += 1
        if (w.once === false) remaining.push(w)
        else dropped = true
      } else {
        remaining.push(w)
      }
    }
    s.watches = remaining
    // 触发过 / 状态（lastState/baseline）有推进就落盘
    if (dropped || additions.some((m) => m.source.form === 'condition-fire')) persist(s)
  }

  // ④ 外部规则（rules.d/*.json）：外部进程写条件，这里读取并触发
  if (s.root) {
    const fired = []
    for (const rule of loadRules(s.root)) {
      if (s.disabledRules?.[rule.id]) continue // 被动作 disable 掉的规则
      // 到期作废：不触发，但**出声**（静默过期会让模型以为提醒还在）
      const exp = rule.expires ? Date.parse(rule.expires) : NaN
      if (Number.isFinite(exp) && Date.now() >= exp) {
        if (!s.expiredRules?.[rule.id]) {
          s.expiredRules[rule.id] = new Date().toISOString()
          saveRuleState(s)
          if (once(`${stepKey}:expired:${rule.id}`)) additions.push(message(renderRuleExpired(rule), 'rule-expired'))
        }
        continue
      }
      if (rule.once !== false && s.firedRules?.[rule.id]) continue // 已触发过（缺省自毁）
      const io = {
        effects: [], progress: { ...(s.seqProgress ?? {}) }, commit: null,
        allowExec: s.allowExec === true, argvAllow: s.argvAllow ?? [],
        cmdCache: s.cmdCache, cmdCacheMs: s.cmdCacheMs,
      }
      io.commit = () => { runEffects(io.effects); io.effects.length = 0 }
      const progressBefore = JSON.stringify(io.progress)
      let r = { fire: false }
      try {
        r = evaluate(rule.when, s.root, io)
      } catch { r = { fire: false } }
      if (JSON.stringify(io.progress) !== progressBefore) { s.seqProgress = io.progress; saveRuleState(s) }
      if (r.fire && once(`${stepKey}:rule:${rule.id}`)) {
        io.commit() // ★两段式：规则真的触发，才提交剩余副作用（消费信号等）
        fired.push({ rule, detail: r.detail })
        s.ruleFires = (s.ruleFires ?? 0) + 1
        if (rule.once !== false) { s.firedRules[rule.id] = new Date().toISOString(); saveRuleState(s) }
        runActions(s, rule)
      }
    }
    // 每步注入预算：超过就合并成一个块（信息不丢，但不刷屏）
    const budget = Math.max(1, Number(s.maxRuleInjectPerStep) || 3)
    if (fired.length > 0 && fired.length <= budget) {
      for (const f of fired) additions.push(message(renderRuleFire(f.rule, f.detail), 'rule-fire'))
    } else if (fired.length > budget) {
      for (const f of fired.slice(0, budget - 1)) additions.push(message(renderRuleFire(f.rule, f.detail), 'rule-fire'))
      additions.push(message(renderRuleMerge(fired.slice(budget - 1)), 'rule-fire-merged'))
    }
  }

  if (additions.length === 0) return decision
  const existing = Array.isArray(decision.messages) ? decision.messages : []
  return { ...decision, messages: [...existing, ...additions] }
}

function attach(targetCtx, agent) {
  const s = stateOf(agent)
  // ★先摘掉任何旧代监听器：reload 后旧监听仍挂在 agent.ctx 上（不随 scope 收口），
  //   不摘就会双触发。这是本会话实测抓到的 bug，不是理论问题。
  if (typeof s.off === 'function') { try { s.off() } catch { /* 旧监听已失效 */ } }
  s.off = null
  const off = targetCtx.on('agent/pre-step', handler, { prepend: true })
  s.off = typeof off === 'function' ? off : null
  return s
}

function detach(agent) {
  const s = states.get(agent)
  if (!s) return false
  if (typeof s.off === 'function') { try { s.off() } catch { /* 已卸载 */ } }
  s.off = null
  return true
}

export function apply(ctx, config) {
  const { defineTool, capability } = config || {}
  // defineTool 由宿主注入（**热载路径**确定会注入）。**预设行路径不注入** —— 那种形态下
  // 插件依然可用（注入通道才是主体：apply 里那条 ctx.on('agent/pre-step') 就在 agent 链上），
  // 只是少了 arm/watch 这些配置动词，root 退回 cwd。所以这里不抛，降级为「只注入、不注册工具」。
  const canTools = typeof defineTool === 'function'

  // 预设行形态：本 ctx 已在 agent 作用域链上，直接挂（热载形态下这条收不到事件，无害）。
  try { ctx.on('agent/pre-step', handler, { prepend: true }) } catch { /* 作用域不支持则忽略 */ }

  const res = (v) => v

  if (canTools) {
  ctx.tools.register(defineTool({
    name: 'ctxinject_arm',
    description: '开启 / 配置本会话的注入引擎（幂等）：设定 root（外部规则目录与相对路径基准）、常驻文本与笔记、每步注入预算、以及外部命令的执行闸。热载 reload 后会自动重挂，无需反复调用。',
    parameters: {
      text: { type: 'string', description: '每轮注入的固定上下文文本' },
      notes: { type: 'string', description: '每轮重读并注入的笔记文件绝对路径' },
      label: { type: 'string', description: '来源标签' },
      withTime: { type: 'boolean', description: 'true = 注入块带当前时间' },
      everyStep: { type: 'boolean', description: 'true = 每个 step 都注入（调试用）' },
      docs: { type: 'boolean', description: 'true（缺省）= 注入一次插件用法说明' },
      store: { type: 'string', description: '触发器持久化文件路径；缺省 <cwd>/.ctxinject/watches.json' },
      root: { type: 'string', description: '工作区根目录（外部规则源 rules.d/ 与相对路径的基准）；缺省 cwd' },
      maxRuleInjectPerStep: { type: 'number', description: '单步最多单独注入多少条规则（超出合并成一个块）；缺省 3' },
      allowExec: { type: 'boolean', description: 'true = 开闸允许 command 叶子执行外部命令（缺省关）' },
      argvAllow: { type: 'string', description: 'argv 前缀白名单，逗号分隔；如 "node -e,git"。开闸后只有命中前缀的命令才执行' },
      cmdCacheMs: { type: 'number', description: 'command 结果缓存窗口（毫秒，缺省 3000）：窗口内同一 argv 不重复执行' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          armed: { type: 'boolean', required: true },
          already: { type: 'boolean', required: true },
          everyStep: { type: 'boolean', required: true },
          docs: { type: 'boolean', required: true },
          durable: { type: 'boolean', required: true },
          loadedWatches: { type: 'number', required: true },
          result: { type: 'string', required: true },
        },
      },
      render: (_a, v) => [{ type: 'text', text: v.result }],
    },
    execute: async (args, exec) => {
      const agent = exec?.agent
      if (!agent) throw new Error('ctxinject_arm: 这次调用没有携带 agent（无法定位会话作用域）')
      const s = stateOf(agent)
      const already = typeof s.off === 'function'
      knownAgents.add(agent) // 记住这个 agent，供下次热载 reload 时自动重挂
      attach(agent.ctx, agent) // ★热载旁路：注册到事件域本身（内部先摘旧监听，幂等）
      s.cfg = {
        text: typeof args?.text === 'string' ? args.text : (s.cfg?.text ?? ''),
        notes: typeof args?.notes === 'string' ? args.notes : (s.cfg?.notes ?? ''),
        label: typeof args?.label === 'string' ? args.label : (s.cfg?.label ?? ''),
        withTime: args?.withTime === true,
        everyStep: args?.everyStep === true,
      }
      s.digest = ''
      s.store = typeof args?.store === 'string' && args.store ? args.store : (s.store || join(process.cwd(), '.ctxinject', 'watches.json'))
      s.root = typeof args?.root === 'string' && args.root ? args.root : (s.root || process.cwd())
      if (Number.isFinite(Number(args?.maxRuleInjectPerStep)) && Number(args.maxRuleInjectPerStep) > 0) {
        s.maxRuleInjectPerStep = Math.floor(Number(args.maxRuleInjectPerStep))
      }
      s.allowExec = args?.allowExec === true
      s.argvAllow = parseArgvAllow(args?.argvAllow)
      s.cmdCache = {} // arm 时清缓存，避免旧判定残留
      if (Number.isFinite(Number(args?.cmdCacheMs)) && Number(args.cmdCacheMs) >= 0) {
        s.cmdCacheMs = Math.floor(Number(args.cmdCacheMs))
      }
      const st = loadRuleState(s)
      s.firedRules = { ...(st.fired ?? {}), ...(s.firedRules ?? {}) }
      s.expiredRules = { ...(st.expired ?? {}), ...(s.expiredRules ?? {}) }
      s.disabledRules = { ...(st.disabled ?? {}), ...(s.disabledRules ?? {}) }
      s.seqProgress = { ...(st.seq ?? {}), ...(s.seqProgress ?? {}) }
      // 从磁盘恢复触发器（reload / 重启后不丢）
      const before = s.watches.length
      const loaded = loadStore(s)
      if (loaded.length > 0) s.watches = loaded
      const wantDocs = args?.docs !== false && s.docsSeen !== DOCS_VERSION
      if (wantDocs) s.docPending = true
      const durable = persist(s)
      const result = `上下文注入引擎已开启（${already ? '此前已武装，本次只更新配置' : '新武装'}）：`
        + `${s.cfg.everyStep ? '每个 step' : '每轮第一个 step（内容变化时）'}注入`
        + `${s.cfg.notes ? `，笔记 ${s.cfg.notes}` : ''}`
        + `；触发器 ${s.watches.length} 条${loaded.length > before ? '（从磁盘恢复）' : ''}`
        + `；${durable ? '持久化已开' : '持久化不可用（仅内存）'}`
        + `${wantDocs ? '；用法说明将在下一个 step 注入一次' : ''}`
      return res({ ok: true, armed: true, already, everyStep: s.cfg.everyStep, docs: wantDocs, durable, loadedWatches: s.watches.length, result })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'ctxinject_watch',
    description: '登记一条条件触发器：when 条件满足时把 inject 的文字注入回上下文（事后自我提醒）。同 id 覆盖。',
    parameters: {
      id: { type: 'string', required: true, description: '触发器 id（同 id 覆盖）' },
      inject: { type: 'string', required: true, description: '条件满足时要注入回上下文的文字' },
      when: {
        type: 'object', additionalProperties: true,
        description: "条件：{kind:'file-changed',path} | {kind:'file-contains',path,pattern,regex?} | {kind:'file-exists',path} | {kind:'turn-every',turns} | {kind:'turn-after',turns} | {kind:'time-after',minutes} | {kind:'always'}",
        properties: {
          kind: { type: 'string', description: '条件类型' },
          path: { type: 'string', description: '文件路径（file-* 类）' },
          pattern: { type: 'string', description: '匹配内容（file-contains）' },
          regex: { type: 'boolean', description: 'pattern 按正则解释' },
          turns: { type: 'number', description: '轮数（turn-*）' },
          minutes: { type: 'number', description: '分钟数（time-after）' },
        },
      },
      once: { type: 'boolean', description: 'true（缺省）= 触发一次后移除；false = 可重复触发' },
      store: { type: 'string', description: '持久化路径（缺省沿用 arm 的）' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          id: { type: 'string', required: true },
          condition: { type: 'string', required: true },
          total: { type: 'number', required: true },
          result: { type: 'string', required: true },
        },
      },
      render: (_a, v) => [{ type: 'text', text: v.result }],
    },
    execute: async (args, exec) => {
      const agent = exec?.agent
      if (!agent) throw new Error('ctxinject_watch: 这次调用没有携带 agent')
      const s = stateOf(agent)
      const id = String(args?.id ?? '').trim()
      if (!id) throw new Error('ctxinject_watch: id 不能为空')
      const when = (args?.when && typeof args.when === 'object') ? args.when : {}
      if (typeof when.kind !== 'string') throw new Error("ctxinject_watch: when.kind 必填（file-changed/file-contains/file-exists/turn-every/turn-after/time-after/always）")
      if (typeof args?.inject !== 'string' || args.inject.trim() === '') throw new Error('ctxinject_watch: inject 不能为空')
      if (typeof args?.store === 'string' && args.store) s.store = args.store
      const prev = s.watches.find((w) => w.id === id)
      const w = {
        id, inject: args.inject, when, once: args?.once !== false,
        baseline: undefined, lastState: undefined,
        createdTurn: prev?.createdTurn, createdAt: new Date().toISOString(),
        fired: prev?.fired ?? 0,
      }
      s.watches = s.watches.filter((x) => x.id !== id)
      s.watches.push(w)
      const durable = persist(s)
      const cond = describeWhen(when)
      return { ok: true, id, condition: cond, total: s.watches.length, result: `已登记触发器 \`${id}\`：${cond} → 触发时注入 ${args.inject.length} 字符${w.once ? '（一次）' : '（可重复）'}${durable ? '' : '；⚠️ 持久化失败（仅内存）'}` }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'ctxinject_unwatch',
    description: '移除一条已登记的条件触发器。',
    parameters: { id: { type: 'string', required: true, description: '触发器 id' } },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { ok: { type: 'boolean', required: true }, removed: { type: 'number', required: true }, total: { type: 'number', required: true }, result: { type: 'string', required: true } },
      },
      render: (_a, v) => [{ type: 'text', text: v.result }],
    },
    execute: async (args, exec) => {
      const agent = exec?.agent
      if (!agent) throw new Error('ctxinject_unwatch: 这次调用没有携带 agent')
      const s = stateOf(agent)
      const id = String(args?.id ?? '')
      const before = s.watches.length
      s.watches = s.watches.filter((w) => w.id !== id)
      persist(s)
      return { ok: true, removed: before - s.watches.length, total: s.watches.length, result: `移除 ${before - s.watches.length} 条（剩 ${s.watches.length}）` }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'ctxinject_watches',
    description: '列出本会话已登记的条件触发器及其状态（条件、是否一次、已触发次数、基线）。',
    parameters: {},
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { ok: { type: 'boolean', required: true }, count: { type: 'number', required: true }, result: { type: 'string', required: true } },
      },
      render: (_a, v) => [{ type: 'text', text: v.result }],
    },
    execute: async (_args, exec) => {
      const agent = exec?.agent
      if (!agent) throw new Error('ctxinject_watches: 这次调用没有携带 agent')
      const s = stateOf(agent)
      if (s.watches.length === 0) return { ok: true, count: 0, result: '当前没有登记的触发器。' }
      const lines = s.watches.map((w) => {
        const bits = [`- \`${w.id}\`：${describeWhen(w.when)}`, w.once ? '一次' : '可重复', w.fired ? `已触发 ${w.fired} 次` : '未触发']
        if (w.baseline) bits.push(`baseline=${w.baseline.slice(0, 8)}`)
        if (w.when?.path) { const st = fileStatText(w.when.path); if (st) bits.push(st) }
        return bits.join(' · ')
      })
      return { ok: true, count: s.watches.length, result: `触发器 ${s.watches.length} 条：\n${lines.join('\n')}` }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'ctxinject_status',
    description: '查看本会话上下文注入/条件触发的总状态。',
    parameters: {},
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true }, armed: { type: 'boolean', required: true },
          injects: { type: 'number', required: true }, fires: { type: 'number', required: true },
          watches: { type: 'number', required: true }, docsShown: { type: 'boolean', required: true },
          durable: { type: 'boolean', required: true }, store: { type: 'string', required: true },
          config: { type: 'string', required: true }, lastAt: { type: 'string' },
          instance: { type: 'string', required: true }, traceTail: { type: 'string', required: true },
          root: { type: 'string', required: true }, allowExec: { type: 'boolean', required: true },
          rules: { type: 'number', required: true }, docsVersion: { type: 'number', required: true },
        },
      },
      render: (_a, v) => [{ type: 'text', text: `armed=${v.armed} 注入=${v.injects} 触发=${v.fires} 触发器=${v.watches} 规则=${v.rules} docs=v${v.docsVersion} durable=${v.durable}\nroot=${v.root}  执行闸=${v.allowExec ? '开' : '关'}\ninstance=${v.instance}\nstore=${v.store}\nconfig=${v.config}\ntrace(tail)=${v.traceTail}` }],
    },
    execute: async (_args, exec) => {
      const agent = exec?.agent
      if (!agent) throw new Error('ctxinject_status: 这次调用没有携带 agent')
      const s = stateOf(agent)
      const tail = trace.slice(-12).map((r) => `${r.i}/t${r.turn}s${r.step}`).join(' ')
      const distinct = [...new Set(trace.map((r) => r.i))].join(',')
      let ruleCount = 0
      try { ruleCount = s.root ? loadRules(s.root).length : 0 } catch { ruleCount = -1 }
      return {
        ok: true, armed: typeof s.off === 'function',
        injects: s.injects, fires: s.fires, watches: s.watches.length,
        docsShown: s.docsSeen === DOCS_VERSION, durable: !!s.store && existsSync(s.store),
        root: s.root || '(未设置)', allowExec: s.allowExec === true,
        rules: ruleCount, docsVersion: s.docsSeen,
        store: s.store || '(未设置)', lastAt: s.lastAt ?? undefined,
        config: s.cfg ? JSON.stringify({ ...s.cfg, text: s.cfg.text ? `${s.cfg.text.length} 字符` : '' }) : '(未配置)',
        instance: `${INSTANCE_ID}（轨迹里出现过的实例：${distinct || '无'}）`,
        traceTail: tail || '(空)',
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'ctxinject_disarm',
    description: '关闭注入引擎并移除 agent/pre-step 监听（已注入进历史的消息与已登记的触发器都不会回滚）。',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, injects: { type: 'number', required: true }, fires: { type: 'number', required: true }, result: { type: 'string', required: true } } },
      render: (_a, v) => [{ type: 'text', text: v.result }],
    },
    execute: async (_args, exec) => {
      const agent = exec?.agent
      if (!agent) throw new Error('ctxinject_disarm: 这次调用没有携带 agent')
      const s = states.get(agent)
      const n = s?.injects ?? 0
      const f = s?.fires ?? 0
      detach(agent)
      return { ok: true, injects: n, fires: f, result: `注入引擎已关闭（本会话累计注入 ${n} 次、条件触发 ${f} 次；触发器仍留在磁盘）` }
    },
  }))
  } // end if (canTools)

  // ★热载透明性：reload 后自动把此前 arm 过的 agent 重新接上（并摘掉旧代监听器）。
  // 于是「改文件 → reload」就够了；忘了 arm 也不会静默跑旧代代码。
  for (const agent of knownAgents) {
    try { attach(agent.ctx, agent) } catch { /* agent 可能已销毁，忽略 */ }
  }

  // 资源挂生命周期：卸载本能力时移除监听。
  ctx.effect(() => () => { /* 各 agent 的 detach 由 scope 收口；此处兜底 */ })

  return { capability: capability || 'ctxinject', tools: ['ctxinject_arm', 'ctxinject_watch', 'ctxinject_unwatch', 'ctxinject_watches', 'ctxinject_status', 'ctxinject_disarm'] }
}


