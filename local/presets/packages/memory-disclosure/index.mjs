/**
 * 记忆河流能力说明的本地注入器。
 *
 * 来历：原为 dsh-preset-composer 生成；预设体系改版后由本 bundle 自行维护，不再是生成物。
 * 职责：把「可用能力的使用说明」在**用户发出第一条消息之后**注入一次，
 * 这样系统提示可以保持极简（贴近模型训练时见过的形状），而说明仍然到得了模型手上。
 *
 * 只依赖 node: 内建——预设资产不保证能解析裸包名。挂载的 `agent/pre-step` 已在
 * dsh 0.1.7-rc.2 上核对存在（packages/core/agent-loop/src/agent.ts）。
 * 消息对象手搓字面量：dsh-llm 的 createMessage 只做 structuredClone + deepFreeze，无运行期校验。
 */
import { randomUUID } from 'node:crypto'

/** 加载器按包名/模块名寻址；与组合文件里的行 id 对应。 */
export const name = 'memory-disclosure'

const MARKER = "⟨记忆河流·能力说明⟩"
const TEXT = "⟨记忆河流·能力说明⟩\n本环境有【记忆河流】：VCPToolBox 的 TagMemo/RiverMemo 记忆算法。\n· 每轮我在形成回答之前，相关历史日记片段已经进入上下文（被动注入）；片段带证据等级：\n  role=direct_answer 可直接采信 / structural_explanation 是结构推理 / thematic_neighbor 仅主题邻近。\n· 工具：memo_recall 主动补证 / memo_write 写日记 / memo_stats 语料体检 / memo_tags 查看 Tag 词汇表 / memo_drafts 草稿队列。\n· 写日记规范（来自记忆系统作者）：\n  ① 写入前先看本轮已注入的相关旧日记与 memo_tags 的词汇表；\n  ② 延续确有同一语义的稳定 Tag；只有概念真正变化时才创建新 Tag；\n  ③ 正文写清\"延续、转折、因果、冲突或完成\"，让 Tag 共现有叙事依据；\n  ④ 召回内容是历史记录而非绝对真理；与当前事实冲突时记录修正和信源；\n  ⑤ 不要为了制造拓扑而堆砌无关旧 Tag。河流来自真实经历的延续，不来自标签数量。\n· 草稿：守护循环把回合摘要自动存为待确认草稿；用户说「看草稿/批准/丢弃」时，用 memo_drafts 列队、memo_approve 一键批准入库（Tag 只复用既有词汇）、memo_discard 丢弃。\n· 原则：被动注入给线索，细节用 memo_recall 深挖；不确定时先验证再下结论。\n⟨记忆河流·能力说明⟩"

export function apply(ctx) {
  if (typeof ctx?.on !== 'function') return
  ctx.on(
    'agent/pre-step',
    async (payload, next) => {
      // ① 永远先委托，不夺权、不改写别人的决策。
      const decision = await next()
      try {
        if (!decision || decision.kind !== 'enter') return decision
        if (payload?.signal?.aborted) return decision
        // ② 只在本会话的第一个 turn 的第一个 step 注入：这一批会进会话日志，之后天然可见。
        if (payload?.turn !== 1 || payload?.step !== 1) return decision
        const messages = Array.isArray(decision.messages) ? decision.messages : []
        // ③ 幂等：多代实例并存时两个监听器都会走到这里，先到的那次已经放了标记。
        if (messages.some((m) => messageText(m).includes(MARKER))) return decision
        return { ...decision, messages: [...messages, message(TEXT)] }
      } catch (e) {
        // ④ 降级：不注入 + 记 stderr，绝不阻塞主流程。
        try {
          console.error('[memory-disclosure] 注入失败，已降级：' + String((e && e.message) || e))
        } catch {}
        return decision
      }
    },
    { prepend: true },
  )
}

/** 取一条消息的纯文本（content 可能是字符串或分块数组）。 */
function messageText(m) {
  if (!m) return ''
  const content = m.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((part) => (part && typeof part.text === 'string' ? part.text : '')).join('')
  return ''
}

/** 手搓一条 user 消息（形状对齐 dsh-llm 的 createUserMessage）。 */
function message(text) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'memory-disclosure', form: 'disclosure' },
  }
}
