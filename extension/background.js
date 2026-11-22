'use strict'

const VERSION = '1.0.0'
const MENU_ID = 'mdm-download-link'
const ALARM_NAME = 'mdm-health'
const ACTIVE_STATUSES = { queued: true, connecting: true, downloading: true }
const DEFAULT_CONFIG = {
  port: 45721,
  token: '',
  intercept: true,
  forwardCookies: true,
  notify: true
}
const bypass = new Map()
let configCache = null
let healthCache = { key: '', at: 0, ok: false, error: '', version: '', stats: null }
let notifySeq = 0

function normalizeConfig(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const port = Number(source.port)
  return {
    port: Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : DEFAULT_CONFIG.port,
    token: typeof source.token === 'string' ? source.token.trim() : '',
    intercept: source.intercept !== false,
    forwardCookies: source.forwardCookies !== false,
    notify: source.notify !== false
  }
}

async function loadConfig() {
  if (configCache) return configCache
  const raw = await chrome.storage.local.get(DEFAULT_CONFIG)
  configCache = normalizeConfig(raw)
  return configCache
}

async function saveConfig(patch) {
  const current = await loadConfig()
  const merged = Object.assign({}, current, patch || {})
  if (patch && patch.port !== undefined) {
    const port = Number(patch.port)
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      throw new Error('端口必须是 1024 - 65535 之间的整数')
    }
  }
  const token = typeof merged.token === 'string' ? merged.token.trim() : ''
  if (token && !/^[a-f0-9]{32,96}$/i.test(token)) {
    throw new Error('API 令牌格式不正确，请从 MDM 设置中完整复制')
  }
  const next = normalizeConfig(Object.assign({}, merged, { token }))
  await chrome.storage.local.set(next)
  configCache = next
  healthCache = { key: '', at: 0, ok: false, error: '', version: '', stats: null }
  return next
}

function cacheKey(config) {
  return config.port + ':' + (config.token ? config.token.slice(0, 12) : 'none')
}

function readCachedHealth(config, maxAge) {
  if (!config.token) return null
  if (healthCache.key !== cacheKey(config)) return null
  if (Date.now() - healthCache.at > maxAge) return null
  return healthCache
}

function describeError(error) {
  if (!error) return '未知错误'
  if (error.name === 'AbortError') return '连接超时，请确认 MDM 正在运行'
  if (error.status === 401) return '令牌无效，请在 MDM 设置中重新复制'
  if (error instanceof TypeError) return '无法连接 MDM，请检查端口与程序状态'
  return error.message || String(error)
}

async function apiRequest(config, path, options) {
  const opts = options || {}
  const controller = new AbortController()
  const timer = setTimeout(function () { controller.abort() }, opts.timeout || 2500)
  const headers = {
    'X-MDM-Token': config.token,
    'X-MDM-Client': 'chrome-extension/' + VERSION
  }
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json'
  try {
    const response = await fetch('http://127.0.0.1:' + config.port + '/api/v1' + path, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      cache: 'no-store',
      signal: controller.signal
    })
    let data = null
    try { data = await response.json() } catch (_error) { data = null }
    if (!response.ok) {
      const error = new Error(data && data.error ? data.error : 'HTTP ' + response.status)
      error.status = response.status
      throw error
    }
    return data
  } finally {
    clearTimeout(timer)
  }
}

async function testHealth(config, force) {
  const key = cacheKey(config)
  if (!config.token) {
    healthCache = {
      key: key,
      at: Date.now(),
      ok: false,
      error: '未配置 API 令牌',
      version: '',
      stats: null
    }
    return healthCache
  }
  if (!force) {
    const cached = readCachedHealth(config, 15000)
    if (cached) return cached
  }
  try {
    const data = await apiRequest(config, '/health', { timeout: 1600 })
    healthCache = {
      key: key,
      at: Date.now(),
      ok: true,
      error: '',
      version: data && data.version ? data.version : '',
      stats: data && data.stats ? data.stats : null
    }
  } catch (error) {
    healthCache = {
      key: key,
      at: Date.now(),
      ok: false,
      error: describeError(error),
      version: '',
      stats: null
    }
  }
  return healthCache
}

function setBadge(text, color, title) {
  chrome.action.setBadgeBackgroundColor({ color: color })
  chrome.action.setBadgeText({ text: text })
  chrome.action.setTitle({ title: title })
}

async function refreshBadge() {
  const config = await loadConfig()
  if (!config.token) {
    setBadge('!', '#ffb020', 'MDM 未配置 API 令牌')
    return
  }
  if (!config.intercept) {
    setBadge('off', '#6b7280', 'MDM 已暂停接管 Chrome 下载')
    return
  }
  const health = await testHealth(config, false)
  if (!health.ok) {
    setBadge('x', '#ff5c72', 'MDM 未连接：' + health.error)
    return
  }
  const stats = health.stats || {}
  const active = (Number(stats.activeCount) || 0) + (Number(stats.queuedCount) || 0)
  if (active > 0) {
    setBadge(active > 99 ? '99+' : String(active), '#7c6cff', 'MDM · ' + active + ' 个任务进行中')
  } else {
    setBadge('', '#7c6cff', 'MDM 已连接')
  }
}

function notify(config, title, message) {
  if (!config.notify) return
  notifySeq += 1
  const id = 'mdm-' + Date.now() + '-' + notifySeq
  chrome.notifications.create(id, {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: title,
    message: message.length > 240 ? message.slice(0, 237) + '...' : message,
    priority: 0
  }, function () { void chrome.runtime.lastError })
  setTimeout(function () { chrome.notifications.clear(id) }, 7000)
}

function baseName(value) {
  if (!value) return ''
  const parts = String(value).split(/[\\/]/)
  return parts[parts.length - 1] || ''
}

function fileNameFromUrl(raw) {
  try {
    const url = new URL(raw)
    const name = baseName(url.pathname)
    return name ? decodeURIComponent(name) : ''
  } catch (_error) {
    return ''
  }
}

function safeFileName(name) {
  return String(name || '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 180)
}

async function cookieHeader(url) {
  if (!/^https?:/i.test(url)) return ''
  try {
    const cookies = await chrome.cookies.getAll({ url: url })
    const ordered = cookies.slice().sort(function (a, b) {
      return (b.path || '').length - (a.path || '').length
    })
    const parts = []
    let size = 0
    for (const cookie of ordered) {
      if (!cookie.name || typeof cookie.value !== 'string') continue
      const part = cookie.name + '=' + cookie.value
      if (size + part.length + 2 > 16384) break
      parts.push(part)
      size += part.length + 2
    }
    return parts.join('; ')
  } catch (_error) {
    return ''
  }
}

function rememberBypass(url) {
  if (!url) return
  bypass.set(url, Date.now() + 30000)
  try {
    chrome.storage.session.set({ mdmBypass: Array.from(bypass.entries()) })
  } catch (_error) { /* session storage may be unavailable */ }
}

function consumeBypass(url) {
  if (!url) return false
  const until = bypass.get(url)
  if (!until) return false
  bypass.delete(url)
  return until > Date.now()
}

async function restoreBypass() {
  try {
    const data = await chrome.storage.session.get('mdmBypass')
    if (!Array.isArray(data.mdmBypass)) return
    for (const entry of data.mdmBypass) {
      if (Array.isArray(entry) && typeof entry[0] === 'string' && entry[1] > Date.now()) {
        bypass.set(entry[0], entry[1])
      }
    }
  } catch (_error) { /* ignore */ }
}

async function pauseDownload(id) {
  try { await chrome.downloads.pause(id); return true } catch (_error) { return false }
}

async function resumeDownload(id) {
  try { await chrome.downloads.resume(id) } catch (_error) { /* ignore */ }
}

async function cancelDownload(id) {
  try { await chrome.downloads.cancel(id); return true } catch (_error) { return false }
}

async function eraseDownload(id) {
  try { await chrome.downloads.erase({ id: id }) } catch (_error) { /* ignore */ }
}

async function downloadState(id) {
  try {
    const items = await chrome.downloads.search({ id: id })
    return items && items.length ? items[0] : null
  } catch (_error) {
    return null
  }
}

async function fallbackDownload(config, url, fileName) {
  rememberBypass(url)
  const name = safeFileName(fileName)
  try {
    await chrome.downloads.download({
      url: url,
      filename: name || undefined,
      conflictAction: 'uniquify',
      saveAs: false
    })
    notify(config, '已交回 Chrome', 'MDM 未能接收，下载已恢复')
  } catch (error) {
    notify(config, '下载未恢复', describeError(error) + '，请手动重新下载')
  }
}

async function postTask(config, payload) {
  return apiRequest(config, '/tasks', {
    method: 'POST',
    timeout: 4500,
    body: payload
  })
}

async function handleCreated(item) {
  if (!item || typeof item.id !== 'number') return
  const config = await loadConfig()
  if (!config.intercept) return
  if (item.byExtensionId === chrome.runtime.id) return
  if (item.state && item.state !== 'in_progress') return
  const url = item.finalUrl || item.url || ''
  if (!/^https?:\/\//i.test(url)) return
  if (url.indexOf('http://127.0.0.1:' + config.port + '/api/v1') === 0) return
  if (consumeBypass(url) || consumeBypass(item.url || '')) return
  if (!config.token) {
    await refreshBadge()
    return
  }

  const cached = readCachedHealth(config, 20000)
  if (cached && !cached.ok) return

  const paused = await pauseDownload(item.id)
  if (paused) {
    const state = await downloadState(item.id)
    if (state && state.state === 'complete') return
  }

  const health = cached || (await testHealth(config, true))
  if (!health.ok) {
    if (paused) await resumeDownload(item.id)
    await refreshBadge()
    return
  }

  const cookies = config.forwardCookies ? await cookieHeader(url) : ''
  if (!(await cancelDownload(item.id))) {
    if (paused) await resumeDownload(item.id)
    return
  }
  const after = await downloadState(item.id)
  if (after && after.state === 'complete') return
  await eraseDownload(item.id)

  const name = baseName(item.filename) || fileNameFromUrl(url)
  try {
    await postTask(config, {
      url: url,
      fileName: name || undefined,
      referrer: item.referrer || undefined,
      cookies: cookies || undefined
    })
    notify(config, 'MDM 已接管下载', name || url)
    await refreshBadge()
  } catch (error) {
    notify(config, 'MDM 接收失败', describeError(error))
    await fallbackDownload(config, url, name)
  }
}

async function handoffUrl(url, referrer) {
  const config = await loadConfig()
  if (!config.token) {
    notify(config, 'MDM 未配置', '请先在扩展设置中填写 API 令牌')
    chrome.runtime.openOptionsPage()
    return
  }
  const health = await testHealth(config, true)
  if (!health.ok) {
    notify(config, 'MDM 未连接', health.error)
    await refreshBadge()
    return
  }
  const cookies = config.forwardCookies ? await cookieHeader(url) : ''
  const name = fileNameFromUrl(url)
  try {
    await postTask(config, {
      url: url,
      fileName: name || undefined,
      referrer: referrer || undefined,
      cookies: cookies || undefined
    })
    notify(config, '已添加到 MDM', name || url)
    await refreshBadge()
  } catch (error) {
    notify(config, '添加失败', describeError(error))
  }
}

function slimTask(task) {
  return {
    id: task.id,
    fileName: task.fileName,
    status: task.status,
    protocol: task.protocol,
    downloadedBytes: task.downloadedBytes,
    totalBytes: task.totalBytes,
    speed: task.speed,
    etaSeconds: task.etaSeconds,
    error: task.error,
    connections: task.connections,
    category: task.category,
    createdAt: task.createdAt
  }
}

async function buildState() {
  const config = await loadConfig()
  const health = await testHealth(config, true)
  let tasks = []
  let stats = health.stats || null
  if (health.ok) {
    try {
      const data = await apiRequest(config, '/tasks', { timeout: 2200 })
      tasks = (data && Array.isArray(data.tasks) ? data.tasks : []).map(slimTask)
      tasks.sort(function (a, b) {
        const left = ACTIVE_STATUSES[a.status] ? 0 : 1
        const right = ACTIVE_STATUSES[b.status] ? 0 : 1
        if (left !== right) return left - right
        return (b.createdAt || 0) - (a.createdAt || 0)
      })
    } catch (error) {
      healthCache = {
        key: cacheKey(config),
        at: Date.now(),
        ok: false,
        error: describeError(error),
        version: '',
        stats: null
      }
    }
  }
  return {
    ok: true,
    version: VERSION,
    config: {
      port: config.port,
      hasToken: Boolean(config.token),
      intercept: config.intercept,
      forwardCookies: config.forwardCookies,
      notify: config.notify
    },
    health: {
      ok: healthCache.ok,
      error: healthCache.error,
      version: healthCache.version
    },
    stats: stats,
    tasks: tasks
  }
}

async function taskAction(id, action) {
  const allowed = { pause: true, resume: true, retry: true, cancel: true }
  if (!id || !allowed[action]) throw new Error('无效的任务操作')
  const config = await loadConfig()
  if (!config.token) throw new Error('未配置 API 令牌')
  const task = await apiRequest(config, '/tasks/' + encodeURIComponent(id) + '/' + action, {
    method: 'POST',
    timeout: 4000
  })
  await refreshBadge()
  return task
}

async function toggleIntercept() {
  const config = await loadConfig()
  const next = await saveConfig({ intercept: !config.intercept })
  await refreshBadge()
  notify(next, next.intercept ? '已恢复接管' : '已暂停接管', next.intercept ? '新的 Chrome 下载将交给 MDM' : '下载将继续由 Chrome 处理')
  return next
}

async function handleMessage(message) {
  if (!message || typeof message.type !== 'string') return { ok: false, error: '无效消息' }
  if (message.type === 'state') return buildState()
  if (message.type === 'getConfig') {
    const config = await loadConfig()
    return { ok: true, config: config }
  }
  if (message.type === 'saveConfig') {
    const config = await saveConfig(message.config || {})
    const health = await testHealth(config, true)
    await refreshBadge()
    return {
      ok: true,
      config: {
        port: config.port,
        hasToken: Boolean(config.token),
        intercept: config.intercept,
        forwardCookies: config.forwardCookies,
        notify: config.notify
      },
      health: { ok: health.ok, error: health.error, version: health.version }
    }
  }
  if (message.type === 'testConfig') {
    const current = await loadConfig()
    const config = normalizeConfig(Object.assign({}, current, message.config || {}))
    const health = await testHealth(config, true)
    return { ok: health.ok, health: { ok: health.ok, error: health.error, version: health.version } }
  }
  if (message.type === 'taskAction') {
    const result = await taskAction(message.id, message.action)
    return { ok: true, task: result }
  }
  if (message.type === 'openOptions') {
    chrome.runtime.openOptionsPage()
    return { ok: true }
  }
  if (message.type === 'toggleIntercept') {
    const config = await toggleIntercept()
    return { ok: true, config: { intercept: config.intercept } }
  }
  return { ok: false, error: '未知消息类型' }
}

function ensureContextMenu() {
  chrome.contextMenus.create({
    id: MENU_ID,
    title: '使用 MDM 下载此链接 / 媒体',
    contexts: ['link', 'video', 'audio']
  }, function () { void chrome.runtime.lastError })
}

chrome.runtime.onInstalled.addListener(function (details) {
  ensureContextMenu()
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: 1 })
  void refreshBadge()
  if (details.reason === 'install') {
    chrome.runtime.openOptionsPage()
  }
})

chrome.runtime.onStartup.addListener(function () {
  ensureContextMenu()
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: 1 })
  void refreshBadge()
})

chrome.alarms.onAlarm.addListener(function (alarm) {
  if (alarm.name === ALARM_NAME) void refreshBadge()
})

chrome.downloads.onCreated.addListener(function (item) {
  void handleCreated(item)
})

chrome.contextMenus.onClicked.addListener(function (info) {
  if (info.menuItemId !== MENU_ID) return
  const url = info.linkUrl || info.srcUrl || ''
  if (!/^(https?|ftps?):\/\//i.test(url)) {
    void loadConfig().then(function (config) {
      notify(config, '无法下载此链接', '仅支持 HTTP、HTTPS、FTP 与 FTPS 链接')
    })
    return
  }
  void handoffUrl(url, info.pageUrl)
})

chrome.commands.onCommand.addListener(function (command) {
  if (command === 'toggle-intercept') void toggleIntercept()
})

chrome.notifications.onClicked.addListener(function () {
  chrome.runtime.openOptionsPage()
})

chrome.runtime.onMessage.addListener(function (message, _sender, sendResponse) {
  handleMessage(message).then(sendResponse, function (error) {
    sendResponse({ ok: false, error: describeError(error) })
  })
  return true
})

ensureContextMenu()
void restoreBypass()
