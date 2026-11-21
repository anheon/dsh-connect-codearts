# 更新日志

本项目遵循语义化版本。日期是发布日（Asia/Shanghai）。

## 0.1.5

- 在账号页新增快捷设置。保存积分胶囊开关、自动刷新间隔和每模型默认思考档位后立即生效。
- 分开显示可用积分、统计总额、已用积分和即将到期金额。没有返回的字段显示为未知。

## 0.1.4

- 签到页按码道账号的实际状态显示「今日已签」或「今日未签」。
- 新用户注册奖励按接口返回的金额和领取状态显示，领过后标为「已领」。
- 打开签到页时刷新福利状态。查询失败时标为「状态待确认」。

## 0.1.3

- 在模型页保存模型可见性。目录刷新与重启后保留偏好。
- 增加自动签到开关，支持启动检查、定时重试和本机保存，手动领取仍可用。
- 修复图片附件丢失、并行工具调用遗漏、CRLF 分帧和流中断误报成功。
- 本机接口接入 DSH 会话鉴权，兼容桌面端请求转发，修复保存模型时报 HTTP 403。
- 自定义网关使用 HTTPS。刷新凭据后按账号更新缓存，目录请求失败时保留最近一次成功目录。
- 补充安装、排查、隐私、设计与协议说明。

## 0.1.2 — 未发布

这一版补的是三处「已声明但没接线」的缺口 —— 它们都不是新功能，而是写好了却没
人调用的代码。

### 新增

- **签到页签**。`src/upstream.ts` 的 `welfareItems()` / `claimWelfare()` 早就写好
  了，但一直没有路由出口和界面，等于死代码。现在设置页多了「签到」页签：打开只
  发 GET 拉列表，只有点「领取」才走新加的 POST 路由
  `/plugins/dsh-connect-codearts/welfare/claim`。活动按 `type === 'USER_LOGIN'`
  识别而不是硬编码 `campaignId`（M0 实测当时是 34，但那是华为当时的值）。
- **配置展示区**。`enabled` / `showCredits` / `pollIntervalMs` / `gateway` /
  `defaultEfforts` 这五个字段以前只能手改 `cordis.patch.yml`，改完还得重启，
  而且无从确认「现在到底是开着还是关着」。账号页签底部现在把它们报出来。

### 修复

- **重复签到不再显示「原因未知」**。真机点了一次今天已经签过的签到，界面弹出
  「领取失败，原因未知」——因为 `claimWelfare()` 在 HTTP 200 且业务码非 0 时
  直接把整个响应体丢掉了，只留一个 `{ok:false}`。用户看不出这是「已经领过了」，
  只会以为插件坏了。现在新增 `classifyBusinessRejection()`（`src/protocol/errors.ts`）
  走独立的分类路径，与「请求失败了」的 `classifyError()` 分开：`kind: 'rejected'`
  表示「请求成功了，但服务端说这件事不能做」。已领取给的是「这个活动今天已经
  领过了，不用再点」，活动过期给「不是插件的问题」，认不出来的业务码则把原文
  与业务码一起透出来，绝不吞掉。
- **`showCredits` 终于生效了**。它此前只在类型和 z schema 里出现过一次，全项目
  零消费者 —— 配置里关掉它，输入框旁的积分胶囊照样显示。现在 status 路由多报一段
  `settings.showCredits`，胶囊在同一个响应里读到并按它显隐（不额外发请求）。
  注意语义：只有明确的 `false` 才隐藏，读不到时**继续显示** —— 一次网络抖动
  让读数闪没会被当成坏了。

### 测试

- 新增 `tests/welfare-claim.spec.ts`（17 项）。钉的不是「能不能领到」（那要真打
  网关），而是「什么情况下绝对不能发出去」：GET/HEAD 一律 405、非回环 Host 403、
  八种非法 body 一律 400，**每一条都额外断言领取实现没被调用** —— 拒得响但已经
  把签到点掉是最糟的组合。
- `tests/web-status.spec.ts` 增至 15 项，覆盖 `settings` / `welfare` 两段的正常
  路径、抛错降级、以及「没传依赖时报 null 而不是空对象」。

### 变异验证

- 把方法闸改成放行 GET → `welfare-claim.spec.ts` 立刻红（`- 405 / + 200`）。
- 更严的一条：在方法闸**之前**插一句无条件领取 → 12 项红，报
  `Number of calls: 1`。证明「断言领取没被调用」这句真的会咬，不是摆设。

## 0.1.1 — 未发布

### 修复

- **积分胶囊不再常驻**。之前它无条件渲染，用 DeepSeek / WorkBuddy 模型时输入框
  右侧也挂着一枚「码道 13,595」。现在由 `src/client/credits-gate.tsx` 读宿主的
  `modelSelection` 投影，只在当前会话选中码道模型时渲染（`next` 优先于
  `lastUsed`；判不出来时不显示）。槽位本身仍无条件注册 —— 注册时读不到模型，
  在模型变化时反复注册/注销会闪。
- 若宿主不再向 `conversation.input.right` 注入 `useProjection`，打一次
  `console.info` 说明「读不到模型因此不显示」，不再静默。

### 测试

- 新增 `tests/credits-gate.spec.tsx`（10 项，纯判定）与
  `tests/credits-gate-render.spec.tsx`（5 项，`react-dom/server` 真渲染）。
  后者是必需的：纯函数测试证明判定对不对，而这个 bug 是「组件没用判定」，
  两者之间隔着一次 React 渲染。主诉验收断言 DeepSeek 下渲染结果是空串。
- 测试总数 149 → 154。

## 0.1.0

首个可用版本。M0 阶段在本机对真实网关做了逐端点实测，M1 按实测结论实现；
所有「上游怎么表现」的判断都有 `probe/` 下的探针脚本可复现。

### 连接

- 用华为云 IAM **长期 AK/SK** 直连码道网关
  `https://snap-access.cn-north-4.myhuaweicloud.com`，请求按 APIG
  `SDK-HMAC-SHA256` 签名。不走 OAuth、不读客户端登录态、不做 token 刷新。
- **凭据四级探测**：环境变量 → Windows 注册表 `HKCU\Environment` →
  `$DSH_HOME/.codearts-credentials.json` → 控制台导出的 CSV。
  第二级是为了绕开「Windows 上改环境变量对已运行进程无效」这个坑：DSH 通常比
  用户配 AK/SK 启动得早，`process.env` 里永远是空的。
- **不签 `maas_type: benefit`**。四组凭据的对照实测表明，IAM AK/SK 只有在
  不签这个头时才能正常对话；签了会得到 `InferHub.4004.200 benefit not found`。
- **查询串参与签名**。参考实现都把 `CanonicalQueryString` 写成空字符串，所以
  任何带 query 的请求（例如签到列表）都会 401 —— 现象是「同一路径不带参数能过、
  带参数过不了」。

### 模型

- 目录来自 `GET /v1/model/builtin`，`contextWindow` / `maxTokens` /
  `supports_images` / 积分倍率都是网关直出的**真实值**，不用内置快照表。
- 走宿主 `registerModelDiscovery`，**刷新目录点击即生效**，不需要重启 DSH。
- 模型名内嵌积分倍率（`GLM-5.3 · 0.79x`）。系数跨度很大（最便宜 `0.07x`、
  最贵 `2.38x`，差 34 倍），选错一次代价很实在。
- 逐模型推理档位来自 `POST /v1/model/thinking-variants`；只有上游真声明了档位
  的模型才出现选择器，且会给 `defaultEffort`（缺了它宿主按 pi-ai 语义当 `off`）。
- **`max_tokens` 自己夹到 131072**。超过这个值网关**不报错**，只返回空流。
- 报给宿主的是**真实** `contextWindow`，不做放大。上下文超窗口时网关**静默
  截断**（实测 900KB 打 202752 窗口返回 `finish=stop`），所以必须让宿主在发
  请求前就拦下。

### 对话

- 自己实现 SSE → `StreamChunk` 翻译，**不起回环桥接服务**
  （`LlmAdapter` 只有 `stream` 是 abstract）。
- `developer → system` 双向改写（`toUpstreamMessages` 与 `buildUpstreamBody`
  各一道）。网关对 `developer` 报的是
  `InferHub.001001044.400: Message role cannot empty` —— 文案与「不认这个角色名」
  毫无字面关系，漏掉改写会给出完全误导人的失败现场。
- **首帧内联错误嗅探**。HTTP 200 也可能是错误：网关把 `{"error_code":…}` 包成
  一行伪 SSE 后直接关流。不识别它，上层看到的是「流结束了但没有 finish_reason」。
- `finish_reason: length` 映射成 `max-tokens` 而不是 `stop` —— 归成 stop 的话，
  被输出预算截断的空回复与正常结束在界面上无法区分。
- `TokenUsage` 按宿主要求拆开：`inputTokens` 只算未命中缓存的部分，
  `cacheReadTokens` 单列（上游的 `prompt_tokens` 是两者之和）。
- 工具调用按 `index` 累积（不假设单帧）；图片走标准 OpenAI `image_url`，
  字节从宿主附件服务读，超过 8 MiB 的图跳过而不是撑爆请求体。

### 界面与状态

- 设置页（设置 → 码道）三页签：账号 / 模型 / 诊断。
- 输入框右侧积分胶囊（`conversation.input.right`）。
- 状态路由 `GET /plugins/dsh-connect-codearts/status` 带 Host 头回环校验；
  `?refresh=1` 触发刷新。
- 卡面文案三处副本（`locale/en.json`、`locale/zh.json`、`package.json.description`）
  由 `tests/locale-meta.spec.ts` 钉住。`en.json` 是锚点，缺它 `zh.json` 永不生效
  且不报错。
- **不认领 `conversation.input.model.label`**。该槽在本机宿主上是 `single` 槽，
  赢家通吃，占住它会把宿主自带的模型徽章挤掉。

### CLI

```bash
dsh-connect-codearts status    # 凭据来源、账号、积分
dsh-connect-codearts models    # 模型清单（一次 GET，不消耗积分）
dsh-connect-codearts doctor    # 逐级检查凭据链路
dsh-connect-codearts logout    # 删除插件保存的凭据（不动环境变量）
```

`lib/bin.js` 里没有裸宿主 specifier，因此能在纯 Node 解析下跑（profile 里
peer 依赖从不安装）。有单测与构建产物检查双重保证。

### 测试

- 6 个 spec 文件、128 项：`sign`（22）、`sse`（23）、`body`（25）、
  `errors`（23）、`adapter`（19）、`locale-meta`（16）。
- 端到端冒烟脚本 `probe/m1-smoke.mjs` 对真实网关跑 30 项断言（对话、流式帧、
  usage 拆分、工具调用、`developer` 改写、账号、积分、签到活动识别）。
