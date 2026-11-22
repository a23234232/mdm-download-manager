import type { DownloadTask } from '@shared/types'
import type { RateLimiter } from './rate-limiter'

export interface StreamDownloadContext {
  task: DownloadTask
  signal: AbortSignal
  limiter: RateLimiter
  onBytes: (bytes: number) => void
  onConnections: (active: number) => void
  ffmpegPath: string | null
  remuxStreams: boolean
}
