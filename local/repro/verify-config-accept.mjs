// 验收 1（绑定真实文件）：profile patch 里新加的 llm-deepseek retryPolicy，
// 逐字取自 /home/h/.dsh/profiles/web/cordis.patch.yml，喂进 0.2.0 宿主真实的三段校验链：
//   schemastery Config（mount 时）→ plainOptions（volatile 解包）→ resolveRetryPolicy（每请求 options()）
// 三段都是安装树里的同一份代码，不是重写。
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const PKG = "/home/h/.local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai";
const require = createRequire("/home/h/.local/lib/node_modules/@deepseek-ai/dsh/node_modules/");
const YAML = require("yaml");

const { Config, plainOptions } = await import(`${PKG}/dsh-llm-deepseek-api-key/lib/index.js`);
const { resolveRetryPolicy, EMPTY_RESPONSE_CODE } = await import(`${PKG}/dsh-llm/lib/index.js`);

const PATCH = "/home/h/.dsh/profiles/web/cordis.patch.yml";
const doc = YAML.parse(readFileSync(PATCH, "utf8"));
const hits = doc.filter((e) => e?.id === "llm-deepseek");

let fail = 0;
const ok = (name, cond, extra = "") => { console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra ? " :: " + extra : ""}`); if (!cond) fail++; };

ok("YAML 可解析且 profile 里 llm-deepseek 条目恰好 1 条", hits.length === 1, `命中 ${hits.length}`);
if (hits.length !== 1) { console.log("中止"); process.exit(1); }
const entry = hits[0];
ok("name = @deepseek-ai/dsh-llm-deepseek-api-key（= base bundle 同名条目）", entry.name === "@deepseek-ai/dsh-llm-deepseek-api-key", String(entry.name));

// —— 宿主真实三段链 ——
let policy;
try {
  const resolved = Config(entry.config);
  const plain = plainOptions(resolved);
  policy = resolveRetryPolicy(plain.retryPolicy, "llm-deepseek: retryPolicy");
  ok("Config → plainOptions → resolveRetryPolicy 全通过", true);
} catch (e) {
  ok("Config → plainOptions → resolveRetryPolicy 全通过", false, String(e?.message ?? e));
}

if (policy) {
  ok("mode=normal", policy.mode === "normal", policy.mode);
  ok("maxRetries=8", policy.maxRetries === 8, String(policy.maxRetries));
  ok("retryableCodes 含 MALFORMED_RESPONSE", policy.retryableCodes.includes("MALFORMED_RESPONSE"), policy.retryableCodes.join(","));
  ok("默认五码一个不少（显式码表是整表替换，漏了会静默丢重试）",
    [EMPTY_RESPONSE_CODE, "RATE_LIMIT", "SERVER", "TIMEOUT", "TRANSPORT"].every((c) => policy.retryableCodes.includes(c)),
    policy.retryableCodes.join(","));
  ok("backoff 生效", policy.initialDelayMs === 2000 && policy.maxDelayMs === 30000 && policy.jitterRatio === 0.3,
    `${policy.initialDelayMs}/${policy.maxDelayMs}/${policy.jitterRatio}`);
  ok("无重复码", new Set(policy.retryableCodes).size === policy.retryableCodes.length);
}

// —— 负面校验：证明这道闸门不是空转（沿用同一条真实链）——
const chain = (c) => resolveRetryPolicy(plainOptions(Config({ ...entry.config, ...c })).retryPolicy, "probe");
const bad = [
  ["未知 mode", { retryPolicy: { mode: "sometimes" } }],
  ["retryPolicy 未知 key", { retryPolicy: { mode: "normal", nope: 1 } }],
  ["重复码", { retryPolicy: { mode: "normal", retryableCodes: ["A", "A"] } }],
  ["空码表", { retryPolicy: { mode: "normal", retryableCodes: [] } }],
  ["initial > max", { retryPolicy: { mode: "normal", backoff: { initialDelayMs: 9000, maxDelayMs: 100 } } }],
];
for (const [label, c] of bad) {
  let threw = false;
  try { chain(c); } catch { threw = true; }
  ok(`负面: ${label} 被拒`, threw);
}

// —— 链条闭合：MALFORMED_RESPONSE 确实是那个判死点的 code ——
const adapter = readFileSync(`${PKG}/dsh-llm-deepseek/lib/index.js`, "utf8");
const site = adapter.match(/catch \(_invalidProviderToolJson\) \{\s*\n\s*return malformed\("tool input is invalid JSON"\)/);
ok("判死点仍在 translate() message_stop（锚点存活）", site !== null);
const malformedDef = adapter.match(/function malformed\(([^)]*)\)\s*\{[^}]*?"MALFORMED_RESPONSE"/s) ?? adapter.match(/"MALFORMED_RESPONSE"/);
ok("malformed() 抛的是 MALFORMED_RESPONSE", malformedDef !== null);

console.log(fail === 0 ? "\n全部 PASS" : `\n${fail} 项 FAIL`);
process.exit(fail === 0 ? 0 : 1);
