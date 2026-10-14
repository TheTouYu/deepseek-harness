// 验收 2（算法级，语料回归）：从**打过补丁的真实文件**里抽出 repairToolCallJson 逐案跑，
// 保证测的就是线上跑的那段代码（不是重抄的副本）。
// 合同两条：
//   A. 绝不让「非法 JSON」以非原文形式溜出去（要么修成合法且等于模型本意，要么原样返回）；
//   B. 绝不把「结构病」猜成合法 JSON —— 猜错参数比整轮失败更危险。
import { readFileSync } from "node:fs";

const TARGET = "/home/h/.local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm-deepseek/lib/index.js";
const src = readFileSync(TARGET, "utf8");
const start = src.indexOf("function repairToolCallJson(raw) {");
if (start < 0) { console.log("FAIL 补丁未落位：源码里没有 repairToolCallJson"); process.exit(1); }
const end = src.indexOf("\n}", start);
if (end < 0) { console.log("FAIL 抽取失败：找不到函数结尾"); process.exit(1); }
const repair = new Function(`${src.slice(start, end + 2)}; return repairToolCallJson;`)();

let fail = 0;
const ok = (name, cond, extra = "") => { console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra ? " :: " + extra : ""}`); if (!cond) fail++; };
const warns = [];
const realWarn = console.warn;
console.warn = (...a) => warns.push(a.join(" "));

// —— 正面：漏转义内层引号，必须修成模型本意 ——
const positives = [
  ["单层工具入参（0.1.5 时代同款事故载荷）", String.raw`{"command":"echo "hi""}`, { command: 'echo "hi"' }],
  ["路径里带引号", String.raw`{"path":"/home/h/my "quoted" dir/f.txt"}`, { path: '/home/h/my "quoted" dir/f.txt' }],
  ["同对象里前后还有其它键", String.raw`{"a":"x","b":"say "hi" now","c":1}`, { a: "x", b: 'say "hi" now', c: 1 }],
  ["一段里两处漏转义", String.raw`{"c":"ls "a" && echo "b""}`, { c: 'ls "a" && echo "b"' }],
  ["内嵌换行的正文", '{"content":"l1\\nl2 "q" end"}', { content: 'l1\nl2 "q" end' }],
];

for (const [label, raw, intended] of positives) {
  const out = repair(raw);
  let parsed = null, valid = true;
  try { parsed = JSON.parse(out); } catch { valid = false; }
  ok(`正面/已修复: ${label}`, valid && JSON.stringify(parsed) === JSON.stringify(intended),
    valid ? JSON.stringify(parsed) : `仍非法: ${out}`);
  ok(`正面/确实动过手（非原文）: ${label}`, out !== raw);
}

// —— 负面：结构病与合法输入，必须逐字节原样返回（不猜） ——
const negatives = [
  ["合法 JSON 恒等返回", String.raw`{"a":1,"b":"say \"hi\" now"}`],
  ["漏逗号（结构病，猜了就会悄悄改参数）", String.raw`{"a": "b" "c": 1}`],
  ["漏逗号且后续不是合法键形（同上，不猜）", String.raw`{"a": 1 "b": 2}`],
  ["漏冒号（引号有闭合引号 ⇒ 语义不明）", String.raw`{"a": "b" "c"}`],
  ["数组漏逗号（报错类别不同，必须原样返回）", String.raw`["a" "b"]`],
  ["嵌套数组漏逗号", String.raw`{"a": ["x" "y"]}`],
  ["尾逗号", String.raw`{"a": 1,}`],
  ["多余右花括号（2026-09 旧案同族）", String.raw`{"a": 1}}`],
  ["截断", String.raw`{"a":`],
  ["字符串未闭合", String.raw`{"a": "x}`],
  ["JSON 后面跟垃圾", String.raw`{"a": 1} extra`],
  ["单引号风格", String.raw`{'a': 1}`],
];

for (const [label, raw] of negatives) {
  const out = repair(raw);
  ok(`负面/原样返回: ${label}`, out === raw, out === raw ? "" : `改动成: ${out}`);
}
console.warn = realWarn;

console.log(`\n修复告警 ${warns.length} 条（应为 ${positives.length} 条 = 正面案数）: 例 ${warns[0] ?? "无"}`);
ok("告警条数 == 正面案数（负面一个都没偷偷修）", warns.length === positives.length, String(warns.length));

console.log(fail === 0 ? "\n全部 PASS" : `\n${fail} 项 FAIL`);
process.exit(fail === 0 ? 0 : 1);
