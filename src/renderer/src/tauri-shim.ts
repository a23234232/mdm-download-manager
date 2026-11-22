import { invoke as tauriInvoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type { AppSnapshot, IpcChannel, IpcInvokeMap } from '@shared/types'

type Unlisten = () => void

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

function install(): void {
  if (!isTauri || window.mdm) return

  window.mdm = {
    snapshot: () => tauriInvoke<AppSnapshot>('mdm_snapshot'),
    onSnapshot(listener) {
      let unlisten: Unlisten | null = null
      let disposed = false
      void listen<AppSnapshot>('state:update', (event) => listener(event.payload)).then((fn) => {
        if (disposed) fn()
        else unlisten = fn
      })
      return () => {
        disposed = true
        unlisten?.()
      }
    },
    onNavigate(listener) {
      let unlisten: Unlisten | null = null
      let disposed = false
      void listen<string>('app:navigate', (event) => listener(event.payload)).then((fn) => {
        if (disposed) fn()
        else unlisten = fn
      })
      return () => {
        disposed = true
        unlisten?.()
      }
    },
    invoke<K extends IpcChannel>(channel: K, ...args: IpcInvokeMap[K]['args']): Promise<IpcInvokeMap[K]['result']> {
      return tauriInvoke<IpcInvokeMap[K]['result']>('mdm_invoke', {
        channel,
        payload: args.length ? args[0] : null
      })
    }
  }
}

install()
