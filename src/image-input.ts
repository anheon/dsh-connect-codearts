/**
 * 图片附件 → `data:` URL。
 *
 * 码道网关走标准 OpenAI 的 `image_url`（M0 用 1x1 纯红 PNG 验过：模型回答
 * 「红色」），所以宿主侧只需要把附件的字节与媒体类型拼成一条 data URL。
 *
 * 为什么单独成文件、且用「取服务」的闭包而不是直接依赖：附件服务是可选部署
 * 能力。没装它时这里是 `undefined`，图片块被跳过 —— 模型收到的是纯文本，而
 * 不是一条打不开的 URL 或一个 500。宁可退化也不要坏掉。
 *
 * @module dsh-connect-codearts/image-input
 */
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'

/**
 * 单张图片的大小上限。
 *
 * 码道没有公开的限制，但把几十 MB 的截图 base64 进 JSON body 会同时撑爆
 * 请求体积和上下文预算。8 MiB 足够容纳一张未压缩的 4K 截图。
 */
export const MAX_INLINE_IMAGE_BYTES = 8 * 1024 * 1024

/** 建一个把附件转成 data URL 的解析器。`store()` 每次调用现取，服务晚到也能用。 */
export const createImageResolver = (
  store: () => AttachmentStore | undefined,
): ((ref: ImageAttachmentRef) => Promise<string | undefined>) => {
  return async (ref) => {
    const attachments = store()
    if (attachments === undefined) return undefined
    if (ref.bytes > MAX_INLINE_IMAGE_BYTES) return undefined

    try {
      const stored = await attachments.readImage(ref)
      /**
       * 用 `ref.mediaType` 而不是 `stored.ref.mediaType` 拼前缀没有区别
       * （readImage 会校验两者一致），但显式取返回值更稳：将来若服务端做
       * 规范化，前缀跟着走。
       */
      const mediaType = stored.ref.mediaType
      return `data:${mediaType};base64,${Buffer.from(stored.data).toString('base64')}`
    } catch {
      /**
       * 读失败一律当「这张图没有」处理，不往上抛。
       *
       * 抛出去的后果是整轮对话失败，而一张图读不出来（文件被清理、字节与摘要
       * 不符）不该有这么大的代价 —— 用户发一条带三张截图的消息，不该因为其中
       * 一张过期就整条发不出。这里返回 undefined，模型看到纯文本，其余照常。
       */
      return undefined
    }
  }
}
