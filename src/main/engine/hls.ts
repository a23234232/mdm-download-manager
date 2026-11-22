import { UnsupportedError } from './errors'

export interface HlsVariant {
  url: string
  bandwidth: number
  resolution?: string
  codecs?: string
  name?: string
}

export interface HlsKey {
  method: 'AES-128' | 'SAMPLE-AES' | 'NONE'
  uri?: string
  iv?: string
}

export interface HlsFragment {
  index: number
  kind: 'init' | 'media'
  url: string
  byteRange?: { offset: number; length: number }
  duration?: number
  sequence?: number
  key?: HlsKey
}

export interface HlsMediaPlaylist {
  fragments: HlsFragment[]
  endList: boolean
  targetDuration: number
  mediaSequence: number
  isFragmentedMp4: boolean
}

function attributes(value: string): Record<string, string> {
  const result: Record<string, string> = {}
  const regex = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g
  for (const match of value.matchAll(regex)) {
    const key = match[1]
    if (!key) continue
    result[key] = (match[2] ?? '').replace(/^"|"$/g, '')
  }
  return result
}

function resolve(base: string, relative: string): string {
  try {
    return new URL(relative, base).toString()
  } catch {
    return relative
  }
}

function keyFromAttributes(attrs: Record<string, string>, baseUrl: string): HlsKey {
  const method = (attrs.METHOD ?? 'NONE').toUpperCase()
  if (method === 'NONE') return { method: 'NONE' }
  if (method !== 'AES-128' && method !== 'SAMPLE-AES') {
    throw new UnsupportedError(`HLS 加密方式 ${method} 暂不支持`)
  }
  return {
    method,
    uri: attrs.URI ? resolve(baseUrl, attrs.URI) : undefined,
    iv: attrs.IV
  }
}

export function parseMasterPlaylist(text: string, baseUrl: string): HlsVariant[] {
  const lines = text.split(/\r?\n/)
  const variants: HlsVariant[] = []
  let pending: Record<string, string> | null = null
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      pending = attributes(line.slice('#EXT-X-STREAM-INF:'.length))
      continue
    }
    if (line.startsWith('#')) continue
    if (pending) {
      variants.push({
        url: resolve(baseUrl, line),
        bandwidth: Number(pending.BANDWIDTH ?? 0) || 0,
        resolution: pending.RESOLUTION,
        codecs: pending.CODECS,
        name: pending.NAME
      })
      pending = null
    }
  }
  return variants.sort((a, b) => b.bandwidth - a.bandwidth)
}

export function parseMediaPlaylist(text: string, baseUrl: string): HlsMediaPlaylist {
  if (!text.trimStart().startsWith('#EXTM3U')) throw new UnsupportedError('不是有效的 HLS 播放列表')
  const lines = text.split(/\r?\n/)
  const fragments: HlsFragment[] = []
  const target = Number(
    lines.find((line) => line.startsWith('#EXT-X-TARGETDURATION:'))?.split(':')[1]?.trim() ?? 0
  )
  const mediaSequence = Number(
    lines.find((line) => line.startsWith('#EXT-X-MEDIA-SEQUENCE:'))?.split(':')[1]?.trim() ?? 0
  ) || 0
  let sequence = mediaSequence
  let duration: number | undefined
  let key: HlsKey | undefined
  let mapUrl: string | undefined
  let lastMapUrl: string | undefined
  let byteRange: { offset: number; length: number } | undefined
  let previousRangeEnd = 0
  let endList = false

  const flushInit = (): void => {
    if (!mapUrl || mapUrl === lastMapUrl) return
    fragments.push({ index: fragments.length, kind: 'init', url: resolve(baseUrl, mapUrl) })
    lastMapUrl = mapUrl
  }

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]?.trim() ?? ''
    if (!line) continue
    if (line.startsWith('#EXT-X-MAP:')) {
      const attrs = attributes(line.slice('#EXT-X-MAP:'.length))
      if (attrs.URI) {
        mapUrl = attrs.URI
        flushInit()
      }
      continue
    }
    if (line.startsWith('#EXT-X-KEY:')) {
      key = keyFromAttributes(attributes(line.slice('#EXT-X-KEY:'.length)), baseUrl)
      continue
    }
    if (line.startsWith('#EXT-X-BYTERANGE:')) {
      const raw = line.slice('#EXT-X-BYTERANGE:'.length).split('@')
      const length = Number(raw[0])
      const offset = raw[1] ? Number(raw[1]) : previousRangeEnd
      if (Number.isFinite(length) && Number.isFinite(offset)) byteRange = { offset, length }
      continue
    }
    if (line.startsWith('#EXTINF:')) {
      duration = Number.parseFloat(line.slice('#EXTINF:'.length).split(',')[0] ?? '0')
      continue
    }
    if (line === '#EXT-X-ENDLIST') {
      endList = true
      continue
    }
    if (line.startsWith('#')) continue
    const fragmentKey = key && key.method !== 'NONE' ? key : undefined
    if (fragmentKey?.method === 'SAMPLE-AES') throw new UnsupportedError('HLS SAMPLE-AES 加密暂不支持')
    if (byteRange) previousRangeEnd = byteRange.offset + byteRange.length
    fragments.push({
      index: fragments.length,
      kind: 'media',
      url: resolve(baseUrl, line),
      byteRange,
      duration,
      sequence: sequence++,
      key: fragmentKey
    })
    duration = undefined
    byteRange = undefined
  }

  return {
    fragments,
    endList,
    targetDuration: target,
    mediaSequence,
    isFragmentedMp4: Boolean(lastMapUrl)
  }
}

export function isMasterPlaylist(text: string): boolean {
  return text.includes('#EXT-X-STREAM-INF:')
}

export function absoluteIv(iv: string | undefined, sequence: number | undefined): string | undefined {
  if (iv) return iv.replace(/^0x/i, '').padStart(32, '0').slice(0, 32)
  if (sequence === undefined) return undefined
  return sequence.toString(16).padStart(32, '0')
}