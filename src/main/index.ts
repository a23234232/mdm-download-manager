import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, Notification, shell } from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { AddDownloadInput, AppSnapshot, SettingsPatch } from '@shared/types'
import { IP_CHANNELS, SNAPSHOT_INTERVAL_MS } from '@shared/constants'
import { DownloadManager } from './download-manager'
import { ApiServer } from './api/server'
import { errorMessage, friendlyError } from './engine/errors'

const __dirname = dirname(fileURLToPath(import.meta.url))

let mainWindow: BrowserWindow | null = null
let manager: DownloadManager | null = null
let api: ApiServer | null = null
let broadcastTimer: NodeJS.Timeout | null = null
let quitting = false
let diskFreeCache: { at: number; value: number | null } = { at: 0, value: null }

function extensionDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'chrome-extension')
    : join(app.getAppPath(), 'extension')
}

async function diskFree(): Promise<number | null> {
  if (Date.now() - diskFreeCache.at < 5000) return diskFreeCache.value
  if (!manager) return null
  const value = await manager.diskFree()
  diskFreeCache = { at: Date.now(), value }
  return value
}

async function snapshot(): Promise<AppSnapshot> {
  if (!manager || !api) throw new Error('MDM is not ready')
  return {
    version: app.getVersion(),
    platform: process.platform,
    tasks: manager.listTasks(),
    settings: manager.settings,
    api: api.status,
    stats: manager.getStats(await diskFree())
  }
}

function scheduleBroadcast(): void {
  if (broadcastTimer) return
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null
    void broadcast()
  }, Math.min(300, SNAPSHOT_INTERVAL_MS))
  broadcastTimer.unref?.()
}

async function broadcast(): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed()) return
  try {
    mainWindow.webContents.send(IP_CHANNELS.EVENT_SNAPSHOT, await snapshot())
  } catch (error) {
    console.error('MDM snapshot failed', errorMessage(error))
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 800,
    minWidth: 980,
    minHeight: 620,
    show: false,
    frame: false,
    backgroundColor: '#090b10',
    title: 'MDM Download Manager',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  })

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const devUrl = process.env.ELECTRON_RENDERER_URL
    if (devUrl && url.startsWith(devUrl)) return
    if (url.startsWith('file://')) return
    event.preventDefault()
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
  })
  mainWindow.webContents.on('before-input-event', (_event, input) => {
    if (input.type !== 'keyDown') return
    if (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i')) {
      mainWindow?.webContents.toggleDevTools()
    }
  })
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) void mainWindow.loadURL(devUrl)
  else void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
}

function registerIpc(): void {
  if (!manager || !api) return
  const mgr = manager
  const server = api

  ipcMain.handle('app:snapshot', () => snapshot())
  ipcMain.handle('app:window', (_event, action: 'minimize' | 'maximize' | 'close') => {
    if (!mainWindow) return
    if (action === 'minimize') mainWindow.minimize()
    if (action === 'maximize') {
      if (mainWindow.isMaximized()) mainWindow.unmaximize()
      else mainWindow.maximize()
    }
    if (action === 'close') mainWindow.close()
  })
  ipcMain.handle('app:clipboard', (_event, text: string) => {
    if (typeof text === 'string') clipboard.writeText(text)
  })
  ipcMain.handle('app:open-path', async (_event, path: string) => {
    if (typeof path !== 'string' || !path) return '路径无效'
    return shell.openPath(path)
  })
  ipcMain.handle('app:show-item', (_event, path: string) => {
    if (typeof path === 'string' && path) shell.showItemInFolder(path)
  })
  ipcMain.handle('app:open-external', async (_event, url: string) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) await shell.openExternal(url)
  })

  ipcMain.handle('downloads:add', async (_event, input: AddDownloadInput) => {
    const id = await mgr.add(input)
    return { taskId: id }
  })
  ipcMain.handle('downloads:pause', (_event, id: string) => mgr.pause(id))
  ipcMain.handle('downloads:resume', (_event, id: string) => mgr.resume(id))
  ipcMain.handle('downloads:cancel', (_event, id: string) => mgr.cancel(id))
  ipcMain.handle('downloads:retry', (_event, id: string) => mgr.retry(id))
  ipcMain.handle('downloads:remove', (_event, id: string) => mgr.remove(id))
  ipcMain.handle('downloads:clear-completed', () => mgr.clearCompleted())
  ipcMain.handle('downloads:open-file', async (_event, id: string) => {
    const task = mgr.getTask(id)
    if (!task) throw new Error('任务不存在')
    if (task.fileMissing) throw new Error('文件已被移动或删除')
    const result = await shell.openPath(task.savePath)
    if (result) throw new Error(friendlyError(new Error(result)))
  })
  ipcMain.handle('downloads:open-folder', async (_event, id: string) => {
    const task = mgr.getTask(id)
    if (!task) throw new Error('任务不存在')
    shell.showItemInFolder(task.savePath)
  })
  ipcMain.handle('downloads:copy-link', (_event, id: string) => {
    const task = mgr.getTask(id)
    if (!task) throw new Error('任务不存在')
    clipboard.writeText(task.finalUrl ?? task.url)
  })
  ipcMain.handle('downloads:reveal-in-explorer', (_event, id: string) => {
    const task = mgr.getTask(id)
    if (!task) throw new Error('任务不存在')
    shell.showItemInFolder(task.savePath)
  })
  ipcMain.handle('settings:update', async (_event, patch: SettingsPatch) => {
    const previous = mgr.settings
    const updated = await mgr.updateSettings(patch ?? {})
    const shouldRestartApi =
      patch.port !== undefined && (updated.port !== server.status.port || !server.status.running)
    if (shouldRestartApi) {
      try {
        await server.setPort(updated.port)
      } catch (error) {
        await mgr.updateSettings({ port: previous.port })
        throw new Error(friendlyError(error))
      }
    }
    nativeTheme.themeSource = updated.theme
    if (process.platform === 'win32' || process.platform === 'darwin') {
      app.setLoginItemSettings({ openAtLogin: updated.autoStart })
    }
    diskFreeCache = { at: 0, value: null }
    scheduleBroadcast()
    return updated
  })
  ipcMain.handle('settings:choose-directory', async (_event, initial?: string) => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择下载目录',
      defaultPath: initial || mgr.settings.downloadDirectory,
      properties: ['openDirectory', 'createDirectory']
    })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })
  ipcMain.handle('api:rotate-token', async () => {
    const status = await server.rotateToken()
    scheduleBroadcast()
    return status
  })
  ipcMain.handle('shell:open-extension-dir', async () => {
    const dir = extensionDir()
    const error = await shell.openPath(dir)
    if (error) throw new Error(`无法打开扩展目录：${error}`)
  })
  ipcMain.handle('shell:open-data-dir', async () => {
    const error = await shell.openPath(app.getPath('userData'))
    if (error) throw new Error(`无法打开数据目录：${error}`)
  })
}

async function bootstrap(): Promise<void> {
  app.setName('MDM')
  if (process.platform === 'win32') app.setAppUserModelId('com.mdm.downloadmanager')
  Menu.setApplicationMenu(null)
  nativeTheme.themeSource = 'dark'

  const dataDir = app.getPath('userData')
  manager = new DownloadManager({ dataDir, downloadDirectory: app.getPath('downloads') })
  await manager.init()
  manager.on('change', scheduleBroadcast)
  manager.on('completed', (task) => {
    scheduleBroadcast()
    if (!manager?.settings.notifications) return
    const notification = new Notification({
      title: '下载完成',
      body: task.fileName,
      silent: false
    })
    notification.on('click', () => {
      if (task.savePath) shell.showItemInFolder(task.savePath)
    })
    notification.show()
  })
  manager.on('failed', (task) => {
    scheduleBroadcast()
    if (!manager?.settings.notifications || task.status !== 'error') return
    new Notification({
      title: '下载失败',
      body: `${task.fileName}\n${task.error ?? '未知错误'}`,
      silent: true
    }).show()
  })

  api = new ApiServer({
    manager,
    dataDir,
    port: manager.settings.port,
    version: app.getVersion(),
    onChange: scheduleBroadcast
  })
  try {
    await api.start()
  } catch (error) {
    console.error('MDM API failed to start:', errorMessage(error))
  }

  registerIpc()
  createWindow()
  nativeTheme.themeSource = manager.settings.theme
  if (process.platform === 'win32') {
    app.setLoginItemSettings({ openAtLogin: manager.settings.autoStart })
  }
  diskFreeCache = { at: 0, value: null }
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })

  app.whenReady().then(bootstrap).catch((error) => {
    console.error('MDM bootstrap failed', error)
    dialog.showErrorBox('MDM 启动失败', friendlyError(error))
    app.quit()
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', (event) => {
    if (quitting) return
    event.preventDefault()
    quitting = true
    void (async () => {
      try {
        await manager?.dispose()
        await api?.stop()
      } finally {
        app.quit()
      }
    })()
  })
}

