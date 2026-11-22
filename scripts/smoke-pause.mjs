import { readFileSync, existsSync, statSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const base = 'http://127.0.0.1:45721/api/v1'
const token = readFileSync(join(process.env.APPDATA || '', 'com.mdm.downloadmanager', 'api-token'), 'utf8').trim()
const target = 'D:/Project/mdm/.smoke-downloads'
mkdirSync(target, { recursive: true })
const headers = { 'X-MDM-Token': token, 'Content-Type': 'application/json' }
const fileName = 'pause-' + Date.now() + '.bin'

const created = await fetch(base + '/tasks', {
  method: 'POST', headers,
  body: JSON.stringify({ url: 'http://127.0.0.1:8899/slowrange.bin', fileName, directory: target, connections: 4, source: 'smoke-pause' })
})
const body = await created.json()
if (!created.ok) throw new Error(JSON.stringify(body))
const id = body.id
const taskUrl = base + '/tasks/' + encodeURIComponent(id)
const read = () => fetch(taskUrl, { headers }).then((response) => response.json())

let task = body.task
const started = Date.now()
while (Date.now() - started < 15000) {
  await new Promise((resolve) => setTimeout(resolve, 300))
  task = await read()
  if (task.downloadedBytes > 1024 * 1024) break
}
console.log('before pause:', JSON.stringify({ status: task.status, downloaded: task.downloadedBytes, total: task.totalBytes, segments: task.segments?.map((s) => s.downloaded) }))
await fetch(taskUrl + '/pause', { method: 'POST', headers })
let paused = null
for (let index = 0; index < 40; index += 1) {
  await new Promise((resolve) => setTimeout(resolve, 250))
  paused = await read()
  if (paused.status === 'paused') break
}
console.log('paused:', JSON.stringify({ status: paused.status, downloaded: paused.downloadedBytes, total: paused.totalBytes, segments: paused.segments?.map((s) => s.downloaded) }))
if (paused.status !== 'paused') throw new Error('task did not pause')
if (paused.downloadedBytes <= 0 || paused.downloadedBytes >= paused.totalBytes) throw new Error('unexpected progress at pause: ' + paused.downloadedBytes)

await fetch(taskUrl + '/resume', { method: 'POST', headers })
const resumed = Date.now()
let final = paused
while (Date.now() - resumed < 90000) {
  await new Promise((resolve) => setTimeout(resolve, 500))
  final = await read()
  if (['completed', 'error', 'cancelled'].includes(final.status)) break
}
console.log('final:', JSON.stringify({ status: final.status, error: final.error, downloaded: final.downloadedBytes, total: final.totalBytes, segments: final.segments?.map((s) => s.downloaded) }))
if (final.status !== 'completed') throw new Error('resume did not complete')
if (!existsSync(final.savePath)) throw new Error('missing final file')
const size = statSync(final.savePath).size
if (size !== 16 * 1024 * 1024) throw new Error('size mismatch ' + size)
rmSync(final.savePath)
await fetch(taskUrl, { method: 'DELETE', headers })
console.log('pause/resume smoke ok')
