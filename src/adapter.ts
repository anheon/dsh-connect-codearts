/**
 * 码道 `LlmAdapter` 实现：把宿主的中性请求直接翻译成网关的 OpenAI 形状。
 *
 * 参考：dsh-connect-workbuddy（MIT, LaoDing）`src/adapter.ts` —「每模型单独
 *       声明 reasoning 档位」与「默认档位必须显式声明，否则内部调用会走到
 *       未优化路径」这两条结论。
 * 改动：**不走回环 shim**。WorkBuddy 与两份码道参考实现都起一个本机 HTTP
 *       服务，再用 pi-ai 的 `PiAiAdapter` 去连它 —— 那套结构是为了复用
 *       `openAICompletionsApi()` 现成的 SSE 翻译层。但 `LlmAdapter` 只有
 *       `stream` 是抽象方法，直接实现它就能产出 `StreamChunk`，于是回环
 *       服务、Bearer 校验、`timingSafeEqual`、端口滚动这一整套（WorkBuddy
 *       约 2400 行）全部不需要。代价是自己写 SSE → StreamChunk 的翻译，
 *       那部分已经在 protocol/sse.ts 里完成。
 *
 * @module dsh-connect-codearts/adapter
 */
import type {
  FinishReason,
  GenerateOptions,
  LlmModelReasoningInfo,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  ReasoningEffortId,
  StreamChunk,
  TokenUsage,
  ToolCallId,
  ToolSchema,
} from '@deepseek-ai/dsh-llm'
import { LlmAdapter, LlmError, ReasoningEffortId as brandEffort } from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'

import { buildUpstreamBody, clampMaxTokens, normalizeContent, upstreamRole } from './protocol/body.ts'
import type { UpstreamContentPart, UpstreamMessage } from './protocol/body.ts'
import type { CodeArtsCredentials } from './protocol/sign.ts'
import { ToolCallAccumulator } from './protocol/sse.ts'
import { CODEARTS_DEFAULT_MAX_OUTPUT } from './protocol/types.ts'
import type { ReasoningEffortId as ProtocolEffort } from './protocol/types.ts'
import type { ChatOutcome, ModelCatalogEntry } from './upstream.ts'
import type { CodeArtsUpstreamClient } from './upstream.ts'

/** provider 路由名。刻意不用 `huaweicloud-codearts`，避免与既有插件撞车。 */
export const CODEARTS_PROVIDER = 'codearts'

/** 选择器与设置页里显示的名字。 */
export const CODEARTS_PROVIDER_DISPLAY_NAME = '码道 CodeArts'

/**
 * 流空闲超时。
 *
 * 码道模型在 `max` 档下会长时间思考而**不发任何帧**（M0 实测 `max` 档整轮
 * 6.2 秒，中间有数秒静默），设短了会把正常思考判成超时。
 */
export const CODEARTS_STREAM_IDLE_TIMEOUT_MS = 300_000

/** 一个模型声明的思考档位。 */
export interface ThinkingVariant {
  readonly strengths: readonly string[]
  readonly defaultStrength?: string
}

/** 适配器需要的外部注入。全部是函数，保证设置页改了立刻生效。 */
export interface CodeArtsAdapterOptions {
  readonly client: CodeArtsUpstreamClient
  /** 当前凭据。**每次调用现读**，用户在设置页保存后下一条请求就生效。 */
  readonly credentials: () => Promise<CodeArtsCredentials | undefined>
  /** 当前模型目录，由 index.ts 的缓存提供，避免每次请求都打目录接口。 */
  readonly catalog: () => readonly ModelCatalogEntry[]
  /**
   * 用户勾掉（隐藏）的模型 id，**每次调用现读**。
   *
   * 过滤放在 adapter 而不是让 `index.ts` 提供一份「已过滤目录」：`catalog()`
   * 同时被 `listModels` 与 `resolveModel` 用，把过滤做在源头会让
   * `resolveModel` 认不出隐藏模型 —— 那时用户切到旧会话里的隐藏模型会拿到
   * 一个「最小可用描述」，请求照发，隐藏就形同虚设。所以两处各自显式过滤，
   * 语义才一致（列表里看不到 = 也解析不出来）。
   */
  readonly hiddenModels: () => ReadonlySet<string>
  /** 每个模型声明的思考档位。 */
  readonly thinkingVariants: () => ReadonlyMap<string, ThinkingVariant>
  /** 用户在设置页为每个模型选的默认档位，键是 model id。 */
  readonly defaultEfforts: () => ReadonlyMap<string, string>
  /**
   * 把一张图片附件读成 `data:` URL。
   *
   * 注入而不是直接依赖 `ctx.attachments`：adapter 是纯协议层，不该知道宿主
   * 的附件服务长什么样；而且没装附件服务的精简部署里这条能力必须能整体缺席
   * （缺席时图片块直接跳过，模型收到的是纯文本，而不是一个坏 URL）。
   */
  readonly resolveImage?:
    | ((ref: ImageAttachmentRef) => Promise<string | undefined>)
    | undefined
  readonly log?: ((line: string) => void) | undefined
}

const isEffortCapable = (
  variants: ReadonlyMap<string, ThinkingVariant>,
  modelId: string,
): boolean => (variants.get(modelId)?.strengths.length ?? 0) > 0

/**
 * 把一个模型的档位表翻译成宿主认识的形式。
 *
 * 关键约束（WorkBuddy 从一处内部调用 400 学到）：对**声明了**档位的模型，
 * 必须显式给出 `defaultEffort`，因为宿主在调用方没指定时会把它物化进请求；
 * 缺失时宿主按 pi-ai 语义当作 `off`，而码道在 `off` 下不下发思考内容，
 * `/compact` 这类内部调用会因此跑到一条明显更慢/更笨的路径上。
 *
 * 对**没有**声明档位的模型，只返回 `off` 一项且**不给** `defaultEffort`：
 * 网关确实接受 `reasoning_effort` 且它确实影响行为（M0 实测），但那不是
 * 「可选档位」，界面上不该给用户一个假的选择器。
 */
export const reasoningInfoOf = (
  variants: ReadonlyMap<string, ThinkingVariant>,
  modelId: string,
  preferred: string | undefined,
): LlmModelReasoningInfo => {
  const declared = variants.get(modelId)
  if (declared === undefined || declared.strengths.length === 0) {
    return { efforts: [{ id: brandEffort('off'), name: '标准' }] }
  }

  const efforts = [
    { id: brandEffort('off'), name: '不思考' },
    ...declared.strengths.map((strength) => ({
      id: brandEffort(strength),
      name: strength === 'high' ? '高' : strength === 'max' ? '最高' : strength,
    })),
  ]

  const ordered = declared.strengths
  const chosen =
    preferred !== undefined && ordered.includes(preferred)
      ? preferred
      : declared.defaultStrength !== undefined && ordered.includes(declared.defaultStrength)
        ? declared.defaultStrength
        : ordered[0]

  // `exactOptionalPropertyTypes` 下不允许把 `undefined` 赋给可选属性，所以
  // 没有确定默认档位时直接省略这个键（而不是给 undefined）。
  return chosen === undefined ? { efforts } : { efforts, defaultEffort: brandEffort(chosen) }
}

/** 从内容里抽出纯文本（tool 结果用）。 */
const plainTextOf = (content: unknown): string => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      if (typeof block !== 'object' || block === null) return ''
      const record = block as Record<string, unknown>
      return record['type'] === 'text' && typeof record['text'] === 'string' ? record['text'] : ''
    })
    .filter((text) => text !== '')
    .join('\n')
}

/**
 * 宿主的消息列表 → 上游消息列表。
 *
 * 三件事：
 *   1. `developer → system`。宿主用 developer 承载系统提示，网关遇到会报
 *      `InferHub.001001044.400: Message role cannot empty`（M0 实测，非静默）。
 *   2. 图片从 attachment 引用转成 data URL（由调用方注入的解析器负责读盘）。
 *   3. 工具调用与工具结果按 OpenAI 形状排布。
 */
const toUpstreamMessages = async (
  options: GenerateOptions,
  resolveImage: ((ref: ImageAttachmentRef) => Promise<string | undefined>) | undefined,
): Promise<UpstreamMessage[]> => {
  const result: UpstreamMessage[] = []

  if (options.system !== undefined && options.system !== '') {
    result.push({ role: 'system', content: options.system })
  }

  for (const message of options.messages) {
    const role = upstreamRole(message.role)

    if (role === 'tool') {
      const record = message as unknown as Record<string, unknown>
      const toolCallId = typeof record['toolCallId'] === 'string' ? record['toolCallId'] : undefined
      result.push({
        role: 'tool',
        content: plainTextOf(message.content),
        ...(toolCallId === undefined ? {} : { tool_call_id: toolCallId }),
      })
      continue
    }

    const parts: UpstreamContentPart[] = []
    const toolCalls: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> = []

    const content = message.content
    if (typeof content === 'string') {
      if (content !== '') parts.push({ type: 'text', text: content })
    } else {
      for (const block of content) {
        switch (block.type) {
          case 'text':
            if (block.text !== '') parts.push({ type: 'text', text: block.text })
            break
          case 'reasoning':
            // 思考内容不回传：网关对 assistant 的 reasoning 字段会报错。
            break
          case 'image': {
            if (resolveImage === undefined) break
            /**
             * 传的是整个 `ImageAttachmentRef` 而不是它的 `attachmentId`：
             * 读字节需要 `mediaType` 拼 `data:` 前缀，而光有 id 是拼不出合法
             * URL 的（`data:attachment/xxx` 不是任何浏览器/网关认识的类型）。
             */
            const dataUrl = await resolveImage(block.attachment)
            if (dataUrl !== undefined) parts.push({ type: 'image_url', image_url: { url: dataUrl } })
            break
          }
          case 'tool-call':
            toolCalls.push({
              id: String(block.id),
              type: 'function',
              function: { name: block.name, arguments: block.arguments },
            })
            break
          default:
            // file / tool-addition / tool-removal 由宿主自己投影，不需要发给上游。
            break
        }
      }
    }

    result.push({
      role: role as UpstreamMessage['role'],
      content: normalizeContent(parts),
      ...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls }),
    })
  }

  return result
}

/** 宿主的工具声明 → 上游 `tools` 字段。形状几乎一致，只做外层包裹。 */
const toUpstreamTools = (tools: readonly ToolSchema[] | undefined): readonly unknown[] | undefined => {
  if (tools === undefined || tools.length === 0) return undefined
  return tools.map((tool) => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }))
}

/**
 * 上游 `finish_reason` → 宿主 `FinishReason`。
 *
 * `length → max-tokens` 很重要：M0 踩过「max_tokens 太小导致正文为空、
 * finish=length」的坑，宿主看到 `max-tokens` 会提示用户调大输出预算；归成
 * `stop` 就变成静默的空回复，用户完全无从下手。
 */
export const finishReasonOf = (raw: string | null | undefined, sawToolCalls: boolean): FinishReason => {
  if (raw === 'tool_calls') return { kind: 'tool-calls' }
  if (raw === 'length') return { kind: 'max-tokens' }
  if (raw === 'stop') return { kind: 'stop' }
  return sawToolCalls ? { kind: 'tool-calls' } : { kind: 'stop' }
}

/** 码道适配器。只覆盖四个方法，其余用 `LlmAdapter` 的默认实现。 */
export class CodeArtsAdapter extends LlmAdapter {
  readonly #options: CodeArtsAdapterOptions

  constructor(options: CodeArtsAdapterOptions) {
    super()
    this.#options = options
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: CODEARTS_PROVIDER_DISPLAY_NAME }
  }

  /**
   * 广告当前模型目录。
   *
   * 目录为空时返回空数组 —— 宿主会把整个 provider 从选择器里隐藏，这正是
   * 「没配凭据」时应有的表现，比列出一串必定失败的模型更诚实。
   *
   * 用户勾掉的模型在这里剔掉。**只在 `listModels` 过滤是不够的**：宿主对
   * 已保存会话里的模型会走 `resolveModel`，那里若仍能解析出来，用户就会在
   * 「模型已隐藏」之后再也没法把它选回来之外的任何地方看到它 —— 不一致比
   * 单纯的多一行更难解释。所以两处都过滤，见 `hiddenModels` 的注释。
   */
  override async listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    const hidden = this.#options.hiddenModels()
    return this.#options
      .catalog()
      .filter((entry) => !hidden.has(entry.id))
      .map((entry) => toModelInfo(entry))
  }

  /**
   * 解析一个模型的完整元数据。
   *
   * `context.contextWindow` 用网关直出的真实值，**不做参考实现那种 ×2.5
   * 放大**：放大是为了绕过 DSH 对 tools schema 的高估估算，但代价是把
   * 「实际超窗口」变成「网关静默截断」——M0 实测用 900KB 打 202752 窗口的
   * GLM-5.2，返回 `finish=stop content="好"`，不报任何错。宁可让宿主如实拦下。
   */
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const hidden = this.#options.hiddenModels()
    const entry = hidden.has(model)
      ? undefined
      : this.#options.catalog().find((candidate) => candidate.id === model)

    if (entry === undefined) {
      // 两种情况都落到这里：目录还没加载好，或用户把这个模型藏起来了。
      // 对宿主的表现一样 —— 给一个最小可用描述，请求本身仍会失败并给可读
      // 错误。**不区分对待是对的**：从宿主的角度「这个模型现在不可用」是
      // 同一件事，而把「被隐藏」报成一个特殊的解析失败只会让宿主的错误提示
      // 更含糊。用户想用回它，去设置页取消勾选即可。
      return {
        provider,
        id: model,
        name: model,
        defaultMaxTokens: CODEARTS_DEFAULT_MAX_OUTPUT,
        reasoning: { efforts: [{ id: brandEffort('off'), name: '标准' }] },
      }
    }

    const reasoning = reasoningInfoOf(
      this.#options.thinkingVariants(),
      model,
      this.#options.defaultEfforts().get(model),
    )

    return {
      provider,
      id: entry.id,
      name: entry.name,
      ...(entry.description === undefined ? {} : { description: entry.description }),
      inputModalities: entry.supportsImages ? ['text', 'image'] : ['text'],
      context: { contextWindow: entry.contextWindow },
      /**
       * 默认输出预算取「模型上限」与「务实默认值」的较小者。
       *
       * 不能直接用模型上限：码道模型先输出思考内容，与正文共享同一份预算。
       * 65536 看起来宽容，但如果宿主每次都按上限申请，留给正文的空间会被
       * 思考吃掉一大半。32768 约两万四千汉字，日常够用。
       */
      defaultMaxTokens: clampMaxTokens(
        undefined,
        Math.min(entry.maxTokens > 0 ? entry.maxTokens : CODEARTS_DEFAULT_MAX_OUTPUT, CODEARTS_DEFAULT_MAX_OUTPUT),
      ),
      reasoning,
      /**
       * 声明模型能读历史里的系统提示。
       *
       * 码道网关接受任意位置的 `system` 消息（M0 实测 system 在数组中间也
       * 正常工作），所以中途改系统提示不必重写消息 0 —— 这对前缀缓存命中率
       * 有实质影响。
       */
      systemPromptUpdate: 'in-history',
    }
  }

  /**
   * 流式对话 —— 唯一必须实现的方法。
   *
   * 错误处理遵循宿主契约：这里抛出的异常会被 `LlmRuntime.stream()` 归一成
   * 终态 `error`/`aborted` 的 `finish`，所以不吞错误。唯一需要自己转的是
   * **上游内联错误**（HTTP 200 + body 里带 error_code），那种情况必须显式
   * 抛 `LlmError` 才能保住业务码，否则宿主只会看到「流结束了」。
   */
  override async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk, void, void> {
    const credentials = await this.#options.credentials()
    if (credentials === undefined) {
      throw new LlmError(
        '没有读到码道的 AK/SK。请设置环境变量 CODEARTS_CLI_AK / CODEARTS_CLI_SK，或将 IAM 导出的 CSV 放入下载目录。',
        'MISSING_CREDENTIAL',
        { status: 401 },
      )
    }

    const messages = await toUpstreamMessages(options, this.#options.resolveImage)

    /**
     * 档位归一。
     *
     * 宿主传来的 `ReasoningEffortId` 是带品牌类型的字符串，跨包边界只剩运行期
     * 的值，所以这里转回协议层的字符串联合。
     *
     * 对没有声明档位的模型，把非 `off` 档位一律归成 `off` —— 否则网关虽然
     * 接受这个字段，行为却未被定义（M0 实测 `high` 档下 reasoning 内容整个
     * 不下发，`max` 档又下发，同一份 prompt）。
     */
    const capable = isEffortCapable(this.#options.thinkingVariants(), options.model)
    const requested = options.reasoningEffort === undefined ? undefined : String(options.reasoningEffort)
    const effectiveEffort: ProtocolEffort | undefined =
      requested === undefined
        ? undefined
        : capable
          ? (requested as ProtocolEffort)
          : 'off'

    const tools = toUpstreamTools(options.tools)
    const body = buildUpstreamBody({
      model: options.model,
      messages,
      ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
      ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
      ...(options.stop === undefined ? {} : { stop: options.stop }),
      ...(tools === undefined ? {} : { tools }),
      ...(effectiveEffort === undefined ? {} : { reasoningEffort: effectiveEffort }),
    })

    const toolCalls = new ToolCallAccumulator()

    /** 思考、正文和每个上游工具调用各占一个宿主块索引。 */
    let nextIndex = 0
    let reasoningIndex = -1
    let textIndex = -1
    const toolBlockIndices = new Map<number, number>()
    let textBuffer = ''
    let reasoningBuffer = ''
    let lastUsage: TokenUsage | undefined
    let finishRaw: string | null | undefined

    const stream = this.#options.client.chatStream(credentials, body, {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })

    /** 放弃流时交给 `AsyncGenerator.return` 的占位结果，只在 finally 里用。 */
    const abortedError = {
      kind: 'transport' as const,
      code: 'ABORTED',
      message: '请求已取消',
      hint: '请求已取消',
      retryable: false,
    }

    let outcome: ChatOutcome | undefined
    try {
      while (true) {
        const next = await stream.next()
        if (next.done === true) {
          outcome = next.value as ChatOutcome
          break
        }

        const chunk = next.value
        const delta = chunk.delta

        if (delta?.reasoning !== undefined && delta.reasoning !== '') {
          if (reasoningIndex < 0) {
            reasoningIndex = nextIndex
            nextIndex += 1
            yield { type: 'block-start', index: reasoningIndex, blockType: 'reasoning' }
          }
          reasoningBuffer += delta.reasoning
          yield { type: 'reasoning-delta', index: reasoningIndex, text: delta.reasoning }
        }

        if (delta?.content !== undefined && delta.content !== '') {
          if (textIndex < 0) {
            textIndex = nextIndex
            nextIndex += 1
            yield { type: 'block-start', index: textIndex, blockType: 'text' }
          }
          textBuffer += delta.content
          yield { type: 'text-delta', index: textIndex, text: delta.content }
        }

        if (delta?.toolCalls !== undefined && delta.toolCalls.length > 0) {
          for (const toolDelta of delta.toolCalls) {
            toolCalls.push([toolDelta])
            let index = toolBlockIndices.get(toolDelta.index)
            if (index === undefined) {
              index = nextIndex++
              toolBlockIndices.set(toolDelta.index, index)
              yield { type: 'block-start', index, blockType: 'tool-call' }
            }
            yield {
              type: 'tool-call-delta',
              index,
              id: (toolCalls.get(toolDelta.index)?.id ?? '') as ToolCallId,
              ...(toolDelta.name === undefined ? {} : { name: toolDelta.name }),
              argumentsDelta: toolDelta.argumentsDelta ?? '',
            }
          }
        }

        if (delta?.finishReason !== undefined) finishRaw = delta.finishReason

        if (chunk.usage !== undefined) {
          const usage = chunk.usage
          const promptTokens = usage.promptTokens ?? 0
          const cachedTokens = usage.cachedTokens ?? 0
          /**
           * 宿主的 `TokenUsage` 字段是**互斥**的：`inputTokens` 只算未命中的
           * 输入，命中的部分单独放在 `cacheReadTokens`；而上游的
           * `prompt_tokens` 是两者之和，所以必须减出来 —— 否则宿主会把缓存
           * 命中的输入再算一遍钱。
           */
          lastUsage = {
            inputTokens: Math.max(0, promptTokens - cachedTokens),
            outputTokens: usage.completionTokens ?? 0,
            ...(usage.totalTokens === undefined ? {} : { totalTokens: usage.totalTokens }),
            ...(cachedTokens === 0 ? {} : { cacheReadTokens: cachedTokens }),
            ...(usage.reasoningTokens === undefined ? {} : { reasoningTokens: usage.reasoningTokens }),
          }
        }
      }
    } finally {
      // `AsyncGenerator.return` 要求 `ChatOutcome`，但这里是在提前放弃流，
      // 不需要它的返回值。传一个中止结果只为满足类型。
      await stream
        .return({ ok: false, error: { ...abortedError } })
        .catch(() => undefined)
    }

    // 上游报错（含内联错误与空流）：转成 LlmError 抛出去，保住业务码。
    if (outcome !== undefined && outcome.ok === false) {
      throw LlmError.fromFailure({
        message: outcome.error.hint,
        code: outcome.error.code,
        ...(outcome.error.retryAfterMs === undefined
          ? {}
          : { providerRetryAfterMs: outcome.error.retryAfterMs }),
      })
    }

    // 收尾：关闭已开的块。宿主按 block-end 组装最终内容。
    if (reasoningIndex >= 0) {
      yield {
        type: 'block-end',
        index: reasoningIndex,
        block: { type: 'reasoning', text: reasoningBuffer },
      }
    }
    if (textIndex >= 0) {
      yield { type: 'block-end', index: textIndex, block: { type: 'text', text: textBuffer } }
    }
    for (const [upstreamIndex, index] of toolBlockIndices) {
      const call = toolCalls.get(upstreamIndex)
      if (call === undefined) continue
      yield {
        type: 'block-end',
        index,
        block: {
          type: 'tool-call',
          id: call.id as ToolCallId,
          name: call.name,
          arguments: call.arguments,
        },
      }
    }

    if (lastUsage !== undefined) yield { type: 'usage', usage: lastUsage }

    if (options.signal?.aborted === true) {
      yield {
        type: 'finish',
        reason: { kind: 'aborted', failure: { message: '请求已取消', code: 'ABORTED' } },
      }
      return
    }

    yield { type: 'finish', reason: finishReasonOf(finishRaw, toolCalls.size > 0) }
  }
}

/** 目录条目 → 宿主选择器条目。倍率走 badge 通道而不是拼进 name。 */
export const toModelInfo = (entry: ModelCatalogEntry): LlmModelInfo => {
  const badge =
    entry.ratioDisplay === undefined
      ? undefined
      : { text: { en: entry.ratioDisplay, zh: entry.ratioDisplay }, tone: 'neutral' as const }
  return {
    provider: CODEARTS_PROVIDER,
    id: entry.id,
    name: entry.name,
    ...(entry.description === undefined ? {} : { description: entry.description }),
    inputModalities: entry.supportsImages ? ['text', 'image'] : ['text'],
    ...(badge === undefined ? {} : { badge }),
  }
}
