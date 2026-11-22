import { copyFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DownloadError, UnsupportedError } from './errors'
import { ensureDir, concatFiles, sizeOf, pathExists } from './fs-utils'
import { fetchTextDocument, downloadFragments, type FragmentJob } from './fragments'
import { parseDashManifest, type DashTrack } from './dash'
import { mux, remux } from './ffmpeg'
import type { StreamDownloadContext } from './stream'

interface TrackJobs {
  track: DashTrack
  jobs: FragmentJob[]
  files: string[]
}

export async function downloadDash(context: StreamDownloadContext): Promise<void> {
  const { task, signal, ffmpegPath, remuxStreams } = context
  await ensureDir(task.directory)
  if (!task.stream) {
    task.stream = { kind: 'dash', fragmentsTotal: 0, fragmentsDone: 0, completedFragments: [] }
  }
  const manifest = await fetchTextDocument(task.finalUrl ?? task.url, task, signal)
  const plan = parseDashManifest(manifest.text, manifest.url)
  task.finalUrl = manifest.url
  if (plan.drmProtected) {
    throw new UnsupportedError('该 DASH 内容受 DRM 保护，暂不支持下载')
  }
  if (!plan.video && !plan.audio) throw new UnsupportedError('DASH 清单没有可下载的轨道')
  if (plan.video && plan.audio && !ffmpegPath) {
    throw new UnsupportedError('DASH 音视频分离，需要 FFmpeg 合并；请安装 FFmpeg 或设置 MDM_FFMPEG 环境变量')
  }

  const tracks: TrackJobs[] = []
  let globalIndex = 0
  const addTrack = (track: DashTrack): void => {
    const entry: TrackJobs = { track, jobs: [], files: [] }
    if (track.initUrl) {
      entry.jobs.push({ index: globalIndex, url: track.initUrl })
      entry.files.push(join(task.fragmentDir!, `${String(globalIndex).padStart(5, '0')}.frag`))
      globalIndex += 1
    }
    for (const fragment of track.fragments) {
      entry.jobs.push({
        index: globalIndex,
        url: fragment.url,
        range: fragment.range
      })
      entry.files.push(join(task.fragmentDir!, `${String(globalIndex).padStart(5, '0')}.frag`))
      globalIndex += 1
    }
    tracks.push(entry)
  }
  task.fragmentDir = task.fragmentDir ?? join(task.directory, `.mdm-fragments-${task.id}`)
  await ensureDir(task.fragmentDir)
  if (plan.video) addTrack(plan.video)
  if (plan.audio) addTrack(plan.audio)

  const allJobs = tracks.flatMap((entry) => entry.jobs)
  task.stream.fragmentsTotal = allJobs.length
  task.stream.kind = 'dash'
  await downloadFragments(context, allJobs, task.fragmentDir)

  for (const entry of tracks) {
    const missing: string[] = []
    for (const file of entry.files) if (!(await pathExists(file))) missing.push(file)
    if (missing.length > 0) throw new DownloadError(`DASH 分片缺失：${missing.slice(0, 3).join(', ')}`)
  }

  const rawPaths = new Map<string, string>()
  for (const entry of tracks) {
    const raw = join(task.fragmentDir, `${entry.track.type}.mp4`)
    await concatFiles(entry.files, raw)
    rawPaths.set(entry.track.type, raw)
  }
  const videoRaw = rawPaths.get('video')
  const audioRaw = rawPaths.get('audio')
  if (videoRaw && audioRaw) {
    if (!ffmpegPath) throw new UnsupportedError('DASH 音视频合并需要 FFmpeg')
    await mux(videoRaw, audioRaw, task.tempPath, ffmpegPath)
    task.stream.remuxed = true
    task.stream.outputKind = 'mp4'
  } else if (videoRaw) {
    if (ffmpegPath && remuxStreams) {
      await remux(videoRaw, task.tempPath, ffmpegPath)
      task.stream.remuxed = true
    } else {
      await copyFile(videoRaw, task.tempPath)
      task.stream.remuxed = false
    }
    task.stream.outputKind = 'mp4'
  } else if (audioRaw) {
    await copyFile(audioRaw, task.tempPath)
    task.stream.remuxed = false
    task.stream.outputKind = 'm4a'
  }
  task.totalBytes = await sizeOf(task.tempPath)
  task.downloadedBytes = task.totalBytes
  task.stream.fragmentsDone = allJobs.length
  task.stream.fragmentsTotal = allJobs.length
}
