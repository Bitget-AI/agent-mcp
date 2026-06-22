# 真网 E2E 测试框架（agent-mcp · 测「出货的 MCP server 能否被 host 正确驱动」）

这个目录是一套**独立可重复运行**的端到端跑数器，测的对象是**本仓库出货的 MCP server 本身**——
即编译产物 `lib/index.js`（发布为 `bitget-agent-mcp` 这个 bin）。这套 e2e 完全以**真实 AI host
（Claude Desktop / Cursor / Continue）**的身份,用官方 `@modelcontextprotocol/sdk` 的 `Client` +
`StdioClientTransport`,**把 server 当子进程拉起来并通过 stdio 说 Model Context Protocol**——
`initialize` 握手 → `tools/list` → `tools/call` → `prompts/*` → `logging/setLevel`——对接**真实的
Bitget API**,产出 `e2e-reports/report-<时间戳>.md`(人读) + `.json`(机读)质量报告。

> **它和 agent-cli / agent-skill 的 e2e 有什么不同?** agent-cli 的 e2e 证明 **`bgc` 二进制**守约,
> agent-skill 的 e2e 证明 **SKILL 文档**忠实;本仓库出货的是**一个 MCP server**,所以它的第一阶段是
> **别处没有的 Phase 0「MCP 协议一致性」**:验证 host 连上的**那一刻**就依赖的线协议契约——
> `serverInfo` 身份、`initialize` 能力声明与 instructions、intent 工具表面与由 `riskLevel` 推导的注解、
> `discover` 四级渐进钻取与自描述契约、`prompts`、`logging` 通知门、未知工具的结构化错误信封、
> `--surface full` 的 1:1 层。一个 server 再能干,只要线契约错一条(比如把 SDK 身份泄漏成自己的名字、
> 或 `order` 动词的 `readOnlyHint` 标反),就会**误导每一个连接它的 host**——这一相就是防这种「线契约漂移」
> 的护栏,且**永不降级为 🟡**。
>
> 除 Phase 0 外,后续阶段(连通性 / 只读扫描 / 场景断言 / 写回环 / 安全闸门 / 子账户生命周期)几乎
> **原样移植自 agent-cli / agent-skill 的 e2e**(`cases.mjs` / `suites.mjs` **与之同源**),唯一的替换是
> **传输层**:那两套分别跑子进程 argv / 子进程 `bgc`,这里则**像 host 一样开一个长连的 stdio MCP 会话**,
> 把每个工具结果的文本通道(`JSON.stringify(SafeResult)`)归一成同形的
> `{ ok, data, endpoint, error, latencyMs }`。

---

## 被测对象:出货的 MCP server,经真实 stdio MCP 会话驱动

```
本仓库出货物                              真实 host 的连接方式(本 e2e 扮演)
┌─────────────────────────┐              ┌────────────────────────────────────┐
│ lib/index.js            │   stdio MCP   │ @modelcontextprotocol/sdk Client     │
│ (bin: bitget-agent-mcp) │ ◄──────────► │  + StdioClientTransport              │ ──► Bitget API
│  薄适配器 over agent-sdk │  线协议       │  spawn `node lib/index.js [flags]`   │
└─────────────────────────┘              └────────────────────────────────────┘
         ▲                                          ▲
         │ Phase 0 校验「线协议契约对不对」              │ Phase 1+ 校验「真调起来通不通」
         └──────────────────── 本 e2e ─────────────────┘
```

跑这套 e2e **前提是先构建出 `lib/index.js`**(被测的就是出货产物,不是 src):

```bash
pnpm run build                      # 产出 ./lib/index.js(正常路径)
# 或用 MCP_BIN 指向任意构建/安装:
#   MCP_BIN=/abs/path/to/lib/index.js  node e2e/run.mjs
#   MCP_BIN=bitget-agent-mcp           node e2e/run.mjs   (全局安装的 bin)
```

`mcp.mjs` 的解析顺序:`$MCP_BIN` → 本包的 `./lib/index.js`(tsup 构建) → `$PATH` 上的 `bitget-agent-mcp`。
都找不到会直接报错并打印构建/安装指引。

> **性能提示**:MCP 握手代价不低,所以 harness **按 server 配置(modules / surface / readOnly /
> paperTrading × 凭据覆盖)缓存一个长连会话**并复用;只有无凭据探针、readOnly 闸门、`--surface full`
> 检查、独立的 logging 探针会各自开一个专属子进程。跑完由 `closeAll()` 统一拆除所有子进程。

---

## 三套测试套件

| 套件 | 命令 | 模式 | 写操作 | 特殊阶段 |
|------|------|------|--------|----------|
| `paper` | `E2E_SUITE=paper`(默认) | `--paper-trading` 虚拟资金 | 无 | 协议一致性 + 仅读 + 场景断言 + 安全闸门 |
| `agent-sub` | `E2E_SUITE=agent-sub` | 实盘 agent 子账户 key | 真实下单回环 + 策略单 | - |
| `main` | `E2E_SUITE=main` | 实盘主账户 key | 真实下单回环 + 策略单 + **子账户生命周期** | 创建→读→验证→删 API key |

三套件都会跑这条统一流水线(按套件能力门控后续阶段):
**MCP 协议一致性(Phase 0) → 公共连通性 → 只读扫描 → 场景断言 → 写回环 → 安全闸门 →(仅 main)子账户
生命周期**。其中「真实下单回环」是一条完整的实盘生命周期:**place(真实挂单)→ 查单(确认进了未成交
列表)→ detail(查详情)→ cancel(撤单)→ 确认消失**。

**Phase 0 在每个套件上都跑**——它是确定性的线协议黑盒(最多触及公共读),是本仓库唯一独有、也最该先看
的一相。

**向后兼容**:旧的 `E2E_LIVE=1` 等价于 `E2E_SUITE=agent-sub`。

---

## Phase 0 · MCP 协议一致性:测「线契约对不对」(本仓库独有)

被测对象是一个 MCP server,所以第一阶段(`protocol`)先验证**host 连上即依赖的线协议契约**。十组检查,
任何一项失败都是**硬 ❌(永不降级为 🟡)**——因为一条线契约错误会误导**每一个**连接它的 host:

| 检查 | 在验证什么 |
|------|-----------|
| `serverInfo-identity` | `initialize` 回的 `serverInfo` 是**本包身份**(`bitget-agent-mcp` @ package.json 版本),**不得泄漏** SDK 的 `bitget-agent-sdk` 身份。 |
| `capabilities` | `initialize` 声明了 `tools` + `logging` + `prompts` 三项能力。 |
| `instructions-briefing` | `initialize.instructions` 教授 `discover`→verb 工作流与写安全(`confirm`/`raw`)——host 启动即拿到使用指引。 |
| `intent-surface` | `tools/list` 暴露的是**意图动词**(`market`/`order`/`position`/`account_overview`/…)+ `raw` + `discover`,**而非** 1:1 端点;且未泄漏 `getTickers`/`spot_get_ticker`/`system_get_capabilities` 这类工具。 |
| `riskLevel-annotations` | 工具注解由 SDK 的 `riskLevel` 推导(**非** `isWrite`):`order`=write(`readOnlyHint:false`),`market`/`account_overview`=read(`readOnlyHint:true`)。 |
| `discover-domains` / `discover-drilldown` | **承重检查**:黑盒 `discover` 的四级渐进披露——`discover({})`→域,`discover({domain})`→动词,`discover({tool})`→action 枚举,`discover({tool,action})`→精确契约(`operationId` + `required[]` + `optional[]` + `requiresConfirm:boolean`);**遍历每个动作型动词的每个 action**,任何一个投影不出契约 = agent 据此盲填。 |
| `self-describing-contract` | 每个投影字段都带 `type`/`enum`(仅 `fields` 视图控制豁免)、`description` 覆盖 100%、核心枚举(`order/place` 的 side/orderType/category)齐备、且至少有一个高危 action 标注 `requiresConfirm:true`。 |
| `prompts` | `prompts/list` 暴露 `account_snapshot` + `pre_trade_check`;`getPrompt` 渲染出含 symbol 的 `user` 消息。 |
| `logging-notification` | `logging/setLevel(debug)` 后调用工具,server 确实把生命周期钩子转成 MCP 日志通知(含 `logger`/`level`)。 |
| `unknown-tool-error` | 调用不存在的工具返回 `ok:false` 的结构化错误信封并指向 `discover`。 |
| `surface-full-tier` | 另起一个 `--surface full` 的 server 配置,确认它**同时**暴露 1:1 生成层(如 `getTickers`)与 intent 动词(`market`)。 |

> Phase 0 的每一项都是**确定性保证**,不是真网行情探针,所以 `report.mjs` 从不把 `protocol` 失败降级为
> 🟡——一条失败直接升级为报告末节的 **high** 级发现。

---

## 为什么它是安全的

危险操作**根本不在任何代码路径里**(安全靠构造,而非靠开关):

- **Phase 0 协议一致性**:确定性线契约黑盒,最多触及公共读。
- **只读扫描**:对 catalog 里所有 `!isWrite` 的操作,经 `raw({operationId, args})` 逐个调用(公共读无 key
  也跑;私有读缺 key 自动跳过并在报告标注)。
- **实盘写回环**:仅 `order` 动词的完整生命周期 `place → 查单 → detail → cancel → 确认消失`,且为**远离
  市价的限价买单**(默认市价的 50%,绝不 ≥ 90%)、**最小下单量**、**秒级撤单**。实盘名义价值上限 60 USDT。
  下单后真的去未成交列表把它**查出来**(断言状态非「已成交」),撤单后再查一次**确认它真的消失**——
  不只看「接口返回 200」,而是验证交易所侧的真实状态流转。
- **策略单(TP/SL)**:仅 `type:"tpsl"`(挂止盈止损到已有持仓),不传 `side`/`triggerPrice`,无法开仓——
  零市场敞口。无持仓时交易所直接拒绝(良性)。
- **子账户生命周期**(`main` 套件):创建 Agent 子账户 → 验证出现在列表 → 验证 API key → 清理 key。
  子账户本身保留(无 delete-sub-account API),不含资金划转。
- **安全闸门验证**(不产生任何真实写):`order {action:cancelAll}` 不带 `confirm` → `confirmationRequired`;
  `--read-only` 下写 → `ValidationError`;`{dryRun:true}` → 返回预览不发送;无凭据私有调用 → `ConfigError`。
- **永不执行**:所有高危操作 + 所有资金类(划转 / 提币 / 借贷)。列入「跳过清单」透明可审计。

---

## 场景层:不只看「接口通不通」,还要看「数据对不对」

只读扫描只验证「每个接口能调通」。**场景层**(`scenario` 阶段,贴近真实 agent 使用习惯的业务流)在此之上
断言**业务级不变量**而非 HTTP 200——比如「卖一不该低于买一」「最新价该落在盘口买卖一之间」「最大可开必须
非负」。场景定义在 `cases.mjs` 的 `SCENARIOS` 数组(与 agent-cli / agent-skill 同源),断言失败标为
`ScenarioAssertError`/`AssertionError`——**这类失败永远是 ❌,绝不降级为 🟡**。

| 领域 | 用例(断言要点) |
|------|------|
| **market**(公共,无 key 也跑,9 条) | 现货/合约最新价为正 · 盘口买一卖一齐全且卖一≥买一 · K线最高≥最低 · 资金费率有效 · 持仓量为正 · 交易对清单>100 且含 BTCUSDT · 最近成交价为正 · **价格自洽**(链式:先 ticker 再 orderbook) |
| **account**(私有读,缺 key 自动跳过,4 条) | 账户总览权益是数字 + 账户模式齐全 · 合约 maker/taker 费率是数字 · 手续费抵扣开关有值 · 可抵扣币种列表非空 |
| **trade**(私有读 + dryRun,6 条) | 未成交委托返回 list 数组 · 历史订单含 orderId/symbol · 成交明细调用成功 · 当前持仓调用成功 · 合约最大可开非负 · **下单预览(dryRun) 生成正确委托但绝不发送** |

---

## 需要配置什么

### 1. 准备 API Key

三套件各需不同的 key。你只需准备三个变量 `BITGET_API_KEY` / `BITGET_SECRET_KEY` /
`BITGET_PASSPHRASE`,按套件给足权限:

| 套件 | Key 类型 | 所需权限 |
|------|----------|----------|
| `paper` | 模拟盘 API Key | 交易(读写) |
| `agent-sub` | 实盘 agent 子账户 API Key | 交易(读写) |
| `main` | 实盘主账户 API Key | 交易 + agent 子账户管理 |

> `paper` 不配 key 也能跑(Phase 0 协议一致性 + 公共只读 + 场景 + 安全闸门,私有读自动跳过)。

### 2. 把凭据放进一个本地文件

自己建一个 shell 可 `source` 的文件,内容就是这三个变量(用 `export` 让它们进入子进程环境,
server 才读得到):

```bash
export BITGET_API_KEY="你的 API Key"
export BITGET_SECRET_KEY="你的 Secret Key"
export BITGET_PASSPHRASE="你的 passphrase"
```

- 模拟盘建议命名 `e2e/.env-paper`。
- 实盘凭据请**自行命名、自行保管**;本仓库**不预置、也不记录任何实盘凭据文件名**。
- 凡是 `.env` 开头的文件都已被 `.gitignore` 忽略(规则 `.env` / `.env.*` / `.env-*`),怎么命名都不会误提交。
- 凭据**绝不落盘到报告**:apiKey 只显示前 4 位指纹 + 长度,secret/passphrase 仅显示「已配置 / 缺失」。
- harness **绝不读取** `.env-*` 文件内容;凭据只经 shell `source` 注入环境,再由 `mcp.mjs` 从已加载的
  `process.env` **转发**进 spawn 出的 server 子进程。

### 3. source 加载后运行

```bash
pnpm run build   # 先构建出 lib/index.js(被测产物)

# 模拟盘(默认;不 source 也能跑 Phase 0 + 公共读)
source e2e/.env-paper && pnpm run e2e:paper

# 实盘 agent 子账户(换成你自己的实盘凭据文件)
source <你的子账户凭据文件> && E2E_ALLOW_WRITES=1 pnpm run e2e:live

# 实盘主账户(换成你自己的主账户凭据文件)
source <你的主账户凭据文件> && E2E_ALLOW_WRITES=1 pnpm run e2e:main
```

---

## 如何运行

```bash
# 先构建(被测的是产物 lib/index.js):
pnpm run build

# 跑(默认 paper 套件):
pnpm run e2e                            # = node e2e/run.mjs(paper 默认)
pnpm run e2e:paper                      # 模拟盘
pnpm run e2e:live                       # agent 子账户(E2E_SUITE=agent-sub)
pnpm run e2e:main                       # 主账户
# 直接调:
node e2e/run.mjs                        # paper(默认)
E2E_SUITE=agent-sub node e2e/run.mjs    # agent 子账户
```

- **不配任何 key** 也能跑:只做 Phase 0 协议一致性 + 公共只读 + 场景 + 安全闸门,私有读全部 skip。
- **必须先 `pnpm run build`**——被测对象是出货产物 `lib/index.js`。改了 `src/**` 要重新 build;只改 e2e
  的 `.mjs` 则立即生效。
- 报告写到 `e2e-reports/report-<ISO 时间戳>.md` 和 `.json`,**按时间戳归档,重跑不互相覆盖**。
- 退出码:`0` = **通过**(0 项真实缺陷且公共行情连通);`1` = **有真实缺陷待查**,或框架级故障
  (server 入口未找到 / 公共行情连不通)。

---

## 如何读报告:只看判定行

报告顶部和控制台都会打印一行**判定**,这是你平时唯一需要看的东西:

- `✅ 判定:通过 — 0 项真实缺陷` → 全绿:线协议守约、server 无缺陷。
- `❌ 判定:失败 — N 项真实缺陷待查` → 有 N 个需排查的问题,见报告末节「发现的问题」。

用例状态分四档:

| 状态 | 含义 |
|------|------|
| ✅ pass | 真实成功 |
| 🟡 预期内(xfail) | **预期内的失败,已自动截获**:模拟盘未托管该端点 / 账户无资金或无持仓 / 子账户无权访问主账户端点 / 通用取样器猜不中真实 orderId 等环境·取样·权限限制,**非协议/SDK 缺陷**,不计入失败。 |
| ❌ fail | **真实缺陷**,需排查。判定行只数这一档。 |
| ⏭️ skip | 主动跳过(缺 key 的私有读 / 高危写操作,永不执行) |

**判定很保守**——只有满足**全部**条件的失败才会降级为 🟡:发生在真实 API 调用阶段(读/写/子账户/场景)、
不是鉴权失败、不是 `InternalError`、不是 `AssertionError`、且错误消息能归入已知良性类别。
**MCP 协议一致性(Phase 0)、安全闸门**这类**确定性保证**一旦失败永远是 ❌,并会被升级为报告末节的 **high**
级发现;任何**全新、未归类的失败(unknown)**也保持 ❌——绝不被悄悄吞掉。

---

## 可调环境变量

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `E2E_SUITE` | `paper` | 套件选择:`paper` / `agent-sub` / `main` |
| `MCP_BIN` | 无 | 显式指定 server 入口;`*.js`/`*.mjs` 用 `node` 跑,否则当可执行文件。不设则用本包 `./lib/index.js`,再退而求 `$PATH` 上的 `bitget-agent-mcp` |
| `BITGET_API_KEY` / `BITGET_SECRET_KEY` / `BITGET_PASSPHRASE` | 无 | 三密钥(须 `export` 进子进程环境) |
| `E2E_ALLOW_WRITES` | `0` | 设 `1` 开启真实下单回环(place→查单→detail→cancel→确认消失) |
| `E2E_LIVE` | `0` | (已废弃,向后兼容映射为 `agent-sub`) |
| `E2E_SYMBOL` | `BTCUSDT` | 测试交易对 |
| `E2E_MARKETS` | `SPOT,USDT-FUTURES` | 写回环覆盖的市场(逗号分隔) |
| `E2E_SIZE` | `0.001` | 下单量(SPOT 固定 0.0002,不受此变量影响) |
| `E2E_PRICE_FACTOR` | `0.5` | 限价 = 市价 × 该系数(自动钳制 ≤ 0.9) |
| `E2E_DELAY_MS` | `80` | 调用间隔(毫秒),降低限频风险 |
| `E2E_CLI_TIMEOUT_MS` | `30000` | 单次 MCP 请求的硬超时(毫秒) |
| `BITGET_API_BASE_URL` | Bitget 默认 | 覆盖 API 基址 |
| `BITGET_TIMEOUT_MS` | `15000` | server 单请求超时(毫秒) |

---

## 经验与结论(写给后来扩充的人)

1. **被测的是产物,不是源码。** `link:../agent-sdk` 解析到的是 SDK 的**编译产物** `lib/`;本仓库被测的也是
   `lib/index.js`。改了任何 `src/**`(本仓库或 SDK),都要先 `pnpm run build` 再跑 e2e,否则测的是旧产物。

2. **MCP 协议一致性失败是硬 ❌,绝不降级。**
   `report.mjs` 的 `isExpectedFailure` 只允许降级 `read`/`write`/`subaccount`/`scenario` 四个真网阶段;
   `protocol` / `connectivity` / `gate` 一律保持 ❌,且每条 `protocol` 失败升级为 **high** 发现。理由:
   线契约错一条,连它的 host 全错——这比任何环境噪声都严重。

3. **会话要缓存,但探针要隔离。** MCP 握手昂贵,所以同配置复用一个长连会话;但无凭据探针(`NO_CREDS`
   覆盖)、readOnly 闸门、`surface=full`、logging 探针必须各开**专属子进程**——`mcp.mjs` 用
   `{args, env, probe}` 三元组做 sessionKey 保证这点(`__probe` 不进 server 参数,只改缓存键)。

4. **先探明真实形态,再写硬断言(probe-before-assert)。**
   把任何硬断言写进用例前,先打一次真网看清真实字段名和结构,不要照文档猜。靠猜写出来的断言会制造假 ❌。

5. **🟡(xfail) 是「环境注定的失败」,不是「失败的垃圾桶」。**
   降级极度保守:协议一致性、安全闸门、`AssertionError`、`unknown`、鉴权失败、`InternalError` 一律
   **保持 ❌**。**不要**为了「跑绿」去放宽 `classifyApiFailure`。

6. **`--read-only` 与 `--paper-trading` 互斥。**
   「readOnly 拒绝写」这条闸门用例必须用一套**干净的全局标志**(`{ modules:"all", readOnly:true }`,
   不带 paper 套件的 paperTrading),否则 server 会拒绝(两者互斥)。这是移植时最容易踩的坑。

7. **限频会咬人。** 公共行情一旦连不通,框架判定后续真网结果「均不可信」并直接 ❌——这是框架级保护。
   用 `E2E_DELAY_MS` 拉大间隔;连不通时隔几分钟再跑。

8. **凭据只 `export` + `source`,绝不用工具读取文件。**
   任何含密钥的文件(`.env-*`)只通过 shell `source` 注入环境变量(且须 `export` 才能进 server 子进程),
   **绝不**用编辑器/读文件工具打开。报告里凭据一律脱敏,绝不落盘。

9. **`cases.mjs` / `suites.mjs` 与 agent-cli / agent-skill 的 e2e 保持同源。** 若那边更新了用例,直接覆盖
   过来即可;本仓库独有的只有 `protocol.mjs`(Phase 0)和 `mcp.mjs`(stdio MCP 会话适配层)。

---

## 文件结构

```
e2e/
  mcp.mjs       【本仓库独有】解析并驱动出货 server 的 stdio MCP 会话(MCP_BIN → ./lib/index.js → $PATH bin);
                按配置缓存长连会话;把工具结果文本通道(SafeResult)归一成 { ok, data, endpoint, error, latencyMs }
                (导出 getClient / invoke / parseToolResult / resetLogs / closeAll / MCP_ENTRY)
  protocol.mjs  【本仓库独有】Phase 0 MCP 协议一致性:initialize 身份/能力/instructions + 工具表面 + riskLevel 注解
                + discover 四级钻取 + 自描述契约 + prompts + logging 通知 + 未知工具信封 + surface=full(导出 runProtocolConformance)
  suites.mjs    三套件定义与 resolveSuite()(与 agent-cli / agent-skill e2e 同源,Phase 0 改为 protocol)
  cases.mjs     声明式注册表:读扫描取样器 + 场景断言(SCENARIOS) + 写步骤 + 子账户生命周期 + 跳过规则(同源)
  report.mjs    结果 → Markdown + JSON;凭据脱敏;预期失败截获为 🟡;protocol 失败升级为 high;自动归纳「发现的问题」
  run.mjs       编排(异步):读 env → resolveSuite → Phase 0 协议一致性 → 分阶段驱动 server(按 suite.phases 门控)→ 收集 → 报告 → closeAll
  README.md     本文件
  .env-paper    模拟盘凭据(不落版;实盘凭据请自建文件,命名随意,.env* 一律被 gitignore)
e2e-reports/    产出目录(已 gitignore)
```

## 扩展点

要纳入更多写操作,在 `cases.mjs` 的注册表里加条目即可,`run.mjs` 和 `report.mjs` 会自动覆盖。
高危集合与资金类永远在跳过清单里,不要解除。若**改了 `src/**`**,记得 `pnpm run build` 后再跑——
Phase 0 会自动重测线契约,新增的动词/action 只要 discover 能投影出精确契约就会通过,漏标 `requiresConfirm`
或泄漏 SDK 身份则当场 ❌。
