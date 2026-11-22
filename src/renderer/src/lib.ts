import type { DownloadCategory, PublicTask, TaskStatus } from '@shared/types'
import { CATEGORY_META, CATEGORY_ORDER } from '@shared/constants'

export type ViewKey =
  | 'all'
  | 'active'
  | 'paused'
  | 'completed'
  | 'failed'
  | DownloadCategory

export const STATUS_META: Record<TaskStatus, { label: string; tone: string }> = {
  queued: { label: '排队中', tone: 'muted' },
  connecting: { label: '连接中', tone: 'cyan' },
  downloading: { label: '下载中', tone: 'accent' },
  paused: { label: '已暂停', tone: 'amber' },
  completed: { label: '已完成', tone: 'green' },
  error: { label: '失败', tone: 'red' },
  cancelled: { label: '已取消', tone: 'muted' }
}

export const CATEGORY_ENTRIES = CATEGORY_ORDER.map((key) => ({
  key,
  ...CATEGORY_META[key]
}))

export function isActiveStatus(status: TaskStatus): boolean {
  return status === 'queued' || status === 'connecting' || status === 'downloading'
}

export function taskProgress(task: PublicTask): number {
  if (task.totalBytes > 0) {
    return Math.max(0, Math.min(1, task.downloadedBytes / task.totalBytes))
  }
  if (task.stream && task.stream.fragmentsTotal > 0) {
    return Math.max(0, Math.min(1, task.stream.fragmentsDone / task.stream.fragmentsTotal))
  }
  return 0
}

export function taskPercent(task: PublicTask): number {
  return Math.round(taskProgress(task) * 1000) / 10
}

export function taskSizeLabel(task: PublicTask): string {
  if (task.totalBytes > 0) return formatSize(task.totalBytes)
  return task.downloadedBytes > 0 ? formatSize(task.downloadedBytes) : '未知大小'
}

export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  const digits = value >= 100 || index === 0 ? 0 : value >= 10 ? 1 : 2
  return `${value.toFixed(digits)} ${units[index]}`
}

export function formatSpeed(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B/s'
  return `${formatSize(bytes)}/s`
}

export function formatEta(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) return '—'
  if (seconds < 60) return `${Math.ceil(seconds)} 秒`
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分 ${Math.floor(seconds % 60)} 秒`
  return `${Math.floor(seconds / 3600)} 小时 ${Math.floor((seconds % 3600) / 60)} 分`
}

export function formatClock(timestamp: number | undefined): string {
  if (!timestamp) return '—'
  const date = new Date(timestamp)
  return `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

export function hostLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

export function protocolLabel(protocol: string): string {
  return protocol === 'http' ? 'HTTP' : protocol.toUpperCase()
}

export function taskMatches(task: PublicTask, view: ViewKey, query: string): boolean {
  if (!taskMatchesView(task, view)) return false
  const q = query.trim().toLowerCase()
  if (!q) return true
  return (
    task.fileName.toLowerCase().includes(q) ||
    task.url.toLowerCase().includes(q) ||
    (task.finalUrl ?? '').toLowerCase().includes(q) ||
    task.category.toLowerCase().includes(q)
  )
}

export function taskMatchesView(task: PublicTask, view: ViewKey): boolean {
  if (view === 'all') return true
  if (view === 'active') return isActiveStatus(task.status)
  if (view === 'paused') return task.status === 'paused'
  if (view === 'completed') return task.status === 'completed'
  if (view === 'failed') return task.status === 'error' || task.status === 'cancelled'
  return task.category === view
}

export function viewCount(tasks: PublicTask[], view: ViewKey): number {
  return tasks.filter((task) => taskMatchesView(task, view)).length
}

export function isStream(task: PublicTask): boolean {
  return Boolean(task.stream) || task.protocol === 'hls' || task.protocol === 'dash'
}

export function statusTone(task: PublicTask): string {
  if (task.fileMissing) return 'red'
  return STATUS_META[task.status].tone
}

export function pluralSeconds(value: number): string {
  return value > 1 ? `${value} 秒` : '1 秒'
}
