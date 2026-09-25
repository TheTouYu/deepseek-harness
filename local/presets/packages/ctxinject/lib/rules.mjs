// 规则引擎（自 ctxinject.mjs 抽出）：条件求值、动作执行、规则源加载、规则状态持久化。
// 纯逻辑：只认识 root 与规则对象，不认识插件/agent。
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { join, dirname, isAbsolute, resolve, sep } from 'node:path'
import { spawnSync } from 'node:child_process'

// ── 外部规则源（<root>/.ctxinject/rules.d/*.json） ─────────────────────────────
/** 规则里的相对路径一律相对 root 解析。 */
export function resolveIn(root, p) {
  const s = String(p ?? '')
  return isAbsolute(s) ? s : join(root, s)
}

/** 路径围栏：解析后必须落在 root 内（root 为空则不设限，测试/独立调用用）。 */
export function inRoot(root, p) {
  if (!root) return true
  const base = resolve(root)
  const full = resolve(base, String(p ?? ''))
  return full === base || full.startsWith(base + sep)
}

/** 读取规则目录：一文件一规则；坏文件跳过，绝不拖垮 pre-step。 */
export function loadRules(root) {
  if (!root) return []
  const dir = join(root, '.ctxinject', 'rules.d')
  let names
  try { names = readdirSync(dir).filter((n) => n.endsWith('.json')) } catch { return [] }
  const out = []
  for (const n of names.sort()) {
    try {
      const raw = JSON.parse(readFileSync(join(dir, n), 'utf8'))
      if (raw && typeof raw === 'object' && raw.id && raw.when) out.push({ ...raw, _src: n })
    } catch { /* 坏规则跳过 */ }
  }
  return out
}

// 规则「已触发」状态：跨 reload/实例持久化，否则默认自毁的规则会复活。
function ruleStatePath(s) { return join(s.root, '.ctxinject', 'state.json') }
export function loadRuleState(s) {
  try {
    const raw = JSON.parse(readFileSync(ruleStatePath(s), 'utf8'))
    return raw && typeof raw === 'object' ? raw : {}
  } catch { return {} }
}
export function saveRuleState(s) {
  try {
    mkdirSync(dirname(ruleStatePath(s)), { recursive: true })
    writeFileSync(ruleStatePath(s), JSON.stringify({ fired: s.firedRules ?? {}, expired: s.expiredRules ?? {}, disabled: s.disabledRules ?? {}, seq: s.seqProgress ?? {} }, null, 2))
  } catch { /* 持久化失败只降级 */ }
}

/** file-line：判断文件中某一行的内容。line 负数从尾部数，缺省看最后一行。 */
export function evalFileLine(c, root) {
  const txt = readSafe(resolveIn(root, c.path))
  if (txt === null) return { fire: false }
  const body = txt.replace(/\r?\n$/, '')
  const lines = body === '' ? [] : body.split(/\r?\n/)
  if (lines.length === 0) return { fire: false }
  const n = typeof c.line === 'number' ? c.line : -1
  const idx = n < 0 ? lines.length + n : n
  const line = lines[idx]
  if (line === undefined) return { fire: false }
  const hit =
    typeof c.matches === 'string' ? new RegExp(c.matches).test(line)
      : typeof c.contains === 'string' ? line.includes(c.contains)
        : typeof c.equals === 'string' ? line === c.equals
          : false
  const want = c.matches ?? c.contains ?? c.equals
  return hit ? { fire: true, detail: `${c.path} 第 ${idx + 1} 行命中「${want}」` } : { fire: false }
}

/** 取 JSON 指针（'/a/b'）；空/缺省取整个文档。 */
function getPtr(doc, ptr) {
  const p = String(ptr ?? '').trim()
  if (p === '' || p === '/') return doc
  return p.split('/').filter(Boolean).reduce((acc, k) => (acc == null ? undefined : acc[k]), doc)
}

/** file-json：把 JSON 文件读进来，按指针取值再用操作符比较（外部「写复杂条件」的核心）。 */
export function evalFileJson(c, root) {
  const txt = readSafe(resolveIn(root, c.path))
  if (txt === null) return { fire: false }
  let doc
  try { doc = JSON.parse(txt) } catch { return { fire: false } }
  const cur = getPtr(doc, c.ptr)
  const val = c.value
  let hit = false
  switch (c.op ?? 'eq') {
    case 'exists': hit = cur !== undefined; break
    case 'eq': hit = cur === val; break
    case 'ne': hit = cur !== val; break
    case 'gt': hit = Number(cur) > Number(val); break
    case 'gte': hit = Number(cur) >= Number(val); break
    case 'lt': hit = Number(cur) < Number(val); break
    case 'lte': hit = Number(cur) <= Number(val); break
    case 'in': hit = Array.isArray(val) && val.includes(cur); break
    default: hit = false
  }
  return hit
    ? { fire: true, detail: `${c.path}${c.ptr ?? ''} ${c.op ?? 'eq'} ${JSON.stringify(val)}（实际 ${JSON.stringify(cur)}）` }
    : { fire: false }
}

/**
 * signal：文件系统事件总线 —— 外部往 <root>/<dir> 里写一个以 topic 命名的文件即"发布事件"。
 * consume:true 表示事件被消费后删除（一次性事件）。
 *
 * ★ 两段式：这里**只把"删除"登记成副作用**（effects），不立刻删。
 *   因为条件树可能在 `all` 里求值到一半就失败 —— 若当场消费，信号就丢了，
 *   等其它子条件将来成立时它已经不在了。由调用方在**规则真正触发后**提交副作用。
 */
export function evalSignal(c, root, io) {
  const rel = String(c.dir ?? '.ctxinject/signals')
  const topic = String(c.topic ?? c.name ?? '')
  if (!topic) return { fire: false }
  if (!inRoot(root, rel)) return { fire: false }
  const dir = resolveIn(root, rel)
  const p = join(dir, topic)
  if (!inRoot(root, p)) return { fire: false }
  if (!existsSync(p)) return { fire: false }
  let payload = ''
  try { payload = readFileSync(p, 'utf8').trim() } catch { /* 读不到当空载荷 */ }
  if (c.consume === true && io && Array.isArray(io.effects)) io.effects.push({ kind: 'remove', path: p })
  return { fire: true, detail: `信号 ${topic}${payload ? `（${payload}）` : ''}` }
}

/** 规则的副作用：只有规则真的触发才提交（目前只有消费信号）。 */
export function runEffects(effects) {
  for (const e of effects) {
    try { if (e?.kind === 'remove') rmSync(e.path, { force: true }) } catch { /* 删不掉不影响触发 */ }
  }
}

/** 把 "node -e,git" 解析成 [['node','-e'],['git']]（也接受已经是数组的形态）。 */
export function parseArgvAllow(spec) {
  if (Array.isArray(spec)) {
    return spec.map((x) => (Array.isArray(x) ? x.map(String) : String(x).trim().split(/\s+/))).filter((a) => a.length > 0)
  }
  return String(spec ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.split(/\s+/))
}

function argvAllowed(allow, argv) {
  if (!Array.isArray(allow) || allow.length === 0) return false
  return allow.some((pre) => Array.isArray(pre) && pre.length > 0 && pre.every((tok, i) => argv[i] === tok))
}

/**
 * command：跑一个外部命令，按退出码 / stdout 判定。
 * ★ 双重开闸：arm 必须显式 allowExec=true，**且** argv 命中白名单前缀；否则一律拒绝、不执行。
 *   规则文件是外部可写的，所以执行能力绝不能是"默认打开"的。
 */
export function evalCommand(c, root, io) {
  if (io?.allowExec !== true) return { fire: false }
  const argv = Array.isArray(c.argv) ? c.argv.map(String) : []
  if (argv.length === 0) return { fire: false }
  if (!argvAllowed(io?.argvAllow, argv)) return { fire: false }
  const cwd = c.cwd ? resolveIn(root, c.cwd) : root
  if (c.cwd && !inRoot(root, c.cwd)) return { fire: false }
  // 结果缓存：命令是在**求值期**执行的，条件不成立也会每步重跑 —— 最坏每步阻塞一个 timeout。
  // 同一 argv+cwd 在 cmdCacheMs 窗口内复用上次判定，不重复 spawn。
  const cache = io?.cmdCache
  const ttl = Number(io?.cmdCacheMs) || 0
  const key = `${argv.join('\u0000')}@${cwd}`
  const now = Date.now()
  if (cache && ttl > 0 && cache[key] && now - cache[key].at < ttl) return cache[key].result

  const timeout = Math.max(100, Number(c.timeoutMs) || 5000)
  let r
  try {
    r = spawnSync(argv[0], argv.slice(1), { cwd, timeout, encoding: 'utf8' })
  } catch {
    return { fire: false }
  }
  const code = r.status
  let hit = code === (c.expectExit ?? 0)
  const out = String(r.stdout ?? '')
  if (hit && typeof c.stdoutContains === 'string') hit = out.includes(c.stdoutContains)
  if (hit && typeof c.stdoutMatches === 'string') {
    try { hit = new RegExp(c.stdoutMatches).test(out) } catch { hit = false }
  }
  const result = hit ? { fire: true, detail: `命令 ${argv.join(' ')} 退出码 ${code}` } : { fire: false }
  if (cache && ttl > 0) cache[key] = { at: now, result }
  return result
}

/** 递归求值条件树：叶子（file-line…）+ 复合（all/any/not/seq…）。求值绝不抛。
 *
 *  `io` 承载求值期的上下文：
 *    · io.effects  —— 登记副作用（如消费信号），由调用方在规则**真正触发后**提交；
 *    · io.progress —— seq 的有序进度（按条件树路径存），跨 step 持久化；
 *    · io.commit() —— 立刻提交当前登记的副作用（seq 走完一步就用它）。
 *  `path` 是条件树里的位置（'/'、'/0'…），seq 用它当进度键。 */
export function evaluate(when, root, io, path = '') {
  const c = when ?? {}
  const key = path || '/'
  try {
    // 围栏：带 path 的叶子一律先过 root 归属检查
    if (typeof c.path === 'string' && c.path && !inRoot(root, c.path)) return { fire: false }
    switch (c.kind) {
      case 'file-line':
        return evalFileLine(c, root)

      case 'file-json':
        return evalFileJson(c, root)

      case 'signal':
        return evalSignal(c, root, io)

      case 'command':
        return evalCommand(c, root, io)

      case 'all': {
        const of = Array.isArray(c.of) ? c.of : []
        if (of.length === 0) return { fire: false }
        const details = []
        for (let i = 0; i < of.length; i++) {
          const r = evaluate(of[i], root, io, `${key}/${i}`)
          if (!r.fire) return { fire: false }
          if (r.detail) details.push(r.detail)
        }
        return { fire: true, detail: details.join('；') }
      }

      case 'any': {
        const of = Array.isArray(c.of) ? c.of : []
        for (let i = 0; i < of.length; i++) {
          const r = evaluate(of[i], root, io, `${key}/${i}`)
          if (r.fire) return { fire: true, detail: r.detail }
        }
        return { fire: false }
      }

      case 'not': {
        const r = evaluate(c.of, root, io, `${key}/0`)
        return r.fire ? { fire: false } : { fire: true, detail: '子条件不成立（not）' }
      }

      case 'seq': {
        // 有序状态机：io.progress[key] 记住走到第几步（跨 step 持久化），
        // 走过的步其副作用**立刻提交**（那些事件确实被"看到"了）→ 达成"先 A 再 B"。
        const of = Array.isArray(c.of) ? c.of : []
        if (of.length === 0) return { fire: false }
        let at = Number(io?.progress?.[key] ?? 0)
        const details = []
        while (at < of.length) {
          const r = evaluate(of[at], root, io, `${key}/${at}`)
          if (!r.fire) break
          if (r.detail) details.push(r.detail)
          at += 1
          if (io?.progress) io.progress[key] = at
          if (typeof io?.commit === 'function') io.commit()
        }
        return at >= of.length ? { fire: true, detail: details.join(' → ') } : { fire: false }
      }

      case 'count': {
        // 至少 n 个子条件成立（不短路：需要数完才知道够不够）
        const of = Array.isArray(c.of) ? c.of : []
        const need = Math.max(1, Number(c.gte ?? c.n ?? 1))
        let hit = 0
        const details = []
        for (let i = 0; i < of.length; i++) {
          const r = evaluate(of[i], root, io, `${key}/${i}`)
          if (r.fire) {
            hit += 1
            if (r.detail) details.push(r.detail)
          }
        }
        return hit >= need
          ? { fire: true, detail: `${hit}/${of.length} 成立：${details.join('；')}` }
          : { fire: false }
      }

      default:
        return { fire: false }
    }
  } catch {
    return { fire: false }
  }
}

export function renderRuleFire(rule, detail) {
  // 插值：{{rule.id}} / {{detail}} —— 让外部规则能把"为什么触发"写进提醒正文
  const body = String(rule.then?.inject ?? '(该规则未提供注入文本)')
    .replaceAll('{{rule.id}}', rule.id)
    .replaceAll('{{detail}}', detail ?? '')
  return [
    `⟨ctxinject·规则触发⟩ ${rule.id}`,
    detail ? `· 条件：${detail}` : '',
    '',
    body,
  ].filter(Boolean).join('\n')
}

/** 同一步触发过多时的合并块：不刷屏，但一条都不丢。 */
export function renderRuleMerge(items) {
  return [
    `⟨ctxinject·规则合并⟩ ${items.length} 条外部条件同一步成立（按每步预算合并）`,
    ...items.map((f) => `· ${f.rule.id}：${f.rule.then?.inject ?? '(无注入文本)'}`),
  ].join('\n')
}

export function renderRuleExpired(rule) {
  return [
    `⟨ctxinject·规则作废⟩ ${rule.id}`,
    `· 到期：${rule.expires}`,
    '',
    `这条外部条件到期仍未触发，已作废 —— 别再等它了${rule.then?.inject ? `（原定提醒：「${rule.then.inject}」）` : ''}。`,
  ].join('\n')
}

/** 执行规则动作。动作失败只降级，绝不影响已经发生的注入。 */
export function runActions(s, rule) {
  const acts = Array.isArray(rule.then?.actions) ? rule.then.actions : []
  for (const act of acts) {
    try {
      switch (act?.kind) {
        case 'write': {
          if (!inRoot(s.root, act.path)) break // 围栏：不许写到 root 外
          const p = resolveIn(s.root, act.path)
          mkdirSync(dirname(p), { recursive: true })
          writeFileSync(p, String(act.content ?? ''))
          break
        }
        case 'disable':
          for (const id of (act.ids ?? [])) s.disabledRules[id] = new Date().toISOString()
          saveRuleState(s)
          break
        case 'emit': {
          // 投递一个事件到信号目录 —— 让别的规则（或外部进程）接力
          const rel = String(act.dir ?? '.ctxinject/signals')
          const topic = String(act.topic ?? '')
          if (!topic || !inRoot(s.root, rel) || !inRoot(s.root, join(rel, topic))) break
          const dir = resolveIn(s.root, rel)
          mkdirSync(dir, { recursive: true })
          writeFileSync(join(dir, topic), String(act.content ?? ''))
          break
        }
        default:
          break
      }
    } catch { /* 动作失败只降级 */ }
  }
}


/** 读文件，失败返回 null（不抛）。 */
export function readSafe(path) {
  try { return readFileSync(String(path), 'utf8') } catch { return null }
}
