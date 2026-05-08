# CLAUDE.md

This file provides guidance to Claude Code when working with code in this repository.

## 项目概述

GlobalAssetHistory 是一个独立的历年涨跌幅查询工具，从 Web3PanelV2 摘出：

- **后端**: Python 3 + Flask API + 静态文件托管（单端口服务）
- **前端**: 原生 HTML + CSS + JS，单页面应用
- **数据源**: Yahoo Finance（美股）、Binance/OKX/CoinGecko（数字货币）、East Money（A 股）

## 命令速查

### 服务管理

```bash
./start.sh                    # 交互式菜单
./start.sh start              # 生产模式（后台运行）
./start.sh debug              # 调试模式（前台 + Flask 自动重载）
./start.sh stop               # 停止后台服务
./start.sh restart            # 重启
./start.sh status             # 查看运行状态
```

端口通过 `PORT` 环境变量配置（默认 8730）：
```bash
PORT=8080 ./start.sh debug
```

### 依赖安装

```bash
python3 -m venv backend/.venv
backend/.venv/bin/pip install -r backend/requirements.txt
```

（start.sh 会自动完成上述步骤）

## 代码架构

### 目录结构

```
GlobalAssetHistory/
├── backend/
│   ├── app.py                              # Flask 入口，CORS，静态文件托管
│   ├── requirements.txt                    # Flask, Flask-Cors, requests, yfinance
│   ├── config/
│   │   └── price_change_config.json        # 预设资产组 + 币种 CoinGecko ID 映射
│   ├── routes/
│   │   └── price_change.py                 # /api/price-change 蓝图（4 个端点）
│   └── service/
│       └── price_change/
│           └── price_change_service.py     # 核心：多源数据获取 + 收益计算 + 缓存
├── frontend/
│   ├── price-change.html                   # 主页面
│   ├── css/app.css                         # Apple 风格样式
│   └── js/price-change.js                  # 前端全部逻辑
├── doc/screenshot/                         # 功能截图
├── logs/                                   # 运行时日志和 PID 文件
└── start.sh                                # 服务管理脚本
```

### API 路由一览

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/health` | 健康检查 |
| GET | `/api/price-change/config` | 获取预设和着色范围 |
| POST | `/api/price-change/yearly` | 多资产历年涨跌幅 |
| POST | `/api/price-change/monthly` | 单资产指定年份月度涨跌幅 |
| POST | `/api/price-change/monthly-batch` | 多资产指定年份月度涨跌幅 |

### 关键设计

1. **Flask 同时托管 API 和前端**（`backend/app.py`）：
   - 注册 `price_change_bp` 处理 `/api/price-change/*`
   - 通过 `send_from_directory` 托管 `frontend/` 目录下的静态文件
   - 前端 JS 的 `API_BASE = ""`，使用相对路径请求 `/api/*`

2. **数据流**：`POST /yearly（symbols）` → `fetch_yearly_returns()` → 并发调用各资产对应的 fetcher → Yahoo/Binance/OKX/CoinGecko/East Money → 计算 YoY 收益 → 返回 `{years, data, meta}`

3. **Fetcher 注册表**（`price_change_service.py`）：通过 `_FETCHERS` 和 `_DAILY_SERIES_FETCHERS` 两个 dict 注册资产类型对应的数据获取函数。新增资产类型只需实现 fetcher 函数并注册：

   ```python
   _FETCHERS["new_type"] = _fetch_new_type  # 旧版，直接返回 yearly dict
   _DAILY_SERIES_FETCHERS["new_type"] = _fetch_daily_series_new  # 新版，返回 PriceSeries
   ```

   新版优先（同时支持 yearly 和 monthly 计算），使用 `_DAILY_SERIES_FETCHERS`；旧版只有 yearly 能力，使用 `_FETCHERS`。建议新资产类型用新版。

4. **PriceSeries + 缓存**：日线数据缓存在内存 `_DAILY_SERIES_CACHE` 中，TTL 6 小时（失败缓存 5 分钟）。通过 `_fetch_daily_series_cached()` 统一访问，线程安全（`_CACHE_LOCK`）。

5. **多数据源自动 fallback**：
   - 美股：Yahoo Finance 直连 → yfinance 库
   - 数字货币：Binance → OKX → CoinGecko（每级失败自动尝试下一级）
   - A 股：East Money API（单源）
   所有 fallback 对调用方透明。

6. **并发控制**：`fetch_yearly_returns` 使用 `ThreadPoolExecutor`（最多 6 线程），`_ThreadLocalSession` 为每个线程维护独立的 `requests.Session`，避免跨线程连接复用问题。

7. **收益计算方法**：
   - 年度收益：`年末收盘价 / 上年末收盘价 - 1`（YoY）
   - 月度收益：`月末收盘价 / 上月未收盘价 - 1`
   - 优先使用 adjclose（含股息修正），fallback 到 close
   - 前 12 个月数据不够时，部分月份 return 为 null

8. **前端状态管理**：`price-change.js` 使用模块级变量管理状态（`symbols`、`_lastYearlyData`、`_chartHidden`、`_mChartHidden`），无框架依赖。

9. **HSL 颜色渐变**：热力图使用 `hsla()` 多阶渐变（同时变化色相/饱和度/明度/透明度），而非单一颜色的透明度渐变，视觉效果更丰富。

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | 8730 | Flask 服务端口 |
| `HOST` | 0.0.0.0 | Flask 绑定地址 |

## 注意事项

- `backend/config/price_change_config.json` 已提交到 git（不含密钥），可自由修改预设
- 运行时日志写入 `logs/` 目录，`logs/.gitignore` 已配置忽略
- `start.sh` 会自动创建虚拟环境并安装依赖
- 前端为单页面应用，所有逻辑在 `frontend/js/price-change.js` 中
- 首次启动若数据源不可用（网络/代理问题），前端会显示 "未连接" 状态
- Yahoo Finance 的 direct API 依赖 `requests`，yfinance 为可选依赖（出错时静默 fallback）
- CoinGecko ID 映射在 `price_change_config.json` 的 `crypto.coin_ids` 中，新增币种需同步添加

## 沟通偏好

- **使用中文**与用户交流，代码注释保持英文。
