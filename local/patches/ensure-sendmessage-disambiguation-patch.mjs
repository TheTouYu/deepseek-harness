#!/usr/bin/env node
/**
 * 消除 send_message 双语义同名遮蔽（根因取证：D133 日记；事故现场：决策模型项目
 * Lead 会话 session-c345a13b，2026-10-15 排障；用户批准实施）。
 *
 * 问题：两个同名 send_message —— dsh-tool-subagent-control 全局版（参数 agent_id，
 * 接受 continuable childId）在勾了 delegation 的会话里被 dsh-experimental-tool-agent-team
 * 的 per-agent 版（参数 target，只认 Team roster kebab-name）按官方 per-agent 变体通道覆盖。
 * subagent 工具描述却静态承诺「continue with send_message」→ 模型传 childId 必然报
 * TEAM_MEMBER_NOT_FOUND，错误消息无指引。
 *
 * 修复三件事：
 *   A. 全局版改名 send_message → message_agent（Team 会话里两者并存，各归其位）；
 *   B. 指名道姓的描述/引导文本/运行时按名查找同步改 message_agent（顺带修复 Team
 *      会话里 guidance 分支 get("send_message") 拿到无标记 agent-team 版导致
 *      withContinuableReturnGuidance 失效的问题）；
 *   C. agent-team 版 TEAM_MEMBER_NOT_FOUND 对 UUID 形状 target 追加引导。
 *
 * 用法（对齐本目录 connstuck/quotamisclass 的 D72 语义）：
 *   node ensure-sendmessage-disambiguation-patch.mjs [--check] [--strict] [DSH_ROOT]
 *   DSH_ROOT 缺省 /home/h/.local/lib/node_modules/@deepseek-ai/dsh
 *   退出码：施打模式 0=完成或已打好；--check 0=全部已打/1=有需打；
 *           锚点异常（上游布局变化）默认放行 exit 0 并落 /var/tmp/dsh-sendmsg-patch.status
 *           留痕；--strict 时锚点异常 exit 2（当阻断闸门用）。
 *   目标文件不存在（包改名/未装）：视为环境变化，放行 exit 0 + 留痕。
 * 行为：幂等；锚点唯一性断言；写盘前 node --check 语法预检；首次施打备份
 *       <file>.bak-sendmsg-<ts>；施打后逐文件 import 烟测。
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';

const args = process.argv.slice(2);
const CHECK = args.includes('--check');
const STRICT = args.includes('--strict');
const ROOT = args.find(a => !a.startsWith('--'))
  ?? '/home/h/.local/lib/node_modules/@deepseek-ai/dsh';
const PKGS = join(ROOT, 'node_modules', '@deepseek-ai');
const STATUS = '/var/tmp/dsh-sendmsg-patch.status';

const UUID_HINT = 'This looks like a subagent id: continue a subagent with message_agent({ agent_id }); this tool only takes teammate names from spawn_teammate/list_agents';
const UUID_TEST_BUNDLE = '/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(name)';
const UUID_TEST_SRC = '/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(name)';

/** @type {{file: string, label: string, edits: {from: string, to: string}[]}[]} */
const TARGETS = [
  {
    file: join(PKGS, 'dsh-tool-subagent-control/lib/index.js'),
    label: 'A. 全局版改名 message_agent',
    edits: [
      { from: '\t\tname: "send_message",', to: '\t\tname: "message_agent",' },
      { from: "You can continue a direct child's conversation later with send_message.", to: "You can continue a direct child's conversation later with message_agent." },
    ],
  },
  {
    file: join(PKGS, 'dsh-tool-subagent/lib/index.js'),
    label: 'B1. subagent 工具描述续聊承诺',
    edits: [
      { from: 'you can continue with `send_message`', to: 'you can continue with `message_agent`' },
    ],
  },
  {
    file: join(PKGS, 'dsh-subagent/lib/index.js'),
    label: 'B2/B3. bundle：引导文本 + 按名查找',
    edits: [
      { from: 'send your result to that agent with send_message({ agent_id: ', to: 'send your result to that agent with message_agent({ agent_id: ' },
      { from: 'this.ctx.get("tools")?.get("send_message", activation.handle.agent)', to: 'this.ctx.get("tools")?.get("message_agent", activation.handle.agent)' },
    ],
  },
  {
    file: join(PKGS, 'dsh-subagent/lib/types/continuation-messages.js'),
    label: 'B2 源文件：引导文本',
    edits: [
      { from: '+ `send_message({ agent_id: ', to: '+ `message_agent({ agent_id: ' },
    ],
  },
  {
    file: join(PKGS, 'dsh-subagent/lib/types/continuation.js'),
    label: 'B3 源文件：按名查找',
    edits: [
      { from: "this.ctx.get('tools')?.get('send_message', activation.handle.agent)", to: "this.ctx.get('tools')?.get('message_agent', activation.handle.agent)" },
    ],
  },
  {
    file: join(PKGS, 'dsh-experimental-agent-team/lib/index.js'),
    label: 'C bundle：UUID 错误引导',
    edits: [
      {
        from: 'if (member === void 0 || member.phase !== "active") throw new TeamError(`active teammate "${name}" not found`, "TEAM_MEMBER_NOT_FOUND");',
        to: `if (member === void 0 || member.phase !== "active") throw new TeamError(${UUID_TEST_BUNDLE} ? \`active teammate "\${name}" not found. ${UUID_HINT}\` : \`active teammate "\${name}" not found\`, "TEAM_MEMBER_NOT_FOUND");`,
      },
    ],
  },
  {
    file: join(PKGS, 'dsh-experimental-agent-team/lib/types/roster.js'),
    label: 'C 源文件：UUID 错误引导',
    edits: [
      {
        from: `        throw new TeamError(\`active teammate "\${name}" not found\`, 'TEAM_MEMBER_NOT_FOUND');`,
        to: `        const uuidLike = ${UUID_TEST_SRC};\n        throw new TeamError(uuidLike ? \`active teammate "\${name}" not found. ${UUID_HINT}\` : \`active teammate "\${name}" not found\`, 'TEAM_MEMBER_NOT_FOUND');`,
      },
    ],
  },
];

let needApply = 0;
let anomalies = 0;
const anomalyNotes = [];
const stamp = new Date().toISOString().replace(/[:T]/g, '').slice(0, 15);

function noteAnomaly(label, detail) {
  anomalies++;
  anomalyNotes.push(`[${label}] ${detail}`);
}

for (const target of TARGETS) {
  let text;
  try {
    text = readFileSync(target.file, 'utf8');
  } catch {
    noteAnomaly(target.label, `目标文件不存在（包未装/改名？）：${target.file}`);
    continue;
  }
  let dirty = false;
  for (const edit of target.edits) {
    const fromCount = text.split(edit.from).length - 1;
    const toCount = text.split(edit.to).length - 1;
    if (fromCount === 0 && toCount >= 1) {
      console.log(`✓ [${target.label}] 已打过，跳过`);
      continue;
    }
    if (fromCount !== 1) {
      noteAnomaly(target.label, `锚点出现 ${fromCount} 次（期望 1）：${edit.from.slice(0, 80)}`);
      continue;
    }
    if (CHECK) {
      console.log(`- [${target.label}] 需打`);
      needApply++;
      continue;
    }
    text = text.replace(edit.from, edit.to);
    dirty = true;
  }
  if (dirty) {
    const backup = `${target.file}.bak-sendmsg-${stamp}`;
    copyFileSync(target.file, backup);
    const tmp = join(dirname(target.file), `.sendmsg-patch-${randomUUID().slice(0, 8)}.js`);
    writeFileSync(tmp, text);
    try {
      execFileSync('node', ['--check', tmp], { stdio: 'pipe' });
      writeFileSync(target.file, text);
      console.log(`✓ [${target.label}] 已施打（备份 ${backup}）`);
    } catch (err) {
      noteAnomaly(target.label, `语法预检失败，未落盘：${String(err.stderr).slice(0, 200)}`);
    } finally {
      rmSync(tmp, { force: true });
    }
  }
}

if (CHECK) {
  if (needApply > 0) {
    console.log(`\n结果：${needApply} 处需打。`);
    process.exit(1);
  }
  if (anomalies > 0) {
    const report = `dsh-sendmsg-patch ${new Date().toISOString()}\n${anomalyNotes.join('\n')}\n`;
    try { writeFileSync(STATUS, report); } catch { /* /var/tmp 不可写时静默，stdout 已有信息 */ }
    console.error(`\n⚠ ${anomalies} 个锚点异常（--check 巡检语义：报 2），详见 ${STATUS}：`);
    for (const n of anomalyNotes) console.error(`  ${n}`);
    process.exit(2);
  }
  console.log('\n结果：全部已打好。');
  process.exit(0);
}
if (anomalies > 0) {
  const report = `dsh-sendmsg-patch ${new Date().toISOString()}\n${anomalyNotes.join('\n')}\n`;
  try { writeFileSync(STATUS, report); } catch { /* /var/tmp 不可写时静默，stdout 已有信息 */ }
  console.error(`⚠ ${anomalies} 个锚点异常（上游布局变化或目标缺失）——已放行，详见 ${STATUS}：`);
  for (const n of anomalyNotes) console.error(`  ${n}`);
  if (STRICT) {
    console.error('--strict：以阻断语义退出。');
    process.exit(2);
  }
  console.error('默认放行（可用性优先于补丁）；人工核对后更新锚点再重跑。');
  process.exit(0);
}

// 施打后 import 烟测：模块可加载（只加载不 apply，无副作用）
let smokeFailed = false;
for (const target of TARGETS) {
  try {
    execFileSync('node', ['-e', `import(${JSON.stringify(target.file)}).catch(e=>{throw e})`], { stdio: 'pipe' });
  } catch (err) {
    const msg = String(err.stderr || err.message);
    // cordis 等裸依赖从补丁器 cwd 解析不到属预期；其余为真失败
    if (!msg.includes('Cannot find package') && !msg.includes('ERR_MODULE_NOT_FOUND')) {
      console.error(`✗ import 烟测失败 ${target.file}: ${msg.slice(0, 200)}`);
      smokeFailed = true;
    }
  }
}
if (smokeFailed) process.exit(2);
console.log('\n结果：施打完成，语法预检与 import 烟测全部通过。');
console.log('提醒：运行中的 dsh 实例工具面是启动快照，重启后新会话才生效。');
process.exit(0);
