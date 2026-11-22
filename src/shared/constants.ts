import type { DownloadCategory } from './types'

export const APP_NAME = 'MDM'
export const APP_TAGLINE = 'Multi-thread Download Manager'
export const DEFAULT_PORT = 45721
export const MAX_SEGMENTS = 64
export const MAX_CONCURRENT_DOWNLOADS = 8
export const MIN_CONCURRENT_DOWNLOADS = 1
export const MAX_CONCURRENT_LIMIT = 16
export const PROBE_TIMEOUT_MS = 25_000
export const REQUEST_TIMEOUT_MS = 60_000
export const RETRY_LIMIT = 4
export const SNAPSHOT_INTERVAL_MS = 450
export const STREAM_CONCURRENCY = 8
export const FFMPEG_TIMEOUT_MS = 30 * 60 * 1000

export const CATEGORY_META: Record<
  DownloadCategory,
  { label: string; short: string; color: string; extensions: string[] }
> = {
  video: {
    label: '视频',
    short: 'VID',
    color: '#8b7cff',
    extensions: ['mp4', 'mkv', 'webm', 'mov', 'avi', 'flv', 'ts', 'm4v', 'wmv']
  },
  audio: {
    label: '音乐',
    short: 'AUD',
    color: '#ff7ab8',
    extensions: ['mp3', 'flac', 'wav', 'aac', 'm4a', 'ogg', 'opus', 'wma']
  },
  document: {
    label: '文档',
    short: 'DOC',
    color: '#5ec8d8',
    extensions: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'epub', 'csv']
  },
  archive: {
    label: '压缩包',
    short: 'ZIP',
    color: '#ffb454',
    extensions: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'iso', 'dmg']
  },
  program: {
    label: '程序',
    short: 'APP',
    color: '#7ee787',
    extensions: ['exe', 'msi', 'apk', 'dmg', 'pkg', 'deb', 'rpm', 'appimage']
  },
  image: {
    label: '图片',
    short: 'IMG',
    color: '#f2d27a',
    extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'avif']
  },
  other: {
    label: '其他',
    short: 'BIN',
    color: '#8b9bb4',
    extensions: []
  }
}

export const CATEGORY_ORDER: DownloadCategory[] = [
  'video',
  'audio',
  'document',
  'archive',
  'program',
  'image',
  'other'
]

export const IP_CHANNELS = {
  SNAPSHOT: 'state:snapshot',
  EVENT_SNAPSHOT: 'state:update',
  NAVIGATE: 'app:navigate'
} as const

export const PROTOCOL_LABEL: Record<string, string> = {
  http: 'HTTP',
  ftp: 'FTP',
  hls: 'HLS',
  dash: 'DASH'
}

export const ACTIVE_STATUSES = ['queued', 'connecting', 'downloading', 'paused'] as const
