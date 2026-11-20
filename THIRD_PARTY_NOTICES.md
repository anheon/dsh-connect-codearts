# 第三方声明

本项目采用 MIT 许可证（见 [LICENSE](LICENSE)）。以下项目提供了协议与实现参考。对应文件的头部注释记录了使用和修改情况。

按 MIT 的要求，凡是「实质借鉴」的地方都在对应源文件头部的注释里写明了
`参考 / 改动` 两段。本文件是那些注释的索引。

## 协议与实现参考（MIT）

### `dsh-connect-madao`（MIT，XLNC-L）

<https://github.com/XLNC-L/dsh-connect-madao>

本项目在**协议层**上直接受益于它，因为它把码道私有接口趟得最完整。具体借鉴：

| 本项目文件 | 借鉴内容 |
| --- | --- |
| `src/protocol/sign.ts` | 华为云 APIG `SDK-HMAC-SHA256` 的规范化流程（CanonicalURI 补尾斜杠、SignedHeaders 与实际发送的头一一对应、payloadHash 用真实 body 的 SHA256） |
| `src/protocol/body.ts` | `developer → system` 角色改写、`reasoning_effort` 字段名与 `off → none` 映射、`max_tokens` 需要夹上限 |
| `src/protocol/sse.ts` | 流式 `tool_calls` 按 index 累积、首帧内联错误嗅探 |
| `src/upstream.ts` | 各私有端点的路径与请求形状（`/v1/model/builtin`、`/v1/model/thinking-variants`、`/snap-manager/v1/statistics/plugin`、`/v1/ops/delivery`、`/v1/ops/claim`） |

**改动**（这些都是刻意的，不是疏忽）：

1. **不做 SM4-GCM 传输加密。** madao 实现了 ECDH(P-256) 密钥协商 + 手写 SM4-GCM
   （400+ 行，因为 DSH 自带的 Node 24 的 OpenSSL 没有 `sm4-gcm` cipher）。本机实测
   **明文 JSON + APIG 签名直接 200**，12 个模型、工具调用、图片、非流式全部正常。
   加密通道是「客户端声明 `X-Encrypt-Capable: sm4-gcm` 才启用」的可选增强。
   省掉 400 行最难维护的代码。
2. **不用回环桥接服务。** madao 起一个本机 OpenAI 兼容 HTTP 服务，再用生成的
   `cordis.patch.yml` 把 `llm-pi-ai` 的 provider 指过去 —— 因为 pi-ai 的 provider
   配置要求模型清单静态列出，它无法运行时发现，只能「启动拉清单 → 写盘 → 重启生效」。
   本项目直接 `extends LlmAdapter`（宿主抽象类只有 `stream` 是 abstract），走
   `registerModelDiscovery`，**点击即生效**。
3. 本机接口校验回环来源与 DSH 会话。
4. **不硬编码 `campaignId=34`。** 实测签到活动确实是 34，但正确做法是按
   `type === 'USER_LOGIN'` 识别，`campaignId` 只作次要键。
5. **不做上下文窗口放大。** madao 给宿主报 `real × 2.5`，为了绕过宿主自己的上下文
   估算（它把 tools 的 JSON schema 按接近 1 token/字符算，偏高）。本项目报真实值：
   放大之后「实际超窗口」会变成「网关静默截断」（实测 900KB 打 202752 窗口返回
   `finish=stop content="好"`，不报错），那比在宿主侧被拦下危险得多。
6. **修正了它的签名器。** `apig-sign` 那条线上的实现都把 `CanonicalQueryString`
   硬编码成空字符串，所以任何带 query 的请求都会 401。本项目把 query 纳入签名，
   并有单测钉住（`tests/sign.spec.ts`）。

### `dsh-huaweicloud-connect`（MIT，Alanine-孔硕）

<https://github.com/Alanine-gH/dsh-huaweicloud-connect>

| 借鉴内容 | 用在哪 |
| --- | --- |
| 「厂商差异收进 driver」的分层思路 | 本项目的 `src/upstream.ts` / `src/protocol/` 划分 |
| 四组凭据 × `maas_type` 的对照表（决定了本项目的凭据策略） | `README.md` 的选型章节 |
| `TM.00001041` 不是真的「并发会话数上限」而是网关节奏限流 | `src/protocol/errors.ts` 的分类与退避参数 |
| 「webServer 路由必须在 `apply` 同步阶段注册，放进异步流程会永远挂不上」 | `src/index.ts` 的路由注册位置 |

**改动**：同样不做 STS 换取（用长期 AK/SK）、不做 `state.vscdb` 读取、补了它没有的
`locale/` 与 `icons/`（它只有 1 个槽位、没有卡面文案）。

### `dsh-connect-workbuddy`（MIT，LaoDing）

<https://github.com/dingminhua/dsh-connect-workbuddy>

**架构蓝本**。本项目几乎所有的宿主侧「怎么接才对」都来自它：

| 借鉴内容 | 用在哪 |
| --- | --- |
| 双入口 tsdown 配置（node ESM + browser CJS + `window.__ModuleLoader__` 外壳） | `tsdown.config.ts` |
| `react-dom` 必须外置（否则 `process is not defined` 让整个 client 半边 import 失败） | `tsdown.config.ts` |
| `settingsNamespaceOf()` 从 `ctx.fiber.entry?.options.id` 取宿主的真实命名空间 | `src/index.ts` |
| 「卡面文案是包元数据不是本插件渲染的」+ 三个静默失败坑 | `locale/*.json`、`tests/locale-meta.spec.ts` |
| 槽位认领的封闭集合与 opt-in 原则 | `src/client/index.tsx` |
| `TokenUsage` 字段互斥（`inputTokens` 只算未命中缓存）的处理方式 | `src/adapter.ts` |
| 「不做插件之间的联动」这条项目级不变量 | `README.md` |

**改动**：单账号直连网关，并提供模型显隐、积分状态和签到开关。

## 协议知识来源（非代码）

上游行为来自本机对真实网关的实测，探针脚本在 `probe/`。下列第三方材料提供了
交叉印证（仅作事实核对，未复制代码）：

- 华为云官方文档：`codeartsagent_pd_0001`（产品形态）、`codeartsagent_cli_0026`
  （CLI AK/SK 授权）、`codeartsagent_ug_0072`（内置模型配置）、
  `codeartsagent_ug_0053`（自定义模型）、`codeartsagent_billing_0029` 与
  `codeartsagent_offers_0004`（积分与签到 —— 这两份自相矛盾，本项目以实测为准）
- `opencode-codearts-provider@1.2.0`：CLI 形态的请求头与体形状
- `dsh-codearts@1.4.4`：OAuth2 PKCE/DPoP 路线的对照（本项目未采用）

## 商标

「华为云」「码道」「CodeArts」是华为技术有限公司的商标。本项目是**非官方的
第三方插件**，与华为无隶属或背书关系，未使用其官方 logo 或视觉资产。

## 随附许可证声明

### dsh-connect-workbuddy

```text
MIT License

Copyright (c) 2026 LaoDing

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### dsh-huaweicloud-connect

```text
MIT License

Copyright (c) 2026 Alanine-孔硕

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### dsh-connect-madao

参考 [v0.7.0 发布标签](https://github.com/XLNC-L/dsh-connect-madao/tree/v0.7.0)（提交 e781970cbad08604d75dd2a4ebfeacdba9bea5cb）。该标签的 package.json 将作者列为 XLNC-L，并声明 MIT 许可证。该标签没有单独的许可证文件。MIT 条款正文见上文。
