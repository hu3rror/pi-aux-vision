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
  maxOutputTokens: 4096,
  maxRetries: 2,
  maxRetryDelayMs: 5000,
  showInFooter: true,
};

export function configPath(): string {
  return path.join(getAgentDir(), "aux-vision.json");
}

/** 读取配置;文件缺失或损坏返回 null。 */
export function loadConfig(): AuxVisionConfig | null {
  try {
    const data = JSON.parse(fs.readFileSync(configPath(), "utf-8")) as Partial<AuxVisionConfig>;
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
  const dir = path.dirname(configPath());
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2) + "\n", "utf-8");
}
