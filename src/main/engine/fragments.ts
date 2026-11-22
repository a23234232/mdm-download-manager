import { createDecipheriv } from 'node:crypto'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { DownloadTask } from '@shared/types'
import { MAX_SEGMENTS, REQUEST_TIMEOUT_MS, RETRY_LIMIT, STREAM_CONCURRENCY } from '@shared/constants'
import { DownloadError, errorMessage, friendlyError, isAbortError, isRetryableStatus } from './errors'
import { buildRequestHeaders } from './request'
import { pathExists, sizeOf } from './fs-utils'
import { sleep, type RateLimiter } from './rate-limiter'

export interface FragmentJob {
  index: number
  url: string
  range?: string
  /** Decryption key bytes (AES-128). */
  key?: Buffer
  iv?: Buffer
}

export interface FragmentContext {
  task: DownloadTask
  signal: AbortSignal
  limiter: RateLimiter
  onBytes: (bytes: number) => void
  onConnections: (active: number) => void
}

function withTimeout(signal: AbortSignal, ms = REQUEST_TIMEOUT_MS): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new DownloadError('请求超时', { retryable: true })), ms)
  const forward = () => controller.abort(signal.reason)
  if (signal.aborted) forward()
  else signal.addEventListener('abort', forward, { once: true })
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', forward)
    }
  }
}

function headersFor(task: DownloadTask, extra: Record<string, string> = {}): Record<string, string> {
  return buildRequestHeaders(task.request, { 'Accept-Encoding': 'identity', ...extra })
}

async function fetchRaw(
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal,
  range?: string
): Promise<{ data: Buffer; url: string }> {
  const timeout = withTimeout(signal)
  try {
    const merged = range ? { ...headers, Range: range } : headers
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      headers: merged,
      signal: timeout.signal,
      cache: 'no-store'
    })
    if (!response.ok && response.status !== 206) {
      await response.body?.cancel().catch(() => undefined)
      throw new DownloadError(
        `流媒体分片返回 HTTP ${response.status}`,
        { retryable: isRetryableStatus(response.status), status: response.status }
      )
    }
    if (range && response.status !== 206) {
      await response.body?.cancel().catch(() => undefined)
      throw new DownloadError('分片服务器不支持 Range 请求', { retryable: false })
    }
    return { data: Buffer.from(await response.arrayBuffer()), url: response.url || url }
  } finally {
    timeout.cleanup()
  }
}

export async function fetchText(url: string, task: DownloadTask, signal: AbortSignal): Promise<string> {
  return (await fetchRaw(url, headersFor(task), signal)).data.toString('utf8')
}

export async function fetchBytes(
  url: string,
  task: DownloadTask,
  signal: AbortSignal,
  range?: string
): Promise<Buffer> {
  return (await fetchRaw(url, headersFor(task), signal, range)).data
}

export async function fetchTextDocument(
  url: string,
  task: DownloadTask,
  signal: AbortSignal
): Promise<{ text: string; url: string }> {
  const result = await fetchRaw(url, headersFor(task), signal)
  return { text: result.data.toString('utf8'), url: result.url }
}

export function decryptAes128(data: Buffer, key: Buffer, iv: Buffer): Buffer {
  const decipher = createDecipheriv('aes-128-cbc', key, iv)
  return Buffer.concat([decipher.update(data), decipher.final()])
}

async function completeFragments(task: DownloadTask): Promise<Set<number>> {
  return new Set(task.stream?.completedFragments ?? [])
}

export async function downloadFragments(
  context: FragmentContext,
  jobs: FragmentJob[],
  directory: string
): Promise<void> {
  const { task, signal, limiter, onBytes, onConnections } = context
  await mkdir(directory, { recursive: true })
  const completed = await completeFragments(task)
  if (!task.stream) {
    task.stream = {
      kind: task.protocol === 'dash' ? 'dash' : 'hls',
      fragmentsTotal: jobs.length,
      fragmentsDone: completed.size,
      completedFragments: [...completed]
    }
  }
  task.stream.fragmentsTotal = jobs.length
  task.stream.fragmentsDone = completed.size

  const controller = new AbortController()
  const combined = AbortSignal.any([signal, controller.signal])
  let nextIndex = 0
  let active = 0
  let failure: unknown = null
  let doneCount = completed.size

  const runOne = async (job: FragmentJob): Promise<void> => {
    const file = join(directory, `${String(job.index).padStart(5, '0')}.frag`)
    if (completed.has(job.index) && (await pathExists(file))) return
    const part = `${file}.part`
    await rm(part, { force: true })
    let attempt = 0
    for (;;) {
      if (combined.aborted) throw combined.reason ?? new DOMException('Aborted', 'AbortError')
      try {
        let data = await fetchBytes(job.url, task, combined, job.range)
        await limiter.consume(data.byteLength, combined)
        if (job.key) {
          if (!job.iv) throw new DownloadError('AES-128 分片缺少 IV', { retryable: false })
          data = decryptAes128(data, job.key, job.iv)
        }
        await writeFile(part, data)
        await rename(part, file)
        completed.add(job.index)
        task.stream!.completedFragments = [...completed].sort((a, b) => a - b)
        task.stream!.fragmentsDone = completed.size
        task.downloadedBytes += data.byteLength
        doneCount += 1
        onBytes(data.byteLength)
        return
      } catch (error) {
        if (combined.aborted || signal.aborted) throw combined.reason ?? signal.reason ?? error
        attempt += 1
        if (attempt > RETRY_LIMIT || (error instanceof DownloadError && !error.retryable)) {
          throw new DownloadError(
            `分片 ${job.index + 1} 下载失败：${friendlyError(error)}`,
            { retryable: false, cause: error }
          )
        }
        await sleep(Math.min(8000, 400 * 2 ** attempt), combined)
      }
    }
  }

  const runner = async (): Promise<void> => {
    for (;;) {
      if (combined.aborted) return
      const job = jobs[nextIndex]
      nextIndex += 1
      if (!job) return
      active += 1
      onConnections(active)
      try {
        await runOne(job)
      } catch (error) {
        failure ??= error
        controller.abort(error)
        return
      } finally {
        active -= 1
        onConnections(active)
      }
    }
  }

  const concurrency = Math.max(1, Math.min(jobs.length, task.connections || STREAM_CONCURRENCY, MAX_SEGMENTS))
  await Promise.all(Array.from({ length: concurrency }, () => runner()))
  onConnections(0)
  if (signal.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError')
  if (failure) throw failure
  const missing = jobs.filter((job) => !completed.has(job.index))
  if (missing.length > 0) {
    throw new DownloadError(`还有 ${missing.length} 个分片未完成：${errorMessage(failure ?? '未知原因')}`)
  }
  task.stream.fragmentsDone = jobs.length
}

export async function fragmentFile(directory: string, index: number): Promise<string> {
  return join(directory, `${String(index).padStart(5, '0')}.frag`)
}

export async function fragmentFileSize(directory: string, index: number): Promise<number> {
  return sizeOf(join(directory, `${String(index).padStart(5, '0')}.frag`))
}