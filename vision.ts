import {
  detectSupportedImageMimeTypeFromFile,
  formatSize,
  resizeImage,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Model, TextContent } from "@earendil-works/pi-ai";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AuxVisionConfig } from "./config";

/** 服务商限制交集:原始图片 10MB 硬上限(Gemini 20MB 请求 / Anthropic 10MB / SenseNova 10MB)。 */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

const SYSTEM_PROMPT =
  "You are a precise image analysis assistant. Answer the user's question about the image factually and precisely. " +
  "Respond in the same language as the user's question. If the image contains text, code, or error messages, " +
  "transcribe them accurately. Be concise but complete — include exact values, coordinates, and quoted text where relevant.";

export type DescribeImageResult =
  | { content: { type: "text"; text: string }[]; isError: true }
  | { content: { type: "text"; text: string }[]; details: Record<string, unknown> };

function errorResult(text: string): { content: { type: "text"; text: string }[]; isError: true } {
  return {
    content: [{ type: "text" as const, text }],
    isError: true as const,
  };
}

/**
 * 核心图像分析:读盘 → 校验/压缩 → 经 modelRegistry 官方管线调用视觉模型 → 返回文本结果。
 * 单次调用,结果作为 tool_result 进入上下文,不产生多余调用。
 */
export async function describeImage(
  params: { image_path: string; question: string },
  ctx: ExtensionContext,
  model: Model,
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

  return {
    content: [{ type: "text", text: resizeNote ? `${text}\n${resizeNote}` : text }],
    details: {
      model: `${model.provider}/${model.id}`,
      usage: result.usage,
    },
  };
}
