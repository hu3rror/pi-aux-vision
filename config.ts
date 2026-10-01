import { getAgentDir } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";

export interface AuxVisionConfig {
  enabled: boolean;
  provider: string;
  model: string;
  maxOutputTokens: number;
  maxRetries: number;
  maxRetryDelayMs: number;
  /** footer 常驻显示开关(本会话触发过 describe_image 后显示)。 */
  showInFooter: boolean;
}

export const DEFAULT_CONFIG: Omit<AuxVisionConfig, "provider" | "model"> = {
  enabled: true,
  // 转录底座契约(ADR-0002):穷尽转录需要更大预算,截断时工具会显式提示而非静默截断。
  maxOutputTokens: 8192,
  maxRetries: 2,
  maxRetryDelayMs: 5000,
  showInFooter: true,
};

export function canonicalConfigPath(): string {
  return path.join(getAgentDir(), "extensions", "aux-vision.json");
}

/** 旧版路径:仅当规范路径缺失时作为兜底读取,从不写入(ADR-0003)。 */
export function legacyConfigPath(): string {
  return path.join(getAgentDir(), "aux-vision.json");
}

export type ConfigSource = "canonical" | "legacy";

/** 生效配置文件:规范优先,缺失回退旧路径,两文件整选不合并(ADR-0003)。 */
export function resolveConfigFile(): { path: string; source: ConfigSource } | null {
  if (fs.existsSync(canonicalConfigPath())) return { path: canonicalConfigPath(), source: "canonical" };
  if (fs.existsSync(legacyConfigPath())) return { path: legacyConfigPath(), source: "legacy" };
  return null;
}

/** 读取配置;文件缺失或损坏返回 null。 */
export function loadConfig(): AuxVisionConfig | null {
  const file = resolveConfigFile();
  if (!file) return null;
  try {
    const data = JSON.parse(fs.readFileSync(file.path, "utf-8")) as Partial<AuxVisionConfig>;
    return {
      enabled: typeof data.enabled === "boolean" ? data.enabled : DEFAULT_CONFIG.enabled,
      provider: typeof data.provider === "string" ? data.provider : "",
      model: typeof data.model === "string" ? data.model : "",
      maxOutputTokens:
        typeof data.maxOutputTokens === "number" ? data.maxOutputTokens : DEFAULT_CONFIG.maxOutputTokens,
      maxRetries: typeof data.maxRetries === "number" ? data.maxRetries : DEFAULT_CONFIG.maxRetries,
      maxRetryDelayMs:
        typeof data.maxRetryDelayMs === "number" ? data.maxRetryDelayMs : DEFAULT_CONFIG.maxRetryDelayMs,
      showInFooter:
        typeof data.showInFooter === "boolean" ? data.showInFooter : DEFAULT_CONFIG.showInFooter,
    };
  } catch {
    return null;
  }
}

export function saveConfig(cfg: AuxVisionConfig): void {
  // 写入永远走规范路径(惰性迁移:下次保存自动把旧内容落盘到新位置,旧文件保留不动,ADR-0003)。
  const dir = path.dirname(canonicalConfigPath());
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(canonicalConfigPath(), JSON.stringify(cfg, null, 2) + "\n", "utf-8");
}
