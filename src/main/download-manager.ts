import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { basename, join, resolve } from 'node:path'
import { rename, statfs } from 'node:fs/promises'
import type {
  AddDownloadInput,
  AppSettings,
  AppStats,
  ChecksumSpec,
  DownloadTask,
  PublicTask,
  SettingsPatch
} from '@shared/types'
import {
  MAX_CONCURRENT_DOWNLOADS,
  MAX_CONCURRENT_LIMIT,
  MAX_SEGMENTS,
  SNAPSHOT_INTERVAL_MS
} from '@shared/constants'
import { clamp, categoryFor, extensionOf, sanitizeFileName } from '@shared/format'
import { atomicWriteJson, ensureDir, pathExists, readJson, removePath, sizeOf, splitName, uniquePath } from './engine/fs-utils'
import { RateLimiter } from './engine/rate-limiter'
import { DownloadError, errorMessage, friendlyError } from './engine/errors'
import { filenameFromUrl } from './engine/request'
import { probeHttp, probeFtp } from './engine/probe'
import { planSegments, resetSegments, segmentLength } from './engine/segments'
import { downloadHttp } from './engine/http'
import { downloadHls } from './engine/hls-download'
import { downloadDash } from './engine/dash-download'
import { downloadFtp } from './engine/ftp'
import { findFfmpeg } from './engine/ffmpeg'
import { sha256File } from './engine/checksum'
import { fetchTextDocument } from './engine/fragments'
import type { StreamDownloadContext } from './engine/stream'

const RUNNING: DownloadTask['status'][] = ['connecting', 'downloading']

interface RunHandle {
  controller: AbortController
  promise: Promise<void>
}

interface ManagerEvents {
  change: []
  completed: [DownloadTask]
  failed: [DownloadTask]
}

function defaultSettings(downloadDirectory: string): AppSettings {
  return {
    downloadDirectory,
    maxConcurrentDownloads: MAX_CONCURRENT_DOWNLOADS,
    defaultConnections: 16,
    globalSpeedLimitBps: 0,
    port: 45721,
    autoStart: false,
    notifications: true,
    remuxStreams: true,
    theme: 'dark'
  }
}

function normalizeSettings(raw: Partial<AppSettings>, base: AppSettings): AppSettings {
  return {
    downloadDirectory:
      typeof raw.downloadDirectory === 'string' && raw.downloadDirectory.trim()
        ? resolve(raw.downloadDirectory)
        : base.downloadDirectory,
    maxConcurrentDownloads: clamp(
      Math.round(raw.maxConcurrentDownloads ?? base.maxConcurrentDownloads),
      1,
      MAX_CONCURRENT_LIMIT
    ),
    defaultConnections: clamp(Math.round(raw.defaultConnections ?? base.defaultConnections), 1, MAX_SEGMENTS),
    globalSpeedLimitBps: Math.max(0, Math.round(raw.globalSpeedLimitBps ?? base.globalSpeedLimitBps)),
    port: clamp(Math.round(raw.port ?? base.port), 1024, 65535),
    autoStart: raw.autoStart ?? base.autoStart,
    notifications: raw.notifications ?? base.notifications,
    remuxStreams: raw.remuxStreams ?? base.remuxStreams,
    theme: raw.theme === 'light' || raw.theme === 'system' ? raw.theme : 'dark'
  }
}

function checksumFromInput(value: string | undefined): ChecksumSpec | undefined {
  if (!value) return undefined
  const trimmed = value.trim()
  const match = /^(?:sha256:)?([a-f0-9]{64})$/i.exec(trimmed)
  return match?.[1] ? { algorithm: 'sha256', value: match[1].toLowerCase(), verified: false } : undefined
}

function streamExtension(protocol: DownloadTask['protocol'], ffmpeg: string | null, remux: boolean): string {
  if (protocol === 'hls') return ffmpeg && remux ? '.mp4' : '.ts'
  return '.mp4'
}

export class DownloadManager extends EventEmitter<ManagerEvents> {
  readonly dataDir: string
  readonly tasksPath: string
  readonly settingsPath: string
  private readonly tasks = new Map<string, DownloadTask>()
  private readonly runs = new Map<string, RunHandle>()
  private readonly autoNamed = new Set<string>()
  private readonly lastSample = new Map<string, number>()
  private settingsValue: AppSettings
  private readonly globalLimiter = new RateLimiter(0)
  private persistTimer: NodeJS.Timeout | null = null
  private ticker: NodeJS.Timeout | null = null
  private disposed = false

  constructor(options: { dataDir: string; downloadDirectory: string }) {
    super()
    this.dataDir = options.dataDir
    this.tasksPath = join(options.dataDir, 'tasks.json')
    this.settingsPath = join(options.dataDir, 'settings.json')
    this.settingsValue = defaultSettings(resolve(options.downloadDirectory))
  }

  async init(): Promise<void> {
    await ensureDir(this.dataDir)
    const savedSettings = await readJson<Partial<AppSettings>>(this.settingsPath, {})
    this.settingsValue = normalizeSettings(savedSettings, this.settingsValue)
    await ensureDir(this.settingsValue.downloadDirectory)
    this.globalLimiter.setRate(this.settingsValue.globalSpeedLimitBps)
    const saved = await readJson<DownloadTask[]>(this.tasksPath, [])
    for (const task of saved) {
      if (!task?.id || !task.url || !task.savePath) continue
      const previousStatus = task.status
      task.status =
        previousStatus === 'completed' || previousStatus === 'cancelled' || previousStatus === 'error'
          ? previousStatus
          : 'paused'
      task.speed = 0
      task.activeConnections = 0
      task.etaSeconds = null
      if (task.status === 'completed' && !(await pathExists(task.savePath))) task.fileMissing = true
      this.tasks.set(task.id, task)
    }
    this.ticker = setInterval(() => this.tick(), SNAPSHOT_INTERVAL_MS)
    this.ticker.unref?.()
    this.emitChange()
  }

  get settings(): AppSettings {
    return { ...this.settingsValue }
  }

  getTask(id: string): DownloadTask | undefined {
    return this.tasks.get(id)
  }

  listTasks(): PublicTask[] {
    return [...this.tasks.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((task) => this.toPublic(task))
  }

  async add(input: AddDownloadInput): Promise<string> {
    const url = input.url?.trim()
    if (!url) throw new DownloadError('下载地址不能为空', { retryable: false })
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      throw new DownloadError('下载地址格式不正确', { retryable: false })
    }
    if (!['http:', 'https:', 'ftp:', 'ftps:'].includes(parsed.protocol)) {
      throw new DownloadError('仅支持 HTTP、HTTPS、FTP、FTPS 地址', { retryable: false })
    }
    const directory = resolve(input.directory?.trim() || this.settingsValue.downloadDirectory)
    await ensureDir(directory)
    const now = Date.now()
    const ftp = parsed.protocol === 'ftp:' || parsed.protocol === 'ftps:'
    const lowerPath = parsed.pathname.toLowerCase()
    const streamGuess = lowerPath.endsWith('.m3u8') || lowerPath.endsWith('.m3u')
      ? 'hls'
      : lowerPath.endsWith('.mpd')
        ? 'dash'
        : null
    const id = randomUUID()
    const providedName = input.fileName?.trim()
    const fileName = sanitizeFileName(providedName || filenameFromUrl(url), 'download')
    const task: DownloadTask = {
      id,
      url,
      protocol: ftp ? 'ftp' : (streamGuess ?? 'http'),
      status: 'queued',
      fileName,
      directory,
      savePath: '',
      tempPath: '',
      totalBytes: 0,
      downloadedBytes: 0,
      speed: 0,
      etaSeconds: null,
      connections: clamp(Math.round(input.connections ?? this.settingsValue.defaultConnections), 1, MAX_SEGMENTS),
      activeConnections: 0,
      rangeSupported: false,
      resumable: false,
      createdAt: now,
      updatedAt: now,
      segments: [],
      category: input.category ?? categoryFor(fileName),
      source: input.source ?? 'app',
      speedLimitBps: input.speedLimitBps && input.speedLimitBps > 0 ? Math.round(input.speedLimitBps) : undefined,
      request: {
        headers: input.headers,
        cookies: input.cookies,
        referrer: input.referrer,
        userAgent: input.userAgent
      },
      checksum: checksumFromInput(input.checksum)
    }
    if (!providedName) this.autoNamed.add(id)
    this.tasks.set(id, task)
    this.emitChange()
    await this.persistNow()
    this.schedule()
    return id
  }

  async pause(id: string): Promise<void> {
    const task = this.tasks.get(id)
    if (!task) return
    if (task.status === 'completed' || task.status === 'cancelled') return
    task.status = 'paused'
    task.updatedAt = Date.now()
    task.speed = 0
    task.etaSeconds = null
    const run = this.runs.get(id)
    run?.controller.abort(new DownloadError('已暂停', { retryable: false }))
    this.emitChange()
    await this.persistNow()
  }

  async resume(id: string): Promise<void> {
    const task = this.tasks.get(id)
    if (!task) return
    if (task.status !== 'paused' && task.status !== 'queued') return
    task.error = undefined
    task.status = 'queued'
    task.updatedAt = Date.now()
    this.emitChange()
    await this.persistNow()
    this.schedule()
  }

  async retry(id: string): Promise<void> {
    const task = this.tasks.get(id)
    if (!task) return
    if (!['error', 'cancelled'].includes(task.status)) return
    const run = this.runs.get(id)
    if (run) {
      run.controller.abort(new DownloadError('正在重试', { retryable: false }))
      await run.promise.catch(() => undefined)
    }
    if (task.tempPath) await removePath(task.tempPath)
    if (task.fragmentDir) await removePath(task.fragmentDir)
    resetSegments(task.segments)
    task.segments = []
    task.stream = undefined
    task.savePath = ''
    task.tempPath = ''
    task.downloadedBytes = 0
    task.totalBytes = 0
    task.activeConnections = 0
    task.speed = 0
    task.etaSeconds = null
    task.error = undefined
    if (task.checksum) task.checksum.verified = false
    task.status = 'queued'
    task.updatedAt = Date.now()
    this.emitChange()
    await this.persistNow()
    this.schedule()
  }

  async cancel(id: string): Promise<void> {
    const task = this.tasks.get(id)
    if (!task) return
    task.status = 'cancelled'
    task.speed = 0
    task.etaSeconds = null
    task.updatedAt = Date.now()
    const run = this.runs.get(id)
    if (run) {
      run.controller.abort(new DownloadError('已取消', { retryable: false }))
      await run.promise.catch(() => undefined)
    }
    if (task.tempPath) await removePath(task.tempPath)
    if (task.fragmentDir) await removePath(task.fragmentDir)
    task.downloadedBytes = 0
    task.activeConnections = 0
    resetSegments(task.segments)
    this.emitChange()
    await this.persistNow()
  }

  async remove(id: string): Promise<void> {
    const task = this.tasks.get(id)
    if (!task) return
    const run = this.runs.get(id)
    if (run) {
      run.controller.abort(new DownloadError('任务已移除', { retryable: false }))
      await run.promise.catch(() => undefined)
    }
    if (task.tempPath) await removePath(task.tempPath)
    if (task.fragmentDir) await removePath(task.fragmentDir)
    this.tasks.delete(id)
    this.autoNamed.delete(id)
    this.lastSample.delete(id)
    this.emitChange()
    await this.persistNow()
    this.schedule()
  }

  async clearCompleted(): Promise<void> {
    for (const task of [...this.tasks.values()]) {
      if (task.status === 'completed') this.tasks.delete(task.id)
    }
    this.emitChange()
    await this.persistNow()
  }

  async updateSettings(patch: SettingsPatch): Promise<AppSettings> {
    this.settingsValue = normalizeSettings({ ...this.settingsValue, ...patch }, this.settingsValue)
    await ensureDir(this.settingsValue.downloadDirectory)
    this.globalLimiter.setRate(this.settingsValue.globalSpeedLimitBps)
    await atomicWriteJson(this.settingsPath, this.settingsValue)
    this.emitChange()
    this.schedule()
    return this.settings
  }

  getStats(diskFreeBytes: number | null = null): AppStats {
    let activeSpeed = 0
    let activeCount = 0
    let queuedCount = 0
    let completedCount = 0
    let totalDownloadedBytes = 0
    for (const task of this.tasks.values()) {
      totalDownloadedBytes += task.downloadedBytes
      if (RUNNING.includes(task.status)) {
        activeCount += 1
        activeSpeed += task.speed
      }
      if (task.status === 'queued' || task.status === 'paused') queuedCount += 1
      if (task.status === 'completed') completedCount += 1
    }
    return { activeSpeed, activeCount, queuedCount, completedCount, totalDownloadedBytes, diskFreeBytes }
  }

  async diskFree(): Promise<number | null> {
    try {
      const stats = await statfs(this.settingsValue.downloadDirectory)
      return Number(stats.bavail) * Number(stats.bsize)
    } catch {
      return null
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    if (this.ticker) clearInterval(this.ticker)
    if (this.persistTimer) clearTimeout(this.persistTimer)
    const pending: Promise<void>[] = []
    for (const task of this.tasks.values()) {
      if (RUNNING.includes(task.status) || task.status === 'queued') {
        task.status = 'paused'
        task.speed = 0
        task.activeConnections = 0
      }
    }
    for (const run of this.runs.values()) {
      run.controller.abort(new DownloadError('应用退出', { retryable: false }))
      pending.push(run.promise.catch(() => undefined))
    }
    await Promise.allSettled(pending)
    await this.persistNow()
  }

  async persistNow(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer)
      this.persistTimer = null
    }
    try {
      await atomicWriteJson(this.tasksPath, [...this.tasks.values()])
    } catch (error) {
      console.error('MDM: 无法保存任务状态', error)
    }
  }

  private schedulePersist(): void {
    if (this.persistTimer) return
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      void this.persistNow()
    }, 800)
    this.persistTimer.unref?.()
  }

  private emitChange(): void {
    this.emit('change')
  }

  private schedule(): void {
    if (this.disposed) return
    let active = 0
    for (const task of this.tasks.values()) if (RUNNING.includes(task.status) || this.runs.has(task.id)) active += 1
    let slots = Math.max(0, this.settingsValue.maxConcurrentDownloads - active)
    if (slots <= 0) return
    const queued = [...this.tasks.values()]
      .filter((task) => task.status === 'queued' && !this.runs.has(task.id))
      .sort((a, b) => a.createdAt - b.createdAt)
    for (const task of queued) {
      if (slots <= 0) break
      slots -= 1
      this.startTask(task)
    }
  }

  private startTask(task: DownloadTask): void {
    const controller = new AbortController()
    const promise = this.execute(task, controller.signal)
    this.runs.set(task.id, { controller, promise })
    void promise
      .catch((error) => console.error('MDM task crashed:', errorMessage(error)))
      .finally(() => {
        this.runs.delete(task.id)
        this.schedule()
      })
  }

  private async execute(task: DownloadTask, signal: AbortSignal): Promise<void> {
    task.status = 'connecting'
    task.error = undefined
    task.speed = 0
    task.etaSeconds = null
    task.startedAt ??= Date.now()
    task.updatedAt = Date.now()
    this.emitChange()
    try {
      if (this.needsPrepare(task)) await this.prepare(task, signal)
      if (signal.aborted) throw signal.reason ?? new DownloadError('已取消')
      task.status = 'downloading'
      task.updatedAt = Date.now()
      this.emitChange()
      const limiter = task.speedLimitBps
        ? new RateLimiter(task.speedLimitBps)
        : this.globalLimiter
      const ffmpegPath = await findFfmpeg()
      const context: StreamDownloadContext = {
        task,
        signal,
        limiter,
        onBytes: () => undefined,
        onConnections: (active) => {
          task.activeConnections = active
        },
        ffmpegPath,
        remuxStreams: this.settingsValue.remuxStreams
      }
      if (task.protocol === 'ftp') {
        await downloadFtp({
          task,
          signal,
          onBytes: () => undefined,
          onConnections: (active) => {
            task.activeConnections = active
          }
        })
      } else if (task.protocol === 'hls') {
        await downloadHls(context)
      } else if (task.protocol === 'dash') {
        await downloadDash(context)
      } else {
        await downloadHttp({
          task,
          signal,
          limiter,
          onBytes: () => undefined,
          onConnections: (active) => {
            task.activeConnections = active
          }
        })
      }
      if (signal.aborted) throw signal.reason ?? new DownloadError('已取消')
      await this.finalize(task)
    } catch (error) {
      this.lastSample.delete(task.id)
      task.activeConnections = 0
      task.speed = 0
      task.etaSeconds = null
      const currentStatus = task.status as DownloadTask['status']
      const cancelled = currentStatus === 'cancelled'
      if (signal.aborted || currentStatus === 'paused' || cancelled) {
        if (!cancelled) task.status = 'paused'
      } else {
        task.status = 'error'
        task.error = friendlyError(error)
      }
      task.updatedAt = Date.now()
      this.emitChange()
      this.schedulePersist()
      if (task.status === 'error') this.emit('failed', task)
      console.error(`MDM task ${task.id} stopped:`, errorMessage(error))
    }
  }

  private needsPrepare(task: DownloadTask): boolean {
    if (!task.savePath || !task.tempPath) return true
    if (task.protocol === 'http' || task.protocol === 'ftp') return task.segments.length === 0
    return !task.stream
  }

  private async prepare(task: DownloadTask, signal: AbortSignal): Promise<void> {
    await ensureDir(task.directory)
    const ffmpegPath = await findFfmpeg()
    let protocol = task.protocol
    let fileName = task.fileName
    let totalBytes = task.totalBytes
    let rangeSupported = task.rangeSupported
    let finalUrl = task.finalUrl ?? task.url
    let etag = task.etag
    let lastModified = task.lastModified
    let mimeType = task.mimeType
    let kind: 'file' | 'hls' | 'dash' = protocol === 'hls' ? 'hls' : protocol === 'dash' ? 'dash' : 'file'

    if (protocol === 'ftp') {
      const probe = await probeFtp(task.url, task.request, signal)
      finalUrl = probe.finalUrl
      protocol = 'ftp'
      kind = 'file'
      fileName = probe.fileName || fileName
      totalBytes = probe.totalBytes
      rangeSupported = true
      lastModified = probe.lastModified
      mimeType = undefined
    } else {
      const probe = await probeHttp(task.url, task.request, signal)
      finalUrl = probe.finalUrl
      protocol = probe.protocol
      kind = probe.kind
      totalBytes = probe.totalBytes
      rangeSupported = probe.rangeSupported
      etag = probe.etag
      lastModified = probe.lastModified
      mimeType = probe.mimeType
      if (this.autoNamed.has(task.id) && probe.fileName) fileName = probe.fileName
    }

    let baseName = fileName
    if (kind === 'hls' || kind === 'dash') {
      const { stem } = splitName(baseName)
      baseName = `${stem || 'stream'}${streamExtension(protocol, ffmpegPath, this.settingsValue.remuxStreams)}`
      task.stream = {
        kind: protocol === 'dash' ? 'dash' : 'hls',
        fragmentsTotal: 0,
        fragmentsDone: 0,
        completedFragments: []
      }
    } else {
      task.stream = undefined
    }
    const savePath = await uniquePath(task.directory, baseName || 'download')
    task.fileName = basename(savePath)
    task.savePath = savePath
    task.tempPath = `${savePath}.mdm-part`
    task.fragmentDir = kind === 'file' ? undefined : join(this.dataDir, 'fragments', task.id)
    task.finalUrl = finalUrl
    task.protocol = protocol
    task.totalBytes = totalBytes
    task.rangeSupported = rangeSupported
    task.resumable = rangeSupported
    task.etag = etag
    task.lastModified = lastModified
    task.mimeType = mimeType
    task.downloadedBytes = 0
    task.activeConnections = 0
    task.category = categoryFor(task.fileName)
    if (protocol === 'ftp') {
      task.connections = 1
      task.segments = [{
        index: 0,
        start: 0,
        end: Math.max(0, totalBytes - 1),
        downloaded: 0,
        status: 'pending'
      }]
    } else if (protocol === 'http') {
      task.segments = planSegments({
        requested: task.connections,
        totalBytes,
        rangeSupported
      })
      if (!rangeSupported) task.connections = 1
    } else {
      task.segments = []
    }
    this.autoNamed.delete(task.id)
    await this.persistNow()
  }

  private async finalize(task: DownloadTask): Promise<void> {
    if (!(await pathExists(task.tempPath))) {
      throw new DownloadError('临时文件不存在，无法完成下载', { retryable: false })
    }
    if (task.checksum) {
      const actual = await sha256File(task.tempPath)
      task.checksum.actual = actual
      task.checksum.verified = actual.toLowerCase() === task.checksum.value.toLowerCase()
      if (!task.checksum.verified) {
        throw new DownloadError(`SHA-256 校验失败：期望 ${task.checksum.value}，实际 ${actual}`, { retryable: false })
      }
    }
    if (await pathExists(task.savePath)) {
      const next = await uniquePath(task.directory, task.fileName)
      task.fileName = basename(next)
      task.savePath = next
    }
    await ensureDir(task.directory)
    await rename(task.tempPath, task.savePath)
    if (task.fragmentDir) await removePath(task.fragmentDir)
    task.status = 'completed'
    task.completedAt = Date.now()
    task.updatedAt = Date.now()
    task.downloadedBytes = task.totalBytes || task.downloadedBytes
    task.speed = 0
    task.etaSeconds = null
    task.activeConnections = 0
    task.error = undefined
    task.fileMissing = false
    this.lastSample.delete(task.id)
    this.emitChange()
    await this.persistNow()
    this.emit('completed', task)
  }

  private tick(): void {
    if (this.disposed) return
    let changed = false
    for (const task of this.tasks.values()) {
      if (task.status === 'downloading' && this.runs.has(task.id)) {
        const previous = this.lastSample.get(task.id)
        if (previous !== undefined) {
          const instant = Math.max(0, task.downloadedBytes - previous)
          task.speed = task.speed > 0 ? task.speed * 0.55 + instant * 0.45 : instant
        }
        this.lastSample.set(task.id, task.downloadedBytes)
        if (task.totalBytes > 0 && task.speed > 0) {
          task.etaSeconds = Math.max(0, (task.totalBytes - task.downloadedBytes) / task.speed)
        } else {
          task.etaSeconds = null
        }
        changed = true
      } else if (task.speed !== 0 || task.etaSeconds !== null) {
        task.speed = 0
        task.etaSeconds = null
        changed = true
      }
    }
    if (changed) {
      this.emitChange()
      this.schedulePersist()
    }
  }

  private toPublic(task: DownloadTask): PublicTask {
    const { request, stream, ...rest } = task
    return {
      ...rest,
      hasCustomHeaders: Boolean(request?.headers && Object.keys(request.headers).length > 0),
      hasCookies: Boolean(request?.cookies),
      stream: stream
        ? { ...stream, completedFragments: stream.completedFragments.length }
        : undefined
    }
  }
}

export { defaultSettings, normalizeSettings }