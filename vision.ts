import {
  detectSupportedImageMimeTypeFromFile,
  formatSize,
  resizeImage,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, AssistantMessage, Model, TextContent, Usage } from "@earendil-works/pi-ai";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AuxVisionConfig } from "./config";

/** 服务商限制交集:原始图片 10MB 硬上限(Gemini 20MB 请求 / Anthropic 10MB / SenseNova 10MB)。 */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

const SYSTEM_PROMPT =
  // 转录底座契约(ADR-0002):无论问题多窄,都先穷尽转储可见信息,盲模型据此推理,不依赖提问精度。
  "You are a precise image analysis assistant. Regardless of the question, ALWAYS begin with an exhaustive transcription base: " +
  "1) classify the image type (terminal screenshot, log output, error dialog, UI/screenshot, photo, diagram, or other); " +
  "2) transcribe verbatim ALL visible text, code, and error messages — every line, in the original language, untranslated; " +
  "   note the layout and reading order (top to bottom, blocks, highlighted items); " +
  "3) coordinates, colors, and non-text visual details are best-effort only. " +
  "If the image contains no readable text, state that explicitly and describe the visual content instead. " +
  "Then, in a section headed 'Answer', answer the user's question factually and precisely using the transcription base. " +
  "End with a completeness attestation: state that all visible text has been transcribed exhaustively, or that no readable text was found. " +
  "Respond in the same language as the user's question (the transcription itself stays verbatim in the original language).";

// Tool result contract (ADR-0001): success carries { model, usage }, failure { error }.
// Expected failures are returned, not thrown, so the transcript isError stays false.
export type DescribeImageResult =
  | { content: { type: "text"; text: string }[]; details: { model: string; usage: Usage } }
  | { content: { type: "text"; text: string }[]; details: { error: string } };

/** Narrow a describe_image result to its expected-failure variant. */
export function isErrorResult(r: DescribeImageResult): r is Extract<DescribeImageResult, { details: { error: string } }> {
  return "error" in r.details;
}

function errorResult(text: string): { content: { type: "text"; text: string }[]; details: { error: string } } {
  return {
    content: [{ type: "text" as const, text }],
    details: { error: text },
  };
}

/**
 * 核心图像分析:读盘 → 校验/压缩 → 经 modelRegistry 官方管线调用视觉模型 → 返回文本结果。
 * 单次调用,结果作为 tool_result 进入上下文,不产生多余调用。
 */
export async function describeImage(
  params: { image_path: string; question: string },
  ctx: ExtensionContext,
  model: Model<Api>,
  cfg: AuxVisionConfig,
  signal: AbortSignal | undefined,
): Promise<DescribeImageResult> {
  const filePath = path.resolve(ctx.cwd, params.image_path);

  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch {
    return errorResult(
      `图片文件不存在: ${filePath}。请先确认文件已落盘(截图/导出/生成均可),并检查路径是否正确。`,
    );
  }
  if (!stat.isFile()) {
    return errorResult(`路径不是文件: ${filePath}`);
  }

  const mimeType = await detectSupportedImageMimeTypeFromFile(filePath);
  if (!mimeType) {
    return errorResult(
      `不支持的图片格式: ${params.image_path}(支持 png / jpeg / gif / webp / bmp)。`,
    );
  }

  let bytes = await fs.readFile(filePath);
  let resizeNote = "";

  // 超过 10MB:优先用官方 resizeImage 压到限制内,压不动才报错。
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    const resized = await resizeImage(bytes, mimeType, { maxBytes: MAX_IMAGE_BYTES });
    if (!resized) {
      return errorResult(
        `图片 ${formatSize(stat.size)} 超过 10MB 上限且无法自动压缩,请手动缩小图片后重试。`,
      );
    }
    bytes = Buffer.from(resized.data, "base64");
    resizeNote = `(原图 ${formatSize(stat.size)} 已压缩至 ${formatSize(bytes.byteLength)})`;
  }

  const base64 = bytes.toString("base64");

  let result: AssistantMessage;
  try {
    result = await ctx.modelRegistry.complete(
      model,
      {
        systemPrompt: SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: params.question },
              { type: "image", data: base64, mimeType },
            ],
            timestamp: Date.now(),
          },
        ],
      },
      {
        maxTokens: cfg.maxOutputTokens,
        maxRetries: cfg.maxRetries,
        maxRetryDelayMs: cfg.maxRetryDelayMs,
        signal,
      },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return errorResult(`视觉模型调用失败: ${msg}`);
  }

  if (result.stopReason === "error") {
    return errorResult(`视觉模型返回错误: ${result.errorMessage ?? "unknown"}`);
  }
  if (result.stopReason === "aborted") {
    return errorResult("视觉模型调用已取消");
  }

  const text = result.content
    .filter((c): c is TextContent => c.type === "text")
    .map((c) => c.text)
    .join("\n")
    .trim();
  if (!text) {
    return errorResult("视觉模型没有返回文本内容");
  }

  // 截断显式化(ADR-0002):SDK 在输出撞到 maxTokens 时标记 stopReason "length",
  // 此时转录底座可能不完整,必须在头部显式告知,而不是把残缺底座静默交回盲模型。
  const body =
    result.stopReason === "length" ? `${TRUNCATION_NOTICE}\n${text}` : text;

  return {
    content: [{ type: "text", text: resizeNote ? `${body}\n${resizeNote}` : body }],
    details: {
      model: `${model.provider}/${model.id}`,
      usage: result.usage,
    },
  };
}

// 截断显式化提示语:头部告知底座可能不完整,并把重调主动权交回调用方。
const TRUNCATION_NOTICE =
  "注意:视觉模型输出已达 token 上限,转录底座可能不完整,截断通常发生在尾部。" +
  "如需完整内容,请缩小范围或用更聚焦的 question 重新调用 describe_image。";
