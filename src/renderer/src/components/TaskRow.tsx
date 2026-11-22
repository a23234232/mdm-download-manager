import type { PublicTask } from '@shared/types'
import { CATEGORY_META } from '@shared/constants'
import { CategoryIcon, Icon, type IconName } from './Icons'
import { STATUS_META, formatEta, formatSize, formatSpeed, hostLabel, protocolLabel, taskPercent, taskProgress, taskSizeLabel } from '../lib'

const CATEGORY_COLOR: Record<string, string> = {
  video: CATEGORY_META.video.color,
  audio: CATEGORY_META.audio.color,
  document: CATEGORY_META.document.color,
  archive: CATEGORY_META.archive.color,
  program: CATEGORY_META.program.color,
  image: CATEGORY_META.image.color,
  other: CATEGORY_META.other.color
}

function SegmentBar({ task }: { task: PublicTask }): React.ReactNode {
  if (task.protocol === 'http' && task.segments.length > 1) {
    const segments = task.segments
    return (
      <div className="segment-bar" style={{ gridTemplateColumns: `repeat(${segments.length}, 1fr)` }}>
        {segments.map((segment) => {
          const length = Math.max(1, segment.end - segment.start + 1)
          const fraction = Math.max(0, Math.min(1, segment.downloaded / length))
          const color =
            task.status === 'error'
              ? 'rgba(255,107,129,.7)'
              : task.status === 'paused'
                ? 'rgba(255,193,94,.75)'
                : 'var(--accent)'
          return (
            <span
              key={segment.index}
              className="segment-cell"
              title={`分片 ${segment.index + 1} · ${Math.round(fraction * 100)}%`}
              style={{
                background: `linear-gradient(90deg, ${color} ${fraction * 100}%, rgba(255,255,255,.055) ${fraction * 100}%)`
              }}
            />
          )
        })}
      </div>
    )
  }
  if (task.stream && task.stream.fragmentsTotal > 0) {
    const total = 36
    const done = Math.round((task.stream.fragmentsDone / task.stream.fragmentsTotal) * total)
    return (
      <div className="segment-bar stream" style={{ gridTemplateColumns: `repeat(${total}, 1fr)` }}>
        {Array.from({ length: total }, (_value, index) => (
          <span
            key={index}
            className="segment-cell"
            style={{ background: index < done ? 'var(--cyan)' : 'rgba(255,255,255,.055)' }}
          />
        ))}
      </div>
    )
  }
  return (
    <div className="progress-track">
      <span className={`progress-fill ${task.status}`} style={{ width: `${Math.max(taskProgress(task) * 100, task.status === 'completed' ? 100 : 0.8)}%` }} />
    </div>
  )
}

export function TaskRow({
  task,
  onSelect,
  onAction
}: {
  task: PublicTask
  onSelect: () => void
  onAction: (action: string) => void
}): React.ReactNode {
  const meta = STATUS_META[task.status]
  const percent = taskPercent(task)
  const color = CATEGORY_COLOR[task.category] ?? 'var(--accent)'
  const primary: { action: string; icon: IconName; label: string } =
    task.status === 'downloading' || task.status === 'connecting' || task.status === 'queued'
      ? { action: 'pause', icon: 'pause', label: '暂停' }
      : task.status === 'paused'
        ? { action: 'resume', icon: 'play', label: '继续' }
        : task.status === 'error' || task.status === 'cancelled'
          ? { action: 'retry', icon: 'refresh', label: '重试' }
          : { action: 'open-folder', icon: 'folder', label: '打开文件夹' }
  const connectionLabel =
    task.protocol === 'http' && task.segments.length > 1
      ? `${task.segments.length} 分片`
      : task.stream && task.stream.fragmentsTotal > 0
        ? `${task.stream.fragmentsDone}/${task.stream.fragmentsTotal} 片段`
        : task.protocol === 'ftp'
          ? 'FTP 单连接'
          : task.activeConnections > 0
            ? `${task.activeConnections} 连接`
            : protocolLabel(task.protocol)

  return (
    <article
      className={`task-row ${task.status} ${task.fileMissing ? 'missing' : ''}`}
      onClick={onSelect}
      onDoubleClick={() => {
        if (task.status === 'completed' && !task.fileMissing) onAction('open-file')
      }}
    >
      <div className="task-icon" style={{ ['--category-color' as string]: color }}>
        <CategoryIcon category={task.category} size={21} />
      </div>
      <div className="task-body">
        <div className="task-title-line">
          <button type="button" className="task-name" onClick={onSelect} title={task.fileName}>
            {task.fileName}
          </button>
          <span className={`status-pill ${meta.tone}`}>
            {task.status === 'downloading' ? <span className="pill-pulse" /> : null}
            {task.fileMissing ? '文件缺失' : meta.label}
          </span>
          {task.checksum ? (
            <span className={`checksum-badge ${task.checksum.verified ? 'ok' : ''}`} title={task.checksum.verified ? 'SHA-256 校验通过' : 'SHA-256 校验'}>
              <Icon name="shield" size={12} />
            </span>
          ) : null}
        </div>
        <div className="task-meta">
          <span className="task-host">
            <Icon name="globe" size={12} />
            {hostLabel(task.finalUrl ?? task.url)}
          </span>
          <span className="meta-dot" />
          <span className={`protocol-badge p-${task.protocol}`}>{protocolLabel(task.protocol)}</span>
          <span className="meta-dot" />
          <span>{connectionLabel}</span>
          <span className="meta-dot" />
          <span>{formatSize(task.totalBytes || task.downloadedBytes)}</span>
          {task.live ? (
            <>
              <span className="meta-dot" />
              <span className="live-badge">LIVE</span>
            </>
          ) : null}
        </div>
        {task.error && (task.status === 'error' || task.status === 'cancelled') ? (
          <div className="task-error" title={task.error}>
            <Icon name="alert" size={12} />
            {task.error}
          </div>
        ) : null}
        <div className="task-progress-line">
          <SegmentBar task={task} />
          <span className="task-percent">{percent > 0 ? `${percent.toFixed(percent >= 10 ? 0 : 1)}%` : '—'}</span>
        </div>
      </div>
      <div className="task-metrics">
        {task.status === 'downloading' ? (
          <>
            <strong className="metric-speed">{formatSpeed(task.speed)}</strong>
            <span className="metric-sub">剩余 {formatEta(task.etaSeconds)}</span>
          </>
        ) : task.status === 'connecting' ? (
          <>
            <strong className="metric-speed connecting">连接中</strong>
            <span className="metric-sub">正在探测分片能力</span>
          </>
        ) : task.status === 'completed' ? (
          <>
            <strong className="metric-speed completed">{taskSizeLabel(task)}</strong>
            <span className="metric-sub">下载完成</span>
          </>
        ) : task.status === 'paused' ? (
          <>
            <strong className="metric-speed paused">已暂停</strong>
            <span className="metric-sub">{formatSize(task.downloadedBytes)} 已下载</span>
          </>
        ) : (
          <>
            <strong className="metric-speed">{taskSizeLabel(task)}</strong>
            <span className="metric-sub">{formatSize(task.downloadedBytes)} 已传输</span>
          </>
        )}
      </div>
      <div className="task-actions" onClick={(event) => event.stopPropagation()}>
        <button type="button" className={`icon-btn ${primary.action}`} title={primary.label} onClick={() => onAction(primary.action)}>
          <Icon name={primary.icon} size={16} />
        </button>
        {task.status === 'completed' ? (
          <button type="button" className="icon-btn" title="打开文件" onClick={() => onAction('open-file')}>
            <Icon name="external" size={16} />
          </button>
        ) : (
          <button type="button" className="icon-btn" title="复制链接" onClick={() => onAction('copy-link')}>
            <Icon name="copy" size={15} />
          </button>
        )}
        <button type="button" className="icon-btn danger" title="移除任务" onClick={() => onAction('remove')}>
          <Icon name="trash" size={15} />
        </button>
        <button type="button" className="icon-btn chevron" title="任务详情" onClick={onSelect}>
          <Icon name="chevron" size={16} />
        </button>
      </div>
    </article>
  )
}
