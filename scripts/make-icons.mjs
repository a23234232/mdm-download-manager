#!/usr/bin/env node
// Generates MDM app + Chrome extension PNG icons with zero dependencies.
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { deflateSync } from 'node:zlib'

const CRC_TABLE = new Uint32Array(256)
for (let n = 0; n < 256; n += 1) {
  let c = n
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  CRC_TABLE[n] = c >>> 0
}

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const name = Buffer.from(type, 'ascii')
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])), 0)
  return Buffer.concat([length, name, data, crc])
}

function encodePng(width, height, rgba) {
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

function mix(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t)
  ]
}

function insideRoundRect(x, y, cx, cy, halfW, halfH, radius) {
  const dx = Math.abs(x - cx) - (halfW - radius)
  const dy = Math.abs(y - cy) - (halfH - radius)
  const ox = Math.max(dx, 0)
  const oy = Math.max(dy, 0)
  return ox * ox + oy * oy <= radius * radius && Math.abs(x - cx) <= halfW && Math.abs(y - cy) <= halfH
}

function insideTriangle(px, py, ax, ay, bx, by, cx, cy) {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by)
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy)
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay)
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0
  return !(hasNeg && hasPos)
}

function render(size) {
  const ss = 4
  const w = size * ss
  const out = Buffer.alloc(size * size * 4)
  const samples = new Float64Array(size * size * 4)
  const bgTop = [26, 31, 56]
  const bgBottom = [9, 11, 20]
  const border = [139, 124, 255]
  const cyanTop = [126, 231, 255]
  const cyanBottom = [52, 197, 255]
  const bar = [143, 128, 255]

  for (let y = 0; y < w; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const nx = (x + 0.5) / w
      const ny = (y + 0.5) / h(w)
      let color = null
      if (insideRoundRect(nx, ny, 0.5, 0.5, 0.478, 0.478, 0.215)) color = border
      if (insideRoundRect(nx, ny, 0.5, 0.5, 0.452, 0.452, 0.195)) {
        color = mix(bgTop, bgBottom, ny)
      }
      const shaftTop = 0.255
      const shaftBottom = 0.57
      if (nx >= 0.445 && nx <= 0.555 && ny >= shaftTop && ny <= shaftBottom) {
        color = mix(cyanTop, cyanBottom, (ny - shaftTop) / (shaftBottom - shaftTop))
      }
      if (insideTriangle(nx, ny, 0.28, 0.515, 0.72, 0.515, 0.5, 0.745)) {
        color = mix(cyanTop, cyanBottom, 0.7)
      }
      if (ny >= 0.805 && ny <= 0.865 && nx >= 0.26 && nx <= 0.74) color = bar
      if (color) {
        const cell = (Math.floor(y / ss) * size + Math.floor(x / ss)) * 4
        samples[cell] += color[0]
        samples[cell + 1] += color[1]
        samples[cell + 2] += color[2]
        samples[cell + 3] += 255
      }
    }
  }

  const count = ss * ss
  for (let i = 0; i < size * size; i += 1) {
    const alpha = samples[i * 4 + 3] / count
    if (alpha <= 0) continue
    const coverage = samples[i * 4 + 3] / 255
    out[i * 4] = Math.round(samples[i * 4] / coverage)
    out[i * 4 + 1] = Math.round(samples[i * 4 + 1] / coverage)
    out[i * 4 + 2] = Math.round(samples[i * 4 + 2] / coverage)
    out[i * 4 + 3] = Math.round(alpha)
  }
  return encodePng(size, size, out)
}

function h(w) {
  return w
}

const root = process.cwd()
const iconDir = resolve(root, 'extension/icons')
mkdirSync(iconDir, { recursive: true })
for (const size of [16, 32, 48, 128]) {
  const file = resolve(iconDir, 'icon' + size + '.png')
  writeFileSync(file, render(size))
  console.log('wrote', file)
}
mkdirSync(resolve(root, 'build'), { recursive: true })
writeFileSync(resolve(root, 'build/icon.png'), render(512))
console.log('wrote', resolve(root, 'build/icon.png'))
