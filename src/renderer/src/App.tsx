import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AppSnapshot, PublicTask } from '@shared/types'
import { CategoryIcon, Icon } from './components/Icons'
import { AddDialog } from './components/AddDialog'
import { SettingsDialog } from './components/SettingsDialog'
import { TaskDetail } from './components/TaskDetail'
import { TaskRow } from './components/TaskRow'
import {
  CATEGORY_ENTRIES,
  STATUS_META,
  formatClock,
  formatSize,
  formatSpeed,
  hostLabel,
  isActiveStatus,
  taskMatches,
  taskPercent,
  taskProgress,
  viewCount,
  type ViewKey
} from './lib'

const NAV_ITEMS: Array<{ key: ViewKey; label: string; icon: 'list' | 'download' | 'pause' | 'checkCircle' | 'alert' }> = [
  { key: 'all', label: '全部下载', icon: 'list' },
  { key: 'active', label: '正在下载', icon: 'download' },
  { key: 'paused', label: '已暂停', icon: 'pause' },
  { key: 'completed', label: '已完成', icon: 'checkCircle' },
  { key: 'failed', label: '需要处理', icon: 'alert' }
]

const TAB_ITEMS: Array<{ key: ViewKey; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'active', label: '进行中' },
  { key: 'paused', label: '已暂停' },
  { key: 'completed', label: '已完成' },
  { key: 'failed', label: '失败' }
]

const TITLES: Record<string, string> = {
  all: '全部下载',
  active: '正在下载',
  paused: '已暂停',
  completed: '已完成',
  failed: '需要处理'
}

interface ToastItem {
  id: number
  text: string
  tone: 'info' | 'success' | 'error'
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function statusOrder(task: PublicTask): number {
  if (task.status === 'downloading' || task.status === 'connecting') return 0
  if (task.status === 'queued') return 1
  if (task.status === 'error') return 2
  if (task.status === 'paused') return 3
  if (task.status === 'cancelled') return 4
  return 5
}

function Sparkline({ values }: { values: number[] }): React.ReactNode {
  const points = useMemo(() => {
    const max = Math.max(1, ...values)
    return values
      .map((value, index) => {
        const x = (index / Math.max(1, values.length - 1)) * 280
        const y = 56 - (value / max) * 46
        return `${x.toFixed(1)},${y.toFixed(1)}`
      })
      .join(' ')
  }, [values])
  return (
    <svg className="sparkline" viewBox="0 0 280 60" preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id="spark-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="rgba(124,108,255,0.38)" />
          <stop offset="100%" stopColor="rgba(124,108,255,0)" />
        </linearGradient>
      </defs>
      <polygon points={`0,60 ${points} 280,60`} fill="url(#spark-fill)" />
      <polyline points={points} fill="none" stroke="#8f80ff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function SpeedHero({ snapshot, history }: { snapshot: AppSnapshot; history: number[] }): React.ReactNode {
  const { stats, tasks } = snapshot
  const active = tasks.filter((task) => isActiveStatus(task.status))
  const aggregate = active.length > 0 ? active.reduce((sum, task) => sum + taskProgress(task), 0) / active.length : 0
  return (
    <section className="speed-hero">
      <div className="hero-glow" />
      <div className="hero-main">
        <div className="hero-label">
          <span className="live-dot" />
          实时吞吐
          <span className="hero-divider" />
          {stats.activeCount > 0 ? `${stats.activeCount} 个任务并行` : '等待新任务'}
        </div>
        <div className="hero-speed">
          <span className="hero-speed-value">{formatSpeed(stats.activeSpeed).replace('/s', '')}</span>
          <span className="hero-speed-unit">/s</span>
        </div>
        <div className="hero-history">
          <Sparkline values={history} />
          <span className="hero-history-caption">最近 32 秒</span>
        </div>
        <div className="hero-stats">
          <div className="hero-stat">
            <span className="hero-stat-label">累计下载</span>
            <strong>{formatSize(stats.totalDownloadedBytes)}</strong>
          </div>
          <div className="hero-stat">
            <span className="hero-stat-label">已完成</span>
            <strong>{stats.completedCount}</strong>
          </div>
          <div className="hero-stat">
            <span className="hero-stat-label">磁盘可用</span>
            <strong>{stats.diskFreeBytes === null ? '—' : formatSize(stats.diskFreeBytes)}</strong>
          </div>
          <div className="hero-stat">
            <span className="hero-stat-label">并发上限</span>
            <strong>{snapshot.settings.maxConcurrentDownloads}</strong>
          </div>
        </div>
      </div>
      <div className="hero-ring-wrap">
        <div
          className="hero-ring"
          style={{ background: `conic-gradient(#7c6cff ${Math.round(aggregate * 360)}deg, rgba(255,255,255,0.07) 0deg)` }}
        >
          <div className="hero-ring-inner">
            <span className="hero-ring-value">{active.length}</span>
            <span className="hero-ring-label">ACTIVE</span>
          </div>
        </div>
        <div className="hero-ring-caption">
          <Icon name="spark" size={14} />
          64 分片引擎
        </div>
      </div>
    </section>
  )
}

function Sidebar({
  snapshot,
  view,
  onChange,
  onSettings
}: {
  snapshot: AppSnapshot
  view: ViewKey
  onChange: (view: ViewKey) => void
  onSettings: () => void
}): React.ReactNode {
  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark">
          <span>M</span>
        </div>
        <div className="brand-text">
          <strong>MDM</strong>
          <span>DOWNLOAD MANAGER</span>
        </div>
      </div>

      <div className="sidebar-section-label">下载任务</div>
      <nav className="side-nav">
        {NAV_ITEMS.map((item) => (
          <button
            key={item.key}
            type="button"
            className={`side-item ${view === item.key ? 'active' : ''}`}
            onClick={() => onChange(item.key)}
          >
            <span className="side-item-icon">
              <Icon name={item.icon} size={17} />
            </span>
            <span className="side-item-label">{item.label}</span>
            <span className="side-item-count">{viewCount(snapshot.tasks, item.key)}</span>
          </button>
        ))}
      </nav>

      <div className="sidebar-section-label category-label">分类</div>
      <nav className="side-nav categories">
        {CATEGORY_ENTRIES.map((item) => (
          <button
            key={item.key}
            type="button"
            className={`side-item category ${view === item.key ? 'active' : ''}`}
            onClick={() => onChange(item.key)}
          >
            <span className="category-dot" style={{ background: item.color }} />
            <span className="side-item-label">{item.label}</span>
            <span className="side-item-count">{viewCount(snapshot.tasks, item.key)}</span>
          </button>
        ))}
      </nav>

      <div className="sidebar-spacer" />

      <div className="api-card" onClick={onSettings} role="button" tabIndex={0} onKeyDown={(event) => event.key === 'Enter' && onSettings()}>
        <div className="api-card-head">
          <span className={`status-dot ${snapshot.api.running ? 'online' : 'offline'}`} />
          <strong>本地接口</strong>
          <span className="api-port">:{snapshot.api.port}</span>
        </div>
        <p>{snapshot.api.running ? 'Chrome 扩展已就绪' : snapshot.api.lastError ?? '接口未启动'}</p>
      </div>

      <button type="button" className="side-item settings-entry" onClick={onSettings}>
        <span className="side-item-icon">
          <Icon name="settings" size={17} />
        </span>
        <span className="side-item-label">设置</span>
        <span className="kbd-hint">⌘,</span>
      </button>
    </aside>
  )
}

function Titlebar({ apiRunning, onSettings }: { apiRunning: boolean; onSettings: () => void }): React.ReactNode {
  const windowAction = (action: 'minimize' | 'maximize' | 'close'): void => {
    void window.mdm.invoke('app:window', action)
  }
  return (
    <header className="titlebar" onDoubleClick={() => windowAction('maximize')}>
      <div className="titlebar-left">
        <span className="titlebar-app">MDM</span>
        <span className="titlebar-sep" />
        <span className="titlebar-page">下载中心</span>
      </div>
      <div className="titlebar-drag" data-tauri-drag-region />
      <div className="titlebar-right no-drag">
        <button type="button" className="titlebar-pill" onClick={onSettings}>
          <span className={`status-dot ${apiRunning ? 'online' : 'offline'}`} />
          {apiRunning ? '扩展在线' : '扩展离线'}
        </button>
        <div className="window-controls">
          <button type="button" className="window-btn" title="最小化" onClick={() => windowAction('minimize')}>
            <Icon name="minimize" size={15} />
          </button>
          <button type="button" className="window-btn" title="最大化" onClick={() => windowAction('maximize')}>
            <Icon name="maximize" size={13} />
          </button>
          <button type="button" className="window-btn close" title="关闭" onClick={() => windowAction('close')}>
            <Icon name="close" size={15} />
          </button>
        </div>
      </div>
    </header>
  )
}

export function App(): React.ReactNode {
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null)
  const [view, setView] = useState<ViewKey>('all')
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [addUrl, setAddUrl] = useState<string | undefined>(undefined)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const [history, setHistory] = useState<number[]>(Array.from({ length: 32 }, () => 0))
  const latestSpeed = useRef(0)
  const toastId = useRef(1)
  const [dragging, setDragging] = useState(false)

  const notify = useCallback((text: string, tone: ToastItem['tone'] = 'info') => {
    const id = toastId.current++
    setToasts((items) => [...items, { id, text, tone }])
    window.setTimeout(() => setToasts((items) => items.filter((item) => item.id !== id)), 3600)
  }, [])

  const refresh = useCallback(async () => {
    try {
      const next = await window.mdm.snapshot()
      setSnapshot(next)
    } catch (error) {
      console.error(error)
    }
  }, [])

  useEffect(() => {
    let alive = true
    const unsubscribe = window.mdm.onSnapshot((next) => {
      if (alive) setSnapshot(next)
    })
    const unsubscribeNavigate = window.mdm.onNavigate((target) => {
      if (['all', 'active', 'paused', 'completed', 'failed'].includes(target)) setView(target as ViewKey)
    })
    void refresh()
    const timer = window.setInterval(() => {
      if (alive) void refresh()
    }, 4000)
    return () => {
      alive = false
      unsubscribe()
      unsubscribeNavigate()
      window.clearInterval(timer)
    }
  }, [refresh])

  useEffect(() => {
    latestSpeed.current = snapshot?.stats.activeSpeed ?? 0
  }, [snapshot?.stats.activeSpeed])

  useEffect(() => {
    const timer = window.setInterval(() => {
      setHistory((values) => [...values.slice(-31), latestSpeed.current])
    }, 1000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    if (!selectedId) return
    if (snapshot && !snapshot.tasks.some((task) => task.id === selectedId)) setSelectedId(null)
  }, [snapshot, selectedId])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null
      const typing = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA'
      if (event.key === 'Escape') {
        setAddOpen(false)
        setSettingsOpen(false)
        setSelectedId(null)
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'n') {
        event.preventDefault()
        setAddUrl(undefined)
        setAddOpen(true)
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f' && !typing) {
        event.preventDefault()
        document.getElementById('task-search')?.focus()
      }
      if ((event.ctrlKey || event.metaKey) && event.key === ',') {
        event.preventDefault()
        setSettingsOpen(true)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const tasks = snapshot?.tasks ?? []
  const filtered = useMemo(
    () =>
      tasks
        .filter((task) => taskMatches(task, view, query))
        .sort((a, b) => statusOrder(a) - statusOrder(b) || b.createdAt - a.createdAt),
    [tasks, view, query]
  )
  const selectedTask = tasks.find((task) => task.id === selectedId)
  const title = TITLES[view] ?? CATEGORY_ENTRIES.find((item) => item.key === view)?.label ?? '下载中心'

  const handleAction = useCallback(
    async (action: string, task: PublicTask): Promise<void> => {
      try {
        if (action === 'pause') await window.mdm.invoke('downloads:pause', task.id)
        if (action === 'resume') await window.mdm.invoke('downloads:resume', task.id)
        if (action === 'retry') await window.mdm.invoke('downloads:retry', task.id)
        if (action === 'cancel') {
          if (!window.confirm('取消后已下载的临时数据会被删除，确认取消？')) return
          await window.mdm.invoke('downloads:cancel', task.id)
        }
        if (action === 'remove') {
          if (!window.confirm('仅移除任务记录，已完成的文件会保留。确认移除？')) return
          await window.mdm.invoke('downloads:remove', task.id)
          setSelectedId(null)
        }
        if (action === 'open-file') await window.mdm.invoke('downloads:open-file', task.id)
        if (action === 'open-folder') await window.mdm.invoke('downloads:open-folder', task.id)
        if (action === 'copy-link') {
          await window.mdm.invoke('downloads:copy-link', task.id)
          notify('下载链接已复制', 'success')
        }
        await refresh()
      } catch (error) {
        notify(errorText(error), 'error')
      }
    },
    [notify, refresh]
  )

  const handleView = (next: ViewKey): void => {
    setView(next)
    setQuery('')
  }

  const handleDrop = (event: React.DragEvent): void => {
    event.preventDefault()
    setDragging(false)
    const text = event.dataTransfer.getData('text/uri-list') || event.dataTransfer.getData('text/plain')
    const url = text.split(/\r?\n/).find((line) => /^(https?|ftps?):\/\//i.test(line.trim()))
    if (!url) {
      notify('没有识别到 HTTP / FTP 下载链接', 'error')
      return
    }
    setAddUrl(url.trim())
    setAddOpen(true)
  }

  if (!snapshot) {
    return (
      <div className="app-shell">
        <Titlebar apiRunning={false} onSettings={() => undefined} />
        <div className="loading-screen">
          <div className="loading-mark">M</div>
          <p>正在唤醒下载引擎…</p>
        </div>
      </div>
    )
  }

  return (
    <div className="app-shell">
      <Titlebar apiRunning={snapshot.api.running} onSettings={() => setSettingsOpen(true)} />
      <div className="app-body">
        <Sidebar snapshot={snapshot} view={view} onChange={handleView} onSettings={() => setSettingsOpen(true)} />
        <main
          className={`main ${dragging ? 'dragging' : ''}`}
          onDragOver={(event) => {
            event.preventDefault()
            setDragging(true)
          }}
          onDragLeave={(event) => {
            if (event.currentTarget === event.target) setDragging(false)
          }}
          onDrop={handleDrop}
        >
          <div className="main-scroll">
            <div className="page-head">
              <div>
                <div className="eyebrow">
                  <span className="eyebrow-line" />
                  下载中心 / {title}
                </div>
                <h1>{title}</h1>
                <p>
                  {view === 'all'
                    ? `共 ${tasks.length} 个任务，${snapshot.stats.activeCount} 个正在传输`
                    : `${filtered.length} 个任务 · 最高 64 分片并发`}
                </p>
              </div>
              <div className="page-actions">
                <button
                  type="button"
                  className="btn ghost"
                  onClick={() => {
                    setAddUrl(undefined)
                    setAddOpen(true)
                  }}
                >
                  <Icon name="link" size={16} />
                  新建任务
                </button>
                <button
                  type="button"
                  className="btn primary"
                  onClick={() => {
                    setAddUrl(undefined)
                    setAddOpen(true)
                  }}
                >
                  <Icon name="plus" size={17} />
                  添加下载
                  <span className="btn-kbd">Ctrl N</span>
                </button>
              </div>
            </div>

            <SpeedHero snapshot={snapshot} history={history} />

            <div className="list-head">
              <div className="tabs">
                {TAB_ITEMS.map((tab) => (
                  <button
                    key={tab.key}
                    type="button"
                    className={`tab ${view === tab.key ? 'active' : ''}`}
                    onClick={() => handleView(tab.key)}
                  >
                    {tab.label}
                    <span>{viewCount(tasks, tab.key)}</span>
                  </button>
                ))}
              </div>
              <div className="list-tools">
                <label className="search-box">
                  <Icon name="search" size={16} />
                  <input
                    id="task-search"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="搜索文件或域名"
                  />
                  {query ? (
                    <button type="button" className="search-clear" onClick={() => setQuery('')} aria-label="清空搜索">
                      <Icon name="close" size={13} />
                    </button>
                  ) : null}
                </label>
                <button
                  type="button"
                  className="icon-btn"
                  title="刷新"
                  onClick={() => void refresh()}
                >
                  <Icon name="refresh" size={17} />
                </button>
              </div>
            </div>

            <section className="task-list">
              {filtered.length === 0 ? (
                <div className="empty-state">
                  <div className="empty-orbit">
                    <div className="empty-icon">
                      <Icon name={view === 'completed' ? 'checkCircle' : view === 'failed' ? 'shield' : 'download'} size={34} />
                    </div>
                  </div>
                  <h2>{query ? '没有匹配的任务' : view === 'all' ? '还没有下载任务' : '这里是空的'}</h2>
                  <p>
                    {query
                      ? '换个关键词试试，或清空搜索。'
                      : '把链接拖到窗口任意位置，或粘贴 HTTP / FTP / HLS / DASH 地址开始下载。'}
                  </p>
                  {!query ? (
                    <button
                      type="button"
                      className="btn primary"
                      onClick={() => {
                        setAddUrl(undefined)
                        setAddOpen(true)
                      }}
                    >
                      <Icon name="plus" size={17} />
                      添加第一个任务
                    </button>
                  ) : null}
                </div>
              ) : (
                filtered.map((task) => (
                  <TaskRow
                    key={task.id}
                    task={task}
                    onSelect={() => setSelectedId(task.id)}
                    onAction={(action) => void handleAction(action, task)}
                  />
                ))
              )}
            </section>

            <footer className="main-footer">
              <span>MDM v{snapshot.version}</span>
              <span className="footer-dot" />
              <span>本地引擎 · 无云端中转</span>
              <span className="footer-dot" />
              <span className="mono">127.0.0.1:{snapshot.api.port}</span>
              <span className="footer-spacer" />
              <button type="button" className="link-btn" onClick={() => setSettingsOpen(true)}>
                <Icon name="puzzle" size={14} />
                Chrome 扩展
              </button>
            </footer>
          </div>

          {dragging ? (
            <div className="drop-overlay">
              <div className="drop-card">
                <Icon name="arrowDown" size={38} />
                <strong>松开立即下载</strong>
                <span>支持 HTTP / FTP / HLS / DASH 链接</span>
              </div>
            </div>
          ) : null}
        </main>
      </div>

      {selectedTask ? (
        <TaskDetail
          task={selectedTask}
          onClose={() => setSelectedId(null)}
          onAction={(action) => void handleAction(action, selectedTask)}
        />
      ) : null}

      <AddDialog
        open={addOpen}
        initialUrl={addUrl}
        settings={snapshot.settings}
        onClose={() => setAddOpen(false)}
        onAdded={(message) => {
          setAddOpen(false)
          notify(message, 'success')
          void refresh()
        }}
        onError={(message) => notify(message, 'error')}
      />

      <SettingsDialog
        open={settingsOpen}
        snapshot={snapshot}
        onClose={() => setSettingsOpen(false)}
        onSaved={(message) => {
          notify(message, 'success')
          void refresh()
        }}
        onError={(message) => notify(message, 'error')}
      />

      <div className="toast-stack">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast ${toast.tone}`}>
            <Icon name={toast.tone === 'error' ? 'alert' : toast.tone === 'success' ? 'checkCircle' : 'info'} size={17} />
            <span>{toast.text}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
