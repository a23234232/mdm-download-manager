import type { PublicTask } from '@shared/types'
import { Icon } from './Icons'
import { STATUS_META, formatClock, formatEta, formatSize, formatSpeed, hostLabel, protocolLabel, taskPercent, taskProgress } from '../lib'

const SOURCE_LABEL: Record<string, string> = {
  app: '应用内添加',
  extension: 'Chrome 扩展',
  'context-menu': '右键菜单',
  takeover: '浏览器接管'
}

function SegmentMap({ task }: { task: PublicTask }): React.ReactNode {
  if (task.protocol === 'http' && task.segments.length > 0) {
    return (
      <div className={`detail-segments ${task.segments.length > 32 ? 'dense' : ''}`}>
        {task.segments.map((segment) => {
          const length = Math.max(1, segment.end - segment.start + 1)
          const fraction = Math.max(0, Math.min(1, segment.downloaded / length))
          return (
            <div key={segment.index} className={`detail-segment ${segment.status}`} title={`分片 ${segment.index + 1} · ${Math.round(fraction * 100)}%`}>
              <span style={{ height: `${Math.max(3, fraction * 100)}%` }} />
              <em>{segment.index + 1}</em>
            </div>
          )
        })}
      </div>
    )
  }
  if (task.stream && task.stream.fragmentsTotal > 0) {
    const total = 64
    const done = Math.round((task.stream.fragmentsDone / task.stream.fragmentsTotal) * total)
    return (
      <div className="detail-segments dense">
        {Array.from({ length: total }, (_value, index) => (
          <div key={index} className={`detail-segment ${index < done ? 'done' : 'pending'}`} title={`片段 ${index + 1}`}>
            <span style={{ height: index < done ? '100%' : '3%' }} />
            <em>{index + 1}</em>
          </div>
        ))}
      </div>
    )
  }
  return (
    <div className="detail-single-progress">
      <div className="progress-track tall">
        <span className={`progress-fill ${task.status}`} style={{ width: `${Math.max(taskProgress(task) * 100, 0.8)}%` }} />
      </div>
      <span>{taskPercent(task).toFixed(1)}%</span>
    </div>
  )
}

function InfoRow({ label, value, mono, action }: { label: string; value: React.ReactNode; mono?: boolean; action?: React.ReactNode }): React.ReactNode {
  return (
    <div className="info-row">
      <dt>{label}</dt>
      <dd className={mono ? 'mono' : ''}>
        <span>{value}</span>
        {action}
      </dd>
    </div>
  )
}

export function TaskDetail({
  task,
  onClose,
  onAction
}: {
  task: PublicTask
  onClose: () => void
  onAction: (action: string) => void
}): React.ReactNode {
  const meta = STATUS_META[task.status]
  const percent = taskPercent(task)
  const active = task.status === 'downloading' || task.status === 'connecting' || task.status === 'queued'
  const primary =
    active
      ? { action: 'pause', label: '暂停下载', icon: 'pause' as const, className: 'ghost' }
      : task.status === 'paused'
        ? { action: 'resume', label: '继续下载', icon: 'play' as const, className: 'primary' }
        : task.status === 'completed'
          ? { action: 'open-file', label: '打开文件', icon: 'external' as const, className: 'primary' }
          : { action: 'retry', label: '重新下载', icon: 'refresh' as const, className: 'primary' }

  return (
    <div className="detail-overlay" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <aside className="detail-sheet" role="dialog" aria-modal="true" aria-label="任务详情">
        <header className="detail-head">
          <div className="eyebrow">
            <span className="eyebrow-line" />
            TRANSFER DETAIL
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭">
            <Icon name="close" size={18} />
          </button>
        </header>

        <div className="detail-scroll">
          <div className="detail-title">
            <div className={`detail-icon status-${meta.tone}`}>
              <Icon name={task.protocol === 'hls' || task.protocol === 'dash' ? 'film' : task.status === 'completed' ? 'checkCircle' : 'download'} size={24} />
            </div>
            <h2 title={task.fileName}>{task.fileName}</h2>
            <div className="detail-badges">
              <span className={`status-pill ${meta.tone}`}>
                {task.status === 'downloading' ? <span className="pill-pulse" /> : null}
                {task.fileMissing ? '文件缺失' : meta.label}
              </span>
              <span className={`protocol-badge p-${task.protocol}`}>{protocolLabel(task.protocol)}</span>
              {task.rangeSupported ? <span className="soft-badge">RANGE</span> : null}
              {task.stream?.remuxed ? <span className="soft-badge">REMUX</span> : null}
              {task.live ? <span className="soft-badge live">LIVE</span> : null}
            </div>
          </div>

          {task.fileMissing ? (
            <div className="detail-warning">
              <Icon name="alert" size={16} />
              保存的文件已被移动或删除，仅保留任务记录。
            </div>
          ) : null}

          {task.error && (task.status === 'error' || task.status === 'cancelled') ? (
            <div className="detail-error">
              <div className="detail-error-head">
                <Icon name="alert" size={16} />
                下载失败
              </div>
              <p>{task.error}</p>
              <button type="button" className="inline-link" onClick={() => onAction('retry')}>
                <Icon name="refresh" size={13} />
                重新尝试
              </button>
            </div>
          ) : null}

          <section className="detail-progress-card">
            <div className="detail-progress-top">
              <div>
                <span className="detail-label">{task.status === 'completed' ? '已完成' : '传输进度'}</span>
                <strong>{percent.toFixed(percent >= 10 ? 0 : 1)}<small>%</small></strong>
              </div>
              <div className="detail-speed-block">
                {task.status === 'downloading' ? (
                  <>
                    <strong>{formatSpeed(task.speed)}</strong>
                    <span>剩余 {formatEta(task.etaSeconds)}</span>
                  </>
                ) : task.status === 'completed' ? (
                  <>
                    <strong>{formatSize(task.totalBytes)}</strong>
                    <span>{formatClock(task.completedAt)}</span>
                  </>
                ) : (
                  <>
                    <strong>{formatSize(task.downloadedBytes)}</strong>
                    <span>已传输</span>
                  </>
                )}
              </div>
            </div>
            <div className="progress-track large">
              <span className={`progress-fill ${task.status}`} style={{ width: `${Math.max(taskProgress(task) * 100, task.status === 'completed' ? 100 : 0.8)}%` }} />
            </div>
            <div className="detail-progress-foot">
              <span>{formatSize(task.downloadedBytes)} / {task.totalBytes > 0 ? formatSize(task.totalBytes) : '未知大小'}</span>
              <span>{task.activeConnections > 0 ? `${task.activeConnections} 个活动连接` : `${task.connections} 个规划连接`}</span>
            </div>
          </section>

          <section className="detail-section">
            <div className="detail-section-head">
              <h3>{task.stream ? '分片时间线' : '分片分布'}</h3>
              <span>
                {task.stream
                  ? `${task.stream.fragmentsDone} / ${task.stream.fragmentsTotal} 片段`
                  : `${task.segments.filter((segment) => segment.status === 'done').length} / ${task.segments.length} 完成`}
              </span>
            </div>
            <SegmentMap task={task} />
            {task.stream ? (
              <div className="stream-meta">
                <span>清单：{task.stream.kind.toUpperCase()}</span>
                {task.stream.variant ? <span title={task.stream.variant}>码率：{task.stream.variant}</span> : null}
                {task.stream.encryption ? <span>加密：{task.stream.encryption}</span> : null}
                {task.stream.outputKind ? <span>输出：{task.stream.outputKind.toUpperCase()}</span> : null}
              </div>
            ) : null}
          </section>

          <section className="detail-section">
            <div className="detail-section-head">
              <h3>任务信息</h3>
            </div>
            <dl className="info-grid">
              <InfoRow label="来源" value={SOURCE_LABEL[task.source] ?? task.source} />
              <InfoRow label="服务器" value={hostLabel(task.finalUrl ?? task.url)} mono />
              <InfoRow label="文件大小" value={task.totalBytes > 0 ? formatSize(task.totalBytes) : '未知'} />
              <InfoRow label="已下载" value={formatSize(task.downloadedBytes)} />
              <InfoRow label="创建时间" value={formatClock(task.createdAt)} />
              <InfoRow label="完成时间" value={formatClock(task.completedAt)} />
              <InfoRow
                label="保存位置"
                value={<span className="path-text" title={task.savePath || task.directory}>{task.savePath || task.directory}</span>}
                action={
                  task.status === 'completed' ? (
                    <button type="button" className="mini-action" onClick={() => onAction('open-folder')} title="打开所在文件夹">
                      <Icon name="folder" size={13} />
                    </button>
                  ) : undefined
                }
              />
              <InfoRow
                label="校验"
                value={
                  task.checksum
                    ? `SHA-256 · ${task.checksum.verified ? '已通过' : task.checksum.verified === false ? '未通过' : '待校验'}`
                    : '未启用'
                }
              />
            </dl>
          </section>

          <section className="detail-section">
            <div className="detail-section-head">
              <h3>链接</h3>
              <button type="button" className="inline-link" onClick={() => onAction('copy-link')}>
                <Icon name="copy" size={13} />
                复制
              </button>
            </div>
            <code className="detail-url" title={task.finalUrl ?? task.url}>{task.finalUrl ?? task.url}</code>
            <div className="request-flags">
              <span className={task.hasCustomHeaders ? 'on' : ''}>
                <Icon name="terminal" size={12} />
                自定义请求头
              </span>
              <span className={task.hasCookies ? 'on' : ''}>
                <Icon name="lock" size={12} />
                Cookie
              </span>
              <span className={task.resumable ? 'on' : ''}>
                <Icon name="refresh" size={12} />
                {task.resumable ? '支持续传' : '不支持续传'}
              </span>
            </div>
          </section>
        </div>

        <footer className="detail-actions">
          <button type="button" className={`btn ${primary.className}`} onClick={() => onAction(primary.action)}>
            <Icon name={primary.icon} size={17} />
            {primary.label}
          </button>
          {task.status === 'completed' ? (
            <button type="button" className="btn ghost" onClick={() => onAction('open-folder')}>
              <Icon name="folder" size={16} />
              文件夹
            </button>
          ) : null}
          {active || task.status === 'paused' ? (
            <button type="button" className="btn ghost danger-text" onClick={() => onAction('cancel')}>
              <Icon name="close" size={16} />
              取消任务
            </button>
          ) : null}
          <span className="detail-actions-spacer" />
          <button type="button" className="icon-btn danger" title="移除任务记录" onClick={() => onAction('remove')}>
            <Icon name="trash" size={16} />
          </button>
        </footer>
      </aside>
    </div>
  )
}
