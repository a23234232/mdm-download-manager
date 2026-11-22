import type { DownloadCategory } from './types'
import { CATEGORY_META } from './constants'

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function formatBytes(bytes: number, precision = 1): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return bytes === 0 ? '0 B' : '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / 1024 ** index
  return `${value.toFixed(index === 0 ? 0 : precision).replace(/\.0$/, '')} ${units[index]}`
}

export function formatSpeed(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '0 B/s'
  return `${formatBytes(bytesPerSecond)}/s`
}

export function formatEta(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return '—'
  if (seconds < 1) return '即将完成'
  if (seconds < 60) return `${Math.ceil(seconds)} 秒`
  const minutes = Math.floor(seconds / 60)
  const rest = Math.floor(seconds % 60)
  if (minutes < 60) return `${minutes} 分 ${rest.toString().padStart(2, '0')} 秒`
  const hours = Math.floor(minutes / 60)
  return `${hours} 小时 ${(minutes % 60).toString().padStart(2, '0')} 分`
}

export function formatDate(timestamp?: number): string {
  if (!timestamp) return '—'
  const date = new Date(timestamp)
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date)
}

export function timeAgo(timestamp?: number): string {
  if (!timestamp) return '—'
  const diff = Math.max(0, Date.now() - timestamp)
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  return `${Math.floor(diff / 86_400_000)} 天前`
}

export function percent(done: number, total: number): number {
  if (!total || total <= 0) return 0
  return clamp((done / total) * 100, 0, 100)
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url.slice(0, 60)
  }
}

export function extensionOf(fileName: string): string {
  const match = /\.([a-z0-9]{1,8})$/i.exec(fileName)
  return (match?.[1] ?? '').toLowerCase()
}

export function categoryFor(fileName: string, mimeType?: string): DownloadCategory {
  const ext = extensionOf(fileName)
  for (const [category, meta] of Object.entries(CATEGORY_META) as [DownloadCategory, (typeof CATEGORY_META)[DownloadCategory]][]) {
    if (meta.extensions.includes(ext)) return category
  }
  if (mimeType?.startsWith('video/')) return 'video'
  if (mimeType?.startsWith('audio/')) return 'audio'
  if (mimeType?.startsWith('image/')) return 'image'
  if (mimeType?.includes('zip') || mimeType?.includes('compressed')) return 'archive'
  if (mimeType?.includes('pdf') || mimeType?.includes('document')) return 'document'
  if (mimeType?.includes('octet-stream') && ['exe', 'msi', 'apk'].includes(ext)) return 'program'
  return 'other'
}

export function sanitizeFileName(name: string, fallback = 'download'): string {
  let value = name
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/^\.+/, '')
    .replace(/[. ]+$/g, '')
    .trim()
  if (!value) value = fallback
  if (value.length > 180) {
    const dot = value.lastIndexOf('.')
    if (dot > 0) value = value.slice(0, 170) + value.slice(dot)
    else value = value.slice(0, 180)
  }
  return value
}

export function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

export function dirname(path: string): string {
  const normalized = path.replace(/[\\/]+$/, '')
  const index = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'))
  return index > 0 ? normalized.slice(0, index) : normalized
}

export function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}
