/**
 * footer 状态机:纯函数,不含任何 ANSI 颜色与 TUI 依赖。
 *
 * 状态:本会话是否已触发过 describe_image 调用、最近一次调用是否失败。
 * 事件:reset(新会话)、call(describe_image 调用完成,含失败)、set/enable(模型变更)、disable(禁用)。
 * 输出:`vision: provider/model`(最近一次 call 失败追加 `!`)或 undefined(不显示)。
 *
 * 接线层(footer-controller.ts)负责:持有状态、在事件点调用 reduceFooter、把磁盘配置投影为 FooterConfig、
 * 用 ui.theme 经 colorFooter 上色后写 footer。
 */

import { DEFAULT_CONFIG, type AuxVisionConfig } from "./config";

export interface FooterState {
  /** 本会话是否已触发过 describe_image 调用。 */
  triggered: boolean;
  /** 最近一次 describe_image 调用是否失败。 */
  lastCallFailed: boolean;
}

export const INITIAL_FOOTER_STATE: FooterState = { triggered: false, lastCallFailed: false };

export type FooterEvent =
  | { type: "reset" } // 新会话开始
  | { type: "call"; ok: boolean } // describe_image 调用完成(含文件缺失等未触达模型的错误)
  | { type: "set" } // /vision set
  | { type: "enable" } // /vision enable
  | { type: "disable" }; // /vision disable

export interface FooterConfig {
  provider: string;
  model: string;
  enabled: boolean;
  showInFooter: boolean;
}

/**
 * 事件 → 状态转移。set/enable/disable 不改变状态:显示与否、显示哪个模型
 * 由 renderFooter/footerParts 依传入的配置决定(disable 后 enabled=false 自然清除)。
 */
export function reduceFooter(state: FooterState, event: FooterEvent): FooterState {
  switch (event.type) {
    case "reset":
      return INITIAL_FOOTER_STATE;
    case "call":
      return { triggered: true, lastCallFailed: !event.ok };
    case "set":
    case "enable":
    case "disable":
      return state;
  }
}

/** footer 文本结构:供接线层上色(dim 的 prefix + accent 的 model + error 的 `!`)。 */
export interface FooterParts {
  prefix: string; // "vision: "
  model: string; // "provider/model"
  failed: boolean;
}

/** 状态 + 配置 → 显示内容。未触发 / 关闭 / 未配置模型 → undefined。 */
export function footerParts(state: FooterState, cfg: FooterConfig): FooterParts | undefined {
  if (!state.triggered) return undefined;
  if (!cfg.enabled || !cfg.showInFooter) return undefined;
  if (!cfg.provider || !cfg.model) return undefined;
  return { prefix: "vision: ", model: `${cfg.provider}/${cfg.model}`, failed: state.lastCallFailed };
}

/** 状态 + 配置 → 要显示的纯文本(无颜色),不显示返回 undefined。 */
export function renderFooter(state: FooterState, cfg: FooterConfig): string | undefined {
  const parts = footerParts(state, cfg);
  if (!parts) return undefined;
  return parts.failed ? `${parts.prefix}${parts.model}!` : `${parts.prefix}${parts.model}`;
}

/** 事件 + 状态 + 配置 → 要显示的纯文本(无颜色),reduce + render 的组合入口。 */
export function footerStatus(state: FooterState, event: FooterEvent, cfg: FooterConfig): string | undefined {
  return renderFooter(reduceFooter(state, event), cfg);
}

/** 上色窄接口:纯函数层不依赖 TUI/ANSI,只约定接线层传入的 theme 需提供 fg。 */
export interface FooterTheme {
  fg(color: "dim" | "accent" | "error", text: string): string;
}

/** FooterParts → 上色文本:dim 前缀 + accent 模型名 + 失败时追加 error 色 `!`。纯函数,theme 由调用方传入。 */
export function colorFooter(parts: FooterParts, theme: FooterTheme): string {
  return (
    theme.fg("dim", parts.prefix) +
    theme.fg("accent", parts.model) +
    (parts.failed ? theme.fg("error", "!") : "")
  );
}

/** 磁盘配置(AuxVisionConfig | null)→ FooterConfig;缺省值(空模型、DEFAULT_CONFIG 开关)归此一处。 */
export function projectFooterConfig(cfg: AuxVisionConfig | null): FooterConfig {
  return {
    provider: cfg?.provider ?? "",
    model: cfg?.model ?? "",
    enabled: cfg?.enabled ?? DEFAULT_CONFIG.enabled,
    showInFooter: cfg?.showInFooter ?? DEFAULT_CONFIG.showInFooter,
  };
}
