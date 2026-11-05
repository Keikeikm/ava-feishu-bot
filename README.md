# AVA 飞书数据分析机器人

发送表格文件，然后输入自然语言问题。机器人通过 **AntV AVA 4.0.0 + DuckDB** 生成并执行只读 SQL，返回中文结论、数据预览、CSV 和含 SQL 的 JSON 报告；有可视化需求时，调用 AVA 生成可下载的图表 HTML。支持同一份数据连续追问。

使用飞书官方 Node SDK 的 **WebSocket 长连接**，本地或服务器运行均可，不需要公网回调地址。需要创建有接收消息能力的「企业自建应用机器人」。

```mermaid
flowchart LR
    A[飞书发送表格] --> B[下载与格式校验]
    B --> C[AVA source / schema / profile]
    D[分析提示词与追问] --> E[AVA analyze]
    C --> E
    E --> F[DuckDB 执行只读 SQL]
    F --> G[结论卡片 / CSV / JSON]
    F --> H[AVA visualize / 图表 HTML]
```

## 支持的数据

| 输入 | AVA 接口 | 说明 |
| --- | --- | --- |
| `.csv` / `.tsv` | `csv-file` | 第一行是表头；TSV 使用制表符 |
| `.json` | `json-file` | 推荐对象数组，字段名作为列名 |
| `.jsonl` / `.ndjson` | `json-file` | 每行一个 JSON 对象 |
| `.xlsx` | `excel` | 所有工作表分别加载，可按表名分析或关联 |
| `.parquet` | `parquet` | 保留文件中的类型信息 |
| `.txt` / `.md` | `text` | 由模型抽取结构化数据，最多 256 KB，UTF-8 编码 |
| `.sqlite` / `.sqlite3` / `.db` | `sqlite` | 只读加载 SQLite 中的表 |
| 飞书多维表格链接 | `feishu-bitable` | `/导入 https://企业.feishu.cn/base/...?...`；支持 wiki 中的多维表格 |

Excel 接口支持 `.xlsx`；旧 `.xls` 请先另存为 `.xlsx` 或 CSV。CSV/文本建议使用 UTF-8。Excel/SQLite 首次使用时，DuckDB 会下载官方扩展，运行环境需要能访问扩展服务器，且运行用户的主目录可写。

AVA 还支持 MySQL、PostgreSQL、MongoDB、Supabase、ClickHouse 等数据库连接；此机器人提供的是**文件上传和多维表格链接**入口，未开放在聊天中提交数据库连接凭据的功能。

## 本地启动

要求 macOS / Linux，Node.js **22.13 或以上**。

```bash
cd /Users/keikei/ava-feishu-bot
nvm use
npm ci
cp .env.example .env
```

在 `.env` 中填写：

```dotenv
FEISHU_APP_ID=你的飞书应用AppID
FEISHU_APP_SECRET=你的飞书应用AppSecret
LLM_API_KEY=你的模型APIKey
LLM_MODEL=你的模型标识
LLM_BASE_URL=https://模型供应商的兼容接口地址/v1
```

`LLM_BASE_URL` 填 API 根地址，AVA 会调用其 `/chat/completions`。填写模型供应商提供的地址和模型 ID；接口应支持 Chat Completions 和纯文本 JSON 输出。使用供应商默认地址时可按其配置要求留空。

然后运行：

```bash
npm run build
npm start
```

日志出现「长连接已连接」后可以接收消息。开发时使用 `npm run dev`；修改 TypeScript 后需要重新构建。

## 飞书开放平台配置

1. 打开 [飞书开发者后台](https://open.feishu.cn/app)，创建**企业自建应用**，添加「机器人」能力。复制 App ID 和 App Secret 到本地 `.env`。
2. 在「权限管理」开通以下**应用身份**权限。可以使用 [私聊权限 JSON](docs/feishu-permissions.json) 批量导入。

   | 权限 | 用途 |
   | --- | --- |
   | `im:message.p2p_msg:readonly` | 接收用户发给机器人的私聊消息和文件 |
   | `im:message:readonly` | 通过消息资源接口下载用户发来的附件 |
   | `im:message:send_as_bot` | 回复分析结果 |
   | `im:resource` | 上传分析结果附件等资源 |

   `im:message.p2p_msg:readonly` 控制私聊事件推送，`im:message:readonly` 控制通过消息资源 API 读取附件，`im:resource` 控制资源上传等操作。三者不能互相替代。如果能收到消息但附件下载提示 `99991672`，应根据返回的 `permission_violations` 核对具体缺失权限。

3. 启动本服务。在「事件与回调」中选择**使用长连接接收事件**，订阅 `im.message.receive_v1`（接收消息）。长连接模式下无需填写回调 URL、Verification Token 或 Encrypt Key。
4. 在「版本管理与发布」创建并发布版本，确认当前用户在应用可用范围内；按租户要求完成管理员审核。权限修改后也需要重新发布。
5. 在飞书中打开机器人私聊，先发送 [示例销售表](examples/sales.csv)，待收到「数据已就绪」后输入：`按地区汇总销售额，并画柱状图`。之后可以继续问：`只看华东，按月份比较`。

### 在群聊使用

将机器人加入群，并额外申请 `im:message.group_at_msg:readonly`。填写 `.env` 中的 `FEISHU_BOT_OPEN_ID`（`ou_` 开头），用于区分用户 @ 的是否为当前机器人。可在飞书 API 调试台调用「获取机器人信息」接口 `/open-apis/bot/v3/info`，读取 `bot.open_id`。

群聊中文件消息无法携带 @，因此要在群里直接发送文件，还需要开通 `im:message.group_msg`（接收群聊所有消息）并发布。如果暂时没有此权限，可以先在私聊上传并分析；或者在群里 @ 机器人，使用 `/导入` 读取多维表格链接。普通群聊文字只响应 @ 当前机器人的消息。

会话以「chat_id + 用户 open_id」隔离；群内另一人的提问不会读到你的数据，私聊与群聊也不共用上传文件。机器人在群内回复的分析结果对群成员可见。

### 读取飞书多维表格

额外申请 `bitable:app:readonly`；读取 wiki 链接时还需对应的知识库读取权限（如 `wiki:wiki:readonly`）。在表格的「更多 → 添加文档应用」或协作者设置中，授予此应用读取权限。多维表格的高级权限也可能影响读取范围。

发送：

```text
/导入 https://你的企业.feishu.cn/base/你的AppToken?table=你的TableId
```

加载后继续输入分析问题。加载的是当次数据快照；表格变化后再次 `/导入` 以刷新。普通飞书电子表格链接请先导出为 XLSX/CSV 再发送。

## 对话用法

```text
按地区汇总销售额，并画柱状图
哪些产品利润率最低？请说明计算口径
只看华东，再按月份比较
/分析 不画图 列出销售额最高的前 10 条记录
/字段
/预览
/画像
/建议
/清空
```

`/状态` 显示当前文件和表信息；`/帮助` 查看用法。上传新文件成功后会替换本人的旧数据并清除追问上下文。导入失败会保留旧数据。Excel 多表可直接指定工作表名，例如 `关联“订单”和“客户”，按客户地区统计金额`。

私聊中也可以在同一条消息里附上一个文件并输入分析要求，例如「分析一下这个数据」+ `sales.csv`。机器人会先加载附件，再执行本条消息的分析要求。一次仅导入一个文件；多个工作表请放在同一个 XLSX 中。

每次分析返回：

- 结论卡片：中文说明、结果预览和计算 SQL。
- `analysis-report.json`：问题、结论、SQL、字段、结果数据、截断信息及图表配置。
- `analysis-result.csv`：本次查询返回的数据，可用 Excel 打开。
- `analysis-chart.html`：AVA 判断需要可视化且生成成功时发送，下载后在浏览器打开。图表加载 GPT-Vis CDN，需要联网。

结果默认限制为 500 行和 512 KB；如发生截断，卡片及报告均会标识。CSV 也只包含这部分受限结果。图表失败会保留已完成的分析和数据；图表超时可能释放数据会话，此时需重新上传后继续提问。

## 不连接飞书，单独验证模型和 AVA

只需配置 `.env` 中的模型参数：

```bash
npm run analyze -- --file examples/sales.csv --prompt "按地区汇总销售额，并画柱状图"
```

结果保存到 `output/`。可用 `--no-chart` 关闭图表，或 `--out 路径` 指定目录。示例表的地区销售额应为：华东 **45000**、华南 **20000**、华北 **11000**。

## Docker 部署

填写 `.env` 并完成飞书应用配置后：

```bash
docker compose up -d --build
docker compose logs -f bot
```

不需要映射端口。服务器需能访问飞书 HTTPS/WSS、模型 API 和 DuckDB 扩展服务。使用单实例运行；会话、队列和去重缓存在进程内，多个实例需要额外的共享会话与任务队列设计。

## 运行参数与数据生命周期

完整参数见 [.env.example](.env.example)。默认最多 8 个数据会话，同时处理 2 个用户任务；每位用户最多积压 5 个任务，总队列上限 40。单文件上限 20 MB，闲置会话 60 分钟过期（每分钟清理一次），单次分析上限 180 秒，图表另外最多 60 秒。DuckDB 每个会话限制 256 MB 内存、1 个线程，单次 SQL 上限 30 秒。

文件只写入服务自己的随机会话目录，正常清空、过期、替换或停机时删除。服务重启后需要重新上传。强制终止或机器断电可能留下 `data/run-*` 临时目录，可在服务停止后清理。群聊消息和已经发送至飞书的附件不随 `/清空` 撤回。

可通过 `ALLOWED_USER_IDS` 配置允许使用的用户 open_id。密钥仅在服务端读取，日志不记录原始事件、模型请求或 SDK 错误对象。模型服务会接收问题、数据结构、查询结果和追问上下文；TXT/Markdown 抽取还会发送文本内容。请按你的数据使用要求选择模型服务。

## 验证

```bash
npm run check
npm test
```

测试运行真实 AVA/DuckDB，使用本地受控的 Chat Completions 接口验证 SQL 计算、总结、连续追问及图表，并通过飞书真实 SDK 配合模拟 HTTP 传输检查文件下载、multipart 上传和消息回复。不需要真实 API Key，不会向飞书发送消息。模型输出质量和飞书应用的实际授权，需填入真实配置后联调。

当前已通过 12 项自动测试，包含「文字 + 附件」直接分析、真实 HTTP 文件流经飞书 SDK 下载后由 AVA 读取、文件权限错误识别，并额外使用实际 XLSX 双工作表、Parquet 和 SQLite 文件验证读取与汇总。TypeScript 构建、CLI 帮助入口及 Compose 配置校验通过。本机 Docker daemon 未运行，尚未执行镜像构建或容器启动。

上传失败时，终端日志会区分 `download`（下载）、`source`（读取数据源）、`schema`（字段）、`profile`（统计）和 `preview`（预览）阶段。成功下载会输出 `file_downloaded` 和文件字节数。下载权限不足会明确提示 `FEISHU_DOWNLOAD_PERMISSION`，避免把飞书 API 错误响应当作 CSV 交给引擎。日志不包含原始文件内容或密钥。更新代码后需先 `npm run build`，再停止旧进程并重新 `npm start`，最后重新上传文件。

## 代码入口

| 文件 | 职责 |
| --- | --- |
| `src/main.ts` | 飞书长连接、启动与清理 |
| `src/bot.ts` | 文件上传、聊天命令和回复流程 |
| `src/analysis-worker.ts` | 调用 AVA source/profile/analyze/visualize |
| `src/engine.ts` | 分析线程与超时终止 |
| `src/sessions.ts` | 数据隔离、替换和过期清理 |
| `src/feishu.ts` | 官方 SDK 文件和消息接口 |

接口依据：[AVA 源码与数据源](https://github.com/antvis/AVA)、[飞书 Node SDK 长连接文档](https://github.com/larksuite/node-sdk/blob/main/README.zh.md)、[飞书消息权限说明](https://open.feishu.cn/document/develop-robots/add-bot-to-external-group)、[消息文件下载](https://open.feishu.cn/document/server-docs/im-v1/message-resource/get)。项目锁定 AVA 4.0.0；API 使用 `source()` / `analyze()`，与早期版本的加载方法不同。

## 使用 DeepSeek API Key

已预设 DeepSeek 官方接口。在本地 `.env` 中填写自己的 API Key：

```dotenv
LLM_API_KEY=你的DeepSeek_API_Key
LLM_MODEL=deepseek-flash
LLM_BASE_URL=https://api.deepseek.com
```

API Key 可在 [DeepSeek 开放平台](https://platform.deepseek.com/api_keys) 创建。模型名与接口地址依据 [DeepSeek 官方接入文档](https://api-docs.deepseek.com/zh-cn/)；可将模型改为 `deepseek-v4-pro`。AVA 的 Chat Completions 接入代码无需修改。保存 `.env` 后重启机器人生效。

