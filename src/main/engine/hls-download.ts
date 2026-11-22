import { copyFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DownloadError, UnsupportedError } from './errors'
import { ensureDir, concatFiles, sizeOf, pathExists } from './fs-utils'
import {
  fetchTextDocument,
  fetchBytes,
  downloadFragments,
  type FragmentJob
} from './fragments'
import {
  isMasterPlaylist,
  parseMasterPlaylist,
  parseMediaPlaylist,
  absoluteIv
} from './hls'
import { remux } from './ffmpeg'
import type { StreamDownloadContext } from './stream'

async function resolvePlaylist(
  context: StreamDownloadContext
): Promise<{ text: string; url: string }> {
  const first = await fetchTextDocument(
    context.task.finalUrl ?? context.task.url,
    context.task,
    context.signal
  )
  if (!isMasterPlaylist(first.text)) return first
  const variants = parseMasterPlaylist(first.text, first.url)
  const chosen = variants[0]
  if (!chosen) throw new UnsupportedError('HLS 主播放列表中没有可用的清晰度')
  context.task.stream!.variant = chosen.url
  return fetchTextDocument(chosen.url, context.task, context.signal)
}

export async function downloadHls(context: StreamDownloadContext): Promise<void> {
  const { task, signal, ffmpegPath, remuxStreams } = context
  await ensureDir(task.directory)
  if (!task.stream) {
    task.stream = {
      kind: 'hls',
      fragmentsTotal: 0,
      fragmentsDone: 0,
      completedFragments: []
    }
  }
  const playlist = await resolvePlaylist(context)
  const parsed = parseMediaPlaylist(playlist.text, playlist.url)
  task.finalUrl = playlist.url
  task.live = !parsed.endList
  if (!parsed.endList) {
    throw new UnsupportedError('直播 HLS（未出现 ENDLIST）暂不支持，请等待直播结束或使用录播源')
  }
  if (parsed.fragments.length === 0) throw new UnsupportedError('HLS 播放列表中没有分片')

  const keyCache = new Map<string, Promise<Buffer>>()
  const loadKey = (uri: string): Promise<Buffer> => {
    const cached = keyCache.get(uri)
    if (cached) return cached
    const pending = fetchBytes(uri, task, signal)
    keyCache.set(uri, pending)
    return pending
  }

  const jobs: FragmentJob[] = []
  let encryption: string | undefined
  for (const fragment of parsed.fragments) {
    const job: FragmentJob = {
      index: jobs.length,
      url: fragment.url,
      range: fragment.byteRange
        ? `bytes=${fragment.byteRange.offset}-${fragment.byteRange.offset + fragment.byteRange.length - 1}`
        : undefined
    }
    if (fragment.key?.method === 'AES-128' && fragment.key.uri) {
      job.key = await loadKey(fragment.key.uri)
      const ivHex = absoluteIv(fragment.key.iv, fragment.sequence)
      if (!ivHex) throw new UnsupportedError('HLS AES-128 分片缺少 IV')
      job.iv = Buffer.from(ivHex, 'hex')
      encryption = 'AES-128'
    }
    jobs.push(job)
  }
  task.stream.encryption = encryption
  task.stream.kind = 'hls'
  task.stream.fragmentsTotal = jobs.length
  task.stream.variant = task.stream.variant ?? task.finalUrl

  const fragmentDir = task.fragmentDir ?? join(task.directory, `.mdm-fragments-${task.id}`)
  task.fragmentDir = fragmentDir
  await ensureDir(fragmentDir)
  await downloadFragments(context, jobs, fragmentDir)

  const ordered = jobs.map((job) =>
    join(fragmentDir, `${String(job.index).padStart(5, '0')}.frag`)
  )
  const missing: string[] = []
  for (const file of ordered) if (!(await pathExists(file))) missing.push(file)
  if (missing.length > 0) {
    throw new DownloadError(`分片文件缺失：${missing.slice(0, 3).join(', ')}`)
  }

  const rawExt = parsed.isFragmentedMp4 ? 'mp4' : 'ts'
  const rawPath = join(fragmentDir, `merged.${rawExt}`)
  await concatFiles(ordered, rawPath)
  task.totalBytes = await sizeOf(rawPath)

  if (ffmpegPath && remuxStreams) {
    await remux(rawPath, task.tempPath, ffmpegPath)
    task.stream.remuxed = true
    task.stream.outputKind = 'mp4'
  } else {
    await copyFile(rawPath, task.tempPath)
    task.stream.remuxed = false
    task.stream.outputKind = parsed.isFragmentedMp4 ? 'mp4' : 'ts'
  }
  task.downloadedBytes = task.totalBytes
  task.stream.fragmentsDone = jobs.length
  task.stream.fragmentsTotal = jobs.length
}
