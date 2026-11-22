import { constants } from 'node:fs'
import { access, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, extname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { sanitizeFileName } from '@shared/format'

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

export async function sizeOf(path: string): Promise<number> {
  try {
    return (await stat(path)).size
  } catch {
    return 0
  }
}

export async function removePath(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
}

export function splitName(fileName: string): { stem: string; ext: string } {
  const ext = extname(fileName)
  return { stem: ext ? fileName.slice(0, -ext.length) : fileName, ext }
}

export async function uniquePath(directory: string, fileName: string): Promise<string> {
  const safe = sanitizeFileName(fileName)
  const { stem, ext } = splitName(safe)
  let candidate = join(directory, safe)
  for (let index = 1; index < 10_000; index++) {
    if (!(await pathExists(candidate))) return candidate
    candidate = join(directory, `${stem} (${index})${ext}`)
  }
  return join(directory, `${stem}-${randomBytes(3).toString('hex')}${ext}`)
}

export async function replaceExtension(directory: string, fileName: string, newExt: string): Promise<string> {
  const { stem } = splitName(fileName)
  return uniquePath(directory, `${stem}${newExt.startsWith('.') ? newExt : `.${newExt}`}`)
}

export async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await ensureDir(dirname(path))
  const temp = `${path}.${process.pid}.tmp`
  await writeFile(temp, JSON.stringify(value, null, 2), 'utf8')
  await rename(temp, path)
}

export async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch {
    return fallback
  }
}

export async function allocateFile(path: string, size: number): Promise<void> {
  const handle = await open(path, 'w')
  try {
    if (size > 0) await handle.truncate(size)
  } finally {
    await handle.close()
  }
}

export async function concatFiles(files: string[], destination: string): Promise<void> {
  await ensureDir(dirname(destination))
  const output = await open(destination, 'w')
  try {
    for (const file of files) {
      const input = await open(file, 'r')
      try {
        const buffer = Buffer.allocUnsafe(1024 * 1024)
        let position = 0
        for (;;) {
          const { bytesRead } = await input.read(buffer, 0, buffer.length, position)
          if (bytesRead === 0) break
          await output.write(buffer, 0, bytesRead)
          position += bytesRead
        }
      } finally {
        await input.close()
      }
    }
  } finally {
    await output.close()
  }
}
