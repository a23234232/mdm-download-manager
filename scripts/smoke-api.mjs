import { readFileSync, existsSync, statSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const base = 'http://127.0.0.1:45721/api/v1'
const tokenPath = join(process.env.APPDATA || '', 'com.mdm.downloadmanager', 'api-token')
const token = readFileSync(tokenPath, 'utf8').trim()
const target = 'D:/Project/mdm/.smoke-downloads'
mkdirSync(target, { recursive: true })
const fileName = 'sample-' + Date.now() + '.bin'
const headers = { 'X-MDM-Token': token, 'Content-Type': 'application/json' }

const ping = await fetch(base + '/ping').then((response) => response.json())
console.log('ping:', ping.name, ping.version)
const health = await fetch(base + '/health', { headers }).then((response) => response.json())
console.log('health:', JSON.stringify(health.stats))

const created = await fetch(base + '/tasks', {
  method: 'POST', headers,
  body: JSON.stringify({
    url: 'http://127.0.0.1:8899/sample.bin',
    fileName,
    directory: target,
    connections: 8,
    source: 'smoke-test'
  })
})
const createdBody = await created.json()
if (!created.ok) throw new Error('create failed: ' + JSON.stringify(createdBody))
const id = createdBody.id
console.log('task:', id, createdBody.task.status, createdBody.task.connections)

let task = null
const started = Date.now()
while (Date.now() - started < 90000) {
  await new Promise((resolve) => setTimeout(resolve, 500))
  const data = await fetch(base + '/tasks/' + encodeURIComponent(id), { headers }).then((response) => response.json())
  task = data
  if (task.status === 'completed' || task.status === 'error' || task.status === 'cancelled') break
  if (task.downloadedBytes > 0) console.log('progress:', task.status, task.downloadedBytes + '/' + task.totalBytes, 'speed=' + Math.round(task.speed), 'active=' + task.activeConnections)
}
console.log('final:', JSON.stringify({ status: task.status, error: task.error, bytes: task.downloadedBytes, total: task.totalBytes, speed: task.speed, savePath: task.savePath, segments: task.segments?.length }))
if (task.status !== 'completed') process.exit(1)
if (!existsSync(task.savePath)) throw new Error('missing output file ' + task.savePath)
const size = statSync(task.savePath).size
if (size !== 8 * 1024 * 1024) throw new Error('size mismatch ' + size)
rmSync(task.savePath)
console.log('smoke ok, output removed')
