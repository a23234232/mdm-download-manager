# Chrome 扩展

扩展目录：`extension/`，Manifest V3，最低 Chrome 109。

## 安装

1. `chrome://extensions` → 开发者模式。
2. 「加载已解压的扩展程序」→ 选择 `extension/`。
3. 启动 MDM 桌面端，在「设置 → Chrome 扩展」复制令牌。
4. 扩展 → 设置连接，填写端口与令牌，测试并保存。

打包版会把 `extension/` 放到 Tauri 资源目录的 `chrome-extension/` 下，桌面端「打开扩展目录」可直接定位。

## 接管流程

1. `chrome.downloads.onCreated` 发现新的 HTTP(S) 下载。
2. 先暂停该下载；若扩展没有令牌或 MDM 健康检查失败，立即放行 Chrome 原生下载。
3. 健康检查通过后取消并清除 Chrome 下载。
4. 读取当前 URL 的 Cookie（可关闭），POST `/api/v1/tasks`，把 URL、文件名、Referer、Cookie 交给 MDM。
5. 失败时记录 30 秒绕过，并用原 URL 重新交给 Chrome，避免丢文件。

## 其它能力

- 右键链接/视频/音频 →「使用 MDM 下载此链接 / 媒体」。
- 工具栏徽标显示活跃任务数；离线/未配置令牌显示不同状态。
- 弹窗每 2 秒刷新最近 6 个任务，可暂停/继续/重试。
- 每分钟健康检查一次。
- 快捷键 `Alt+Shift+M` 临时切换接管。

## 权限

`downloads`、`storage`、`cookies`、`contextMenus`、`notifications`、`alarms`，以及 `<all_urls>`（拦截任意站点下载）。不注入内容脚本，不读取页面 DOM。

## 已知边界

- `chrome.downloads` 只能看到 Chrome 已决定下载的 URL；需要 POST 表单/流式响应的下载可能无法完整接管。
- 某些站点用 `Content-Disposition` 决定文件名，扩展会把它作为 `fileName` 提示。
- Cookie 有 16KB 上限，超出部分截断。
- MDM 未启动时扩展不会排队，直接把下载还给 Chrome。
