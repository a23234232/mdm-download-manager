import type { RequestOptions } from '@shared/types'
import { sanitizeFileName } from '@shared/format'

export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36 MDM/0.1'

const BLOCKED_HEADERS = new Set(['host', 'connection', 'content-length', 'range', 'transfer-encoding'])

export function buildRequestHeaders(
  options: RequestOptions | undefined,
  extra: Record<string, string> = {},
  includeRange = true
): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': options?.userAgent?.trim() || DEFAULT_USER_AGENT,
    Accept: '*/*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
  }
  if (options?.referrer) headers.Referer = options.referrer
  if (options?.cookies) headers.Cookie = options.cookies
  for (const [key, value] of Object.entries(options?.headers ?? {})) {
    const lower = key.toLowerCase()
    if (BLOCKED_HEADERS.has(lower) || (!includeRange && lower === 'range')) continue
    if (typeof value !== 'string' || value.length > 16_384) continue
    headers[key] = value
  }
  for (const [key, value] of Object.entries(extra)) {
    const lower = key.toLowerCase()
    const isRange = lower === 'range'
    if (BLOCKED_HEADERS.has(lower) && !(isRange && includeRange)) continue
    if (!includeRange && isRange) continue
    headers[key] = value
  }
  return headers
}

export function parseContentRange(value: string | null): { start: number; end: number; total: number } | null {
  if (!value) return null
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(value.trim())
  if (!match) return null
  const total = match[3] === '*' ? -1 : Number(match[3])
  if (!Number.isSafeInteger(Number(match[1])) || !Number.isSafeInteger(Number(match[2])) || total === 0) return null
  return { start: Number(match[1]), end: Number(match[2]), total }
}

export function parseContentLength(value: string | null): number | null {
  if (!value) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null
}

export function filenameFromContentDisposition(value: string | null): string | undefined {
  if (!value) return undefined
  const encoded = /filename\*=([^;]+)/i.exec(value)?.[1]?.trim()
  if (encoded) {
    const match = /^([^']*)'[^']*'(.+)$/.exec(encoded)
    if (match?.[2]) {
      const name = match[2]
      try {
        return sanitizeFileName(decodeURIComponent(name))
      } catch {
        return sanitizeFileName(name)
      }
    }
  }
  const plain = /filename\s*=\s*(?:"((?:\\.|[^"])*)"|([^;]+))/i.exec(value)
  const raw = plain?.[1] ?? plain?.[2]
  if (!raw) return undefined
  return sanitizeFileName(raw.replace(/\\(.)/g, '$1').trim())
}

export function filenameFromUrl(url: string, fallback = 'download'): string {
  try {
    const parsed = new URL(url)
    const last = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() ?? '')
    return sanitizeFileName(last || parsed.hostname || fallback, fallback)
  } catch {
    return fallback
  }
}

export function withQuery(url: string, values: Record<string, string>): string {
  const parsed = new URL(url)
  for (const [key, value] of Object.entries(values)) parsed.searchParams.set(key, value)
  return parsed.toString()
}

export function safeRemotePath(path: string): string {
  return path
    .split('/')
    .filter((part) => part && part !== '..')
    .map((part) => encodeURIComponent(part))
    .join('/')
}