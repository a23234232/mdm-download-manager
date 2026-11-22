import type { DownloadProtocol, RequestOptions } from '@shared/types'
import { PROBE_TIMEOUT_MS } from '@shared/constants'
import { DownloadError, isAbortError, isRetryableStatus } from './errors'
import { buildRequestHeaders, filenameFromContentDisposition, parseContentLength, parseContentRange } from './request'
import { filenameFromUrl } from './request'
import { probeFtpSize } from './ftp'

export interface ProbeResult {
  finalUrl: string
  protocol: DownloadProtocol
  kind: 'file' | 'hls' | 'dash'
  fileName: string
  totalBytes: number
  rangeSupported: boolean
  mimeType?: string
  etag?: string
  lastModified?: string
  status: number
}

export function protocolForUrl(url: string): DownloadProtocol {
  const scheme = new URL(url).protocol.toLowerCase()
  return scheme === 'ftp:' || scheme === 'ftps:' ? 'ftp' : 'http'
}

export function looksLikeStream(url: string, mimeType?: string): 'hls' | 'dash' | 'file' {
  const path = (() => {
    try {
      return new URL(url).pathname.toLowerCase()
    } catch {
      return ''
    }
  })()
  const mime = (mimeType ?? '').toLowerCase()
  if (mime.includes('mpegurl') || path.endsWith('.m3u8') || path.endsWith('.m3u')) return 'hls'
  if (mime.includes('dash+xml') || path.endsWith('.mpd')) return 'dash'
  return 'file'
}

async function fetchProbe(url: string, headers: Record<string, string>, signal: AbortSignal): Promise<Response> {
  return fetch(url, {
    method: 'GET',
    redirect: 'follow',
    headers,
    signal,
    cache: 'no-store'
  })
}

export async function probeHttp(
  url: string,
  request: RequestOptions | undefined,
  parentSignal?: AbortSignal
): Promise<ProbeResult> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(new DownloadError('连接超时', { retryable: true })), PROBE_TIMEOUT_MS)
  const abortParent = () => controller.abort(parentSignal?.reason)
  parentSignal?.addEventListener('abort', abortParent, { once: true })
  const headers = buildRequestHeaders(request, { Range: 'bytes=0-0' })
  try {
    let response: Response
    try {
      response = await fetchProbe(url, headers, controller.signal)
    } catch (error) {
      if (isAbortError(error, parentSignal)) throw new DownloadError('已取消', { retryable: false })
      if (isAbortError(error, controller.signal)) throw new DownloadError('连接超时', { retryable: true })
      throw new DownloadError(`无法连接服务器：${(error as Error).message}`, { retryable: true, cause: error })
    }

    let rangeSupported = false
    let totalBytes = parseContentLength(response.headers.get('content-length')) ?? 0
    const contentRange = parseContentRange(response.headers.get('content-range'))
    if (response.status === 206 && contentRange) {
      rangeSupported = true
      totalBytes = contentRange.total >= 0 ? contentRange.total : totalBytes
    }

    if (!response.ok && response.status !== 206) {
      await response.body?.cancel().catch(() => undefined)
      if (response.status === 416) {
        return {
          finalUrl: response.url || url,
          protocol: 'http',
          kind: 'file',
          fileName: filenameFromUrl(url),
          totalBytes: 0,
          rangeSupported: true,
          mimeType: response.headers.get('content-type')?.split(';')[0] ?? undefined,
          etag: response.headers.get('etag') ?? undefined,
          lastModified: response.headers.get('last-modified') ?? undefined,
          status: response.status
        }
      }
      const retryable = isRetryableStatus(response.status)
      throw new DownloadError(`服务器返回 HTTP ${response.status}`, { retryable, status: response.status })
    }

    const mimeType = response.headers.get('content-type')?.split(';')[0]?.trim() || undefined
    const disposition = response.headers.get('content-disposition')
    const fileName =
      filenameFromContentDisposition(disposition) ||
      filenameFromUrl(response.url || url) ||
      'download'
    const kind = looksLikeStream(response.url || url, mimeType)
    await response.body?.cancel().catch(() => undefined)
    return {
      finalUrl: response.url || url,
      protocol: kind === 'file' ? 'http' : kind,
      kind,
      fileName,
      totalBytes,
      rangeSupported,
      mimeType,
      etag: response.headers.get('etag') ?? undefined,
      lastModified: response.headers.get('last-modified') ?? undefined,
      status: response.status
    }
  } finally {
    clearTimeout(timeout)
    parentSignal?.removeEventListener('abort', abortParent)
  }
}

export async function probeFtp(
  url: string,
  request: RequestOptions | undefined,
  signal: AbortSignal
): Promise<ProbeResult> {
  const controller = new AbortController()
  const timeout = setTimeout(
    () => controller.abort(new DownloadError('连接超时', { retryable: true })),
    PROBE_TIMEOUT_MS
  )
  const abortParent = (): void => controller.abort(signal.reason)
  signal.addEventListener('abort', abortParent, { once: true })
  try {
    const result = await probeFtpSize(url, controller.signal)
    void request
    return {
      finalUrl: url,
      protocol: 'ftp',
      kind: 'file',
      fileName: result.fileName || 'download',
      totalBytes: result.totalBytes,
      rangeSupported: true,
      lastModified: result.lastModified,
      status: 200
    }
  } catch (error) {
    if (signal.aborted) throw new DownloadError('已取消', { retryable: false })
    if (controller.signal.aborted) throw new DownloadError('FTP 连接超时', { retryable: true })
    throw new DownloadError(`FTP 探测失败：${(error as Error).message}`, { retryable: true, cause: error })
  } finally {
    clearTimeout(timeout)
    signal.removeEventListener('abort', abortParent)
  }
}