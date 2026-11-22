import { useEffect, useMemo, useRef, useState } from 'react'
import type { AddDownloadInput, AppSettings } from '@shared/types'
import { Icon } from './Icons'

interface AddDialogProps {
  open: boolean
  initialUrl?: string
  settings: AppSettings
  onClose: () => void
  onAdded: (message: string) => void
  onError: (message: string) => void
}

function urlFileName(url: string): string {
  try {
    const parsed = new URL(url)
    const parts = parsed.pathname.split('/').filter(Boolean)
    const name = parts[parts.length - 1]
    return name ? decodeURIComponent(name) : ''
  } catch {
    return ''
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function AddDialog({ open, initialUrl, settings, onClose, onAdded, onError }: AddDialogProps): React.ReactNode {
  const [url, setUrl] = useState('')
  const [fileName, setFileName] = useState('')
  const [directory, setDirectory] = useState(settings.downloadDirectory)
  const [connections, setConnections] = useState(settings.defaultConnections)
  const [checksum, setChecksum] = useState('')
  const [speedMb, setSpeedMb] = useState('0')
  const [advanced, setAdvanced] = useState(false)
  const [headersText, setHeadersText] = useState('')
  const [referrer, setReferrer] = useState('')
  const [cookies, setCookies] = useState('')
  const [userAgent, setUserAgent] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const urlRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    setUrl(initialUrl ?? '')
    setFileName('')
    setDirectory(settings.downloadDirectory)
    setConnections(settings.defaultConnections)
    setChecksum('')
    setSpeedMb(settings.globalSpeedLimitBps > 0 ? String(Math.round((settings.globalSpeedLimitBps / 1024 / 1024) * 10) / 10) : '0')
    setAdvanced(false)
    setHeadersText('')
    setReferrer('')
    setCookies('')
    setUserAgent('')
    setSubmitting(false)
    window.setTimeout(() => urlRef.current?.focus(), 80)
  }, [open, initialUrl, settings.downloadDirectory, settings.defaultConnections, settings.globalSpeedLimitBps])

  const guessedName = useMemo(() => (fileName.trim() ? fileName.trim() : urlFileName(url)), [fileName, url])
  const isStreamLink = /\.m3u8($|\?)|\/master\.m3u8|manifest/i.test(url) || /\.mpd($|\?)/i.test(url)
  const validUrl = /^(https?|ftps?):\/\//i.test(url.trim())

  if (!open) return null

  const browse = async (): Promise<void> => {
    try {
      const picked = await window.mdm.invoke('settings:choose-directory', directory)
      if (picked) setDirectory(picked)
    } catch (error) {
      onError(errorText(error))
    }
  }

  const parseHeaders = (): Record<string, string> | undefined => {
    if (!advanced || !headersText.trim()) return undefined
    let parsed: unknown
    try {
      parsed = JSON.parse(headersText)
    } catch {
      throw new Error('自定义请求头必须是合法的 JSON 对象')
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('自定义请求头必须是 JSON 对象，例如 {"Authorization":"Bearer ..."}')
    }
    const headers: Record<string, string> = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string') headers[key] = value
      else if (typeof value === 'number') headers[key] = String(value)
      else throw new Error(`请求头 ${key} 的值必须是字符串`)
    }
    return Object.keys(headers).length > 0 ? headers : undefined
  }

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    if (submitting) return
    if (!validUrl) {
      onError('请输入有效的 HTTP、HTTPS、FTP 或 FTPS 链接')
      return
    }
    try {
      const headers = parseHeaders()
      const input: AddDownloadInput = {
        url: url.trim(),
        fileName: fileName.trim() || undefined,
        directory: directory.trim() || undefined,
        connections,
        checksum: checksum.trim() || undefined,
        speedLimitBps: Math.max(0, Math.round(Number(speedMb || '0') * 1024 * 1024)),
        headers,
        referrer: referrer.trim() || undefined,
        cookies: cookies.trim() || undefined,
        userAgent: userAgent.trim() || undefined,
        source: 'app'
      }
      setSubmitting(true)
      const result = await window.mdm.invoke('downloads:add', input)
      onAdded(`任务已创建：${guessedName || result.taskId.slice(0, 8)}`)
    } catch (error) {
      onError(errorText(error))
      setSubmitting(false)
    }
  }

  return (
    <div className="overlay" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="dialog add-dialog" role="dialog" aria-modal="true" aria-label="添加下载">
        <div className="dialog-head">
          <div>
            <div className="eyebrow">
              <span className="eyebrow-line" />
              NEW TRANSFER
            </div>
            <h2>添加下载</h2>
            <p>支持 HTTP / FTP / HLS / DASH，最高 64 分片并发。</p>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭">
            <Icon name="close" size={18} />
          </button>
        </div>

        <form onSubmit={(event) => void submit(event)}>
          <div className="dialog-body">
            <label className="field">
              <span className="field-label">
                下载链接
                <em>必填</em>
              </span>
              <div className={`url-input ${url && !validUrl ? 'invalid' : ''}`}>
                <Icon name="link" size={17} />
                <input
                  ref={urlRef}
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                  placeholder="https://example.com/video.zip 或 https://cdn.example.com/live.m3u8"
                  spellCheck={false}
                />
                {validUrl ? <Icon name="checkCircle" size={16} className="url-ok" /> : null}
              </div>
              {url && !validUrl ? <span className="field-error">链接必须以 http://、https://、ftp:// 或 ftps:// 开头</span> : null}
              {isStreamLink ? (
                <span className="field-hint accent">
                  <Icon name="film" size={13} />
                  检测到流媒体清单，将自动解析最佳码率并支持分片续传
                </span>
              ) : null}
            </label>

            <div className="form-grid">
              <label className="field">
                <span className="field-label">文件名</span>
                <input
                  value={fileName}
                  onChange={(event) => setFileName(event.target.value)}
                  placeholder={guessedName || '留空则从响应头推断'}
                />
              </label>
              <label className="field">
                <span className="field-label">保存到</span>
                <div className="input-with-button">
                  <input value={directory} onChange={(event) => setDirectory(event.target.value)} spellCheck={false} />
                  <button type="button" className="input-action" onClick={() => void browse()} title="选择文件夹">
                    <Icon name="folder" size={16} />
                  </button>
                </div>
              </label>
            </div>

            <div className="field connections-field">
              <div className="connections-head">
                <span className="field-label">
                  分片连接数
                  <em>1 – 64</em>
                </span>
                <span className="connections-value">
                  <strong>{connections}</strong>
                  <span>{connections === 64 ? '最大并发' : '连接'}</span>
                </span>
              </div>
              <input
                type="range"
                min={1}
                max={64}
                step={1}
                value={connections}
                onChange={(event) => setConnections(Number(event.target.value))}
                style={{ ['--range-progress' as string]: `${((connections - 1) / 63) * 100}%` }}
              />
              <div className="range-marks">
                {[1, 4, 8, 16, 32, 64].map((mark) => (
                  <button key={mark} type="button" onClick={() => setConnections(mark)} className={connections === mark ? 'on' : ''}>
                    {mark}
                  </button>
                ))}
              </div>
              <span className="field-hint">实际连接数取决于服务器是否支持 Range 以及文件大小；小于 16 MB 的文件会自动减少分片。</span>
            </div>

            <div className="form-grid">
              <label className="field">
                <span className="field-label">全局限速 (MB/s)</span>
                <input
                  type="number"
                  min={0}
                  step={0.5}
                  value={speedMb}
                  onChange={(event) => setSpeedMb(event.target.value)}
                  placeholder="0 表示不限速"
                />
                <span className="field-hint">0 表示不限制，仅对本任务生效。</span>
              </label>
              <label className="field">
                <span className="field-label">SHA-256 校验</span>
                <input
                  value={checksum}
                  onChange={(event) => setChecksum(event.target.value)}
                  placeholder="可选，64 位十六进制"
                  spellCheck={false}
                  className="mono-input"
                />
                <span className="field-hint">下载完成后自动校验，失败会标记任务错误。</span>
              </label>
            </div>

            <button type="button" className={`advanced-toggle ${advanced ? 'open' : ''}`} onClick={() => setAdvanced((value) => !value)}>
              <Icon name="chevron" size={14} />
              高级请求选项
              <span>Cookie、Referer、UA、自定义请求头</span>
            </button>

            {advanced ? (
              <div className="advanced-box">
                <div className="form-grid">
                  <label className="field">
                    <span className="field-label">Referer</span>
                    <input value={referrer} onChange={(event) => setReferrer(event.target.value)} placeholder="https://example.com/" spellCheck={false} />
                  </label>
                  <label className="field">
                    <span className="field-label">User-Agent</span>
                    <input value={userAgent} onChange={(event) => setUserAgent(event.target.value)} placeholder="留空使用 MDM 默认 UA" spellCheck={false} />
                  </label>
                </div>
                <label className="field">
                  <span className="field-label">Cookie</span>
                  <input value={cookies} onChange={(event) => setCookies(event.target.value)} placeholder="session=...; token=..." spellCheck={false} />
                </label>
                <label className="field">
                  <span className="field-label">自定义请求头 (JSON)</span>
                  <textarea
                    value={headersText}
                    onChange={(event) => setHeadersText(event.target.value)}
                    placeholder={'{\n  "Authorization": "Bearer ...",\n  "X-Requested-With": "MDM"\n}'}
                    rows={4}
                    spellCheck={false}
                  />
                </label>
              </div>
            ) : null}
          </div>

          <div className="dialog-foot">
            <div className="dialog-foot-note">
              <Icon name="lock" size={14} />
              链接与 Cookie 仅保存在本机
            </div>
            <div className="dialog-foot-actions">
              <button type="button" className="btn ghost" onClick={onClose}>
                取消
              </button>
              <button type="submit" className="btn primary" disabled={submitting || !validUrl}>
                {submitting ? <span className="spinner" /> : <Icon name="download" size={17} />}
                {submitting ? '正在创建…' : '开始下载'}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  )
}
