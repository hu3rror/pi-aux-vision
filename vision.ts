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
import { Type } from "typebox";

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
  "End with a completeness attestation in the response language, using exactly one of: " +
  "'I have exhaustively transcribed all visible text.' or 'No readable text was found — I described the visual content instead.' " +
  "Respond in the same language as the user's question (the transcription itself stays verbatim in the original language).";

// Tool result contract (ADR-0001): success carries { model, usage }, failure { error }.
// Expected failures are returned, not thrown, so the transcript isError stays false.
// Structured result (ADR-0005): codemode scripts receive structuredContent once outputSchema is declared.
// usage is a JSON-safe type alias (interface types fail the SDK's JsonValue constraint, ADR-0005).
export type UsageJson = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h?: number;
  reasoning?: number;
  totalTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
};

export type DescribeImageResult =
  | {
      content: { type: "text"; text: string }[];
      details: { model: string; usage: Usage };
      structuredContent: {
        ok: true;
        model: string;
        usage: UsageJson;
        transcription: string;
        truncated: boolean;
        resize_note?: string;
      };
    }
  | {
      content: { type: "text"; text: string }[];
      details: { error: string };
      structuredContent: { ok: false; error: string };
    };

/** Narrow a describe_image result to its expected-failure variant. */
export function isErrorResult(r: DescribeImageResult): r is Extract<DescribeImageResult, { details: { error: string } }> {
  return "error" in r.details;
}

export function errorResult(text: string): {
  content: { type: "text"; text: string }[];
  details: { error: string };
  structuredContent: { ok: false; error: string };
} {
  return {
    content: [{ type: "text" as const, text }],
    details: { error: text },
    structuredContent: { ok: false, error: text },
  };
}

// 结构化输出契约(ADR-0005):转录保持普通字符串字段,脚本可弃;usage 仅承诺 totalTokens。
export const structuredOutputSchema = Type.Union([
  Type.Object({
    ok: Type.Literal(true),
    model: Type.String(),
    usage: Type.Object({ totalTokens: Type.Number() }, { additionalProperties: true }),
    transcription: Type.String(),
    truncated: Type.Boolean(),
    resize_note: Type.Optional(Type.String()),
  }),
  Type.Object({
    ok: Type.Literal(false),
    error: Type.String(),
  }),
]);

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
      `Image file does not exist: ${filePath}. Make sure the file is on disk (screenshot, export, or generated) and check the path.`,
    );
  }
  if (!stat.isFile()) {
    return errorResult(`Path is not a file: ${filePath}`);
  }

  const mimeType = await detectSupportedImageMimeTypeFromFile(filePath);
  if (!mimeType) {
    return errorResult(
      `Unsupported image format: ${params.image_path} (supported: png / jpeg / gif / webp / bmp).`,
    );
  }

  let bytes = await fs.readFile(filePath);
  let resizeNote = "";

  // 超过 10MB:优先用官方 resizeImage 压到限制内,压不动才报错。
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    const resized = await resizeImage(bytes, mimeType, { maxBytes: MAX_IMAGE_BYTES });
    if (!resized) {
      return errorResult(
        `Image ${formatSize(stat.size)} exceeds the 10MB limit and could not be auto-compressed; shrink the image and retry.`,
      );
    }
    bytes = Buffer.from(resized.data, "base64");
    resizeNote = `(original ${formatSize(stat.size)} compressed to ${formatSize(bytes.byteLength)})`;
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
    return errorResult(`Vision model call failed: ${msg}`);
  }

  if (result.stopReason === "error") {
    return errorResult(`Vision model returned an error: ${result.errorMessage ?? "unknown"}`);
  }
  if (result.stopReason === "aborted") {
    return errorResult("Vision model call was aborted");
  }

  const text = result.content
    .filter((c): c is TextContent => c.type === "text")
    .map((c) => c.text)
    .join("\n")
    .trim();
  if (!text) {
    return errorResult("Vision model returned no text content");
  }

  // 截断显式化(ADR-0002):SDK 在输出撞到 maxTokens 时标记 stopReason "length",
  // 此时转录底座可能不完整,必须在头部显式告知,而不是把残缺底座静默交回盲模型。
  const truncated = result.stopReason === "length";
  const body = truncated ? `${truncationNotice()}\n${text}` : text;
  const fullText = resizeNote ? `${body}\n${resizeNote}` : body;

  return {
    content: [{ type: "text", text: fullText }],
    details: {
      model: `${model.provider}/${model.id}`,
      usage: result.usage,
    },
    structuredContent: {
      ok: true,
      model: `${model.provider}/${model.id}`,
      usage: result.usage,
      transcription: fullText,
      truncated,
      ...(resizeNote ? { resize_note: resizeNote } : {}),
    },
  };
}

// 截断显式化提示语(ADR-0002):头部告知底座可能不完整,并把重调主动权交回调用方。
// 固定英文:提示语属于工具输出的稳定契约,不跟随提问语言(ADR-0002)。
function truncationNotice(): string {
  return (
    "Note: the vision model's output hit the token limit, so the transcription base may be incomplete " +
    "(truncation usually cuts the tail). To get the full content, narrow the scope or call describe_image " +
    "again with a more focused question."
  );
}
