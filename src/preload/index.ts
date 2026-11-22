import { contextBridge, ipcRenderer } from 'electron'
import type { AppSnapshot, IpcChannel, MdmApi } from '@shared/types'
import { IP_CHANNELS } from '@shared/constants'

const ALLOWED = new Set<IpcChannel>([
  'app:snapshot',
  'app:window',
  'app:clipboard',
  'app:open-path',
  'app:show-item',
  'app:open-external',
  'downloads:add',
  'downloads:pause',
  'downloads:resume',
  'downloads:cancel',
  'downloads:retry',
  'downloads:remove',
  'downloads:clear-completed',
  'downloads:open-file',
  'downloads:open-folder',
  'downloads:copy-link',
  'downloads:reveal-in-explorer',
  'settings:update',
  'settings:choose-directory',
  'api:rotate-token',
  'shell:open-extension-dir',
  'shell:open-data-dir'
])

const api: MdmApi = {
  snapshot: () => ipcRenderer.invoke('app:snapshot') as Promise<AppSnapshot>,
  onSnapshot: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: AppSnapshot): void => listener(snapshot)
    ipcRenderer.on(IP_CHANNELS.EVENT_SNAPSHOT, handler)
    return () => ipcRenderer.removeListener(IP_CHANNELS.EVENT_SNAPSHOT, handler)
  },
  onNavigate: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, view: string): void => listener(view)
    ipcRenderer.on(IP_CHANNELS.NAVIGATE, handler)
    return () => ipcRenderer.removeListener(IP_CHANNELS.NAVIGATE, handler)
  },
  invoke: (channel, ...args) => {
    if (!ALLOWED.has(channel)) return Promise.reject(new Error(`IPC channel not allowed: ${channel}`))
    return ipcRenderer.invoke(channel, ...args)
  }
}

contextBridge.exposeInMainWorld('mdm', api)
