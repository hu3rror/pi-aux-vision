import { type ExtensionAPI, type ExtensionContext, type ModelSelectEvent } from "@earendil-works/pi-coding-agent";
import type { SelectItem } from "@earendil-works/pi-tui";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { DEFAULT_CONFIG, legacyConfigPath, loadConfig, resolveConfigFile, saveConfig, type AuxVisionConfig } from "./config";
import { findConfiguredModel, findFirstVisionModel, formatContextWindow, formatModelDescription, formatProviderDescription, groupVisionProviders, isVisionModel, listVisionModels, resolveVisionCandidates } from "./discovery";
import { describeImage, isErrorResult, type DescribeImageResult } from "./vision";
import { generateTestImage } from "./test-image";
import { createFooterController } from "./footer-controller";

import { pickFromList } from "./ui";

const TOOL_NAME = "describe_image";
const TEST_QUESTION =
  "Describe this test image: repeat all visible text, and state which colors the red, blue, and green blocks are.";
/** 用法与状态的分隔线:notify 为纯文本渲染,markdown 分隔符不生效。 */
const STATUS_DIVIDER = "─".repeat(60);

export default function (pi: ExtensionAPI) {
  let toolRegistered = false;
  /** 旧路径回退通知:每会话一次(ADR-0003)。 */
  let legacyNotified = false;
  /** getArgumentCompletions has no ExtensionContext; cache the registry from session_start (pattern from pi's built-in mcp extension). */
  let modelRegistry: ExtensionContext["modelRegistry"] | null = null;

  // footer controller:状态与 footer key 收在闭包,事件点一行转发
  const footer = createFooterController();

  // 加载期只做注册:动作方法(getActiveTools/setActiveTools)在扩展加载阶段被 pi 禁止,
  // 可见性完全由门控在 session_start/model_select 中决定(ADR-0004)
  registerToolOnce();

  /** 差分控制 describe_image 在当前会话的可见性,不动其他工具。 */
  function ensureToolActive(active: boolean) {
    const current = pi.getActiveTools();
    const has = current.includes(TOOL_NAME);
    if (active && !has) pi.setActiveTools([...current, TOOL_NAME]);
    else if (!active && has) pi.setActiveTools(current.filter((t) => t !== TOOL_NAME));
  }

  /** 写入配置并启用指定视觉模型;返回给用户的提示文本。可见性由门控决定,这里只落配置(ADR-0004)。 */
  function applySelection(provider: string, modelId: string): string {
    const prev = loadConfig() ?? { ...DEFAULT_CONFIG, provider: "", model: "" };
    const fresh: AuxVisionConfig = { ...prev, enabled: true, provider, model: modelId };
    saveConfig(fresh);
    return `aux-vision: configured and enabled ${provider}/${modelId}.`;
  }

  /** 加载即注册;注册后立即移出可见集合(pi 0.86 无 defaultActive,稳态等价,ADR-0004)。 */
  function registerToolOnce() {
    if (toolRegistered) return;
    toolRegistered = true;
    pi.registerTool({
      name: TOOL_NAME,
      label: "Describe Image",
      description:
        "Analyze a local image file with a vision-capable model and answer a specific question about it. " +
        "Pass the exact on-disk path and a precise, focused question, e.g. \"extract the stack trace shown in line 4 of the error message\" or \"why is the button shifted 10px to the right?\". " +
        "The tool reads the file once, sends it to the configured vision model once, and returns text. " +
        "The result ALWAYS begins with an exhaustive transcription base — image type, verbatim transcription of all visible text, and layout/order — followed by the answer to your question and a completeness attestation, so you can reason from the base even about parts you did not ask about. " +
        "If the result says the transcription was truncated (output hit the token limit), call again with a narrower question or scope. " +
        "Only call this when the actual image content matters — never guess content from the path or filename alone.",
      promptSnippet: "Analyze a local image file with a vision model, answering a precise question",
      promptGuidelines: [
        "Use describe_image when the user asks to analyze or extract information from an image file on disk — reading error messages or stack traces, checking UI screenshots or layout issues, transcribing text or diagrams. Pass the file path and a precise question; never guess image content from the path alone.",
      ],
      parameters: Type.Object({
        image_path: Type.String({
          description: "Absolute or workspace-relative path to the image file on disk (png/jpeg/gif/webp/bmp)",
        }),
        question: Type.String({
          description: "The specific question to answer about the image content",
        }),
      }),
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        const result = await runDescribe(params, ctx, signal);
        // 任何调用(含失败)都算触发:footer 显示模型并保持到会话结束
        footer.on({ type: "call", ok: !isErrorResult(result) }, ctx.ui);
        return result;
      },
    });
  }

  /** describe_image 主体:校验配置与模型可用性后走官方管线;供 execute 触发 footer 事件。 */
  async function runDescribe(
    params: { image_path: string; question: string },
    ctx: ExtensionContext,
    signal: AbortSignal | undefined,
  ): Promise<DescribeImageResult> {
    const cfg = loadConfig();
    if (!cfg || !cfg.enabled || !cfg.provider || !cfg.model) {
      const text =
        "aux-vision plugin is not enabled. Run /vision status for details, or /vision set <provider> <model> to configure a vision model.";
      return {
        content: [{ type: "text", text }],
        details: { error: text },
      };
    }
    const model = findConfiguredModel(ctx, cfg.provider, cfg.model);
    if (!model) {
      const text = `The configured vision model ${cfg.provider}/${cfg.model} is unavailable (not found or not authenticated). Run /vision list to see available models.`;
      return {
        content: [{ type: "text", text }],
        details: { error: text },
      };
    }
    return describeImage(params, ctx, model, cfg, signal);
  }

  /** 门控核心(ADR-0004):工具可见 ⇔ 启用 && 已配置可用 && 当前模型已定且盲。 */
  function syncToolVisibility(ctx: ExtensionContext): { activated: boolean; announced: boolean } {
    const cfg = loadConfig();
    const main = ctx.model;
    const blind = main ? !isVisionModel(main) : false;
    const inactive = { activated: false, announced: false };

    // 用户主动禁用:保持安静,任何会话都不介入
    if (cfg && !cfg.enabled) {
      ensureToolActive(false);
      return inactive;
    }

    // 未配置(无文件或缺 provider/model):仅在主模型已定且盲时自动发现,视觉会话不写配置、不通知
    const configured = Boolean(cfg && cfg.provider && cfg.model);
    if (!configured) {
      if (!blind) {
        ensureToolActive(false);
        return inactive;
      }
      const m = findFirstVisionModel(ctx);
      if (!m) {
        ensureToolActive(false);
        ctx.ui.notify(
          "aux-vision: no vision-capable model detected; plugin not enabled. Configure one with /vision set <provider> <model>.",
          "warning",
        );
        return inactive;
      }
      const base: AuxVisionConfig = cfg ?? { ...DEFAULT_CONFIG, provider: "", model: "" };
      saveConfig({ ...base, provider: m.provider, model: m.id });
      ensureToolActive(true);
      ctx.ui.notify(
        `aux-vision: automatically configured vision model ${m.provider}/${m.id}; describe_image is now exposed. Tune with /vision set or verify with /vision test.`,
        "info",
      );
      return { activated: true, announced: true };
    }

    // 配置了模型但不可用 → 回退自动发现(仅盲会话,与旧行为一致)
    if (!findConfiguredModel(ctx, cfg!.provider, cfg!.model)) {
      if (!blind) {
        ensureToolActive(false);
        return inactive;
      }
      const fallback = findFirstVisionModel(ctx);
      if (!fallback) {
        ensureToolActive(false);
        ctx.ui.notify(
          "aux-vision: the configured model is unavailable and no other vision-capable model is available; plugin not enabled.",
          "warning",
        );
        return inactive;
      }
      const fresh: AuxVisionConfig = { ...cfg!, provider: fallback.provider, model: fallback.id };
      saveConfig(fresh);
      ensureToolActive(true);
      ctx.ui.notify(
        `aux-vision: configured model ${cfg!.provider}/${cfg!.model} is unavailable; fell back to ${fallback.provider}/${fallback.id} and saved the config.`,
        "warning",
      );
      return { activated: true, announced: true };
    }

    const wasActive = pi.getActiveTools().includes(TOOL_NAME);
    ensureToolActive(blind);
    return { activated: blind && !wasActive, announced: false };
  }

  /** 门控状态描述:/vision status 展示用(ADR-0004)。 */
  function gatingNote(ctx: ExtensionContext, cfg: AuxVisionConfig | null): string {
    if (!cfg) return "Gating: no vision model configured; describe_image is not exposed";
    if (!cfg.enabled) return "Gating: plugin disabled; describe_image is not exposed";
    if (!cfg.provider || !cfg.model) return "Gating: no vision model configured; describe_image is not exposed";
    if (!ctx.model) return "Gating: session model not set; describe_image not exposed yet";
    return isVisionModel(ctx.model)
      ? "Gating: session model reads images natively; describe_image is not exposed"
      : "Gating: session model cannot read images; describe_image is exposed";
  }

  /** 门控反馈后缀:当前模型具读图能力时追加说明,避免"已配置并启用"误导(ADR-0004)。 */
  function gatingSuffix(ctx: ExtensionContext): string {
    return ctx.model && isVisionModel(ctx.model)
      ? "The session model reads images natively, so describe_image stays unexposed."
      : "";
  }

  /** 未配置/未启用 → warning,有效启用态 → info。 */
  function statusLevel(cfg: AuxVisionConfig | null): "info" | "warning" {
    return cfg && cfg.provider && cfg.model && cfg.enabled ? "info" : "warning";
  }

  function statusText(ctx: ExtensionContext, cfg: AuxVisionConfig | null): string {
    if (!cfg || !cfg.provider || !cfg.model) {
      return `aux-vision: no vision model configured; plugin not enabled.\n${gatingNote(ctx, cfg)}`;
    }
    const model = findConfiguredModel(ctx, cfg.provider, cfg.model);
    const detail = model
      ? `api ${model.api} | context ${formatContextWindow(model.contextWindow)} | max output ${model.maxTokens}`
      : "(model currently unavailable)";
    return `aux-vision: ${cfg.enabled ? "enabled" : "disabled"} | ${cfg.provider}/${cfg.model} | footer: ${cfg.showInFooter ? "on" : "off"}\n${detail}\n${gatingNote(ctx, cfg)}`;
  }

  /** 写入选择并同步门控:通知(含门控后缀)+ 单点同步 + footer 事件(ADR-0004)。 */
  function applyAndSync(provider: string, modelId: string, footerEvent: "set" | "enable", ctx: ExtensionContext): void {
    ctx.ui.notify(applySelection(provider, modelId) + gatingSuffix(ctx), "info");
    syncToolVisibility(ctx);
    footer.on({ type: footerEvent }, ctx.ui);
  }

  /** Completion for `set `: authenticated vision models only (no unauthenticated fallback, unlike the picker). */
  function visionModelCompletions(argumentPrefix: string): AutocompleteItem[] {
    if (!modelRegistry) return [];
    const [, afterSet] = /^set\s+(.*)$/.exec(argumentPrefix.trimStart()) ?? [];
    const parts = (afterSet ?? "").trim().split(/\s+/);
    const providerPart = parts[0] ?? "";
    const modelPart = parts[1] ?? "";
    const cfg = loadConfig();
    const currentKey = cfg ? `${cfg.provider}/${cfg.model}` : "";
    return modelRegistry
      .getAvailable()
      .filter(isVisionModel)
      .filter((m) => m.provider.startsWith(providerPart))
      .filter((m) => !modelPart || m.id.startsWith(modelPart))
      // 当前选择排首位:补全打开即见,且默认高亮行(accent 配色)落在它身上
      .sort((a, b) => {
        const keyA = `${a.provider}/${a.id}` === currentKey ? 0 : 1;
        const keyB = `${b.provider}/${b.id}` === currentKey ? 0 : 1;
        return keyA - keyB;
      })
      .map((m) => {
        const label = `${m.provider}/${m.id}`;
        return {
          value: `set ${m.provider} ${m.id}`,
          // 当前选择用 label 前导 ● 标注:description 右对齐、窄屏截断且 muted,放尾部不可见
          label: label === currentKey ? `● ${label}` : label,
          description: formatModelDescription(m, true),
        };
      });
  }

  pi.on("session_start", (_event, ctx) => {
    // 新会话:footer 回到未触发(不显示);门控通知按会话重置
    footer.on({ type: "reset" }, ctx.ui);
    modelRegistry = ctx.modelRegistry;
    legacyNotified = false;
    // 旧路径回退:每会话一次,仅旧配置实际可读时通知,不引导迁移命令(ADR-0003)
    if (resolveConfigFile()?.source === "legacy" && loadConfig() !== null && !legacyNotified) {
      legacyNotified = true;
      ctx.ui.notify(
        `aux-vision: using config from the legacy path (${legacyConfigPath()}); the next config change will be written to the new path.`,
        "info",
      );
    }
    syncToolVisibility(ctx);
  });

  pi.on("model_select", (event: ModelSelectEvent, ctx: ExtensionContext) => {
    // 盲→视觉:静默退出;视觉→盲:工具出现且无自带通知时提示一次(ADR-0004)
    const { activated, announced } = syncToolVisibility(ctx);
    if (activated && !announced) {
      ctx.ui.notify("aux-vision: describe_image is now exposed (session model cannot read images).", "info");
    }
  });

  pi.registerCommand("vision", {
    description: "Manage the aux-vision image analysis tool (describe_image)",
    getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
      const subcommands = ["status", "set", "list", "enable", "disable", "test"];
      if (!prefix || !prefix.includes(" ")) {
        return subcommands
          .filter((s) => s.startsWith(prefix))
          .map((s) => ({ value: s, label: s }));
      }
      if (prefix.trimStart().startsWith("set ")) {
        return visionModelCompletions(prefix);
      }
      if (prefix.trimStart().startsWith("test ")) {
        return [{ value: "test <path>", label: "test <path> — test with a specific image file" }];
      }
      return [];
    },
    handler: async (args, ctx) => {
      const parts = (args ?? "").trim().split(/\s+/);
      const sub = parts[0] ?? "";
      switch (sub) {
        case "status": {
          const cfg = loadConfig();
          ctx.ui.notify(statusText(ctx, cfg), statusLevel(cfg));
          return;
        }
        case "set": {
          const provider = parts[1];
          const modelId = parts.slice(2).join(" ");
          if (!provider || !modelId) {
            // 交互式选择:provider → model,行为对齐 /login
            if (!ctx.hasUI) {
              ctx.ui.notify("Usage: /vision set <provider> <model>, e.g. /vision set google gemini-2.5-flash.", "warning");
              return;
            }
            // 候选:已认证优先;无已认证才退全量(避免内置目录 30+ provider 铺满选择器)
            const { models: candidates } = resolveVisionCandidates(
              ctx.modelRegistry.getAvailable(),
              ctx.modelRegistry.getAll(),
            );
            if (candidates.length === 0) {
              ctx.ui.notify("No vision-capable models available (none registered or authenticated).", "warning");
              return;
            }
            const cfg = loadConfig();
            const groups = groupVisionProviders(candidates, (m) =>
              ctx.modelRegistry.hasConfiguredAuth(m),
            );
            const providerItems: SelectItem[] = groups.map((g) => ({
              value: g.provider,
              label: g.provider,
              description: formatProviderDescription(g.total, g.authed),
            }));
            const providerIdx = providerItems.findIndex((it) => it.value === cfg?.provider);
            const pickedProvider = await pickFromList(ctx, "Select a vision model provider:", providerItems, providerIdx);
            if (!pickedProvider) {
              ctx.ui.notify("Cancelled.", "info");
              return;
            }
            const group = groups.find((g) => g.provider === pickedProvider)!;
            const modelItems: SelectItem[] = group.models.map((m) => ({
              value: m.id,
              label: m.id,
              description: formatModelDescription(m, ctx.modelRegistry.hasConfiguredAuth(m)),
            }));
            const modelIdx = modelItems.findIndex((it) => it.value === cfg?.model);
            const pickedModel = await pickFromList(ctx, `Select a vision model from ${group.provider}:`, modelItems, modelIdx);
            if (!pickedModel) {
              ctx.ui.notify("Cancelled.", "info");
              return;
            }
            const model = group.models.find((m) => m.id === pickedModel)!;
            if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
              ctx.ui.notify(
                `Model ${group.provider}/${model.id} is not authenticated. Run /login ${group.provider} first, then /vision set again.`,
                "warning",
              );
              return;
            }
            applyAndSync(group.provider, model.id, "set", ctx);
            return;
          }
          const model = findConfiguredModel(ctx, provider, modelId);
          if (!model) {
            ctx.ui.notify(`Model ${provider}/${modelId} is unavailable (does not exist, does not accept images, or is not authenticated). Run /vision list to see available models.`, "error");
            return;
          }
          applyAndSync(provider, modelId, "set", ctx);
          return;
        }
        case "list": {
          const models = listVisionModels(ctx);
          if (models.length === 0) {
            ctx.ui.notify("aux-vision: no authenticated vision-capable models available. Run /login for the provider you want to use.", "warning");
            return;
          }
          const cfg = loadConfig();
          const current = cfg ? `${cfg.provider}/${cfg.model}` : "";
          const lines = models.map((m) => {
            const key = `${m.provider}/${m.id}`;
            // 当前行用前导 ● 标注:行首左缘最显眼,尾部标记会融入模型名
            return key === current ? `● ${key}` : key;
          });
          ctx.ui.notify(`Available vision models:\n${lines.join("\n")}`, "info");
          return;
        }
        case "enable": {
          let cfg = loadConfig();
          if (!cfg) {
            cfg = { ...DEFAULT_CONFIG, provider: "", model: "" };
          }
          if (!cfg.provider || !cfg.model) {
            const m = findFirstVisionModel(ctx);
            if (m) {
              cfg = { ...cfg, provider: m.provider, model: m.id };
              ctx.ui.notify(`aux-vision: auto-selected ${m.provider}/${m.id}.`, "info");
            } else {
              ctx.ui.notify("aux-vision: no vision-capable model available; run /login or /vision set first.", "warning");
              return;
            }
          }
          applyAndSync(cfg.provider, cfg.model, "enable", ctx);
          return;
        }
        case "disable": {
          const cfg = loadConfig() ?? { ...DEFAULT_CONFIG, provider: "", model: "" };
          const fresh: AuxVisionConfig = { ...cfg, enabled: false };
          saveConfig(fresh);
          // 走单点同步:disabled 状态由门控统一处理为不介入(ADR-0004)
          syncToolVisibility(ctx);
          ctx.ui.notify("aux-vision: disabled; describe_image is no longer exposed to the model.", "info");
          footer.on({ type: "disable" }, ctx.ui);
          return;
        }
        case "test": {
          const cfg = loadConfig();
          if (!cfg || !cfg.enabled || !cfg.provider || !cfg.model) {
            ctx.ui.notify("aux-vision: not enabled; cannot test. Run /vision set or /vision enable first.", "warning");
            return;
          }
          const model = findConfiguredModel(ctx, cfg.provider, cfg.model);
          if (!model) {
            ctx.ui.notify(`Model ${cfg.provider}/${cfg.model} is unavailable; cannot test. Run /vision list.`, "error");
            return;
          }
          const imagePath = parts.slice(1).join(" ") || (await generateTestImage());
          ctx.ui.notify(`aux-vision: analyzing ${imagePath} with ${cfg.provider}/${cfg.model} ...`, "info");
          const result = await describeImage(
            { image_path: imagePath, question: TEST_QUESTION },
            ctx,
            model,
            cfg,
            ctx.signal,
          );
          // /vision test 也是本会话内实际调用视觉模型:与 execute 一致,成功/失败都算触发
          const testFailed = isErrorResult(result);
          footer.on({ type: "call", ok: !testFailed }, ctx.ui);
          if (testFailed) {
            ctx.ui.notify(`aux-vision test failed: ${result.content[0].text}`, "error");
            return;
          }
          const text = result.content[0].text;
          ctx.ui.notify(
            `aux-vision test passed (${cfg.provider}/${cfg.model}): ${text.slice(0, 300)}${text.length > 300 ? " …" : ""}`,
            "info",
          );
          return;
        }
        default: {
          const cfg = loadConfig();
          ctx.ui.notify(
            `Usage: /vision status | set <provider> <model> | list | enable | disable | test [path]\n${STATUS_DIVIDER}\n${statusText(ctx, cfg)}`,
            statusLevel(cfg),
          );
          return;
        }
      }
    },
  });
}
