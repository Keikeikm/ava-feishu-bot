# AVA 飞书数据分析机器人

把表格和问题发给飞书机器人，就能收到结论、关键依据和交互图表，也可以围绕同一份数据继续追问。机器人用 **AntV AVA 4.0.0 + DuckDB** 计算结果，用 DeepSeek 或其他兼容模型理解问题和撰写结论。

[快速开始](#快速开始) · [在飞书使用](#在飞书使用) · [实验功能](#实验功能) · [部署与运行](#部署与运行) · [排查问题](#排查问题) · [本地验证](#本地验证)

## 快速开始

本地运行需要 macOS 或 Linux，以及 Node.js **22.13 或以上**。项目通过飞书官方 Node SDK 建立 WebSocket 长连接，无需公网回调地址。

### 1. 创建飞书应用

在[飞书开发者后台](https://open.feishu.cn/app)创建**企业自建应用**，添加「机器人」能力，保存 App ID 和 App Secret。进入「权限管理」，开通以下**应用身份**权限。

| 权限 | 用途 |
| --- | --- |
| `im:message.p2p_msg:readonly` | 接收用户发给机器人的私聊消息 |
| `im:message:readonly` | 下载消息里的表格附件 |
| `im:message:send_as_bot` | 以机器人身份回复 |
| `im:resource` | 上传导出文件等消息资源 |

[权限导入 JSON](docs/feishu-permissions.json)同时包含群聊权限。只需要私聊时，开通上表四项即可。多维表格和群聊的额外配置见下文。

### 2. 安装并启动

在项目根目录运行：

```bash
nvm use
npm ci
test -f .env || cp .env.example .env
```

在 `.env` 中填写飞书凭证和模型配置。示例使用项目默认的 DeepSeek 配置。

```dotenv
FEISHU_APP_ID=你的飞书应用AppID
FEISHU_APP_SECRET=你的飞书应用AppSecret
LLM_API_KEY=你的DeepSeek_API_Key
LLM_MODEL=deepseek-flash
LLM_BASE_URL=https://api.deepseek.com
```

[创建 DeepSeek API Key](https://platform.deepseek.com/api_keys)。使用其他供应商时，填写其模型标识和兼容 Chat Completions 的 API 根地址，AVA 会在根地址后调用 `/chat/completions`。模型需要支持以文本返回 JSON。 [DeepSeek 接入文档](https://api-docs.deepseek.com/zh-cn/)

```bash
npm run build
npm start
```

### 3. 订阅事件并发布

保持服务运行。在飞书开发者后台打开「事件与回调」，选择「使用长连接接收事件」，订阅 `im.message.receive_v1`。在「版本管理与发布」发布版本，确认测试账号在应用可用范围内，并完成租户要求的审核。事件或权限修改后需要重新发布。 [飞书长连接接入说明](https://open.feishu.cn/document/ukTMukTMukTM/uYDNxYjL2QTM24iN0EjN/event-subscription-configure-)

### 4. 私聊验证

在终端确认出现「长连接已连接」。向机器人发送 [sales.csv](examples/sales.csv)，收到「表格已收到」后问 **按地区汇总销售额，并画柱状图**。也可以在同一条消息里附上文件并写问题。示例汇总应为华东 **45000**、华南 **20000**、华北 **11000**。

## 在飞书使用

### 分析与追问

| 想做什么 | 给机器人发什么 |
| --- | --- |
| 查看整体表现 | `分析一下` |
| 分组计算或画图 | `按地区汇总销售额，并画柱状图` |
| 沿用上一问的范围 | `只看华东，再按月份比较` |
| 查看字段名和类型 | `/字段` 或 `介绍一下数据字段分别是什么？` |
| 查看当前文件、预览或缺失值 | `/状态`、`/预览`、`/画像` |
| 获取分析问题建议 | `/建议` |
| 只看文字结论 | `/分析 不画图 按地区汇总销售额` |
| 清除当前数据和追问记录 | `/清空` |

分析卡给出结论、依据和可继续追问的方向。结果适合可视化时，卡片会显示用实际计算值绘制的图表。默认在卡片中交付结果，附件按需导出。

| 命令 | 下载内容 |
| --- | --- |
| `/导出` 或 `/导出 CSV` | 上一次计算结果 |
| `/导出 JSON` | 上一次的结论和计算结果 |
| `/导出 图表` | 图表 HTML，需开启 `ENABLE_CHARTS`，打开时需要联网加载 GPT-Vis |

同一会话中，每位用户有自己的数据和追问记录。成功导入新文件后会替换该用户的旧数据，导入失败时保留旧数据。一次发送一个附件，多张 Excel 工作表可以放在同一个 `.xlsx` 里，提问时写明表名和关联键。

### 导入飞书多维表格

1. 为机器人应用开通应用身份权限 `bitable:app:readonly`。导入知识库的 `/wiki/` 链接时，还需开通应用身份权限 `wiki:wiki:readonly`，并授予机器人对应知识空间的访问权限。开通权限后重新发布应用。
2. 在表格右上角「更多 → 添加文档应用」授权同一个机器人。应用的 API 权限和具体表格的访问权限需分别配置。启用高级权限时，也要检查目标子表的权限。 [飞书多维表格权限说明](https://open.feishu.cn/document/docs/bitable-v1/faq?lang=zh-CN)
3. 发送原表地址或带预览的链接。可以一起写「分析一下」，也可以只发送链接或 `/导入 链接`，加载后再提问。

```text
https://你的企业.feishu.cn/base/你的AppToken
分析一下
```

整份 Base 链接导入所有子表，概览按表给出发现，有可靠关联键时可跨表计算。带 `table=tbl…` 的链接只导入指定子表。每张子表由 AVA 的 `feishu-bitable` 读取器加载，多表快照使用 AVA 的 SQLite 数据源。数据更新后重新发送链接可刷新快照。 [AVA 数据源文档](https://ava.antv.vision/documentation/data/sources/#feishu-bitable)

发布分享链接（`/share/base/`）需要换成原表地址。普通飞书电子表格可先导出为 XLSX 或 CSV 再上传。

### 在群聊使用

- 将机器人加入群，开通 `im:message.group_at_msg:readonly` 并发布。用飞书 API 调试台调用 `GET /open-apis/bot/v3/info`，把返回的 `bot.open_id` 填到 `.env` 的 `FEISHU_BOT_OPEN_ID`，然后重启。在群里 `@` 机器人提问或导入链接。
- 要让机器人接收无法携带 `@` 的群文件消息，另外开通 `im:message.group_msg` 并发布。也可以在私聊上传文件。
- 私聊与群聊各自保存数据和上下文。机器人在群聊中的回复对群成员可见。

### 支持的文件

| 格式 | 说明 |
| --- | --- |
| CSV、TSV | 第一行为表头，推荐 UTF-8 |
| JSON、JSONL、NDJSON | JSON 推荐对象数组，JSONL 和 NDJSON 每行一个对象 |
| XLSX | 支持多个工作表，旧 `.xls` 请先转换 |
| Parquet | 保留文件中的字段类型 |
| TXT、Markdown | 由模型抽取结构化数据，最多 256 KB，需 UTF-8 |
| SQLite（`.sqlite`、`.sqlite3`、`.db`） | 只读加载数据库中的表 |
| ZIP（飞书附件） | 解压后按文件分析 |

Excel、SQLite 和多子表 Base 首次使用时，DuckDB 会下载对应的官方扩展。运行环境需要能访问扩展服务器，运行用户的主目录需要可写。

### 分析 ZIP 中的文件

上传未加密的 ZIP 后，机器人会列出其中的数据文件。可以在提问时指定文件名，也可以用 `/选文件 <编号>` 先选择文件。遇到同名文件时，请指定 ZIP 内的完整路径。

解压使用 Python 3。单个 ZIP 最多 16 个数据文件，解压后合计不超过 `MAX_FILE_MB` 的三倍，最高 100 MB。

## 实验功能

可以用上传的数据在本机尝试分类或回归训练，并查看交叉验证结果。上传含有目标值的表格后，发送 `/训练 <目标列>`，回归任务加上 `--回归`。

本地训练需要 Python **3.11 或以上**。Docker 镜像已包含训练依赖，本地运行时可用以下命令安装。

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r ml/requirements.txt
```

## 部署与运行

### Docker Compose

配置好 `.env` 后运行以下命令，飞书事件订阅和发布流程与本地启动相同。

```bash
docker compose up -d --build
docker compose logs -f bot
```

容器使用 `/app/data` 保存会话临时文件。保持单实例运行，服务器需要能访问飞书 HTTPS/WSS、配置的模型 API 和 DuckDB 扩展服务器。会话、任务队列和去重记录保存在进程内。

### 常用配置

完整配置见 [.env.example](.env.example)。修改 `.env` 后重启服务。

| 配置 | 默认值 | 含义 |
| --- | --- | --- |
| `MAX_FILE_MB` | `20` | 上传文件大小上限 |
| `MAX_SESSIONS` | `8` | 可同时保留的数据会话数 |
| `SESSION_TTL_MINUTES` | `60` | 会话闲置有效期 |
| `JOB_TIMEOUT_SECONDS` | `180` | 单个分析任务的超时设置，本地训练至多 120 秒 |
| `MAX_RESULT_ROWS` | `500` | 分析结果行数上限，另有限制 512 KB |
| `ENABLE_CHARTS` | `true` | 卡片图表和 HTML 图表导出 |
| `LOG_USER_INPUT` | `true` | 在终端记录用户消息正文 |
| `ALLOWED_USER_IDS` | 空 | 可选的用户 `open_id` 白名单，多个值用逗号分隔 |

同一用户的任务按发送顺序处理，默认同时处理 2 个任务。会话过期、清空或正常停机会清理临时数据，服务重启后需重新上传。意外退出留下的 `data/run-*` 临时目录可在服务停止后清理。

自然语言分析会把问题、数据结构、计算结果和追问上下文发送给配置的模型服务。TXT 和 Markdown 抽取也会发送文本内容。消息日志会遮盖链接和常见凭证，需要关闭正文时设置 `LOG_USER_INPUT=false`。

## 排查问题

| 现象 | 检查方式 |
| --- | --- |
| 私聊发消息没有回应 | 查看终端是否已连接，再检查 `im.message.receive_v1`、发布状态和应用可用范围 |
| 收到消息但附件下载失败 | 核对应用身份的 `im:message:readonly`，日志里有 `requiredScopes` 时按实际缺项处理 |
| 多维表格提示 `BITABLE_API_SCOPE` 或 `99991672` | 检查应用的 API 权限及新版本是否已发布 |
| 多维表格提示 `BITABLE_ACCESS_DENIED` | 在原表给机器人添加文档应用权限，启用高级权限时核对目标子表 |
| 回复「正在分析」后等待较久 | 按同一个 `request_id` 对照 `wait_ms`、`generate_sql`、`execute_sql` 和 `summarize` 的 `duration_ms` |
| 训练提示 `ML_RUNTIME` | 安装 Python 训练依赖，或检查 `ML_PYTHON` 指向的解释器 |

终端的 `message_received` 可以确认收到的文字和附件，`request_id` 可串起队列、分析或训练、飞书回复。`fields_served` 表示字段问题直接用了会话中已有的字段信息。`job_failed` 记录出错阶段、错误码和可用的诊断信息。

## 本地验证

只配置 `.env` 里的模型参数，就能用示例数据验证 AVA，无需飞书凭证。

```bash
npm run analyze -- --file examples/sales.csv --prompt "按地区汇总销售额"
```

结果默认保存在 `output/`，可用 `--out 路径` 指定目录，或用 `--no-chart` 跳过图表生成。开发时可运行 `npm run dev`，它会先编译一次，再监听编译产物。修改 TypeScript 后，在另一个终端执行 `npm run build` 即可触发重启。

```bash
npm run check
npm test
```

测试使用真实 AVA/DuckDB 和模拟服务。安装 Python 训练依赖后，测试也会执行实际的分类和回归训练。测试不需要真实密钥。

[AVA 源码](https://github.com/antvis/AVA) · [飞书 Node SDK](https://github.com/larksuite/node-sdk/blob/main/README.zh.md)
