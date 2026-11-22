import { useEffect, useState } from 'react'
import type { AppSettings, AppSnapshot, SettingsPatch } from '@shared/types'
import { Icon } from './Icons'
import { formatClock } from '../lib'

interface SettingsDialogProps {
  open: boolean
  snapshot: AppSnapshot
  onClose: () => void
  onSaved: (message: string) => void
  onError: (message: string) => void
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function Toggle({ checked, onChange, label, description }: { checked: boolean; onChange: (value: boolean) => void; label: string; description: string }): React.ReactNode {
  return (
    <button type="button" className="toggle-row" onClick={() => onChange(!checked)}>
      <span>
        <strong>{label}</strong>
        <small>{description}</small>
      </span>
      <span className={`toggle ${checked ? 'on' : ''}`} role="switch" aria-checked={checked}>
        <span />
      </span>
    </button>
  )
}

export function SettingsDialog({ open, snapshot, onClose, onSaved, onError }: SettingsDialogProps): React.ReactNode {
  const [draft, setDraft] = useState<AppSettings>(snapshot.settings)
  const [speedMb, setSpeedMb] = useState('0')
  const [token, setToken] = useState(snapshot.api.token)
  const [showToken, setShowToken] = useState(false)
  const [saving, setSaving] = useState(false)
  const [rotating, setRotating] = useState(false)
  const [port, setPort] = useState(String(snapshot.settings.port))

  useEffect(() => {
    if (!open) return
    setDraft(snapshot.settings)
    setPort(String(snapshot.settings.port))
    setSpeedMb(snapshot.settings.globalSpeedLimitBps > 0 ? String(Math.round((snapshot.settings.globalSpeedLimitBps / 1024 / 1024) * 10) / 10) : '0')
    setToken(snapshot.api.token)
    setShowToken(false)
    setSaving(false)
    setRotating(false)
  }, [open])

  if (!open) return null

  const patch = (partial: Partial<AppSettings>): void => setDraft((current) => ({ ...current, ...partial }))

  const browse = async (): Promise<void> => {
    try {
      const picked = await window.mdm.invoke('settings:choose-directory', draft.downloadDirectory)
      if (picked) patch({ downloadDirectory: picked })
    } catch (error) {
      onError(errorText(error))
    }
  }

  const copy = async (text: string, message: string): Promise<void> => {
    try {
      await window.mdm.invoke('app:clipboard', text)
      onSaved(message)
    } catch (error) {
      onError(errorText(error))
    }
  }

  const rotate = async (): Promise<void> => {
    if (!window.confirm('轮换后旧令牌立即失效，已配对的扩展需要重新填写。继续？')) return
    try {
      setRotating(true)
      const status = await window.mdm.invoke('api:rotate-token')
      setToken(status.token)
      setShowToken(true)
      onSaved('令牌已轮换，请更新扩展中的令牌')
    } catch (error) {
      onError(errorText(error))
    } finally {
      setRotating(false)
    }
  }

  const save = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    const parsedPort = Number(port)
    if (!Number.isInteger(parsedPort) || parsedPort < 1024 || parsedPort > 65535) {
      onError('API 端口必须是 1024 – 65535 之间的整数')
      return
    }
    try {
      setSaving(true)
      const next: SettingsPatch = {
        downloadDirectory: draft.downloadDirectory.trim(),
        maxConcurrentDownloads: draft.maxConcurrentDownloads,
        defaultConnections: draft.defaultConnections,
        globalSpeedLimitBps: Math.max(0, Math.round(Number(speedMb || '0') * 1024 * 1024)),
        port: parsedPort,
        autoStart: draft.autoStart,
        notifications: draft.notifications,
        remuxStreams: draft.remuxStreams,
        theme: draft.theme
      }
      await window.mdm.invoke('settings:update', next)
      onSaved('设置已保存')
      onClose()
    } catch (error) {
      onError(errorText(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="overlay" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="dialog settings-dialog" role="dialog" aria-modal="true" aria-label="设置">
        <div className="dialog-head">
          <div>
            <div className="eyebrow">
              <span className="eyebrow-line" />
              PREFERENCES
            </div>
            <h2>设置</h2>
            <p>调整下载引擎、系统行为与 Chrome 扩展配对。</p>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭">
            <Icon name="close" size={18} />
          </button>
        </div>

        <form onSubmit={(event) => void save(event)}>
          <div className="dialog-body settings-body">
            <section className="settings-section">
              <div className="settings-title">
                <Icon name="download" size={17} />
                <div>
                  <h3>下载引擎</h3>
                  <p>磁盘、并发和流媒体处理方式。</p>
                </div>
              </div>

              <label className="field">
                <span className="field-label">默认保存目录</span>
                <div className="input-with-button">
                  <input value={draft.downloadDirectory} onChange={(event) => patch({ downloadDirectory: event.target.value })} spellCheck={false} />
                  <button type="button" className="input-action" onClick={() => void browse()} title="选择文件夹">
                    <Icon name="folder" size={16} />
                  </button>
                </div>
              </label>

              <div className="form-grid">
                <div className="field">
                  <div className="connections-head">
                    <span className="field-label">同时下载任务数</span>
                    <span className="connections-value small">
                      <strong>{draft.maxConcurrentDownloads}</strong>
                    </span>
                  </div>
                  <input
                    type="range"
                    min={1}
                    max={16}
                    value={draft.maxConcurrentDownloads}
                    onChange={(event) => patch({ maxConcurrentDownloads: Number(event.target.value) })}
                    style={{ ['--range-progress' as string]: `${((draft.maxConcurrentDownloads - 1) / 15) * 100}%` }}
                  />
                  <span className="field-hint">1 – 16，超出后任务排队。</span>
                </div>
                <div className="field">
                  <div className="connections-head">
                    <span className="field-label">默认分片连接数</span>
                    <span className="connections-value small">
                      <strong>{draft.defaultConnections}</strong>
                    </span>
                  </div>
                  <input
                    type="range"
                    min={1}
                    max={64}
                    value={draft.defaultConnections}
                    onChange={(event) => patch({ defaultConnections: Number(event.target.value) })}
                    style={{ ['--range-progress' as string]: `${((draft.defaultConnections - 1) / 63) * 100}%` }}
                  />
                  <span className="field-hint">最高 64 分片；小文件会自动降级。</span>
                </div>
              </div>

              <div className="form-grid">
                <label className="field">
                  <span className="field-label">全局速度限制 (MB/s)</span>
                  <input type="number" min={0} step={0.5} value={speedMb} onChange={(event) => setSpeedMb(event.target.value)} />
                  <span className="field-hint">0 表示不限速，对所有任务生效。</span>
                </label>
                <div className="field">
                  <span className="field-label">流媒体</span>
                  <Toggle
                    checked={draft.remuxStreams}
                    onChange={(value) => patch({ remuxStreams: value })}
                    label="HLS / DASH 自动封装"
                    description="检测到 ffmpeg 时合并为 MP4，否则保留分片合并文件。"
                  />
                </div>
              </div>
            </section>

            <section className="settings-section">
              <div className="settings-title">
                <Icon name="settings" size={17} />
                <div>
                  <h3>系统行为</h3>
                  <p>启动、通知与外观。</p>
                </div>
              </div>
              <Toggle
                checked={draft.notifications}
                onChange={(value) => patch({ notifications: value })}
                label="下载完成通知"
                description="完成时弹出系统通知，点击可在文件夹中定位。"
              />
              <Toggle
                checked={draft.autoStart}
                onChange={(value) => patch({ autoStart: value })}
                label="开机自动启动"
                description="登录 Windows 后在后台启动 MDM。"
              />
              <div className="field theme-field">
                <span className="field-label">主题</span>
                <div className="segmented">
                  {(['dark', 'light', 'system'] as const).map((theme) => (
                    <button key={theme} type="button" className={draft.theme === theme ? 'active' : ''} onClick={() => patch({ theme })}>
                      {theme === 'dark' ? '深色' : theme === 'light' ? '浅色' : '跟随系统'}
                    </button>
                  ))}
                </div>
              </div>
            </section>

            <section className="settings-section extension-section">
              <div className="settings-title">
                <Icon name="puzzle" size={17} />
                <div>
                  <h3>Chrome 扩展</h3>
                  <p>通过本机回环接口接管浏览器下载，无需云端中转。</p>
                </div>
                <span className={`extension-state ${snapshot.api.running ? 'online' : 'offline'}`}>
                  <span className={`status-dot ${snapshot.api.running ? 'online' : 'offline'}`} />
                  {snapshot.api.running ? '服务运行中' : '服务未运行'}
                </span>
              </div>

              <div className="form-grid">
                <label className="field">
                  <span className="field-label">API 端口</span>
                  <input value={port} onChange={(event) => setPort(event.target.value.replace(/[^0-9]/g, ''))} inputMode="numeric" />
                  <span className="field-hint">修改端口会重启本地接口，扩展中的端口需同步更新。</span>
                </label>
                <div className="field">
                  <span className="field-label">接口地址</span>
                  <div className="readonly-copy">
                    <code>{snapshot.api.url}</code>
                    <button type="button" className="input-action" onClick={() => void copy(snapshot.api.url, '接口地址已复制')} title="复制">
                      <Icon name="copy" size={15} />
                    </button>
                  </div>
                  <span className="field-hint">
                    {snapshot.api.lastError ? `最近错误：${snapshot.api.lastError}` : `已处理 ${snapshot.api.requests} 个扩展请求`}
                  </span>
                </div>
              </div>

              <div className="field">
                <span className="field-label">
                  访问令牌
                  <em>自动生成</em>
                </span>
                <div className="token-row">
                  <code className={`token-value ${showToken ? 'shown' : ''}`}>{showToken ? token : '•'.repeat(Math.min(48, token.length || 48))}</code>
                  <button type="button" className="icon-btn" title={showToken ? '隐藏' : '显示'} onClick={() => setShowToken((value) => !value)}>
                    <Icon name="lock" size={15} />
                  </button>
                  <button type="button" className="icon-btn" title="复制令牌" onClick={() => void copy(token, '扩展令牌已复制')}>
                    <Icon name="copy" size={15} />
                  </button>
                  <button type="button" className="icon-btn danger" title="轮换令牌" disabled={rotating} onClick={() => void rotate()}>
                    <Icon name="rotate" size={15} />
                  </button>
                </div>
                <span className="field-hint">令牌以 0600 权限保存在本机数据目录，仅在回环地址上使用。</span>
              </div>

              <div className="pairing-steps">
                <div className="pairing-head">
                  <strong>配对步骤</strong>
                  <span>约 30 秒</span>
                </div>
                <ol>
                  <li>
                    <span>1</span>
                    打开 <code>chrome://extensions</code>，开启右上角「开发者模式」。
                  </li>
                  <li>
                    <span>2</span>
                    点击「加载已解压的扩展程序」，选择 MDM 的 <code>extension</code> 文件夹。
                    <button type="button" className="inline-link" onClick={() => void window.mdm.invoke('shell:open-extension-dir').catch((error: unknown) => onError(errorText(error)))}>
                      <Icon name="folder" size={13} />
                      打开扩展目录
                    </button>
                  </li>
                  <li>
                    <span>3</span>
                    在扩展选项中填入端口 <code>{port}</code> 和上方令牌，点击「测试连接」。
                  </li>
                </ol>
                <div className="pairing-status">
                  <span className={`status-dot ${snapshot.api.running ? 'online' : 'offline'}`} />
                  {snapshot.api.lastExtensionContactAt
                    ? `最近扩展连接：${formatClock(snapshot.api.lastExtensionContactAt)}`
                    : '尚未收到扩展连接'}
                </div>
              </div>
            </section>

            <section className="settings-section compact">
              <div className="settings-title">
                <Icon name="terminal" size={17} />
                <div>
                  <h3>数据与维护</h3>
                  <p>任务状态与分片缓存保存在本机用户数据目录。</p>
                </div>
              </div>
              <div className="settings-inline-actions">
                <button type="button" className="btn ghost small" onClick={() => void window.mdm.invoke('shell:open-data-dir').catch((error: unknown) => onError(errorText(error)))}>
                  <Icon name="folder" size={15} />
                  打开数据目录
                </button>
                <span className="settings-version">MDM v{snapshot.version} · {snapshot.platform}</span>
              </div>
            </section>
          </div>

          <div className="dialog-foot">
            <div className="dialog-foot-note">
              <Icon name="info" size={14} />
              设置立即生效，端口变更会重启接口
            </div>
            <div className="dialog-foot-actions">
              <button type="button" className="btn ghost" onClick={onClose}>
                取消
              </button>
              <button type="submit" className="btn primary" disabled={saving}>
                {saving ? <span className="spinner" /> : <Icon name="check" size={17} />}
                {saving ? '保存中…' : '保存设置'}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  )
}
