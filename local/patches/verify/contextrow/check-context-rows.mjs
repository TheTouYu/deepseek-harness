// 浏览器端可见性核验：打开沙箱 GUI 里的指定会话，数「上下文注入」行。
// 用法： SBX_URL=http://127.0.0.1:3105/?token=… NEEDLE=升级验证 SESSION_NEEDLE=… node check-context-rows.mjs
const CD = process.env.CHROMEDRIVER ?? 'http://127.0.0.1:9515'
const URL_ = process.env.SBX_URL
const WORKSPACE = process.env.WORKSPACE ?? 'dsh-plugins'
const NEEDLE = process.env.NEEDLE ?? '升级验证'
const ONLY_READ = true

async function wd(path, method = 'GET', body) {
  const r = await fetch(`${CD}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === void 0 ? void 0 : JSON.stringify(body) })
  const t = await r.text(); let j; try { j = JSON.parse(t) } catch { j = { raw: t.slice(0, 300) } }
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${JSON.stringify(j).slice(0, 400)}`)
  return j.value
}
const { sessionId } = await wd('/session', 'POST', { capabilities: { alwaysMatch: { 'goog:chromeOptions': { binary: '/usr/sbin/chromium', args: ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--window-size=1600,1200'] } } } })
const exec = (script, args = []) => wd(`/session/${sessionId}/execute/sync`, 'POST', { script, args })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
console.log('WebDriver:', sessionId)

try {
  await wd(`/session/${sessionId}/url`, 'POST', { url: URL_ })
  await sleep(7000)
  // 侧栏默认已列出当前工作区的会话；先直接按标题找，找不到再展开工作区重试。
  const listRows = `return [...document.querySelectorAll('[class*=sessionRow]')].map(e=>(e.innerText||'').trim().slice(0,60));`
  let rows = await exec(listRows)
  if (!Array.isArray(rows) || !rows.some((t) => String(t).includes(NEEDLE))) {
    const opened = await exec(`const rows=[...document.querySelectorAll('[class*=projectText],[class*=workspace]')];
      const hit=rows.find(e=>(e.innerText||'').trim()===arguments[0]);
      if(!hit) return 'NOT-FOUND';
      (hit.closest('button,[role=button],[class*=project]')??hit).click(); return 'clicked';`, [WORKSPACE])
    console.log('① 展开工作区:', opened)
    await sleep(3000)
    rows = await exec(listRows)
  }
  console.log('② 侧栏会话行:', JSON.stringify(rows))

  const clicked = await exec(`const rows=[...document.querySelectorAll('[class*=sessionRow]')];
    const hit=rows.find(e=>(e.innerText||'').includes(arguments[0]));
    if(!hit) return 'NOT-FOUND'; hit.click(); return 'clicked: '+(hit.innerText||'').trim().slice(0,50);`, [NEEDLE])
  console.log('③ 打开会话:', clicked)
  if (String(clicked) === 'NOT-FOUND') { console.log('侧栏里没有该会话'); process.exit(2) }
  await sleep(9000)

  const r = await exec(`const text=document.body.innerText||'';
    const n=(re)=>((text.match(re)||[]).length);
    const rows=[...document.querySelectorAll('[class*=ontext],[class*=njection]')].map(e=>({cls:(e.className||'').toString().slice(0,60),t:(e.innerText||'').trim().slice(0,80)})).slice(0,8);
    return {url:location.href, inject:n(/上下文注入/g), recall:n(/跨会话召回/g), toolsUpdated:n(/工具已更新/g),
      memoSnippet:(text.match(/.{0,40}上下文注入.{0,60}/g)||[]).slice(0,4), rows, len:text.length};`)
  console.log('④ 会话视图 url:', r.url, '| 正文长度', r.len)
  console.log('   「上下文注入」行数 =', r.inject, '| 「跨会话召回」=', r.recall, '| 「工具已更新」=', r.toolsUpdated)
  console.log('   片段:', JSON.stringify(r.memoSnippet, null, 0))
  console.log('   候选行元素:', JSON.stringify(r.rows, null, 0).slice(0, 600))
  console.log('\n判定:', r.inject >= 3 ? '✅ 注入行可见' : '❌ 注入行不可见')
} catch (e) { console.log('驱动异常:', e.message); process.exitCode = 1 } finally {
  await wd(`/session/${sessionId}`, 'DELETE').catch(() => {})
}
