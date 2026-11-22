import { readFileSync, existsSync, statSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const base = 'http://127.0.0.1:45721/api/v1'
const token = readFileSync(join(process.env.APPDATA || '', 'com.mdm.downloadmanager', 'api-token'), 'utf8').trim()
const target = 'D:/Project/mdm/.smoke-downloads'
mkdirSync(target, { recursive: true })
const headers = { 'X-MDM-Token': token, 'Content-Type': 'application/json' }

async function run(label, url, expectedSize) {
  const created = await fetch(base + '/tasks', {
    method: 'POST', headers,
    body: JSON.stringify({ url, fileName: label + '-' + Date.now(), directory: target, connections: 4, source: 'smoke-stream' })
  })
  const body = await created.json()
  if (!created.ok) throw new Error(label + ' create failed: ' + JSON.stringify(body))
  const id = body.id
  const started = Date.now()
  let task = body.task
  while (Date.now() - started < 60000) {
    await new Promise((resolve) => setTimeout(resolve, 400))
    task = await fetch(base + '/tasks/' + encodeURIComponent(id), { headers }).then((response) => response.json())
    if (['completed', 'error', 'cancelled'].includes(task.status)) break
  }
  console.log(label + ':', JSON.stringify({ status: task.status, error: task.error, protocol: task.protocol, bytes: task.downloadedBytes, total: task.totalBytes, stream: task.stream, savePath: task.savePath }))
  if (task.status !== 'completed') throw new Error(label + ' did not complete')
  if (!existsSync(task.savePath)) throw new Error(label + ' missing output')
  const size = statSync(task.savePath).size
  if (expectedSize && size !== expectedSize) throw new Error(label + ' size ' + size + ' expected ' + expectedSize)
  rmSync(task.savePath)
  console.log(label + ' ok, ' + size + ' bytes')
}

await run('hls', 'http://127.0.0.1:8899/hls/master.m3u8', 3 * 4096)
await run('dash', 'http://127.0.0.1:8899/dash/manifest.mpd', 2048 + 3 * 2048)
