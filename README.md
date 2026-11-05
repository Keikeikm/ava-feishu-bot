# AVA 飞书数据分析机器人

把表格和问题发给飞书机器人，就能收到结论、关键依据和交互图表，也可以围绕同一份数据继续追问。机器人用 **AntV AVA 4.0.0 + DuckDB** 计算结果，用 DeepSeek 或其他兼容模型理解问题和撰写结论。分类和回归模型都可以在本机训练和评估。

[快速开始](#快速开始) · [在飞书使用](#在飞书使用) · [训练模型](#训练模型) · [部署与运行](#部署与运行) · [排查问题](#排查问题) · [本地验证](#本地验证)

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

1. 为机器人应用开通应用身份权限 `bitable:app:readonly` 并发布。对于 `/wiki/` 链接，还要配置对应的知识库读取权限（如 `wiki:wiki:readonly`）和知识空间访问权限。
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
| ZIP（飞书附件） | 解压后按文件分析，或用训练集和测试集生成提交文件 |

Excel、SQLite 和多子表 Base 首次使用时，DuckDB 会下载对应的官方扩展。运行环境需要能访问扩展服务器，运行用户的主目录需要可写。

### 上传 ZIP 并生成提交文件

直接上传未加密的 ZIP。只发附件时，机器人列出数据文件并询问用途。提问时可以直接写「请你帮我对 train.csv 进行数据探索性分析」，也可以发送 `/选文件 1` 后提问。如果有多个同名文件，写明 ZIP 内的完整路径，例如 `data/train.csv`。

若 ZIP 包含 `train.csv`、`test.csv` 和 `sample_submission.csv` 或 `gender_submission.csv`，发送「请用机器学习预测」或 `/预测`。指令可以和附件一起发送，也可以等机器人解压后再发。CSV 需为 UTF-8，文件可放在 ZIP 的子目录里。

机器人从提交模板和训练集确定单个目标列，在训练集上交叉验证选模型，再用完整训练集拟合，为测试集生成预测。模板提供列名和 ID 顺序，预测写入飞书回传的 `submission.csv`。飞书回执里的分数来自训练集交叉验证。若需明确目标和任务类型，可发送 `/预测 --目标 Survived --分类` 或 `/预测 --目标 SalePrice --回归`。

预测回执会说明本轮实际使用的模型。发送 `/模型` 或「刚才用了什么模型训练」可查看当前数据会话上一轮的模型和交叉验证分数。每次 `/预测` 都在本机重新训练，会话只保留预测结果和评估记录。

同一会话中发送 `/对比 gender_submission.csv`，或直接说「请检验一下预测结果，答案在 gender_submission.csv」，会用上一轮预测按 ID 对齐文件并计算一致率。Kaggle 的 `gender_submission.csv` 是按性别规则生成的提交示例。要计算真实准确率，可以把带有同一测试集 ID 和真实目标值的 CSV 与 `/对比` 一起发送。对照文件的行顺序可以不同，ID 必须非空、唯一且完整匹配。 [Kaggle 数据说明](https://www.kaggle.com/c/titanic/data?select=gender_submission.csv)

解压使用 Python 3，训练依赖见下节。单个 ZIP 最多 16 个数据文件，解压后合计不超过 `MAX_FILE_MB` 的三倍，最高 100 MB。预测流程中，每份 CSV 最多 5,000 行、8 MB。

## 训练模型

本地运行时使用 Python **3.11 或以上**安装训练依赖。项目的 Dockerfile 已包含这一步。

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r ml/requirements.txt
```

上传含有目标值的表格，再告诉机器人预测哪一列。

| 任务 | 指令示例 | 评估卡 |
| --- | --- | --- |
| 分类 | `/训练 是否流失` | 比较多数类基线、逻辑回归和随机森林，展示宏平均 F1、平衡准确率、准确率和各类别误判 |
| 回归 | `/训练 MEDV --回归`，或「请帮我训练一个机器学习模型。目标字段是 MEDV（自住房屋中位数价值）。这是一个回归任务。」 | 比较中位数基线、岭回归和随机森林，展示 MAE、RMSE、R² 和模型误差图 |

训练使用一张表。如果多个子表有同名目标列，可用 `--表` 指定，例如 `/训练 MEDV --回归 --表 "房价"`。

AVA 从当前快照读取数据，本地 Python 用 scikit-learn 做交叉验证。预处理在各训练折内完成，相同特征的记录留在同一折。这个流程独立于 DeepSeek，产出是评估报告。可通过 `ML_PYTHON` 指定 Python 路径，默认优先用项目里的 `.venv/bin/python`。

单次训练最多 **5,000 行、80 个特征、4 MB**，至少需要 **30 条有目标值的记录**。分类目标需要 **2～8 个类别**，每类至少 **5 条**。回归目标需要是有变化的数值。

[titanic.csv](examples/titanic.csv)适合测试标签检查。它的 `Survived` 列与 Kaggle 按性别生成的示例预测一致，执行 `/训练 Survived` 会提示核对标签并停止训练。评估历史生还预测需要有可验证标签的数据。 [Kaggle 数据说明](https://www.kaggle.com/competitions/titanic/data)

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
