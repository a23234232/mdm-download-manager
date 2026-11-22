import { open } from 'node:fs/promises'
import type { DownloadTask, SegmentState } from '@shared/types'
import { RETRY_LIMIT } from '@shared/constants'
import { DownloadError, errorMessage, friendlyError, isAbortError, isRetryableStatus } from './errors'
import { buildRequestHeaders, parseContentRange } from './request'
import { allocateFile, pathExists, sizeOf } from './fs-utils'
import { rangeForSegment, resetSegments, segmentLength, sumSegments } from './segments'
import { sleep, type RateLimiter } from './rate-limiter'

export interface HttpDownloadContext {
  task: DownloadTask
  signal: AbortSignal
  limiter: RateLimiter
  onBytes: (bytes: number) => void
  onConnections: (active: number) => void
}

const TRANSFER_CHUNK = 256 * 1024

function backoff(attempt: number): number {
  return Math.min(12_000, 500 * 2 ** attempt) + Math.floor(Math.random() * 300)
}

async function fetchSegment(
  task: DownloadTask,
  segment: SegmentState,
  signal: AbortSignal
): Promise<Response> {
  const headers = buildRequestHeaders(task.request, {
    Range: rangeForSegment(segment),
    'Accept-Encoding': 'identity'
  })
  return fetch(task.finalUrl ?? task.url, {
    method: 'GET',
    headers,
    redirect: 'follow',
    signal,
    cache: 'no-store'
  })
}

async function downloadSegment(context: HttpDownloadContext, segment: SegmentState): Promise<void> {
  const { task, signal, limiter, onBytes } = context
  let attempt = 0
  while (segment.downloaded < segmentLength(segment)) {
    if (signal.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError')
    segment.status = 'active'
    let response: Response | null = null
    let handle: Awaited<ReturnType<typeof open>> | null = null
    try {
      response = await fetchSegment(task, segment, signal)
      if (response.status === 416 && segment.downloaded >= segmentLength(segment)) {
        segment.status = 'done'
        return
      }
      if (!response.ok) {
        if (isRetryableStatus(response.status) || response.status === 416) {
          throw new DownloadError(`HTTP ${response.status}`, { retryable: true, status: response.status })
        }
        throw new DownloadError(`服务器返回 HTTP ${response.status}`, { status: response.status })
      }
      if (task.rangeSupported) {
        if (response.status !== 206) {
          throw new DownloadError('服务器未按分片请求返回数据（需要支持 Range）', { retryable: false })
        }
        const range = parseContentRange(response.headers.get('content-range'))
        if (!range || range.start !== segment.start + segment.downloaded) {
          throw new DownloadError('服务器返回了错误的字节范围', { retryable: true })
        }
      }
      if (!response.body) throw new DownloadError('服务器没有返回响应体', { retryable: true })

      handle = await open(task.tempPath, 'r+')
      const reader = response.body.getReader()
      for (;;) {
        if (signal.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError')
        const { done, value } = await reader.read()
        if (done) break
        if (!value || value.byteLength === 0) continue
        await limiter.consume(value.byteLength, signal)
        if (signal.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError')
        await handle.write(value, 0, value.byteLength, segment.start + segment.downloaded)
        segment.downloaded += value.byteLength
        onBytes(value.byteLength)
      }
      segment.status = segment.downloaded >= segmentLength(segment) ? 'done' : 'pending'
      if (segment.status !== 'done') {
        attempt = 0
        await sleep(120, signal)
      }
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? error
      if (error instanceof DownloadError && !error.retryable) {
        segment.status = 'error'
        throw error
      }
      attempt += 1
      if (attempt > RETRY_LIMIT) {
        segment.status = 'error'
        const reason = error instanceof DownloadError ? error.message : friendlyError(error)
        throw new DownloadError(`分片 #${segment.index + 1} 下载失败：${reason}`, { retryable: false, cause: error })
      }
      segment.status = 'pending'
      await sleep(backoff(attempt), signal)
    } finally {
      await handle?.close().catch(() => undefined)
      await response?.body?.cancel().catch(() => undefined)
    }
  }
  segment.status = 'done'
}

export async function downloadHttp(context: HttpDownloadContext): Promise<void> {
  const { task, signal, onConnections } = context
  if (signal.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError')

  const exists = await pathExists(task.tempPath)
  let shouldRestart = !exists
  if (task.rangeSupported && task.totalBytes > 0) {
    const size = await sizeOf(task.tempPath)
    if (size !== task.totalBytes) shouldRestart = true
  }
  if (!task.rangeSupported && task.downloadedBytes > 0) shouldRestart = true
  if (shouldRestart) {
    resetSegments(task.segments)
    task.downloadedBytes = 0
    await allocateFile(task.tempPath, task.rangeSupported ? task.totalBytes : 0)
  }
  if (task.segments.length === 0) {
    throw new DownloadError('没有可用的分片计划', { retryable: false })
  }

  for (const segment of task.segments) {
    if (segment.status !== 'done') segment.status = 'pending'
  }
  task.downloadedBytes = sumSegments(task.segments)
  let active = 0
  onConnections(0)

  let failure: unknown = null
  const workers = task.segments.map(async (segment) => {
    if (signal.aborted || failure) return
    if (segment.downloaded >= segmentLength(segment)) {
      segment.status = 'done'
      return
    }
    active += 1
    onConnections(active)
    try {
      await downloadSegment(context, segment)
    } catch (error) {
      if (!failure) failure = error
      throw error
    } finally {
      active -= 1
      onConnections(active)
    }
  })

  const settled = await Promise.allSettled(workers)
  onConnections(0)
  if (failure) throw failure
  const rejected = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected')
  if (rejected) throw rejected.reason
  const remaining = task.segments.filter((segment) => segment.downloaded < segmentLength(segment))
  if (remaining.length > 0) throw new DownloadError('部分分片未能完成', { retryable: true })
  if (!task.rangeSupported && task.totalBytes <= 0) task.totalBytes = task.downloadedBytes
  const finalSize = await sizeOf(task.tempPath)
  if (task.totalBytes > 0 && finalSize !== task.totalBytes) {
    throw new DownloadError(`文件大小校验失败：期望 ${task.totalBytes} 字节，实际 ${finalSize} 字节`)
  }
}

export function chunkBytesForTest(): number {
  return TRANSFER_CHUNK
}
