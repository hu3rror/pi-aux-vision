import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SelectItem } from "@earendil-works/pi-tui";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { DEFAULT_CONFIG, loadConfig, saveConfig, type AuxVisionConfig } from "./config";
import { findConfiguredModel, findFirstVisionModel, formatModelDescription, formatProviderDescription, groupVisionProviders, listVisionModels, resolveVisionCandidates } from "./discovery";
import { describeImage } from "./vision";
import { generateTestImage } from "./test-image";

import { pickFromList } from "./ui";

const TOOL_NAME = "describe_image";
const TEST_QUESTION = "描述这张测试图:复述图中所有文字,并说明红、蓝、绿色块分别是什么颜色。";

export default function (pi: ExtensionAPI) {
  let toolRegistered = false;
  let initialized = false;

  /** 差分控制 describe_image 在当前会话的可见性,不动其他工具。 */
  function ensureToolActive(active: boolean) {
    const current = pi.getActiveTools();
    const has = current.includes(TOOL_NAME);
    if (active && !has) pi.setActiveTools([...current, TOOL_NAME]);
    else if (!active && has) pi.setActiveTools(current.filter((t) => t !== TOOL_NAME));
  }

  /** 注册工具并确保对模型可见。 */
  function enableTool() {
    registerToolOnce();
    ensureToolActive(true);
  }

  /** 写入配置并启用指定视觉模型;返回给用户的提示文本。 */
  function applySelection(provider: string, modelId: string): string {
    const prev = loadConfig() ?? { ...DEFAULT_CONFIG, provider: "", model: "" };
    const fresh: AuxVisionConfig = { ...prev, enabled: true, provider, model: modelId };
    saveConfig(fresh);
    enableTool();
    return `aux-vision: 已配置并启用 ${provider}/${modelId}。`;
  }

  function registerToolOnce() {
    if (toolRegistered) return;
    toolRegistered = true;
    pi.registerTool({
      name: TOOL_NAME,
      label: "Describe Image",
      description:
        "Analyze a local image file with a vision-capable model and answer a specific question about it. " +
        "Pass the exact on-disk path and a precise, focused question, e.g. \"extract the stack trace shown in line 4 of the error message\" or \"why is the button shifted 10px to the right?\". " +
        "The tool reads the file once, sends it to the configured vision model once, and returns the model's answer as text. " +
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
        const cfg = loadConfig();
        if (!cfg || !cfg.enabled || !cfg.provider || !cfg.model) {
          return {
            content: [
              {
                type: "text",
                text: "aux-vision 插件未启用。运行 /vision status 查看状态,用 /vision set <provider> <model> 配置视觉模型。",
              },
            ],
            isError: true,
          };
        }
        const model = findConfiguredModel(ctx, cfg.provider, cfg.model);
        if (!model) {
          return {
            content: [
              {
                type: "text",
                text: `配置的视觉模型 ${cfg.provider}/${cfg.model} 当前不可用(不存在或未认证)。运行 /vision list 查看可用模型。`,
              },
            ],
            isError: true,
          };
        }
        return describeImage(params, ctx, model, cfg, signal);
      },
    });
  }

  async function initialize(ctx: ExtensionContext) {
    if (initialized) return;
    initialized = true;

    const cfg = loadConfig();
    const hasSelection = Boolean(cfg && cfg.provider && cfg.model);

    if (hasSelection) {
      if (!cfg!.enabled) return; // 用户主动禁用,保持安静
      if (findConfiguredModel(ctx, cfg!.provider, cfg!.model)) {
        enableTool();
        return;
      }
      // 配置失效 → 回退自动发现
      const fallback = findFirstVisionModel(ctx);
      if (fallback) {
        const fresh: AuxVisionConfig = { ...cfg!, provider: fallback.provider, model: fallback.id };
        saveConfig(fresh);
        enableTool();
        ctx.ui.notify(
          `aux-vision: 配置的模型 ${cfg!.provider}/${cfg!.model} 不可用,已回退至 ${fallback.provider}/${fallback.id} 并写入配置。`,
          "warn",
        );
      } else {
        ctx.ui.notify(
          "aux-vision: 配置的模型不可用,且当前没有其他可用的图像识别模型,插件未启用。",
          "warn",
        );
      }
      return;
    }

    // 无配置 → 自动发现第一个支持图像输入的模型并写入配置
    const m = findFirstVisionModel(ctx);
    if (m) {
      const fresh: AuxVisionConfig = { ...DEFAULT_CONFIG, provider: m.provider, model: m.id };
      saveConfig(fresh);
      enableTool();
      ctx.ui.notify(
        `aux-vision: 已自动配置视觉模型 ${m.provider}/${m.id}。用 /vision set 或 /vision test 调整/验证。`,
        "info",
      );
    } else {
      ctx.ui.notify(
        "aux-vision: 未检测到可用的图像识别模型,插件未启用。用 /vision set <provider> <model> 配置。",
        "warn",
      );
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    await initialize(ctx);
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
        return [{ value: "set <provider> <model>", label: "set <provider> <model> — e.g. set google gemini-2.5-flash" }];
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
          if (!cfg || !cfg.provider || !cfg.model) {
            ctx.ui.notify("aux-vision: 未配置视觉模型,插件未启用。", "warn");
            return;
          }
          const model = findConfiguredModel(ctx, cfg.provider, cfg.model);
          const detail = model
            ? `协议 ${model.api} | 上下文 ${model.contextWindow} | 输出上限 ${model.maxTokens}`
            : "(模型当前不可用)";
          ctx.ui.notify(
            `aux-vision: ${cfg.enabled ? "启用" : "已禁用"} | ${cfg.provider}/${cfg.model}\n${detail}`,
            cfg.enabled ? "info" : "warn",
          );
          return;
        }
        case "set": {
          const provider = parts[1];
          const modelId = parts.slice(2).join(" ");
          if (!provider || !modelId) {
            // 交互式选择:provider → model,行为对齐 /login
            if (!ctx.hasUI) {
              ctx.ui.notify("用法:/vision set <provider> <model>,例如 /vision set google gemini-2.5-flash。", "warn");
              return;
            }
            // 候选:已认证优先;无已认证才退全量(避免内置目录 30+ provider 铺满选择器)
            const { models: candidates } = resolveVisionCandidates(
              ctx.modelRegistry.getAvailable(),
              ctx.modelRegistry.getAll(),
            );
            if (candidates.length === 0) {
              ctx.ui.notify("当前没有任何支持图像输入的模型(未注册或未认证)。", "warn");
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
            const pickedProvider = await pickFromList(ctx, "选择视觉模型 provider:", providerItems, providerIdx);
            if (!pickedProvider) {
              ctx.ui.notify("已取消。", "info");
              return;
            }
            const group = groups.find((g) => g.provider === pickedProvider)!;
            const modelItems: SelectItem[] = group.models.map((m) => ({
              value: m.id,
              label: m.id,
              description: formatModelDescription(m, ctx.modelRegistry.hasConfiguredAuth(m)),
            }));
            const modelIdx = modelItems.findIndex((it) => it.value === cfg?.model);
            const pickedModel = await pickFromList(ctx, `选择 ${group.provider} 的视觉模型:`, modelItems, modelIdx);
            if (!pickedModel) {
              ctx.ui.notify("已取消。", "info");
              return;
            }
            const model = group.models.find((m) => m.id === pickedModel)!;
            if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
              ctx.ui.notify(
                `模型 ${group.provider}/${model.id} 尚未认证。请先执行 /login ${group.provider} 完成认证,再重新 /vision set。`,"warn",
              );
              return;
            }
            ctx.ui.notify(applySelection(group.provider, model.id), "info");
            return;
          }
          const model = findConfiguredModel(ctx, provider, modelId);
          if (!model) {
            ctx.ui.notify(`模型 ${provider}/${modelId} 不可用(不存在、不支持图像输入或未认证)。运行 /vision list 查看可用模型。`, "error");
            return;
          }
          ctx.ui.notify(applySelection(provider, modelId), "info");
          return;
        }
        case "list": {
          const models = listVisionModels(ctx);
          if (models.length === 0) {
            ctx.ui.notify("aux-vision: 当前没有可用(已认证)的图像识别模型。请先 /login 配置对应 provider。", "warn");
            return;
          }
          const cfg = loadConfig();
          const current = cfg ? `${cfg.provider}/${cfg.model}` : "";
          const lines = models.map((m) => {
            const tag = `${m.provider}/${m.id}` === current ? " ← 当前" : "";
            return `${m.provider}/${m.id}${tag}`;
          });
          ctx.ui.notify(`可用的图像识别模型:\n${lines.join("\n")}`, "info");
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
              ctx.ui.notify(`aux-vision: 自动选用 ${m.provider}/${m.id}。`, "info");
            } else {
              ctx.ui.notify("aux-vision: 没有可用的图像识别模型,请先 /login 或 /vision set。", "warn");
              return;
            }
          }
          ctx.ui.notify(applySelection(cfg.provider, cfg.model), "info");
          return;
        }
        case "disable": {
          const cfg = loadConfig() ?? { ...DEFAULT_CONFIG, provider: "", model: "" };
          const fresh: AuxVisionConfig = { ...cfg, enabled: false };
          saveConfig(fresh);
          ensureToolActive(false);
          ctx.ui.notify("aux-vision: 已禁用,describe_image 工具不再对模型可见。", "info");
          return;
        }
        case "test": {
          const cfg = loadConfig();
          if (!cfg || !cfg.enabled || !cfg.provider || !cfg.model) {
            ctx.ui.notify("aux-vision: 未启用,无法测试。先 /vision set 或 /vision enable。", "warn");
            return;
          }
          const model = findConfiguredModel(ctx, cfg.provider, cfg.model);
          if (!model) {
            ctx.ui.notify(`模型 ${cfg.provider}/${cfg.model} 不可用,无法测试。运行 /vision list。`, "error");
            return;
          }
          const imagePath = parts.slice(1).join(" ") || (await generateTestImage());
          ctx.ui.notify(`aux-vision: 正在用 ${cfg.provider}/${cfg.model} 分析 ${imagePath} ...`, "info");
          const result = await describeImage(
            { image_path: imagePath, question: TEST_QUESTION },
            ctx,
            model,
            cfg,
            ctx.signal,
          );
          if (result.isError) {
            ctx.ui.notify(`aux-vision 测试失败:${result.content[0].text}`, "error");
            return;
          }
          const text = result.content[0].text;
          ctx.ui.notify(
            `aux-vision 测试通过(${cfg.provider}/${cfg.model}):${text.slice(0, 300)}${text.length > 300 ? " …" : ""}`,
            "info",
          );
          return;
        }
        default: {
          ctx.ui.notify(
            "用法:/vision status | set <provider> <model> | list | enable | disable | test [path]",
            "info",
          );
          return;
        }
      }
    },
  });
}
