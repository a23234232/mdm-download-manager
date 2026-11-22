const $ = (id) => document.getElementById(id);
function send(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else if (!response) reject(new Error('后台没有响应'));
      else resolve(response);
    });
  });
}
function setStatus(text, tone) {
  const node = $('status');
  node.textContent = text;
  node.className = 'status' + (tone ? ' ' + tone : '');
}
function formConfig() {
  return {
    port: Number($('port').value),
    token: $('token').value.trim(),
    intercept: $('intercept').checked,
    forwardCookies: $('cookies').checked,
    notify: $('notify').checked
  };
}
function fill(config) {
  $('port').value = config.port || 45721;
  $('token').value = config.token || '';
  $('intercept').checked = config.intercept !== false;
  $('cookies').checked = config.forwardCookies !== false;
  $('notify').checked = config.notify !== false;
}
async function load() {
  try {
    const response = await send({ type: 'getConfig' });
    if (!response.ok) throw new Error(response.error || '读取配置失败');
    fill(response.config || {});
  } catch (error) { setStatus(String(error.message || error), 'bad'); }
}
$('show-token').onclick = () => {
  const input = $('token');
  const showing = input.type === 'text';
  input.type = showing ? 'password' : 'text';
  $('show-token').textContent = showing ? '显示' : '隐藏';
};
$('test').onclick = async () => {
  $('test').disabled = true;
  setStatus('正在连接 127.0.0.1:' + $('port').value + ' …');
  try {
    const response = await send({ type: 'testConfig', config: formConfig() });
    if (response.ok) setStatus('连接成功' + (response.health.version ? '，MDM ' + response.health.version : ''), 'ok');
    else setStatus('连接失败：' + ((response.health && response.health.error) || '未知错误'), 'bad');
  } catch (error) { setStatus(String(error.message || error), 'bad'); }
  finally { $('test').disabled = false; }
};
$('save').onclick = async () => {
  $('save').disabled = true;
  try {
    const config = formConfig();
    if (!Number.isInteger(config.port) || config.port < 1024 || config.port > 65535) throw new Error('端口需在 1024–65535 之间');
    if (!/^[a-f0-9]{32,96}$/i.test(config.token)) throw new Error('令牌应为 32–96 位十六进制字符');
    const response = await send({ type: 'saveConfig', config });
    if (!response.ok) throw new Error(response.error || '保存失败');
    await load();
    if (response.health && response.health.ok) setStatus('已保存，连接正常', 'ok');
    else setStatus('已保存，但暂时无法连接 MDM：' + ((response.health && response.health.error) || ''), 'bad');
  } catch (error) { setStatus(String(error.message || error), 'bad'); }
  finally { $('save').disabled = false; }
};
$('port').addEventListener('keydown', (event) => { if (event.key === 'Enter') void $('test').click(); });
load();