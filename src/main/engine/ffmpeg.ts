import { execFile, spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { FFMPEG_TIMEOUT_MS } from '@shared/constants'
import { DownloadError, errorMessage } from './errors'

let cachedPath: string | null | undefined

function candidatePaths(): string[] {
  const names = process.platform === 'win32' ? ['ffmpeg.exe', 'ffmpeg'] : ['ffmpeg']
  const paths: string[] = []
  if (process.env.MDM_FFMPEG) paths.push(process.env.MDM_FFMPEG)
  for (const dir of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    for (const name of names) paths.push(join(dir, name))
  }
  return paths
}

export async function findFfmpeg(): Promise<string | null> {
  if (cachedPath !== undefined) return cachedPath
  for (const candidate of candidatePaths()) {
    try {
      await access(candidate)
      cachedPath = candidate
      return candidate
    } catch {
      // keep looking
    }
  }
  cachedPath = null
  return null
}

export function resetFfmpegCache(): void {
  cachedPath = undefined
}

export async function remux(input: string, output: string, ffmpegPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      ffmpegPath,
      ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-c', 'copy', '-movflags', '+faststart', output],
      { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] }
    )
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new DownloadError('FFmpeg 转封装超时', { retryable: false }))
    }, FFMPEG_TIMEOUT_MS)
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-4000)
    })
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(new DownloadError(`无法启动 FFmpeg：${errorMessage(error)}`))
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new DownloadError(`FFmpeg 转封装失败：${stderr.trim() || `退出码 ${code}`}`))
    })
  })
}

export async function mux(video: string, audio: string, output: string, ffmpegPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const args = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      video,
      '-i',
      audio,
      '-map',
      '0:v:0?',
      '-map',
      '1:a:0?',
      '-c',
      'copy',
      '-movflags',
      '+faststart',
      output
    ]
    execFile(ffmpegPath, args, { timeout: FFMPEG_TIMEOUT_MS, windowsHide: true }, (error, _stdout, stderr) => {
      if (!error) return resolve()
      reject(new DownloadError(`FFmpeg 合并音视频失败：${String(stderr || errorMessage(error)).trim().slice(-1000)}`))
    })
  })
}
