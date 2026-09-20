import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";

/** 模型是否支持图像输入。 */
export function isVisionModel(m: Model<Api>): boolean {
  return Array.isArray(m.input) && m.input.includes("image");
}

/** 当前所有可用(已认证)且支持图像输入的模型,按 modelRegistry 顺序。 */
export function listVisionModels(ctx: ExtensionContext): Model<Api>[] {
  return ctx.modelRegistry.getAvailable().filter(isVisionModel);
}

/** 按 modelRegistry 顺序取第一个支持图像输入的模型。 */
export function findFirstVisionModel(ctx: ExtensionContext): Model<Api> | undefined {
  return ctx.modelRegistry.getAvailable().find(isVisionModel);
}

/** 按 provider/model 定位模型,校验支持图像输入且认证已配置;无效返回 undefined。 */
export function findConfiguredModel(
  ctx: ExtensionContext,
  provider: string,
  modelId: string,
): Model<Api> | undefined {
  const m = ctx.modelRegistry.find(provider, modelId);
  if (!m || !isVisionModel(m)) return undefined;
  if (!ctx.modelRegistry.hasConfiguredAuth(m)) return undefined;
  return m;
}

export interface VisionProviderGroup {
  provider: string;
  models: Model<Api>[];
  /** 已认证模型数。 */
  authed: number;
  /** 模型总数。 */
  total: number;
}

/**
 * 按 provider 聚合 vision 模型。含已认证模型的 provider 排前(组内保持 registry 顺序),
 * 全部未认证的 provider 排后。
 */
export function groupVisionProviders(models: Model<Api>[], isAuthed: (m: Model<Api>) => boolean): VisionProviderGroup[] {
  const byProvider = new Map<string, Model<Api>[]>();
  for (const m of models) {
    const list = byProvider.get(m.provider) ?? [];
    list.push(m);
    byProvider.set(m.provider, list);
  }
  const groups: VisionProviderGroup[] = Array.from(byProvider.entries()).map(([provider, ms]) => {
    const authed = ms.filter(isAuthed).length;
    return { provider, models: ms, authed, total: ms.length };
  });
  // 稳定排序:含已认证模型的 provider 在前,其余保持 registry 顺序。
  return groups.sort((a, b) => Number(a.authed === 0) - Number(b.authed === 0));
}

/** 上下文窗口格式化:1048576 → "1M",262144 → "256K"。 */
export function formatContextWindow(n: number): string {
  if (n >= 1_048_576) {
    const m = n / 1_048_576;
    return `${m % 1 === 0 ? m : m.toFixed(1)}M`;
  }
  if (n >= 1024) return `${Math.round(n / 1024)}K`;
  return `${n}`;
}

/** provider 选择器说明列:`22 个模型` / `2 个模型 · 1 未认证`。 */
export function formatProviderDescription(total: number, authed: number): string {
  return authed < total
    ? `${total} 个模型 · ${total - authed} 未认证`
    : `${total} 个模型`;
}

/** 模型选择器说明列:`1M ctx · 协议`,未认证追加 `· 需 /login`。 */
export function formatModelDescription(model: Model<Api>, authed: boolean): string {
  const base = `${formatContextWindow(model.contextWindow)} ctx · ${model.api}`;
  return authed ? base : `${base} · 需 /login`;
}

/**
 * 候选策略:默认只返回已认证的 vision 模型;一个已认证都没有时退全量(含未认证)。
 * 避免内置目录 30+ provider 铺满选择器。
 */
export function resolveVisionCandidates(
  available: Model<Api>[],
  all: Model<Api>[],
): { models: Model<Api>[]; usingAll: boolean } {
  const authed = available.filter(isVisionModel);
  if (authed.length > 0) return { models: authed, usingAll: false };
  return { models: all.filter(isVisionModel), usingAll: true };
}
