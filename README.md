# GlobalAssetHistory — 历年涨跌幅与定投回测

> 跨资产类别（美股、数字货币、A 股指数）的历史收益查询工具，支持年 / 月 / 日钻取与基于日线的定投回测。

## 功能

- **历年汇总**：多资产历年涨跌幅热力图
- **年份钻取**：点击某个资产某一年，查看该年的月度涨跌幅
- **月份钻取**：在月度卡片中继续点击某个月，查看该月的日涨跌幅和日收盘价
- **月度走势**：指定年份后渲染月度折线图，支持图例交互
- **定投回测**：按日线回测单资产策略，支持：
  - 一次性
  - 按日
  - 按周
  - 按月
- **回测图表**：
  - 总资产蓝线
  - 累计投入灰线
  - 总收益分色面积（正收益绿色，负收益红色）
  - hover tooltip / 竖向参考线 / 回报率
  - 可配置显示点数
  - 可配置图表动画秒数，默认 5 秒

## 截图

### 历年涨跌幅热力图

![历年热力图](doc/screenshot/yearly-heatmap.png)

### 历年走势折线图

![历年走势](doc/screenshot/yearly-chart.png)

### 指定年份月度涨跌幅

![月度涨跌幅](doc/screenshot/monthly-breakdown.png)

### 指定年份月度走势

![月度走势](doc/screenshot/monthly-trend.png)

### 回测图表

![回测图表](doc/screenshot/backtest.png)

### 回测明细

![回测明细](doc/screenshot/backtest-detail.png)

## 数据源

| 类型 | 数据源 | 备注 |
|------|--------|------|
| 美股 | Yahoo Finance | 优先 adjclose，失败时回退 |
| 数字货币 | Binance → OKX → CoinGecko | 自动 fallback |
| A 股指数 | East Money | 日线数据 |

## 快速开始

```bash
./start.sh
```

首次运行会自动：

- 创建 `backend/.venv`
- 安装 `requirements.txt`
- 启动服务

默认地址：

- 前端: [http://127.0.0.1:8730](http://127.0.0.1:8730)
- 健康检查: [http://127.0.0.1:8730/api/health](http://127.0.0.1:8730/api/health)

## 启动脚本

### 交互模式

```bash
./start.sh
```

### 命令模式

| 命令 | 说明 |
|------|------|
| `./start.sh` | 交互式菜单 |
| `./start.sh start` | 后台启动 |
| `./start.sh debug` | 前台调试启动 |
| `./start.sh stop` | 停止服务 |
| `./start.sh restart` | 重启服务 |
| `./start.sh status` | 查看状态 |

### 端口配置

```bash
PORT=8080 ./start.sh start
```

### 端口占用

启动前脚本会检查目标端口；若被占用，会先尝试释放端口再启动新服务。

注意：

- 当前 `backend/app.py` 使用 `debug=True`
- 在 `start.sh start` 下仍会触发 Flask reloader
- 因此 `logs/server.pid` 与真实监听进程偶尔会不一致，`status` 可能出现 “PID 文件残留”

如果后续要进一步稳定后台运行，建议把生产模式切到 `debug=False`

## 配置

配置文件：

`backend/config/price_change_config.json`

支持：

- `presets`：预设资产组
- `color_range`：热力图着色范围
- `crypto.coin_ids`：CoinGecko 币种映射
- `crypto.*_base_url`：各数据源地址

## API

所有接口都在 `http://127.0.0.1:8730/api/price-change/` 下。

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/config` | 获取预设和颜色配置 |
| POST | `/yearly` | 多资产历年涨跌幅 |
| POST | `/monthly` | 单资产某年的月度涨跌幅 |
| POST | `/monthly-batch` | 多资产某年的月度涨跌幅 |
| POST | `/daily` | 单资产某年某月的日涨跌幅 |
| POST | `/backtest` | 单资产基于日线的回测 |

健康检查：

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/health` | 健康检查 |

### POST /api/price-change/daily

请求：

```json
{
  "symbol": "BTC",
  "type": "crypto",
  "year": 2024,
  "month": 3
}
```

响应：

```json
{
  "symbol": "BTC",
  "type": "crypto",
  "year": 2024,
  "month": 3,
  "days": [
    { "day": 1, "date": "2024-03-01", "return": 2.15, "close": 62451.12 }
  ]
}
```

### POST /api/price-change/backtest

请求：

```json
{
  "symbol": "BTC",
  "type": "crypto",
  "start_date": "2024-01-01",
  "end_date": "2024-12-31",
  "initial_amount": 0,
  "amount": 1000,
  "frequency": "monthly",
  "interval": 1,
  "day_of_month": 1,
  "weekday": 0
}
```

`frequency` 支持：

- `once`
- `daily`
- `weekly`
- `monthly`

响应：

```json
{
  "symbol": "BTC",
  "type": "crypto",
  "source": "binance",
  "frequency": "monthly",
  "interval": 1,
  "start_date": "2024-01-01",
  "end_date": "2024-12-31",
  "summary": {
    "invested": 12000.0,
    "final_value": 14320.55,
    "profit": 2320.55,
    "return_pct": 19.34,
    "annualized_return_pct": 19.34,
    "trade_count": 12,
    "last_price": 92123.11
  },
  "cashflows": [],
  "equity_curve": []
}
```

## 项目结构

```text
├── start.sh
├── README.md
├── CLAUDE.md
├── backend/
│   ├── app.py
│   ├── requirements.txt
│   ├── config/
│   │   └── price_change_config.json
│   ├── routes/
│   │   └── price_change.py
│   └── service/
│       └── price_change/
│           ├── calculations.py
│           ├── common.py
│           ├── config.py
│           ├── fetchers.py
│           └── price_change_service.py
├── frontend/
│   ├── price-change.html
│   ├── css/app.css
│   └── js/
│       ├── api.js
│       ├── backtest.js
│       ├── charts.js
│       ├── drilldown.js
│       └── price-change.js
├── doc/screenshot/
└── logs/
```

## 技术栈

| 层 | 技术 |
|----|------|
| 后端 | Python 3 + Flask |
| 前端 | 原生 HTML / CSS / JS |
| 图表 | 原生 SVG |
| 数据获取 | requests, yfinance |

## License

MIT
