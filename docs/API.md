# 本地 API

默认地址：`http://127.0.0.1:45721/api/v1`，端口可在设置中修改。

## 鉴权

除公开端点外，所有请求需要：

```http
X-MDM-Token: <32–96 位十六进制令牌>
```

或：

```http
Authorization: Bearer <token>
```

令牌在首次启动时生成并保存为数据目录的 `api-token`，也可在设置中轮换。鉴权失败返回 401：

```json
{ "error": "扩展令牌无效，请在 MDM 设置中重新复制令牌", "code": "unauthorized" }
```

## 公开端点

### GET /api/v1

```json
{ "name": "MDM", "version": "0.1.0", "api": "v1", "requiresToken": true }
```

### GET /api/v1/ping

同上。

## 需要鉴权

### GET /api/v1/health

```json
{ "ok": true, "version": "0.1.0", "stats": { "activeSpeed": 0, "activeCount": 0, "queuedCount": 0, "completedCount": 0, "totalDownloadedBytes": 0, "diskFreeBytes": null } }
```

### GET /api/v1/tasks

```json
{ "tasks": [PublicTask], "active": 0 }
```

### POST /api/v1/tasks

请求体字段与 `AddDownloadInput` 一致：

```json
{
  "url": "https://example.com/file.zip",
  "fileName": "file.zip",
  "directory": "D:\\Downloads",
  "connections": 32,
  "headers": { "Referer": "https://example.com" },
  "cookies": "a=1; b=2",
  "referrer": "https://example.com",
  "userAgent": "Mozilla/5.0",
  "checksum": "sha256:<64 hex>",
  "speedLimitBps": 0,
  "source": "extension"
}
```

成功返回 201：

```json
{ "id": "任务 ID", "task": PublicTask }
```

错误返回 400：`{ "error": "中文错误信息" }`。

### GET /api/v1/tasks/{id}

返回 `PublicTask`，不存在返回 404。

### DELETE /api/v1/tasks/{id}

删除任务记录（不删除已完成文件），返回 `{ "ok": true }`。

### POST /api/v1/tasks/{id}/pause

### POST /api/v1/tasks/{id}/resume

### POST /api/v1/tasks/{id}/cancel

### POST /api/v1/tasks/{id}/retry

### POST /api/v1/tasks/clear-completed

### GET /api/v1/stats

返回 `AppStats`。

## CORS

允许任意来源、方法与 `Content-Type`、`Authorization`、`X-MDM-Token`、`X-MDM-Client` 请求头，方便扩展直接调用。仅监听回环地址，切勿通过反向代理暴露到公网。

## 示例

```bash
TOKEN=$(cat "$APPDATA/com.mdm.downloadmanager/api-token")
curl -H "X-MDM-Token: $TOKEN" http://127.0.0.1:45721/api/v1/tasks
curl -X POST -H "X-MDM-Token: $TOKEN" -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/big.iso","connections":64}' \
  http://127.0.0.1:45721/api/v1/tasks
```
