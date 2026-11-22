import { readFileSync, mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const base = 'http://127.0.0.1:45721/api/v1'
const token = readFileSync(join(process.env.APPDATA, 'com.mdm.downloadmanager', 'api-token'), 'utf8').trim()
const headers = { 'X-MDM-Token': token, 'Content-Type': 'application/json' }
const target = 'D:/Project/mdm/.smoke-downloads'
mkdirSync(target, { recursive: true })
const response = await fetch(base + '/tasks', {
  method: 'POST', headers,
  body: JSON.stringify({ url: 'http://127.0.0.1:8899/slowrange.bin', fileName: 'mdm-64segs.bin', directory: target, connections: 64, source: 'smoke-64' })
})
const created = await response.json()
if (!response.ok) throw new Error(JSON.stringify(created))
const id = created.id
let task = created.task
const started = Date.now()
while (Date.now() - started < 120000) {
  await new Promise((resolve) => setTimeout(resolve, 400))
  task = await fetch(base + '/tasks/' + encodeURIComponent(id), { headers }).then((r) => r.json())
  if (['completed', 'error', 'cancelled'].includes(task.status)) break
}
console.log(JSON.stringify({ status: task.status, error: task.error, segments: task.segments?.length, downloaded: task.downloadedBytes, total: task.totalBytes, savePath: task.savePath, size: task.savePath ? statSync(task.savePath).size : null }))
if (task.status !== 'completed' || task.segments?.length !== 64) process.exit(1)
