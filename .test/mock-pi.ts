// 测试用 mock:替代 @earendil-works/pi-coding-agent 的运行时依赖
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let agentDir = path.join(os.tmpdir(), "aux-vision-test-agent");

export function setTestAgentDir(d: string) {
  agentDir = d;
}

export function getAgentDir(): string {
  return agentDir;
}

export function detectSupportedImageMimeTypeFromFile(filePath: string): Promise<string | null> {
  return Promise.resolve(filePath.endsWith(".png") ? "image/png" : filePath.endsWith(".jpg") ? "image/jpeg" : null);
}

export function formatSize(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

export async function resizeImage(): Promise<null> {
  return null;
}

// ---- fake model registry ----
export interface FakeModel {
  provider: string;
  id: string;
  api: string;
  input: string[];
  contextWindow: number;
  maxTokens: number;
}

export function makeFakeCtx(completeImpl?: (model: FakeModel) => unknown) {
  const models: FakeModel[] = [
    { provider: "sensenova-anthropic", id: "sensenova-6.8-flash-lite", api: "anthropic-messages", input: ["text", "image"], contextWindow: 262144, maxTokens: 65536 },
    { provider: "google", id: "gemini-2.5-flash", api: "google-generative-ai", input: ["text", "image"], contextWindow: 1048576, maxTokens: 65536 },
    { provider: "google", id: "gemini-3.1-flash-lite", api: "google-generative-ai", input: ["text", "image"], contextWindow: 1048576, maxTokens: 65536 },
    { provider: "sensenova", id: "deepseek-v4-flash", api: "openai-completions", input: ["text"], contextWindow: 1048576, maxTokens: 65536 },
  ];
  const noAuth = new Set<string>(["google/gemini-2.5-flash"]);
  const isAuthed = (m: FakeModel) => !noAuth.has(`${m.provider}/${m.id}`);
  return {
    cwd: os.tmpdir(),
    signal: undefined,
    modelRegistry: {
      getAll: () => models,
      getAvailable: () => models.filter(isAuthed),
      find: (provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id),
      hasConfiguredAuth: (m: FakeModel) => isAuthed(m),
      complete: completeImpl ?? (async (_m: FakeModel, ctx: { messages: unknown[] }) => ({
        role: "assistant",
        content: [{ type: "text", text: `mock-answer(${JSON.stringify(ctx.messages).length})` }],
        api: "openai-completions",
        provider: "mock",
        model: "mock",
        stopReason: "stop" as const,
        timestamp: Date.now(),
      })),
    },
  };
}

// ---- typebox mock(esbuild 打包时替换)----
export const Type = {
  Object: (props: Record<string, unknown>) => ({ type: "object", properties: props }),
  String: (opts?: unknown) => ({ type: "string", ...(opts as object) }),
};

export const tmpfile = (name: string) => path.join(os.tmpdir(), name);
export const writePng = (name: string) => {
  const p = tmpfile(name);
  fs.writeFileSync(p, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"));
  return p;
};
