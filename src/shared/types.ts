export const MAX_SEGMENTS = 64
export const MIN_SEGMENT_BYTES = 256 * 1024

export type DownloadProtocol = 'http' | 'ftp' | 'hls' | 'dash'
export type TaskStatus =
  | 'queued'
  | 'connecting'
  | 'downloading'
  | 'paused'
  | 'completed'
  | 'error'
  | 'cancelled'
export type SegmentStatus = 'pending' | 'active' | 'done' | 'error'
export type DownloadCategory =
  | 'video'
  | 'audio'
  | 'document'
  | 'archive'
  | 'program'
  | 'image'
  | 'other'
export type TaskSource = 'app' | 'extension' | 'context-menu' | 'takeover'
export type ChecksumAlgorithm = 'sha256'

export interface SegmentState {
  index: number
  start: number
  end: number
  downloaded: number
  status: SegmentStatus
}

export interface StreamState {
  kind: 'hls' | 'dash'
  fragmentsTotal: number
  fragmentsDone: number
  /** Present in persisted state, intentionally omitted from renderer snapshots. */
  completedFragments: number[]
  variant?: string
  encryption?: string
  remuxed?: boolean
  outputKind?: 'ts' | 'mp4' | 'm4a'
}

export interface RequestOptions {
  headers?: Record<string, string>
  cookies?: string
  referrer?: string
  userAgent?: string
}

export interface ChecksumSpec {
  algorithm: ChecksumAlgorithm
  value: string
  verified?: boolean
  actual?: string
}

export interface DownloadTask {
  id: string
  url: string
  finalUrl?: string
  protocol: DownloadProtocol
  status: TaskStatus
  fileName: string
  directory: string
  savePath: string
  tempPath: string
  totalBytes: number
  downloadedBytes: number
  speed: number
  etaSeconds: number | null
  connections: number
  activeConnections: number
  rangeSupported: boolean
  resumable: boolean
  mimeType?: string
  etag?: string
  lastModified?: string
  error?: string
  createdAt: number
  updatedAt: number
  startedAt?: number
  completedAt?: number
  segments: SegmentState[]
  stream?: StreamState
  checksum?: ChecksumSpec
  speedLimitBps?: number
  category: DownloadCategory
  source: TaskSource
  request?: RequestOptions
  fragmentDir?: string
  live?: boolean
  fileMissing?: boolean
}

export interface PublicStreamState extends Omit<StreamState, 'completedFragments'> {
  completedFragments: number
}

export interface PublicTask extends Omit<DownloadTask, 'request' | 'stream'> {
  hasCustomHeaders: boolean
  hasCookies: boolean
  stream?: PublicStreamState
}

export interface AddDownloadInput {
  url: string
  fileName?: string
  directory?: string
  connections?: number
  headers?: Record<string, string>
  cookies?: string
  referrer?: string
  userAgent?: string
  checksum?: string
  speedLimitBps?: number
  category?: DownloadCategory
  source?: TaskSource
}

export interface AppSettings {
  downloadDirectory: string
  maxConcurrentDownloads: number
  defaultConnections: number
  globalSpeedLimitBps: number
  port: number
  autoStart: boolean
  notifications: boolean
  remuxStreams: boolean
  theme: 'dark' | 'light' | 'system'
}

export interface ApiStatus {
  running: boolean
  port: number
  token: string
  url: string
  lastExtensionContactAt: number | null
  lastError?: string
  requests: number
}

export interface AppStats {
  activeSpeed: number
  activeCount: number
  queuedCount: number
  completedCount: number
  totalDownloadedBytes: number
  diskFreeBytes: number | null
}

export interface AppSnapshot {
  version: string
  platform: string
  tasks: PublicTask[]
  settings: AppSettings
  api: ApiStatus
  stats: AppStats
}

export interface SettingsPatch {
  downloadDirectory?: string
  maxConcurrentDownloads?: number
  defaultConnections?: number
  globalSpeedLimitBps?: number
  port?: number
  autoStart?: boolean
  notifications?: boolean
  remuxStreams?: boolean
  theme?: 'dark' | 'light' | 'system'
}

export interface IpcInvokeMap {
  'app:snapshot': { args: []; result: AppSnapshot }
  'app:window': { args: [action: 'minimize' | 'maximize' | 'close']; result: void }
  'app:clipboard': { args: [text: string]; result: void }
  'app:open-path': { args: [path: string]; result: string | null }
  'app:show-item': { args: [path: string]; result: void }
  'app:open-external': { args: [url: string]; result: void }
  'downloads:add': { args: [input: AddDownloadInput]; result: { taskId: string } }
  'downloads:pause': { args: [id: string]; result: void }
  'downloads:resume': { args: [id: string]; result: void }
  'downloads:cancel': { args: [id: string]; result: void }
  'downloads:retry': { args: [id: string]; result: void }
  'downloads:remove': { args: [id: string]; result: void }
  'downloads:clear-completed': { args: []; result: void }
  'downloads:open-file': { args: [id: string]; result: void }
  'downloads:open-folder': { args: [id: string]; result: void }
  'downloads:copy-link': { args: [id: string]; result: void }
  'downloads:reveal-in-explorer': { args: [id: string]; result: void }
  'settings:update': { args: [patch: SettingsPatch]; result: AppSettings }
  'settings:choose-directory': { args: [initial?: string]; result: string | null }
  'api:rotate-token': { args: []; result: ApiStatus }
  'shell:open-extension-dir': { args: []; result: void }
  'shell:open-data-dir': { args: []; result: void }
}

export type IpcChannel = keyof IpcInvokeMap

export interface MdmApi {
  snapshot(): Promise<AppSnapshot>
  onSnapshot(listener: (snapshot: AppSnapshot) => void): () => void
  onNavigate(listener: (view: string) => void): () => void
  invoke<K extends IpcChannel>(channel: K, ...args: IpcInvokeMap[K]['args']): Promise<IpcInvokeMap[K]['result']>
}

export interface ApiError {
  error: string
  code?: string
}

export interface ApiTaskList {
  tasks: PublicTask[]
  active: number
}