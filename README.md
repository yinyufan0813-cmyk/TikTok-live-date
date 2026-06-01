# TikTok Shop GMV Max Monitor - Windows 11

这是 `Tiktok-GMVMAX` 的 Windows 11 适配版本，用于自动监测 TikTok Shop Ads 后台的 `LIVE GMV Max` 页面，并定时记录：

- 计划新增消耗
- 计划新增成交金额
- 总消耗
- 总成交金额
- 不同 TikTok 账号下的 LIVE GMV Max 计划数据

数据会写入：

- `logs/gmvmax-records.jsonl`
- `logs/gmvmax-records.csv`
- `logs/gmvmax-plan-records.csv`

## Windows 11 环境要求

请先安装：

1. Google Chrome
2. Node.js 18 或以上版本
3. Python 3，可选，仅用于备用 Tk 悬浮窗

检查 Node.js：

```powershell
node -v
npm -v
```

## 安装

在 PowerShell 或 CMD 中进入项目目录：

```powershell
npm install
npm run install:browsers
```

## 配置

复制示例配置：

```powershell
copy examples\config.example.json config.json
```

然后编辑 `config.json`，把 `url` 改成你的 TikTok GMV Max 页面 URL。

注意：这个 URL 可能包含广告账号、卖家、业务中心标识，不要提交到公开仓库。

## 推荐运行方式：连接已登录 Chrome

### 1. 启动 Windows 专用 Chrome 调试窗口

```powershell
npm run start:chrome
```

或者双击：

```text
scripts\start-chrome-win.bat
```

这个命令会启动一个独立 Chrome 用户目录：

```text
%USERPROFILE%\.gmvmax-chrome-win
```

并开启远程调试端口：

```text
http://127.0.0.1:9222
```

启动脚本会优先打开 `$env:GMVMAX_URL`，其次读取 `config.json` 的 `url`。如果两者都没有配置，则只打开 TikTok Ads 首页，避免把包含广告账号或店铺 ID 的 Dashboard URL 写进仓库。

### 2. 在新 Chrome 窗口中登录 TikTok Ads

打开你的 TikTok GMV Max 页面并完成登录。

### 3. 确认脚本能看到 Chrome 标签页

```powershell
npm run list-tabs
```

如果能看到包含 `ads.tiktok.com` 和 `GMV` 的页面，就可以运行监控。

### 4. 单次运行

```powershell
npm run once
```

### 5. 持续监控

```powershell
npm start
```

默认每 10 分钟刷新一次。需要调整时，修改 `config.json` 中的：

```json
"intervalMinutes": 10
```

## 屏幕面板

推荐使用 HTML 面板。现在同一个面板会同时显示：

- GMVMAX 三账号数据：新增消耗、新增成交、新增 ROI、总消耗、总成交和总 ROI
- LIVE 直播间数据：实时在线人数、Tap-through rate、LIVE CTR、Order rate、Ads Cost 和 GMV Max ROI

两块数据都会显示相对上一轮数据的 `▲` / `▼` / `→`。

启动方式：

```powershell
npm run dashboard
```

或者双击：

```text
scripts\start-dashboard-win.bat
```

macOS 可直接双击或运行：

```bash
./start_dashboard.command
```

面板会启动本地服务：

```text
http://127.0.0.1:8787/dashboard.html
```

如果 `8787` 已被旧版面板占用，macOS 启动脚本默认使用：

```text
http://127.0.0.1:8789/dashboard.html
```

页面每 30 秒读取一次 `logs/gmvmax-plan-records.csv` 和 `logs/live-room-records.csv`，右上角会显示两块数据的最新更新时间和本次检查时间。

如果需要通过 Tailscale Funnel 暴露手机面板，可以运行：

```powershell
npm run mobile:funnel
```

可选环境变量：

```powershell
$env:GMVMAX_MOBILE_PORT = "8788"
$env:GMVMAX_TAILSCALE_HOSTNAME = "your-hostname"
```

公开访问地址以 `tailscale funnel status` 输出为准。

## LIVE 直播间指标监测

新增的直播间监测会从 TikTok Seller Analytics 页面进入所有正在直播的直播大屏，并每 10 分钟记录这些指标：

- 实时在线人数
- Tap-through rate (via LIVE preview)
- Tap-through rate
- LIVE CTR
- Order rate (SKU orders)
- Ads Cost
- GMV Max ROI

数据会写入：

- `logs/live-room-records.jsonl`
- `logs/live-room-records.csv`

### 1. 配置入口页面

在 `config.json` 里加入或确认以下配置：

```json
{
  "liveAnalytics": {
    "overviewUrl": "https://seller-my.tiktok.com/compass/data-overview?shop_region=MY",
    "intervalMinutes": 10,
    "maxRooms": 12,
    "liveStreamsText": "LIVE streams",
    "liveRoomTexts": [],
    "discoverEveryRun": true,
    "selectors": {
      "liveStreamsTrigger": "",
      "liveRoomItems": "",
      "metricHover": ""
    }
  }
}
```

默认每轮都会刷新 Analytics 入口页，自动把鼠标悬停到右侧 `LIVE streams +N` 区域，按浮出的直播间账号重新打开直播大屏。这样直播间关播后，下一轮会以红框下拉列表为准，不再继续采集旧的大屏页面。如果 TikTok 页面改版，可在 `selectors` 中补实际 CSS 选择器。

### 2. 单次采集

```powershell
npm run live:once
```

### 3. 持续监控

```powershell
npm run live
```

### 4. 打开直播悬浮窗

```powershell
npm run live:dashboard
```

或双击：

```text
scripts\start-live-dashboard-win.bat
```

直播悬浮窗地址：

```text
http://127.0.0.1:8787/live-dashboard.html
```

如果字段没有识别出来，脚本会在 `logs/` 保存 `live-debug-时间.txt` 和 `live-debug-时间.png`，便于补选择器。

## 备用 Tk 悬浮窗

如果已安装 Python 3，可以运行：

```powershell
npm run float
```

备用悬浮窗会置顶显示 `logs/gmvmax-plan-records.csv` 中最新一轮数据，并每 30 秒刷新一次。

## Windows 开机/登录后自动运行

注册 Windows 任务计划程序：

```powershell
npm run register-startup
```

取消自动运行：

```powershell
npm run unregister-startup
```

注意：自动运行前，你仍需要确保 Chrome 调试窗口可用，并且 TikTok Ads 登录状态有效。

## 如果页面字段没有识别出来

TikTok Ads 后台页面可能会变动。如果字段识别失败，脚本会在 `logs/` 保存：

- `debug-时间.txt`
- `debug-时间.png`

你可以在 `config.json` 的 `selectors` 中填写页面实际 CSS 选择器：

```json
{
  "selectors": {
    "planRows": "tbody tr",
    "account": "td:nth-child(1)",
    "planName": "td:nth-child(2)",
    "newSpend": "td:nth-child(4)",
    "newOrderAmount": "td:nth-child(5)",
    "totalSpend": "td:nth-child(6)",
    "totalOrderAmount": "td:nth-child(7)"
  }
}
```

## 与 macOS 版本的主要区别

- Chrome 启动命令改为 Windows PowerShell 脚本。
- 默认 Chrome profile 改为 `chrome-profile-win` / `%USERPROFILE%\.gmvmax-chrome-win`。
- 屏幕面板使用 `scripts\start-dashboard-win.bat` 或 `npm run dashboard` 打开。
- 后台常驻方式改为 Windows Task Scheduler，而不是 macOS launchd。
- Python 悬浮窗字体改为 Windows 常用的 `Segoe UI`。
- README、路径、命令全部改为 Windows 11 写法。
