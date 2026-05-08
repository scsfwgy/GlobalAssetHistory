# CLAUDE.md

This file provides guidance to Claude Code when working with code in this repository.

## 项目概述

GlobalAssetHistory 是一个独立的资产历史收益分析工具。

- 后端：Python 3 + Flask
- 前端：原生 HTML / CSS / JS 单页面
- 图表：原生 SVG
- 数据源：
  - 美股：Yahoo Finance / yfinance fallback
  - 数字货币：Binance → OKX → CoinGecko
  - A 股指数：East Money

当前不仅支持历年涨跌幅，还支持：

- 年 → 月 → 日三级钻取
- 基于日线的单资产回测
- 一次性 / 按日 / 按周 / 按月策略

## 命令速查

```bash
./start.sh
./start.sh start
./start.sh debug
./start.sh stop
./start.sh restart
./start.sh status
```

端口：

```bash
PORT=8080 ./start.sh debug
```

依赖安装：

```bash
python3 -m venv backend/.venv
backend/.venv/bin/pip install -r backend/requirements.txt
```

## 目录结构

```text
GlobalAssetHistory/
├── backend/
│   ├── app.py
│   ├── requirements.txt
│   ├── config/
│   │   └── price_change_config.json
│   ├── routes/
│   │   └── price_change.py
│   └── service/
│       └── price_change/
│           ├── calculations.py          # 收益计算、日期计划、回测曲线构建
│           ├── common.py                # PriceSeries、HTTP session、常量
│           ├── config.py                # 配置加载与访问器
│           ├── fetchers.py              # Yahoo/Binance/OKX/CoinGecko/East Money fetcher
│           └── price_change_service.py  # 公共 API 与编排层
├── frontend/
│   ├── price-change.html
│   ├── css/app.css
│   └── js/
│       ├── api.js                 # API endpoint constants
│       ├── backtest.js            # 回测控件、回测图、回测结果表
│       ├── charts.js              # 年度/月度 SVG 图表
│       ├── drilldown.js           # 年→月→日钻取卡片
│       └── price-change.js        # 主状态、表格、预设、初始化
├── doc/screenshot/
├── logs/
├── README.md
├── CLAUDE.md
└── start.sh
```

## API 路由

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/health` | 健康检查 |
| GET | `/api/price-change/config` | 获取预设和着色范围 |
| POST | `/api/price-change/yearly` | 多资产历年涨跌幅 |
| POST | `/api/price-change/monthly` | 单资产某年月份涨跌幅 |
| POST | `/api/price-change/monthly-batch` | 多资产某年月度涨跌幅 |
| POST | `/api/price-change/daily` | 单资产某年某月日涨跌幅 |
| POST | `/api/price-change/backtest` | 单资产日线回测 |

## 核心设计

### 1. Flask 同时托管 API 和前端

`backend/app.py`：

- 注册 `price_change_bp`
- 托管 `frontend/` 静态文件
- `/` 直接返回 `frontend/price-change.html`

前端使用相对路径请求 API，`API_BASE = ""`。

### 2. 日线数据是统一基础层

核心能力都建立在 `PriceSeries` 之上：

- `yearly`
- `monthly`
- `daily`
- `backtest`

统一入口：

- `_fetch_daily_series_cached(symbol, asset_type)`

缓存：

- 成功缓存 6 小时
- 失败缓存 5 分钟

### 3. Fetcher 注册表

在 `backend/service/price_change/fetchers.py` 中：

- `_FETCHERS`：旧式 yearly fetcher
- `_DAILY_SERIES_FETCHERS`：新版日线 fetcher

`price_change_service.py` 会复制这些注册表，并提供：

- `register_fetcher(...)`
- `register_daily_series_fetcher(...)`

新增资产类型时优先接 daily-series fetcher。

### 4. 收益计算

- 年度收益：年末 / 上年末 - 1
- 月度收益：月末 / 上月末 - 1
- 日度收益：当日 / 前一有效日 - 1

### 5. 回测模型

当前回测是**单资产、基于日线、无手续费、无滑点、无再平衡**。

支持策略：

- `once`
- `daily`
- `weekly`
- `monthly`

关键函数：

- `_generate_schedule_dates(...)`
- `_resolve_execution_points(...)`
- `_build_equity_curve(...)`
- `run_dca_backtest(...)`

执行规则：

- 若计划日无交易数据，则顺延到下一个有价格的交易日

### 6. 前端状态

前端使用多个 classic script，共享全局作用域，不使用 bundler。

脚本加载顺序在 `frontend/price-change.html` 中很重要：

1. `api.js`
2. `price-change.js`
3. `charts.js`
4. `drilldown.js`
5. `backtest.js`

`frontend/js/price-change.js` 仍负责主状态：

- `symbols`
- `PRESETS`
- `_lastYearlyData`
- `_chartHidden`
- `_mChartHidden`

无框架依赖，不要引 React/Vue 等大改，除非用户明确要求。

## 当前前端功能点

### 年 / 月 / 日钻取

- 点击年表单元格：展开月度卡片
- 点击月度卡片中的某个月：展开日度卡片

### 回测图

当前回测图包含：

- 蓝线：总资产
- 灰线：累计投入
- 绿 / 红面积：总收益（正负分色）
- hover tooltip
- 竖向参考线
- 回报率显示
- 抽样显示点数
- 图表入场动画，默认 5 秒

相关输入：

- `pcBtSampleSize`
- `pcBtAnimSeconds`

## 启动脚本注意事项

`start.sh` 在启动前会尝试释放端口占用。

但要注意：

- `backend/app.py` 仍然是 `debug=True`
- 即使通过 `./start.sh start` 后台启动，也会触发 Flask reloader
- 因此 `logs/server.pid` 与真实监听进程有时会不一致
- `status` 可能提示 “PID 文件残留”

如果要修生产稳定性，优先改这里。

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `8730` | Flask 服务端口 |
| `HOST` | `0.0.0.0` | Flask 监听地址 |

## 修改建议

1. 改后端能力时，优先保持 `PriceSeries` 为唯一基础数据结构。
2. 改前端图表时，优先延续当前 SVG 手工渲染风格，不要引图表库。
3. 回测若继续增强，建议按这个顺序：
   - 手续费 / 滑点
   - 多资产组合
   - 权重与再平衡
   - 最大回撤 / 波动率 / IRR
4. 如果改 `start.sh`，要一起考虑：
   - 端口释放
   - reloader
   - PID 管理

## 沟通偏好

- 与用户使用中文交流
- 代码注释保持英文
