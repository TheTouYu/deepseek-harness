/**
 * memo-river.mjs —— 记忆河流预设的本地插件 wrapper（DESIGN.md §5.1）。
 *
 * 存在的理由：composition 的 `name:` 只能写「相对本文件的路径」或「可解析的包名」，
 * 而本插件是仓库里的构建产物、不在 preset 目录内、也不是 node_modules 里可解析的包。
 * 这一层把组装面与构建产物的绝对路径解耦：
 *   · 组装文件永远只写 `./memo-river.mjs?v=N`（N 由 dev_reload_preset 自增）；
 *   · 换构建目录 / 换部署位置只改这一个文件；
 *   · `file://` 绝对 URL 让 Node 的 ESM 解析不依赖 preset 目录的 node_modules。
 *
 * ⚠ 为什么是 top-level await 的 `import()` 而不是静态 `export … from`：
 *   静态 re-export 的模块 URL 永远不变（`…/lib/index.js`），而 **Node 的 ESM 缓存按 URL 键**。
 *   实测：改了 lib/ 之后用 `?v=2` 重新 import wrapper，拿到的仍是旧代码（V 还是 1）——
 *   也就是说 `dev_reload_preset` 只换了 wrapper，插件代码根本没换，热更新是空转的。
 *   这里用「lib 文件 mtime」做查询串：任何一次重建都会自然产生新 URL，
 *   下一次挂载即拿到新代码，无需手动同步两个版本号。
 *   （构建产物 lib/index.js 是自包含的，不存在跨文件缓存问题。）
 *
 * 除这段缓存击穿外**不含任何逻辑**——逻辑全在 lib/ 里，便于单测与非预设环境下复用
 * （scripts/acceptance.mjs 就是直接 import lib/index.js 跑十条验收判据的）。
 */
import { statSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const LIB = '/home/h/app/dsh-memo-river/lib/index.js'

let gen
try {
  gen = statSync(LIB).mtimeMs
} catch (e) {
  throw new Error(
    `memo-river: 构建产物不存在 ${LIB} —— 先在 /home/h/app/dsh-memo-river 跑 \`bash scripts/build.sh\`（${e?.message ?? e}）`,
  )
}

const impl = await import(`${pathToFileURL(LIB).href}?v=${gen}`)

export const name = impl.name
export const inject = impl.inject
export const Config = impl.Config
export const apply = impl.apply
