const $ = (id) => document.getElementById(id);
const STATUS_TEXT = {
  queued: '排队', connecting: '连接中', downloading: '下载中', paused: '已暂停',
  completed: '已完成', error: '失败', cancelled: '已取消'
};
let current = null;

function send(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else if (!response) reject(new Error('后台没有响应'));
      else resolve(response);
    });
  });
}

function bytes(value) {
  if (!value) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let index = 0;
  let number = Number(value);
  while (number >= 1024 && index < units.length - 1) { number /= 1024; index += 1; }
  return (number >= 100 || index === 0 ? number.toFixed(0) : number.toFixed(1)) + ' ' + units[index];
}
function speed(value) { return value > 0 ? bytes(value) + '/s' : '—'; }
function eta(value) {
  if (!value || value <= 0 || !Number.isFinite(value)) return '—';
  const seconds = Math.round(value);
  if (seconds < 60) return seconds + ' 秒';
  if (seconds < 3600) return Math.floor(seconds / 60) + ' 分 ' + (seconds % 60) + ' 秒';
  return Math.floor(seconds / 3600) + ' 小时 ' + Math.floor((seconds % 3600) / 60) + ' 分';
}
function pct(task) {
  if (!task.totalBytes) return 0;
  return Math.max(0, Math.min(100, task.downloadedBytes / task.totalBytes * 100));
}
function actionFor(task) {
  if (task.status === 'downloading' || task.status === 'connecting' || task.status === 'queued') return ['pause', '暂停'];
  if (task.status === 'paused') return ['resume', '继续'];
  if (task.status === 'error') return ['retry', '重试'];
  return null;
}
function renderTask(task) {
  const node = document.createElement('div');
  node.className = 'task';
  const top = document.createElement('div');
  top.className = 'task-top';
  const name = document.createElement('span');
  name.className = 'task-name';
  name.textContent = task.fileName || '未命名任务';
  name.title = task.fileName || '';
  const pill = document.createElement('span');
  pill.className = 'pill ' + task.status;
  pill.textContent = STATUS_TEXT[task.status] || task.status;
  top.append(name, pill);
  const bar = document.createElement('div');
  bar.className = 'bar';
  const fill = document.createElement('i');
  fill.style.width = pct(task) + '%';
  bar.append(fill);
  const meta = document.createElement('div');
  meta.className = 'task-meta';
  const left = document.createElement('span');
  left.textContent = task.status === 'downloading'
    ? speed(task.speed) + ' · ' + bytes(task.downloadedBytes) + ' / ' + bytes(task.totalBytes)
    : bytes(task.downloadedBytes) + ' / ' + bytes(task.totalBytes) + ' · ' + eta(task.etaSeconds);
  const right = document.createElement('span');
  right.className = 'task-actions';
  const action = actionFor(task);
  if (action) {
    const button = document.createElement('button');
    button.className = 'icon-btn';
    button.textContent = action[1];
    button.onclick = async () => {
      button.disabled = true;
      try { await send({ type: 'taskAction', id: task.id, action: action[0] }); await refresh(); }
      catch (error) { showHealth(String(error.message || error)); }
      finally { button.disabled = false; }
    };
    right.append(button);
  }
  meta.append(left, right);
  node.append(top, bar, meta);
  return node;
}
function showHealth(text) {
  const node = $('health');
  node.textContent = text;
  node.classList.add('show');
}
function render(state) {
  current = state;
  const health = state.health || {};
  $('status-dot').className = 'dot' + (health.ok ? ' ok' : '');
  $('version').textContent = health.version ? 'MDM ' + health.version : '';
  if (!health.ok) showHealth(health.error || '无法连接 MDM，请确认桌面端已启动');
  else { $('health').classList.remove('show'); }
  const config = state.config || {};
  $('toggle').className = 'switch' + (config.intercept ? ' on' : '');
  $('intercept-hint').textContent = config.intercept ? '新下载将自动交给 MDM' : '已暂停接管，下载由 Chrome 处理';
  const stats = state.stats || {};
  const tasks = state.tasks || [];
  $('active-count').textContent = String(tasks.filter((task) => ['downloading', 'connecting', 'queued'].includes(task.status)).length || stats.activeCount || 0);
  $('speed').textContent = speed(stats.activeSpeed || 0);
  $('done-count').textContent = String(stats.completedCount || tasks.filter((task) => task.status === 'completed').length);
  const list = $('tasks');
  list.textContent = '';
  if (!tasks.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = config.hasToken ? '暂无下载任务' : '请先在设置中填写 API 令牌';
    list.append(empty);
  } else {
    tasks.slice(0, 6).forEach((task) => list.append(renderTask(task)));
  }
}
async function refresh() {
  try {
    const state = await send({ type: 'state' });
    if (state && state.ok !== false) render(state);
    else showHealth((state && state.error) || '读取状态失败');
  } catch (error) { showHealth(String(error.message || error)); }
}
$('refresh').onclick = () => void refresh();
$('options').onclick = () => send({ type: 'openOptions' });
$('toggle').onclick = async () => {
  try { await send({ type: 'toggleIntercept' }); await refresh(); }
  catch (error) { showHealth(String(error.message || error)); }
};
refresh();
setInterval(refresh, 2000);