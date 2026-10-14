// 验收 3（端到端）：真 HTTPS 服务 + 真 DeepSeekAdapter.stream() + 真 SSE 解析 + 真 translate 收口。
// 不是模拟收口点，是把整条链路跑起来：node:https 上的 SSE 帧 → parseSse → translate →
// content_block_stop 处的 arguments 收口 → block-end 事件。
// 同一份用例跑两次（E2E_MODULE 指哪个模块）：original = 上游原文件（.mjs 副本），patched = 打过补丁的。
//   原文件应当判死（MALFORMED_RESPONSE），补丁后应当修好并给出模型本意的参数 —— 对照即证据。
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"; // 本地自签证书；仅测试进程，不进生产

import { createServer } from "node:https";
import { readFileSync } from "node:fs";

const HERE = "/home/h/dsh-plugins/.scratch/invalidjson";
const MODULE = process.env.E2E_MODULE
  ?? "/home/h/.local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm-deepseek/lib/index.js";
const LABEL = process.env.E2E_LABEL ?? "patched";
const { DeepSeekAdapter, resolveAdapterOptions } = await import(MODULE);

let fail = 0;
const ok = (name, cond, extra = "") => { console.log(`${cond ? "PASS" : "FAIL"} [${LABEL}] ${name}${extra ? " :: " + extra : ""}`); if (!cond) fail++; };

// —— SSE 夹具：把一段 tool 入参按真实流式的样子切片 ——
const frame = (type, data) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
function sseFor(payloadChunks) {
  return [
    frame("message_start", { type: "message_start", message: { usage: { input_tokens: 7 } } }),
    frame("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_e2e_1", name: "run_shell", input: {} } }),
    ...payloadChunks.map((partial_json) => frame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json } })),
    frame("content_block_stop", { type: "content_block_stop", index: 0 }),
    frame("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 12 } }),
    frame("message_stop", { type: "message_stop" }),
  ].join("");
}

const CANONICAL = String.raw`{"command":"echo "hi""}`;
const VALID = String.raw`{"command":"echo \"hi\""}`;
const STRUCTURAL = String.raw`{"command": "ls" "cwd": "/tmp"}`;   // 漏逗号：结构病，不能猜
const EXTRA_BRACE = String.raw`{"command":"ls"}}`;                // 2026-09 旧案同族：多一个 }

const CASES = {
  canonical: { chunks: [String.raw`{"command":"echo `, String.raw`"hi"`, String.raw`"}`], expect: "repaired", intended: { command: 'echo "hi"' } },
  valid: { chunks: [String.raw`{"command":"echo \"h`, String.raw`i\""}`], expect: "intact", intended: { command: 'echo "hi"' } },
  structural: { chunks: [String.raw`{"command": "ls" `, String.raw`"cwd": "/tmp"}`], expect: "kill", intended: null },
  extrabrace: { chunks: [String.raw`{"command":"ls"`, String.raw`}` , String.raw`}`], expect: "kill", intended: null },
};
for (const spec of Object.values(CASES)) spec.raw = spec.chunks.join("");

// —— 真 HTTPS 服务：按请求体里的 case id 选夹具 ——
const server = createServer({ key: readFileSync(`${HERE}/tls/key.pem`), cert: readFileSync(`${HERE}/tls/cert.pem`) }, (req, res) => {
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", () => {
    let caseId = "?";
    try { caseId = JSON.parse(raw).messages[0].content[0].text; } catch {}
    const c = CASES[caseId];
    if (c === undefined) { res.writeHead(400).end("unknown case"); return; }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(sseFor(c.chunks));
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

const connection = resolveAdapterOptions({ baseURL: `https://127.0.0.1:${port}/v1` }, void 0);
const deps = {
  options: () => connection,
  resolveAuth: async () => ({ headers: { "x-api-key": "e2e" } }),
  resolveUserId: () => "e2e-test",
  resolveFiles: () => ({ beginAttempt() {} }),
  prepareExtensions: async () => ({ fields: {}, accept: async () => {} }),
};
const adapter = new DeepSeekAdapter(deps);

async function run(caseId) {
  const events = [];
  let thrown = null;
  try {
    for await (const e of adapter.stream({
      provider: "deepseek-official",
      model: "deepseek-flash",
      reasoningEffort: "off",
      messages: [{ role: "user", content: [{ type: "text", text: caseId }] }],
    })) events.push(e);
  } catch (error) {
    thrown = error;
  }
  const blockEnd = events.find((e) => e.type === "block-end" && e.block?.type === "tool-call");
  const deltas = events.filter((e) => e.type === "tool-call-delta" && e.argumentsDelta !== "");
  return { events, thrown, blockEnd, deltas, arguments: blockEnd?.block?.arguments };
}

for (const [caseId, spec] of Object.entries(CASES)) {
  const r = await run(caseId);
  if (spec.expect === "repaired" || spec.expect === "intact") {
    ok(`${caseId}: 不判死（原样跑完）`, r.thrown === null, r.thrown ? `${r.thrown.code}: ${r.thrown.message}` : "");
    ok(`${caseId}: 收到 block-end(tool-call)`, r.blockEnd !== void 0);
    ok(`${caseId}: 参数合法且等于模型本意`,
      (() => { try { return JSON.stringify(JSON.parse(r.arguments)) === JSON.stringify(spec.intended); } catch { return false; } })(),
      String(r.arguments));
    ok(`${caseId}: 流式切片确实分片到达（${spec.chunks.length} 片）`, r.deltas.length === spec.chunks.length, String(r.deltas.length));
    if (spec.expect === "intact") ok(`${caseId}: 合法入参逐字节恒等`, r.arguments === VALID, String(r.arguments));
    if (spec.expect === "repaired") ok(`${caseId}: 确实被改写过`, r.arguments !== CANONICAL);
  } else {
    ok(`${caseId}: 判死 MALFORMED_RESPONSE（不猜，交给 retryPolicy 兜底）`,
      r.thrown?.code === "MALFORMED_RESPONSE" && r.thrown?.message === "DeepSeek Messages stream: tool input is invalid JSON",
      r.thrown ? `${r.thrown.code}: ${r.thrown.message}` : `没抛，参数=${r.arguments}`);
    // 判死发生在 message_stop，block-end 早就吐过了；关键是它吐的是**原文**——
    // 没被悄悄替换成猜测结果（这才是「宁可整轮失败也不给工具错参数」的证据）。
    ok(`${caseId}: 已吐出的 block-end 参数仍是原文（未被猜改）`, r.arguments === spec.raw, String(r.arguments));
    ok(`${caseId}: 该参数确实非法（判死有理）`,
      (() => { try { JSON.parse(r.arguments); return false; } catch { return true; } })());
  }
}

server.close();
console.log(fail === 0 ? `\n[${LABEL}] 全部 PASS` : `\n[${LABEL}] ${fail} 项 FAIL`);
process.exit(fail === 0 ? 0 : 1);
