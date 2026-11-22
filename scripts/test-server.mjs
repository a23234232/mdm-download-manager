import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync, statSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '.smoke')
mkdirSync(root, { recursive: true })
const file = join(root, 'sample.bin')
const SIZE = 8 * 1024 * 1024
if (!statSync(file, { throwIfNoEntry: false }) || statSync(file).size !== SIZE) {
  const buffer = Buffer.alloc(SIZE)
  for (let index = 0; index < SIZE; index += 1) buffer[index] = (index * 31 + 7) & 0xff
  writeFileSync(file, buffer)
}
const data = readFileSync(file)
const digest = createHash('sha256').update(data).digest('hex')
const SLOW_SIZE = 16 * 1024 * 1024
const slowData = Buffer.alloc(SLOW_SIZE, 5)
mkdirSync(join(dirname(fileURLToPath(import.meta.url)), '..', '.smoke'), { recursive: true })

const server = createServer((request, response) => {
  const url = new URL(request.url || '/', 'http://127.0.0.1')
  if (url.pathname === '/sample.bin') {
    const range = request.headers.range
    if (range) {
      const match = /^bytes=(\d+)-(\d*)$/.exec(range)
      if (!match) { response.writeHead(416, { 'Content-Range': 'bytes */' + SIZE }); response.end(); return }
      const start = Number(match[1])
      const end = match[2] ? Math.min(Number(match[2]), SIZE - 1) : SIZE - 1
      response.writeHead(206, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(end - start + 1),
        'Content-Range': 'bytes ' + start + '-' + end + '/' + SIZE,
        'Accept-Ranges': 'bytes',
        'Content-Disposition': 'attachment; filename="sample.bin"',
        'ETag': '"smoke-v1"',
        'Cache-Control': 'no-store'
      })
      response.end(data.subarray(start, end + 1))
      return
    }
    response.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(SIZE),
      'Accept-Ranges': 'bytes',
      'Content-Disposition': 'attachment; filename="sample.bin"',
      'ETag': '"smoke-v1"'
    })
    response.end(data)
    return
  }
  if (url.pathname === '/slowrange.bin') {
    const match = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range || '')
    if (!match) { response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(SLOW_SIZE), 'Accept-Ranges': 'bytes' }); response.end(slowData); return }
    const start = Number(match[1])
    const end = match[2] ? Math.min(Number(match[2]), SLOW_SIZE - 1) : SLOW_SIZE - 1
    response.writeHead(206, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(end - start + 1),
      'Content-Range': 'bytes ' + start + '-' + end + '/' + SLOW_SIZE,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store'
    })
    let position = start
    let closed = false
    request.on('close', () => { closed = true })
    const pump = () => {
      if (closed || position > end) { if (!closed) response.end(); return }
      const size = Math.min(64 * 1024, end - position + 1)
      response.write(slowData.subarray(position, position + size))
      position += size
      setTimeout(pump, 40)
    }
    pump()
    return
  }
  if (url.pathname === '/hls/master.m3u8') {
    response.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store' })
    response.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1200000\nmedia.m3u8\n')
    return
  }
  if (url.pathname === '/hls/media.m3u8') {
    response.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store' })
    response.end('#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:1\n#EXTINF:4,\nseg0.ts\n#EXTINF:4,\nseg1.ts\n#EXTINF:4,\nseg2.ts\n#EXT-X-ENDLIST\n')
    return
  }
  if (/^\/hls\/seg[0-9]\.ts$/.test(url.pathname)) {
    response.writeHead(200, { 'Content-Type': 'video/mp2t', 'Content-Length': '4096', 'Cache-Control': 'no-store' })
    response.end(Buffer.alloc(4096, 9))
    return
  }
  if (url.pathname === '/dash/manifest.mpd') {
    response.writeHead(200, { 'Content-Type': 'application/dash+xml', 'Cache-Control': 'no-store' })
    response.end('<?xml version="1.0"?><MPD xmlns="urn:mpeg:dash:schema:mpd:2011" mediaPresentationDuration="PT12S"><Period><AdaptationSet contentType="video" mimeType="video/mp4"><Representation id="v1" bandwidth="800000"><SegmentTemplate timescale="1" duration="4" startNumber="1" media="seg-$Number$.m4s" initialization="init.mp4"/></Representation></AdaptationSet></Period></MPD>')
    return
  }
  if (url.pathname === '/dash/init.mp4' || /^\/dash\/seg-[0-9]\.m4s$/.test(url.pathname)) {
    response.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': '2048', 'Cache-Control': 'no-store' })
    response.end(Buffer.alloc(2048, 7))
    return
  }
  if (url.pathname === '/slow.bin') {
    response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': '4096' })
    response.end(Buffer.alloc(4096, 1))
    return
  }
  response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
  response.end('not found')
})
server.listen(8899, '127.0.0.1', () => console.log('fixture server http://127.0.0.1:8899/sample.bin sha256=' + digest))
