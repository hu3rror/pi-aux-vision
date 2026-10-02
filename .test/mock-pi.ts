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

// Tool result contract (ADR-0001): success { model, usage }, failure { error }.
export interface MockToolResult {
  content: { type: "text"; text: string }[];
  details: { model: string; usage: { totalTokens: number } } | { error: string };
}

export function makeFakeCtx(completeImpl?: (model: FakeModel) => unknown, model?: FakeModel) {
  const models: FakeModel[] = [
    { provider: "sensenova-anthropic", id: "sensenova-6.8-flash-lite", api: "anthropic-messages", input: ["text", "image"], contextWindow: 262144, maxTokens: 65536 },
    { provider: "google", id: "gemini-2.5-flash", api: "google-generative-ai", input: ["text", "image"], contextWindow: 1048576, maxTokens: 65536 },
    { provider: "google", id: "gemini-3.1-flash-lite", api: "google-generative-ai", input: ["text", "image"], contextWindow: 1048576, maxTokens: 65536 },
    { provider: "sensenova", id: "deepseek-v4-flash", api: "openai-completions", input: ["text"], contextWindow: 1048576, maxTokens: 65536 },
  ];
  const noAuth = new Set<string>(["google/gemini-2.5-flash"]);
  const isAuthed = (m: FakeModel) => !noAuth.has(`${m.provider}/${m.id}`);
  const statusCalls: { key: string; text: string | undefined }[] = [];
  const notifies: { text: string; level: string | undefined }[] = [];
  return {
    cwd: os.tmpdir(),
    signal: undefined,
    model,
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
        usage: {
          input: 10,
          output: 20,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 30,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      })),
    },
    // footer 接线测试:记录 setStatus 调用;notify 记录通知文本;theme 保持可用
    ui: {
      setStatus: (key: string, text: string | undefined) => {
        statusCalls.push({ key, text });
      },
      notify: (text: string, level?: string) => {
        notifies.push({ text, level });
      },
      theme: fakeTheme,
    },
    uiStatusCalls: statusCalls,
    uiNotifies: notifies,
  };
}

// ---- ui/theme mock(接线层上色断言用)----
export const fakeTheme = {
  fg: (color: string, text: string) => `[${color}]${text}[/${color}]`,
  bold: (t: string) => t,
  dim: (t: string) => t,
};

// ---- pi-tui / pi-coding-agent 组件桩(仅需可解析,接线测试不会实例化)----
export class Container {
  addChild(_c: unknown) {}
  render(_w: unknown) {}
  invalidate() {}
}
export class DynamicBorder {
  constructor(_fn?: unknown) {}
  render(_w: unknown) {}
  invalidate() {}
}
export class SelectList {
  constructor(_items: unknown[], _height?: number, _opts?: unknown) {}
  setSelectedIndex(_i: number) {}
  onSelect: unknown;
  onCancel: unknown;
  handleInput(_d: unknown) {}
  render(_w: unknown) {}
  invalidate() {}
}
export class Text {
  constructor(_t: string, _x: number, _y: number) {}
  render(_w: unknown) {}
  invalidate() {}
}

// ---- ExtensionAPI 桩:捕获工具/命令注册与事件处理器,供接线测试驱动 ----
// 模拟 pi 0.99+ 的加载守卫:扩展加载期调用动作方法(getActiveTools/setActiveTools 等)
// 会抛 "Extension runtime not initialized",与真实运行时一致;markReady() 模拟运行时就绪。
const LOADING_ERROR = "Extension runtime not initialized. Action methods cannot be called during extension loading.";

export function makeFakePi() {
  const tools = new Map<string, unknown>();
  const commands = new Map<string, unknown>();
  const events = new Map<string, ((event: unknown, ctx: unknown) => Promise<void> | void)[]>();
  let activeTools: string[] = [];
  let ready = false;
  return {
    pi: {
      registerTool: (def: { name: string }) => {
        tools.set(def.name, def);
      },
      registerCommand: (name: string, def: unknown) => {
        commands.set(name, def);
      },
      on: (event: string, cb: (event: unknown, ctx: unknown) => Promise<void> | void) => {
        const list = events.get(event) ?? [];
        list.push(cb);
        events.set(event, list);
      },
      getActiveTools: () => {
        if (!ready) throw new Error(LOADING_ERROR);
        return activeTools;
      },
      setActiveTools: (t: string[]) => {
        if (!ready) throw new Error(LOADING_ERROR);
        activeTools = [...t];
      },
    },
    /** 模拟运行时就绪:扩展加载完成后调用,动作方法才可用。 */
    markReady() {
      ready = true;
    },
    tool: (name: string) => tools.get(name) as { execute: (...args: unknown[]) => Promise<MockToolResult> } | undefined,
    command: (name: string) => commands.get(name) as { handler: (...args: unknown[]) => Promise<void> | void } | undefined,
    async fire(event: string, e: unknown, ctx: unknown) {
      for (const cb of events.get(event) ?? []) await cb(e, ctx);
    },
  };
}

// ---- typebox mock(esbuild 打包时替换):最小 schema 构造 + 校验语义 ----
export const Type = {
  Object: (properties: Record<string, unknown>, opts?: { additionalProperties?: boolean }) => ({
    kind: "Object",
    properties,
    ...(opts ?? {}),
  }),
  String: (opts?: unknown) => ({ kind: "String", ...(opts as object) }),
  Number: () => ({ kind: "Number" }),
  Boolean: () => ({ kind: "Boolean" }),
  Literal: (value: unknown) => ({ kind: "Literal", value }),
  Optional: (value: unknown) => ({ kind: "Optional", value }),
  Union: (anyOf: unknown[]) => ({ kind: "Union", anyOf }),
};

// 契约校验(ADR-0005):outputSchema 与 structuredContent 一致性;non-strict 语义,额外属性忽略。
export const Value = {
  Check: (schema: any, value: unknown): boolean => {
    switch (schema?.kind) {
      case "Object":
        if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
        return Object.entries(schema.properties).every(([k, sub]) => Value.Check(sub, (value as Record<string, unknown>)[k]));
      case "String":
        return typeof value === "string";
      case "Number":
        return typeof value === "number";
      case "Boolean":
        return typeof value === "boolean";
      case "Literal":
        return value === schema.value;
      case "Optional":
        return value === undefined || Value.Check(schema.value, value);
      case "Union":
        return schema.anyOf.some((s: any) => Value.Check(s, value));
      default:
        return false;
    }
  },
};

export const tmpfile = (name: string) => path.join(os.tmpdir(), name);
export const writePng = (name: string) => {
  const p = tmpfile(name);
  fs.writeFileSync(p, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"));
  return p;
};
