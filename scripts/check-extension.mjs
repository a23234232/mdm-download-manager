import { readFileSync, existsSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const ext = join(root, 'extension')
const errors = []
const fail = (message) => errors.push(message)

let manifest
try {
  manifest = JSON.parse(readFileSync(join(ext, 'manifest.json'), 'utf8'))
} catch (error) {
  console.error('manifest.json 解析失败：' + error.message)
  process.exit(1)
}

if (manifest.manifest_version !== 3) fail('manifest_version 必须为 3')
if (!manifest.background || !manifest.background.service_worker) fail('缺少 background.service_worker')
for (const page of [manifest.action?.default_popup, manifest.options_ui?.page]) {
  if (!page) { fail('缺少弹窗或设置页'); continue }
  if (!existsSync(join(ext, page))) fail('文件不存在：' + page)
}
for (const page of [manifest.action?.default_popup, manifest.options_ui?.page]) {
  if (!page) continue
  const html = readFileSync(join(ext, page), 'utf8')
  for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    if (match[1].startsWith('http') || match[1].startsWith('#')) continue
    if (!existsSync(join(ext, match[1]))) fail('页面引用不存在：' + match[1])
  }
}
for (const size of ['16', '32', '48', '128']) {
  const file = join(ext, 'icons/icon' + size + '.png')
  if (!existsSync(file)) { fail('缺少图标：' + file); continue }
  if (statSync(file).size < 100) fail('图标文件过小：' + file)
}
for (const file of ['background.js', 'popup.js', 'options.js']) {
  try { execFileSync(process.execPath, ['--check', join(ext, file)], { stdio: 'pipe' }) }
  catch (error) { fail(file + ' 语法错误：' + String(error.stderr || error.message)) }
}
const background = readFileSync(join(ext, 'background.js'), 'utf8')
for (const endpoint of ['/api/v1', '/tasks', '/health']) {
  if (!background.includes(endpoint)) fail('background.js 缺少接口路径：' + endpoint)
}
if (!manifest.permissions.includes('downloads')) fail('缺少 downloads 权限')

if (errors.length) {
  console.error('扩展检查失败（' + errors.length + ' 项）：')
  for (const error of errors) console.error(' - ' + error)
  process.exit(1)
}
console.log('扩展检查通过：MV3、' + manifest.permissions.length + ' 个权限、3 个页面脚本、4 个图标')
console.log('接口入口：http://127.0.0.1:45721/api/v1')
