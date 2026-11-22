import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AddDownloadInput, ApiStatus, ApiTaskList, PublicTask } from '@shared/types'
import type { DownloadManager } from '../download-manager'
import { DownloadError, errorMessage } from '../engine/errors'

interface ApiServerOptions {
  manager: DownloadManager
  dataDir: string
  port: number
  version: string
  onChange?: (status: ApiStatus) => void
}

interface JsonObject {
  [key: string]: unknown
}

const BODY_LIMIT = 1024 * 1024

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-MDM-Token, X-MDM-Client'
  })
  res.end(text)
}

function fail(res: ServerResponse, status: number, message: string, code?: string): void {
  json(res, status, { error: message, code })
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

async function readBody(request: IncomingMessage): Promise<JsonObject> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    size += buffer.length
    if (size > BODY_LIMIT) throw new DownloadError('请求体过大', { retryable: false })
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
    return typeof parsed === 'object' && parsed !== null ? (parsed as JsonObject) : {}
  } catch {
    throw new DownloadError('请求 JSON 格式错误', { retryable: false })
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function asRecord(value: unknown): Record<string, string> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const result: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') result[key] = entry
  }
  return Object.keys(result).length > 0 ? result : undefined
}

function publicTask(manager: DownloadManager, id: string): PublicTask | undefined {
  return manager.listTasks().find((task) => task.id === id)
}

export class ApiServer {
  private readonly manager: DownloadManager
  private readonly dataDir: string
  private readonly version: string
  private readonly onChange?: (status: ApiStatus) => void
  private server: ReturnType<typeof createServer> | null = null
  private portValue: number
  private tokenValue = ''
  private running = false
  private lastContact: number | null = null
  private lastError: string | undefined
  private requests = 0

  constructor(options: ApiServerOptions) {
    this.manager = options.manager
    this.dataDir = options.dataDir
    this.portValue = options.port
    this.version = options.version
    this.onChange = options.onChange
  }

  get status(): ApiStatus {
    return {
      running: this.running,
      port: this.portValue,
      token: this.tokenValue,
      url: `http://127.0.0.1:${this.portValue}/api/v1`,
      lastExtensionContactAt: this.lastContact,
      lastError: this.lastError,
      requests: this.requests
    }
  }

  async start(port = this.portValue): Promise<ApiStatus> {
    if (this.server) await this.stop()
    this.portValue = port
    this.tokenValue = await this.loadToken()
    this.server = createServer((request, response) => {
      void this.handle(request, response)
    })
    this.lastError = undefined
    await new Promise<void>((resolve, reject) => {
      const server = this.server
      if (!server) return reject(new Error('server missing'))
      const onError = (error: NodeJS.ErrnoException): void => {
        server.off('listening', onListening)
        this.running = false
        this.lastError =
          error.code === 'EADDRINUSE' ? `端口 ${port} 已被占用` : `API 启动失败：${errorMessage(error)}`
        this.emitChange()
        reject(error)
      }
      const onListening = (): void => {
        server.off('error', onError)
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(port, '127.0.0.1')
    })
    this.running = true
    this.emitChange()
    return this.status
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = null
    this.running = false
    if (!server) {
      this.emitChange()
      return
    }
    await new Promise<void>((resolve) => server.close(() => resolve()))
    this.emitChange()
  }

  async setPort(port: number): Promise<void> {
    if (port === this.portValue && this.running) return
    await this.start(port)
  }

  async rotateToken(): Promise<ApiStatus> {
    this.tokenValue = randomBytes(24).toString('hex')
    await writeFile(this.tokenPath(), `${this.tokenValue}\n`, { encoding: 'utf8', mode: 0o600 })
    this.emitChange()
    return this.status
  }

  private tokenPath(): string {
    return join(this.dataDir, 'api-token')
  }

  private async loadToken(): Promise<string> {
    try {
      const existing = (await readFile(this.tokenPath(), 'utf8')).trim()
      if (/^[a-f0-9]{32,96}$/i.test(existing)) return existing
    } catch {
      // create below
    }
    const token = randomBytes(24).toString('hex')
    await writeFile(this.tokenPath(), `${token}\n`, { encoding: 'utf8', mode: 0o600 })
    return token
  }

  private emitChange(): void {
    this.onChange?.(this.status)
  }

  private authorized(request: IncomingMessage): boolean {
    if (!this.tokenValue) return false
    const header = request.headers.authorization
    if (header?.startsWith('Bearer ')) return safeEqual(header.slice(7).trim(), this.tokenValue)
    const custom = request.headers['x-mdm-token']
    if (typeof custom === 'string') return safeEqual(custom.trim(), this.tokenValue)
    return false
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const method = request.method ?? 'GET'
    if (method === 'OPTIONS') {
      response.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-MDM-Token, X-MDM-Client',
        'Access-Control-Max-Age': '86400'
      })
      response.end()
      return
    }
    let url: URL
    try {
      url = new URL(request.url ?? '/', 'http://127.0.0.1')
    } catch {
      fail(response, 400, '无效请求')
      return
    }
    const path = url.pathname
    this.requests += 1
    if (path === '/api/v1/ping' || path === '/api/v1') {
      json(response, 200, {
        name: 'MDM',
        version: this.version,
        api: 'v1',
        requiresToken: true,
        port: this.portValue
      })
      return
    }
    if (!this.authorized(request)) {
      fail(response, 401, '扩展令牌无效，请在 MDM 设置中重新复制令牌', 'unauthorized')
      return
    }
    this.lastContact = Date.now()
    if (path === '/api/v1/health') {
      json(response, 200, { ok: true, version: this.version, stats: this.manager.getStats() })
      return
    }
    if (path === '/api/v1/tasks' && method === 'GET') {
      const body: ApiTaskList = {
        tasks: this.manager.listTasks(),
        active: this.manager.getStats().activeCount
      }
      json(response, 200, body)
      return
    }
    if (path === '/api/v1/tasks' && method === 'POST') {
      let payload: JsonObject
      try {
        payload = await readBody(request)
      } catch (error) {
        fail(response, 400, errorMessage(error))
        return
      }
      const target = asString(payload.url)
      if (!target) {
        fail(response, 400, '缺少 url 字段', 'invalid_url')
        return
      }
      const input: AddDownloadInput = {
        url: target,
        fileName: asString(payload.fileName),
        directory: asString(payload.directory),
        connections: typeof payload.connections === 'number' ? payload.connections : undefined,
        headers: asRecord(payload.headers),
        cookies: asString(payload.cookies),
        referrer: asString(payload.referrer) ?? asString(payload.referer),
        userAgent: asString(payload.userAgent),
        checksum: asString(payload.checksum),
        speedLimitBps: typeof payload.speedLimitBps === 'number' ? payload.speedLimitBps : undefined,
        source: 'extension'
      }
      try {
        const id = await this.manager.add(input)
        json(response, 201, { id, task: publicTask(this.manager, id) })
      } catch (error) {
        fail(response, 400, errorMessage(error), 'add_failed')
      }
      return
    }
    if (path === '/api/v1/tasks/clear-completed' && method === 'POST') {
      await this.manager.clearCompleted()
      json(response, 200, { ok: true })
      return
    }
    if (path === '/api/v1/stats' && method === 'GET') {
      const stats = this.manager.getStats(await this.manager.diskFree())
      json(response, 200, stats)
      return
    }
    const match = /^\/api\/v1\/tasks\/([a-zA-Z0-9-]+)(?:\/(pause|resume|cancel|retry))?$/.exec(path)
    if (match) {
      const id = match[1]!
      const task = this.manager.listTasks().find((item) => item.id === id)
      if (!task) {
        fail(response, 404, '任务不存在', 'not_found')
        return
      }
      const action = match[2]
      try {
        if (method === 'GET' && !action) {
          json(response, 200, task)
          return
        }
        if (method === 'DELETE' && !action) {
          await this.manager.remove(id)
          json(response, 200, { ok: true })
          return
        }
        if (method === 'POST' && action) {
          if (action === 'pause') await this.manager.pause(id)
          if (action === 'resume') await this.manager.resume(id)
          if (action === 'cancel') await this.manager.cancel(id)
          if (action === 'retry') await this.manager.retry(id)
          json(response, 200, publicTask(this.manager, id) ?? { ok: true })
          return
        }
      } catch (error) {
        fail(response, 500, errorMessage(error), 'action_failed')
        return
      }
    }
    fail(response, 404, '接口不存在', 'not_found')
  }
}
