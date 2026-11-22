import { Client } from 'basic-ftp'
import { basename } from 'node:path'
import type { DownloadTask } from '@shared/types'
import { DownloadError, UnsupportedError, errorMessage, friendlyError, isAbortError } from './errors'
import { ensureDir, sizeOf } from './fs-utils'

export interface FtpTarget {
  host: string
  port: number
  user: string
  password: string
  remotePath: string
  secure: boolean | 'implicit'
  fileName: string
}

export function parseFtpTarget(url: string): FtpTarget {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new DownloadError('FTP 地址格式不正确', { retryable: false })
  }
  if (parsed.protocol !== 'ftp:' && parsed.protocol !== 'ftps:') {
    throw new UnsupportedError('仅支持 ftp:// 与 ftps:// 地址')
  }
  const remotePath = decodeURIComponent(parsed.pathname).replace(/^\/+/, '')
  return {
    host: parsed.hostname,
    port: Number(parsed.port || 21),
    user: decodeURIComponent(parsed.username) || 'anonymous',
    password: decodeURIComponent(parsed.password) || 'guest',
    remotePath,
    secure: parsed.protocol === 'ftps:',
    fileName: basename(remotePath) || 'ftp-download'
  }
}

export interface FtpDownloadContext {
  task: DownloadTask
  signal: AbortSignal
  onBytes: (bytes: number) => void
  onConnections: (active: number) => void
}

export async function downloadFtp(context: FtpDownloadContext): Promise<void> {
  const { task, signal, onBytes, onConnections } = context
  const target = parseFtpTarget(task.finalUrl ?? task.url)
  if (!target.remotePath) throw new UnsupportedError('FTP 地址缺少文件名')
  await ensureDir(task.directory)
  const client = new Client(30_000)
  const abort = (): void => client.close()
  signal.addEventListener('abort', abort, { once: true })
  let lastBytes = 0
  onConnections(1)
  try {
    if (signal.aborted) throw new DownloadError('已取消')
    await client.access({
      host: target.host,
      port: target.port,
      user: target.user,
      password: target.password,
      secure: target.secure
    })
    if (signal.aborted) throw new DownloadError('已取消')
    try {
      const remoteSize = await client.size(target.remotePath)
      if (Number.isFinite(remoteSize) && remoteSize > 0) task.totalBytes = remoteSize
    } catch {
      // SIZE is optional on many FTP servers; fall back to progress-only mode.
    }
    let startAt = await sizeOf(task.tempPath)
    if (task.totalBytes > 0 && startAt > task.totalBytes) {
      const { allocateFile } = await import('./fs-utils')
      await allocateFile(task.tempPath, 0)
      startAt = 0
    }
    task.rangeSupported = startAt > 0
    task.resumable = true
    task.segments = [
      {
        index: 0,
        start: 0,
        end: Math.max(0, (task.totalBytes || startAt) - 1),
        downloaded: startAt,
        status: startAt > 0 && task.totalBytes > 0 && startAt >= task.totalBytes ? 'done' : 'active'
      }
    ]
    task.downloadedBytes = startAt
    if (task.totalBytes > 0 && startAt >= task.totalBytes) {
      task.segments[0]!.status = 'done'
      onConnections(0)
      return
    }
    client.trackProgress((info) => {
      if (info.type !== 'download') return
      const delta = Math.max(0, info.bytes - lastBytes)
      lastBytes = info.bytes
      if (delta > 0) {
        task.downloadedBytes = startAt + info.bytes
        const segment = task.segments[0]
        if (segment) segment.downloaded = Math.min(segment.end + 1, task.downloadedBytes)
        onBytes(delta)
      }
    })
    try {
      await client.downloadTo(task.tempPath, target.remotePath, startAt)
    } finally {
      client.trackProgress()
    }
    if (signal.aborted) throw new DownloadError('已取消')
    const finalSize = await sizeOf(task.tempPath)
    if (task.totalBytes > 0 && finalSize !== task.totalBytes) {
      throw new DownloadError(`FTP 文件大小校验失败：期望 ${task.totalBytes} 字节，实际 ${finalSize} 字节`)
    }
    if (task.totalBytes <= 0) task.totalBytes = finalSize
    task.downloadedBytes = finalSize
    task.segments[0]!.downloaded = finalSize
    task.segments[0]!.end = Math.max(0, finalSize - 1)
    task.segments[0]!.status = 'done'
  } catch (error) {
    if (signal.aborted) throw new DownloadError('已取消', { retryable: false, cause: error })
    if (error instanceof DownloadError) throw error
    throw new DownloadError(`FTP 下载失败：${friendlyError(error)}`, {
      retryable: /ECONNRESET|ETIMEDOUT|timeout/i.test(errorMessage(error)),
      cause: error
    })
  } finally {
    signal.removeEventListener('abort', abort)
    client.close()
    onConnections(0)
    void isAbortError
  }
}

export async function probeFtpSize(url: string, signal: AbortSignal): Promise<{ totalBytes: number; fileName: string; lastModified?: string }> {
  const target = parseFtpTarget(url)
  const client = new Client(25_000)
  const abort = (): void => client.close()
  signal.addEventListener('abort', abort, { once: true })
  try {
    await client.access({
      host: target.host,
      port: target.port,
      user: target.user,
      password: target.password,
      secure: target.secure
    })
    if (signal.aborted) throw new DownloadError('已取消')
    let totalBytes = 0
    try {
      totalBytes = await client.size(target.remotePath)
    } catch {
      totalBytes = 0
    }
    let lastModified: string | undefined
    try {
      lastModified = (await client.lastMod(target.remotePath)).toISOString()
    } catch {
      lastModified = undefined
    }
    return { totalBytes, fileName: target.fileName, lastModified }
  } finally {
    signal.removeEventListener('abort', abort)
    client.close()
  }
}
