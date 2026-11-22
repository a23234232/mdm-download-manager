export class DownloadError extends Error {
  readonly retryable: boolean
  readonly status?: number

  constructor(message: string, options: { retryable?: boolean; status?: number; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'DownloadError'
    this.retryable = options.retryable ?? false
    this.status = options.status
  }
}

export class UnsupportedError extends DownloadError {
  constructor(message: string) {
    super(message, { retryable: false })
    this.name = 'UnsupportedError'
  }
}

export function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true
  if (!error || typeof error !== 'object') return false
  const name = (error as { name?: string }).name
  const code = (error as { code?: string }).code
  return name === 'AbortError' || name === 'TimeoutError' || code === 'ABORT_ERR' || code === 'UND_ERR_ABORTED'
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return '未知错误'
  }
}

export function friendlyError(error: unknown): string {
  const message = errorMessage(error)
  if (/ENOSPC/i.test(message)) return '磁盘空间不足'
  if (/EACCES|EPERM/i.test(message)) return '没有写入权限，请检查下载目录'
  if (/ENOTFOUND|EAI_AGAIN/i.test(message)) return '无法解析服务器地址'
  if (/ECONNREFUSED/i.test(message)) return '服务器拒绝连接'
  if (/ECONNRESET|socket hang up/i.test(message)) return '连接被服务器重置'
  if (/ETIMEDOUT|timeout/i.test(message)) return '连接超时'
  if (/certificate|CERT_|self.signed/i.test(message)) return '证书校验失败'
  if (/403/.test(message)) return '服务器拒绝访问（403）'
  if (/404/.test(message)) return '文件不存在（404）'
  return message
}

export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599)
}
