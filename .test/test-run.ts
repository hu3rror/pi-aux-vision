// 逻辑测试:esbuild 打包(pi 依赖 alias 到 mock-pi.ts)后由 node 执行。
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig, saveConfig, DEFAULT_CONFIG, type AuxVisionConfig } from "../config";
import { findConfiguredModel, findFirstVisionModel, formatModelDescription, formatProviderDescription, groupVisionProviders, isVisionModel, listVisionModels, resolveVisionCandidates } from "../discovery";
import { describeImage, structuredOutputSchema } from "../vision";
import { Value } from "typebox";
import { generateTestImage } from "../test-image";
import { INITIAL_FOOTER_STATE, colorFooter, footerParts, footerStatus, projectFooterConfig, reduceFooter, renderFooter } from "../footer";
import { createFooterController } from "../footer-controller";
import extension from "../index";
import { fakeTheme, makeFakeCtx, makeFakePi, setTestAgentDir, tmpfile, writePng } from "./mock-pi";
let passed = 0;
function ok(name: string) {
  passed++;
  console.log(`  PASS ${name}`);
}

// ---- 1. 配置往返与路径解析(ADR-0003:写入规范路径,旧路径仅缺失时兜底)----
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aux-vision-cfg-"));
  setTestAgentDir(dir);
  const canonical = path.join(dir, "extensions", "aux-vision.json");
  const legacy = path.join(dir, "aux-vision.json");

  const cfg = { ...DEFAULT_CONFIG, provider: "google", model: "gemini-2.5-flash" };
  saveConfig(cfg);
  // 写入永远落在规范路径(extensions/ 子目录),旧路径不产生文件
  assert.ok(fs.existsSync(canonical), "save writes canonical path");
  assert.ok(!fs.existsSync(legacy), "save does not write legacy path");
  assert.deepStrictEqual(loadConfig(), cfg);
  ok("config round-trip via canonical path");

  // 规范路径缺失 → 回退旧路径(兼容);showInFooter 缺失 → 默认 true
  fs.rmSync(canonical);
  fs.writeFileSync(legacy, JSON.stringify({ provider: "google", model: "gemini-2.5-flash" }));
  assert.strictEqual(loadConfig()?.showInFooter, true);
  assert.strictEqual(loadConfig()?.model, "gemini-2.5-flash");
  ok("legacy fallback when canonical missing");

  // canonical 优先:两文件并存时读 canonical,整选不合并字段
  fs.writeFileSync(canonical, JSON.stringify({ provider: "google", model: "gemini-3.1-flash-lite", showInFooter: false }));
  fs.writeFileSync(legacy, JSON.stringify({ provider: "google", model: "gemini-2.5-flash" }));
  const prio = loadConfig()!;
  assert.strictEqual(prio.model, "gemini-3.1-flash-lite");
  assert.strictEqual(prio.showInFooter, false, "canonical field wins, no merging");
  ok("canonical precedence over legacy (whole-file selection)");

  // canonical 存在但损坏 → null(文件存在即管制,不静默回退 legacy)
  fs.writeFileSync(canonical, "{ not json");
  assert.strictEqual(loadConfig(), null);
  ok("corrupt canonical -> null (no silent legacy fallback)");

  // legacy 损坏 → null
  fs.rmSync(canonical);
  fs.writeFileSync(legacy, "{ not json");
  assert.strictEqual(loadConfig(), null);
  ok("corrupt legacy -> null");

  // 两文件都缺失 → null
  fs.rmSync(legacy);
  assert.strictEqual(loadConfig(), null);
  ok("both missing -> null");
}

// ---- 2. 自动发现顺序 ----
{
  const ctx = makeFakeCtx();
  const first = findFirstVisionModel(ctx);
  assert.strictEqual(first?.provider, "sensenova-anthropic");
  assert.strictEqual(first?.id, "sensenova-6.8-flash-lite");
  ok("first vision model by registry order (google excluded: no auth)");
  const all = listVisionModels(ctx).map((m) => `${m.provider}/${m.id}`);
  assert.deepStrictEqual(all, [
    "sensenova-anthropic/sensenova-6.8-flash-lite",
    "google/gemini-3.1-flash-lite",
  ]);
  ok("listVisionModels filters to auth+vision only");
}

// ---- 3. findConfiguredModel 校验 ----
{
  const ctx = makeFakeCtx();
  assert.ok(findConfiguredModel(ctx, "sensenova-anthropic", "sensenova-6.8-flash-lite"));
  ok("configured model valid");
  assert.strictEqual(findConfiguredModel(ctx, "google", "gemini-2.5-flash"), undefined);
  ok("no-auth model rejected");
  assert.strictEqual(findConfiguredModel(ctx, "sensenova", "deepseek-v4-flash"), undefined);
  ok("non-vision model rejected");
  assert.strictEqual(findConfiguredModel(ctx, "nope", "x"), undefined);
  ok("unknown model rejected");
}

// ---- 4. describeImage 成功路径 ----
{
  const ctx = makeFakeCtx();
  const cfg = { ...DEFAULT_CONFIG, provider: "sensenova-anthropic", model: "sensenova-6.8-flash-lite" };
  const model = findConfiguredModel(ctx, cfg.provider, cfg.model)!;
  const png = writePng("aux-vision-test.png");
  const res = await describeImage({ image_path: png, question: "图中是什么?" }, ctx, model, cfg, undefined);
  // Tool result contract (ADR-0001): success details carry model/usage, no error marker.
  assert.ok(!("error" in res.details), "success result has no error marker");
  assert.strictEqual(res.details.model, "sensenova-anthropic/sensenova-6.8-flash-lite");
  assert.strictEqual(res.details.usage.totalTokens, 30);
  assert.match(res.content[0].text, /mock-answer/);
  ok("describeImage success path");
}

// ---- 5. describeImage 失败路径 ----
{
  const ctx = makeFakeCtx();
  const cfg = { ...DEFAULT_CONFIG, provider: "sensenova-anthropic", model: "sensenova-6.8-flash-lite" };
  const model = findConfiguredModel(ctx, cfg.provider, cfg.model)!;
  const missing = await describeImage({ image_path: tmpfile("nope.png"), question: "?" }, ctx, model, cfg, undefined);
  assert.ok("error" in missing.details, "missing file carries error marker");
  assert.match(missing.details.error, /does not exist/);
  assert.match(missing.content[0].text, /does not exist/);
  ok("missing file -> error");
  const doc = tmpfile("doc.txt");
  fs.writeFileSync(doc, "hello");
  const badType = await describeImage({ image_path: doc, question: "?" }, ctx, model, cfg, undefined);
  assert.ok("error" in badType.details);
  assert.match(badType.content[0].text, /Unsupported image format/);
  ok("unsupported format -> error");
  const boom = await describeImage({ image_path: writePng("boom.png"), question: "?" }, makeFakeCtx(async () => {
    throw new Error("401 unauthorized");
  }), model, cfg, undefined);
  assert.ok("error" in boom.details);
  assert.match(boom.details.error, /401/);
  assert.match(boom.content[0].text, /401/);
  ok("complete throw -> error passthrough");
}

// ---- 5b. 工具结果契约(ADR-0001):details.error 判别,结果不再携带 isError 字段 ----
{
  const ctx = makeFakeCtx();
  const cfg = { ...DEFAULT_CONFIG, provider: "sensenova-anthropic", model: "sensenova-6.8-flash-lite" };
  const model = findConfiguredModel(ctx, cfg.provider, cfg.model)!;
  const okRes = await describeImage({ image_path: writePng("contract-ok.png"), question: "?" }, ctx, model, cfg, undefined);
  assert.ok(!("error" in okRes.details), "success result carries no error marker");
  assert.strictEqual(okRes.details.model, "sensenova-anthropic/sensenova-6.8-flash-lite");
  assert.strictEqual(okRes.details.usage.totalTokens, 30);
  assert.ok(!("isError" in okRes), "success result carries no isError field (ADR-0001)");
  const failRes = await describeImage({ image_path: tmpfile("contract-nope.png"), question: "?" }, ctx, model, cfg, undefined);
  assert.ok("error" in failRes.details, "failure result carries error marker");
  assert.match(failRes.details.error, /does not exist/);
  assert.ok(!("isError" in failRes), "failure result carries no isError field (ADR-0001)");
  ok("tool result contract: details.error discriminates, no isError field");
}

// ---- 5c. 截断显式化(ADR-0002):stopReason "length" → 头部显式提示,不静默截断 ----
{
  const ctx = makeFakeCtx(async () => ({
    role: "assistant",
    content: [{ type: "text", text: "部分转录…" }],
    api: "openai-completions",
    provider: "mock",
    model: "mock",
    stopReason: "length" as const,
    timestamp: Date.now(),
    usage: {
      input: 10,
      output: 20,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 30,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  }));
  const cfg = { ...DEFAULT_CONFIG, provider: "sensenova-anthropic", model: "sensenova-6.8-flash-lite" };
  const model = findConfiguredModel(ctx, cfg.provider, cfg.model)!;
  const res = await describeImage({ image_path: writePng("trunc.png"), question: "?" }, ctx, model, cfg, undefined);
  assert.ok(!("error" in res.details), "truncation stays a success result (ADR-0002)");
  assert.strictEqual(res.details.model, "sensenova-anthropic/sensenova-6.8-flash-lite");
  assert.strictEqual(res.details.usage.totalTokens, 30);
  assert.match(res.content[0].text, /token limit/); // 固定英文提示
  assert.match(res.content[0].text, /部分转录/);
  assert.strictEqual(DEFAULT_CONFIG.maxOutputTokens, 8192, "default output budget raised for exhaustive base (ADR-0002)");
  ok("stopReason length -> truncation notice prepended, no silent truncation");

  // 中文提问 → 提示仍为固定英文(不跟随提问语言,ADR-0002)
  const resZh = await describeImage({ image_path: writePng("trunc-zh.png"), question: "图里是什么?" }, ctx, model, cfg, undefined);
  assert.match(resZh.content[0].text, /token limit/);
  ok("truncation notice is fixed English regardless of question language");
}

// ---- 5d. 结构化结果(codemode 契约):脚本侧收到 structuredContent 而非文本 - 成功路径 ----
{
  const ctx = makeFakeCtx();
  const cfg = { ...DEFAULT_CONFIG, provider: "sensenova-anthropic", model: "sensenova-6.8-flash-lite" };
  const model = findConfiguredModel(ctx, cfg.provider, cfg.model)!;
  const res = await describeImage({ image_path: writePng("sc-ok.png"), question: "?" }, ctx, model, cfg, undefined);
  assert.ok(!("error" in res.details), "success result has no error marker");
  assert.strictEqual(res.structuredContent.ok, true, "structured success carries ok=true");
  assert.strictEqual(res.structuredContent.model, "sensenova-anthropic/sensenova-6.8-flash-lite");
  assert.strictEqual(res.structuredContent.usage.totalTokens, 30);
  assert.strictEqual(res.structuredContent.truncated, false);
  assert.strictEqual(res.structuredContent.transcription, res.content[0].text, "transcription equals content text");
  ok("structured result: success carries ok/model/usage/truncated/transcription");
}

// ---- 5e. 结构化结果:截断路径 truncated=true,转录含显式提示(ADR-0002/0005) ----
{
  const ctx = makeFakeCtx(async () => ({
    role: "assistant",
    content: [{ type: "text", text: "部分转录…" }],
    api: "openai-completions",
    provider: "mock",
    model: "mock",
    stopReason: "length" as const,
    timestamp: Date.now(),
    usage: {
      input: 10,
      output: 20,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 30,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  }));
  const cfg = { ...DEFAULT_CONFIG, provider: "sensenova-anthropic", model: "sensenova-6.8-flash-lite" };
  const model = findConfiguredModel(ctx, cfg.provider, cfg.model)!;
  const res = await describeImage({ image_path: writePng("sc-trunc.png"), question: "?" }, ctx, model, cfg, undefined);
  assert.strictEqual(res.structuredContent.ok, true);
  assert.strictEqual(res.structuredContent.truncated, true, "truncation flagged programmatically");
  assert.strictEqual(res.structuredContent.transcription, res.content[0].text);
  assert.match(res.structuredContent.transcription, /token limit/);
  ok("structured result: truncation carries truncated=true with notice in transcription");
}

// ---- 5f. 结构化结果:失败路径 ok=false + error,结果仍不携带 isError(ADR-0001/0005) ----
{
  const ctx = makeFakeCtx();
  const cfg = { ...DEFAULT_CONFIG, provider: "sensenova-anthropic", model: "sensenova-6.8-flash-lite" };
  const model = findConfiguredModel(ctx, cfg.provider, cfg.model)!;
  const res = await describeImage({ image_path: tmpfile("sc-nope.png"), question: "?" }, ctx, model, cfg, undefined);
  assert.ok("error" in res.details, "failure carries error marker");
  assert.strictEqual(res.structuredContent.ok, false, "structured failure carries ok=false");
  assert.strictEqual(res.structuredContent.error, res.details.error);
  assert.match(res.structuredContent.error, /does not exist/);
  assert.ok(!("isError" in res), "failure result carries no isError field (ADR-0001)");
  ok("structured result: failure carries ok=false + error, no isError");
}

// ---- 5g. 结构化契约一致性:outputSchema 与返回值不漂移(切片 4) ----
{
  const ctx = makeFakeCtx();
  const cfg = { ...DEFAULT_CONFIG, provider: "sensenova-anthropic", model: "sensenova-6.8-flash-lite" };
  const model = findConfiguredModel(ctx, cfg.provider, cfg.model)!;
  const okRes = await describeImage({ image_path: writePng("schema-ok.png"), question: "?" }, ctx, model, cfg, undefined);
  assert.ok(Value.Check(structuredOutputSchema, okRes.structuredContent), "success structuredContent matches declared outputSchema");
  const truncCtx = makeFakeCtx(async () => ({
    role: "assistant",
    content: [{ type: "text", text: "部分转录…" }],
    api: "openai-completions",
    provider: "mock",
    model: "mock",
    stopReason: "length" as const,
    timestamp: Date.now(),
    usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 30, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  }));
  const truncRes = await describeImage({ image_path: writePng("schema-trunc.png"), question: "?" }, truncCtx, model, cfg, undefined);
  assert.ok(Value.Check(structuredOutputSchema, truncRes.structuredContent), "truncated structuredContent matches declared outputSchema");
  const failRes = await describeImage({ image_path: tmpfile("schema-nope.png"), question: "?" }, ctx, model, cfg, undefined);
  assert.ok(Value.Check(structuredOutputSchema, failRes.structuredContent), "failure structuredContent matches declared outputSchema");
  ok("outputSchema/structuredContent consistency: success, truncation, failure");
}

// ---- 6. 测试图生成(真实 PowerShell) ----
{
  const p = await generateTestImage();
  assert.ok(fs.existsSync(p));
  assert.ok(fs.statSync(p).size > 0);
  ok(`test image generated (${fs.statSync(p).size} bytes)`);
}

// ---- 7. 交互式选择器候选构建(含未认证模型) ----
{
  const ctx = makeFakeCtx();
  const allModels = ctx.modelRegistry.getAll().filter(isVisionModel);
  const all = allModels.map((m) => `${m.provider}/${m.id}`);
  assert.deepStrictEqual(all, [
    "sensenova-anthropic/sensenova-6.8-flash-lite",
    "google/gemini-2.5-flash",
    "google/gemini-3.1-flash-lite",
  ]);
  ok("all vision models includes unauthenticated");

  const groups = groupVisionProviders(allModels, (m) => ctx.modelRegistry.hasConfiguredAuth(m));
  assert.deepStrictEqual(groups.map((g) => g.provider), ["sensenova-anthropic", "google"]);
  ok("groupVisionProviders keeps registry order for providers with authed models");
  assert.strictEqual(groups[0].authed, 1);
  assert.strictEqual(groups[0].total, 1);
  assert.strictEqual(groups[1].authed, 1);
  assert.strictEqual(groups[1].total, 2);
  ok("groupVisionProviders counts authed/total per provider");

  assert.strictEqual(formatProviderDescription(1, 1), "1 models");
  assert.strictEqual(formatProviderDescription(2, 1), "2 models · 1 unauthenticated");
  ok("formatProviderDescription marks unauthenticated count");

  const m6 = groups[0].models[0];
  const mG25 = groups[1].models[0];
  assert.strictEqual(formatModelDescription(m6, true), "256K ctx · anthropic-messages");
  assert.strictEqual(formatModelDescription(mG25, false), "1M ctx · google-generative-ai · needs /login");
  ok("formatModelDescription shows ctx/api and auth marker");
}

// ---- 8. 候选策略:已认证优先,空则退全量 ----
{
  const ctx = makeFakeCtx();
  const available = ctx.modelRegistry.getAvailable();
  const all = ctx.modelRegistry.getAll();
  const r1 = resolveVisionCandidates(available, all);
  assert.strictEqual(r1.usingAll, false);
  assert.deepStrictEqual(r1.models.map((m) => `${m.provider}/${m.id}`), [
    "sensenova-anthropic/sensenova-6.8-flash-lite",
    "google/gemini-3.1-flash-lite",
  ]);
  ok("resolveVisionCandidates prefers authenticated models");

  const r2 = resolveVisionCandidates([], all);
  assert.strictEqual(r2.usingAll, true);
  assert.deepStrictEqual(r2.models.map((m) => `${m.provider}/${m.id}`), [
    "sensenova-anthropic/sensenova-6.8-flash-lite",
    "google/gemini-2.5-flash",
    "google/gemini-3.1-flash-lite",
  ]);
  ok("resolveVisionCandidates falls back to all when nothing authenticated");
}

// ---- 9. footer 状态机(纯函数)----
{
  const cfg = { provider: "google", model: "gemini-2.5-flash", enabled: true, showInFooter: true };
  const triggered = reduceFooter(INITIAL_FOOTER_STATE, { type: "call", ok: true });
  const failed = reduceFooter(INITIAL_FOOTER_STATE, { type: "call", ok: false });

  // 未触发 → 不显示
  assert.strictEqual(renderFooter(INITIAL_FOOTER_STATE, cfg), undefined);
  assert.strictEqual(footerStatus(INITIAL_FOOTER_STATE, { type: "reset" }, cfg), undefined);
  ok("untriggered -> hidden");

  // showInFooter=false → 不显示(即使已触发)
  assert.strictEqual(renderFooter(triggered, { ...cfg, showInFooter: false }), undefined);
  ok("showInFooter=false -> hidden");

  // 触发成功 → vision: provider/model
  assert.strictEqual(
    footerStatus(INITIAL_FOOTER_STATE, { type: "call", ok: true }, cfg),
    "vision: google/gemini-2.5-flash",
  );
  ok("successful call -> vision: provider/model");

  // 触发失败 → 追加 !
  assert.strictEqual(
    footerStatus(INITIAL_FOOTER_STATE, { type: "call", ok: false }, cfg),
    "vision: google/gemini-2.5-flash!",
  );
  ok("failed call -> trailing !");

  // 失败后成功 → 错误标记恢复
  assert.strictEqual(footerStatus(failed, { type: "call", ok: true }, cfg), "vision: google/gemini-2.5-flash");
  ok("success after failure clears !");

  // set/enable 刷新模型
  const newCfg = { provider: "sensenova-anthropic", model: "sensenova-6.8-flash-lite", enabled: true, showInFooter: true };
  assert.strictEqual(footerStatus(triggered, { type: "set" }, newCfg), "vision: sensenova-anthropic/sensenova-6.8-flash-lite");
  assert.strictEqual(footerStatus(triggered, { type: "enable" }, newCfg), "vision: sensenova-anthropic/sensenova-6.8-flash-lite");
  ok("set/enable refresh model in footer");

  // disable → 清除(配置 enabled=false 时渲染为空)
  assert.strictEqual(renderFooter(triggered, { ...cfg, enabled: false }), undefined);
  ok("disable -> hidden");

  // reset → 回到未触发
  assert.strictEqual(footerStatus(triggered, { type: "reset" }, cfg), undefined);
  ok("reset -> untriggered");

  // 未配置模型 → 不显示
  assert.strictEqual(renderFooter(triggered, { ...cfg, provider: "" }), undefined);
  ok("no model configured -> hidden");

  // footerParts 供接线层上色(dim prefix + accent model + error !)
  assert.deepStrictEqual(footerParts(triggered, cfg), {
    prefix: "vision: ",
    model: "google/gemini-2.5-flash",
    failed: false,
  });
  assert.strictEqual(footerParts(failed, cfg)?.failed, true);
  assert.strictEqual(footerParts(INITIAL_FOOTER_STATE, cfg), undefined);
  ok("footerParts exposes prefix/model/failed for coloring");
}

// ---- 9b. footer 纯函数:colorFooter 与 projectFooterConfig ----
{
  // colorFooter 成功:dim 前缀 + accent 模型名,无 !
  assert.strictEqual(
    colorFooter({ prefix: "vision: ", model: "google/gemini-2.5-flash", failed: false }, fakeTheme),
    "[dim]vision: [/dim][accent]google/gemini-2.5-flash[/accent]",
  );
  ok("colorFooter success -> dim prefix + accent model");

  // colorFooter 失败:追加 error 色 !
  assert.strictEqual(
    colorFooter({ prefix: "vision: ", model: "google/gemini-2.5-flash", failed: true }, fakeTheme),
    "[dim]vision: [/dim][accent]google/gemini-2.5-flash[/accent][error]![/error]",
  );
  ok("colorFooter failure -> appends error !");

  // projectFooterConfig null → 全默认(空模型 + DEFAULT_CONFIG 开关)
  assert.deepStrictEqual(projectFooterConfig(null), {
    provider: "",
    model: "",
    enabled: DEFAULT_CONFIG.enabled,
    showInFooter: DEFAULT_CONFIG.showInFooter,
  });
  ok("projectFooterConfig null -> defaults");

  // projectFooterConfig 完整配置 → 原样投影
  const fullCfg: AuxVisionConfig = { ...DEFAULT_CONFIG, provider: "sensenova-anthropic", model: "sensenova-6.8-flash-lite" };
  assert.deepStrictEqual(projectFooterConfig(fullCfg), {
    provider: "sensenova-anthropic",
    model: "sensenova-6.8-flash-lite",
    enabled: DEFAULT_CONFIG.enabled,
    showInFooter: DEFAULT_CONFIG.showInFooter,
  });
  ok("projectFooterConfig full config -> projected");
}
// ---- 9c. footer controller:闭包状态 + 每次事件重读配置 + key 归 controller ----
{
  setTestAgentDir(fs.mkdtempSync(path.join(os.tmpdir(), "aux-vision-ctrl-")));
  const calls: { key: string; text: string | undefined }[] = [];
  const ui = {
    setStatus: (key: string, text: string | undefined) => {
      calls.push({ key, text });
    },
    theme: fakeTheme,
  };
  const controller = createFooterController();

  // 未触发 → reset → 清除(key 由 controller 内部持有)
  controller.on({ type: "reset" }, ui);
  assert.deepStrictEqual(calls, [{ key: "aux-vision", text: undefined }]);
  ok("controller reset clears footer with owned key");

  // call 成功 → 上色文本
  saveConfig({ ...DEFAULT_CONFIG, provider: "google", model: "gemini-2.5-flash" });
  controller.on({ type: "call", ok: true }, ui);
  assert.strictEqual(
    calls.at(-1)!.text,
    "[dim]vision: [/dim][accent]google/gemini-2.5-flash[/accent]",
  );
  ok("controller call success -> colored text");

  // 每次事件重读磁盘配置:改配置 → set → footer 显示新模型
  saveConfig({ ...DEFAULT_CONFIG, provider: "sensenova-anthropic", model: "sensenova-6.8-flash-lite" });
  controller.on({ type: "set" }, ui);
  assert.strictEqual(
    calls.at(-1)!.text,
    "[dim]vision: [/dim][accent]sensenova-anthropic/sensenova-6.8-flash-lite[/accent]",
  );
  ok("controller re-reads config on each event (set)");

  // disable(配置 enabled=false)→ 清除
  saveConfig({ ...DEFAULT_CONFIG, provider: "google", model: "gemini-2.5-flash", enabled: false });
  controller.on({ type: "disable" }, ui);
  assert.strictEqual(calls.at(-1)!.text, undefined);
  ok("controller disable clears footer");

  // enable → 恢复(会话内已触发过)
  saveConfig({ ...DEFAULT_CONFIG, provider: "google", model: "gemini-2.5-flash" });
  controller.on({ type: "enable" }, ui);
  assert.strictEqual(
    calls.at(-1)!.text,
    "[dim]vision: [/dim][accent]google/gemini-2.5-flash[/accent]",
  );
  ok("controller enable restores footer");

  // 失败 call → 追加 error !
  controller.on({ type: "call", ok: false }, ui);
  assert.match(calls.at(-1)!.text!, /\[error\]!\[\/error\]$/);
  ok("controller failed call appends error !");
}

// ---- 10. 接线:session_start reset + describe_image execute call → ui.setStatus ----
{
  setTestAgentDir(fs.mkdtempSync(path.join(os.tmpdir(), "aux-vision-wire-")));
  saveConfig({ ...DEFAULT_CONFIG, provider: "sensenova-anthropic", model: "sensenova-6.8-flash-lite" });

  const fake = makeFakePi();
  extension(fake.pi as never);
  fake.markReady();

  const ctx = makeFakeCtx();
  await fake.fire("session_start", {}, ctx);

  // 新会话 → reset → footer 清除
  assert.deepStrictEqual(ctx.uiStatusCalls, [{ key: "aux-vision", text: undefined }]);
  ok("session_start resets footer to hidden");

  const tool = fake.tool("describe_image");
  assert.ok(tool, "describe_image tool registered");

  // 成功调用 → footer 显示上色文本(dim 前缀 + accent 模型名)
  const res = await tool.execute("1", { image_path: writePng("wire.png"), question: "?" }, undefined, undefined, ctx);
  assert.ok(!("error" in res.details), "success result has no error marker");
  const last = ctx.uiStatusCalls.at(-1)!;
  assert.strictEqual(last.key, "aux-vision");
  assert.strictEqual(
    last.text,
    "[dim]vision: [/dim][accent]sensenova-anthropic/sensenova-6.8-flash-lite[/accent]",
  );
  ok("execute success -> footer shows colored vision status");

  // 失败调用 → 追加 error !
  const bad = await tool.execute("2", { image_path: tmpfile("nope.png"), question: "?" }, undefined, undefined, ctx);
  assert.ok("error" in bad.details);
  assert.match(ctx.uiStatusCalls.at(-1)!.text!, /\[error\]!\[\/error\]$/);
  ok("execute failure -> footer appends error !");

  // 下一次成功调用 → 错误标记恢复(接线层验证)
  await tool.execute("3", { image_path: writePng("wire-ok.png"), question: "?" }, undefined, undefined, ctx);
  assert.strictEqual(
    ctx.uiStatusCalls.at(-1)!.text,
    "[dim]vision: [/dim][accent]sensenova-anthropic/sensenova-6.8-flash-lite[/accent]",
  );
  ok("success after failure restores normal style");

  // /vision set → 刷新模型
  const cmd = fake.command("vision");
  assert.ok(cmd, "vision command registered");
  await cmd.handler("set google gemini-3.1-flash-lite", ctx);
  assert.strictEqual(
    ctx.uiStatusCalls.at(-1)!.text,
    "[dim]vision: [/dim][accent]google/gemini-3.1-flash-lite[/accent]",
  );
  ok("/vision set refreshes footer model");

  // /vision disable → 清除
  await cmd.handler("disable", ctx);
  assert.strictEqual(ctx.uiStatusCalls.at(-1)!.text, undefined);
  ok("/vision disable clears footer");

  // /vision enable → 恢复显示(本会话已触发过)
  await cmd.handler("enable", ctx);
  assert.strictEqual(
    ctx.uiStatusCalls.at(-1)!.text,
    "[dim]vision: [/dim][accent]google/gemini-3.1-flash-lite[/accent]",
  );
  ok("/vision enable restores footer after re-enable");
}

// ---- 11. 接线:/vision test 也应触发 footer(本会话内实际调用了视觉模型)----
{
  setTestAgentDir(fs.mkdtempSync(path.join(os.tmpdir(), "aux-vision-test-wire-")));
  saveConfig({ ...DEFAULT_CONFIG, provider: "sensenova-anthropic", model: "sensenova-6.8-flash-lite" });

  const fake = makeFakePi();
  extension(fake.pi as never);
  fake.markReady();
  const ctx = makeFakeCtx();
  await fake.fire("session_start", {}, ctx);

  const cmd = fake.command("vision");
  assert.ok(cmd, "vision command registered");
  const png = writePng("wire-test.png");
  await cmd.handler(`test ${png}`, ctx);

  // test 成功调用 → footer 显示上色文本
  const last = ctx.uiStatusCalls.at(-1)!;
  assert.strictEqual(last.key, "aux-vision");
  assert.strictEqual(
    last.text,
    "[dim]vision: [/dim][accent]sensenova-anthropic/sensenova-6.8-flash-lite[/accent]",
  );
  ok("/vision test triggers footer display");

  // test 失败 → footer 追加 error !(与 execute 一致)
  const boom = makeFakeCtx(async () => {
    throw new Error("401 unauthorized");
  });
  await cmd.handler(`test ${png}`, boom);
  assert.match(boom.uiStatusCalls.at(-1)!.text!, /\[error\]!\[\/error\]$/);
  ok("/vision test failure appends error !");
}

// ---- 12. 读图门控(ADR-0004):describe_image 仅对不具备读图能力的主模型可见 ----
{
  const vision = { provider: "google", id: "gemini-3.1-flash-lite", api: "google-generative-ai", input: ["text", "image"], contextWindow: 1048576, maxTokens: 65536 };
  const blind = { provider: "sensenova", id: "deepseek-v4-flash", api: "openai-completions", input: ["text"], contextWindow: 1048576, maxTokens: 65536 };

  /** 启动样板:独立 agent 目录 + 注册 + session_start;返回 pi 桩、记录通知的 ctx 与目录。 */
  async function boot(model?: unknown, setup?: (dir: string) => void) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aux-vision-gate-"));
    setTestAgentDir(dir);
    const fake = makeFakePi();
    extension(fake.pi as never);
    fake.markReady();
    setup?.(dir);
    const ctx = makeFakeCtx(undefined, model as never);
    await fake.fire("session_start", {}, ctx);
    return { fake, ctx, dir };
  }

  // 加载期不得调用动作方法(回归):pi 0.99+ 在扩展加载阶段禁止 getActiveTools/setActiveTools
  {
    const fake = makeFakePi();
    assert.doesNotThrow(
      () => extension(fake.pi as never),
      "extension factory must not call action methods during loading",
    );
    assert.ok(fake.tool("describe_image"), "tool registered at load");
    ok("extension loads without calling action methods (loading guard)");
  }

  // 加载即注册,但不激活:门控批准前不进入模型可见集合
  {
    const fake = makeFakePi();
    extension(fake.pi as never);
    fake.markReady();
    assert.ok(fake.tool("describe_image"), "tool registered at load");
    assert.deepStrictEqual(fake.pi.getActiveTools(), []);
    ok("tool registered inactive at load");
  }

  // 视觉主模型:配置有效也不介入
  {
    const { fake } = await boot(vision, () => saveConfig({ ...DEFAULT_CONFIG, provider: "sensenova-anthropic", model: "sensenova-6.8-flash-lite" }));
    assert.ok(!fake.pi.getActiveTools().includes("describe_image"));
    ok("vision-capable main model -> tool not intervening");
  }

  // 盲主模型:配置有效 → 介入
  {
    const { fake } = await boot(blind, () => saveConfig({ ...DEFAULT_CONFIG, provider: "sensenova-anthropic", model: "sensenova-6.8-flash-lite" }));
    assert.ok(fake.pi.getActiveTools().includes("describe_image"));
    ok("blind main model -> tool intervening");
  }

  // model_select 驱动:模型未定→盲(介入+通知)→视觉(静默退出)
  {
    const { fake, ctx } = await boot(undefined, () => saveConfig({ ...DEFAULT_CONFIG, provider: "sensenova-anthropic", model: "sensenova-6.8-flash-lite" }));
    assert.ok(!fake.pi.getActiveTools().includes("describe_image"), "undefined model -> not active");
    ctx.model = blind;
    await fake.fire("model_select", { model: blind, previousModel: undefined, source: "restore" }, ctx);
    assert.ok(fake.pi.getActiveTools().includes("describe_image"), "switch to blind -> active");
    assert.ok(ctx.uiNotifies.some((n) => n.text.includes("is now exposed")));
    ctx.model = vision;
    await fake.fire("model_select", { model: vision, previousModel: blind, source: "set" }, ctx);
    assert.ok(!fake.pi.getActiveTools().includes("describe_image"), "switch to vision -> inactive");
    ok("model_select toggles gating, announces activation, silent deactivation");
  }

  // 未配置 + 视觉主模型 → 不自动发现、不写配置、不通知
  {
    const { fake, ctx, dir } = await boot(vision);
    assert.ok(!fs.existsSync(path.join(dir, "extensions", "aux-vision.json")));
    assert.strictEqual(ctx.uiNotifies.length, 0);
    assert.ok(!fake.pi.getActiveTools().includes("describe_image"));
    ok("unconfigured vision session -> no discovery, no config write, no notify");
  }

  // 未配置 + 盲主模型 → 自动发现、写规范路径、通知、介入
  {
    const { fake, ctx, dir } = await boot(blind);
    assert.ok(fs.existsSync(path.join(dir, "extensions", "aux-vision.json")));
    const written = loadConfig()!;
    assert.ok(written.provider && written.model);
    assert.ok(fake.pi.getActiveTools().includes("describe_image"));
    assert.ok(ctx.uiNotifies.some((n) => n.text.includes("automatically configured")));
    ok("unconfigured blind session -> auto-discovery, canonical write, notify, active");
  }

  // /vision enable 在视觉主模型下:配置写入但工具不介入,反馈说明原因
  {
    const { fake, ctx } = await boot(vision);
    const cmd = fake.command("vision")!;
    await cmd.handler("enable", ctx);
    assert.strictEqual(loadConfig()?.enabled, true, "config enabled: true");
    assert.ok(!fake.pi.getActiveTools().includes("describe_image"), "still gated off");
    assert.ok(ctx.uiNotifies.some((n) => n.text.includes("unexposed")), "feedback explains gating");
    ok("/vision enable under vision model -> config on, tool gated, honest feedback");
  }

  // /vision status 显示门控状态(含未配置分支)
  {
    const { fake, ctx: ctxB } = await boot(blind, () => saveConfig({ ...DEFAULT_CONFIG, provider: "sensenova-anthropic", model: "sensenova-6.8-flash-lite" }));
    const cmd = fake.command("vision")!;
    await cmd.handler("status", ctxB);
    assert.ok(ctxB.uiNotifies.some((n) => n.text.includes("exposed")));
    const { ctx: ctxV } = await boot(vision, () => saveConfig({ ...DEFAULT_CONFIG, provider: "sensenova-anthropic", model: "sensenova-6.8-flash-lite" }));
    await cmd.handler("status", ctxV);
    assert.ok(ctxV.uiNotifies.some((n) => n.text.includes("not exposed")));
    const { ctx: ctxN } = await boot(vision);
    await cmd.handler("status", ctxN);
    assert.ok(ctxN.uiNotifies.some((n) => n.text.includes("Gating") && n.text.includes("not exposed")), "unconfigured status still surfaces gating");
    ok("/vision status surfaces gating state (configured + unconfigured)");
  }

  // disable → 盲会话也不介入
  {
    const { fake, ctx } = await boot(blind, () => saveConfig({ ...DEFAULT_CONFIG, provider: "sensenova-anthropic", model: "sensenova-6.8-flash-lite" }));
    const cmd = fake.command("vision")!;
    await cmd.handler("disable", ctx);
    assert.ok(!fake.pi.getActiveTools().includes("describe_image"));
    ok("/vision disable keeps tool hidden in blind session");
  }

  // legacy 回退:每会话 notify 一次,且仅旧配置实际可读时通知
  {
    const { ctx } = await boot(blind, (dir) => {
      fs.writeFileSync(path.join(dir, "aux-vision.json"), JSON.stringify({ ...DEFAULT_CONFIG, provider: "sensenova-anthropic", model: "sensenova-6.8-flash-lite" }));
    });
    const legacyNotices = ctx.uiNotifies.filter((n) => n.text.includes("legacy path"));
    assert.strictEqual(legacyNotices.length, 1);
    assert.match(legacyNotices[0]!.text, /aux-vision.json/);
    ok("legacy fallback notified once per session");

    // 旧文件损坏 → 不算"正在使用",不通知
    const { ctx: ctxCorrupt } = await boot(blind, (dir) => {
      fs.writeFileSync(path.join(dir, "aux-vision.json"), "{ not json");
    });
    assert.ok(!ctxCorrupt.uiNotifies.some((n) => n.text.includes("legacy path")));
    ok("corrupt legacy file -> no legacy notice");
  }
}

// ---- 13. /vision set 补全:仅已认证 vision 模型(provider/model),前缀过滤,当前标注 ----
{
  const vision = { provider: "google", id: "gemini-3.1-flash-lite", api: "google-generative-ai", input: ["text", "image"], contextWindow: 1048576, maxTokens: 65536 };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aux-vision-comp-"));
  setTestAgentDir(dir);
  const fake = makeFakePi();
  extension(fake.pi as never);
  fake.markReady();
  const ctx = makeFakeCtx(undefined, vision as never);
  await fake.fire("session_start", {}, ctx);
  const cmd = fake.command("vision")! as unknown as {
    getArgumentCompletions(p: string): { value: string; label: string; description?: string }[] | null;
  };

  // set + 空:全部已认证 vision 模型(provider/model),不含未认证与非 vision
  const all = cmd.getArgumentCompletions("set ") ?? [];
  assert.deepStrictEqual(
    all.map((i) => i.label).sort(),
    ["google/gemini-3.1-flash-lite", "sensenova-anthropic/sensenova-6.8-flash-lite"],
  );
  ok("set completion lists authenticated vision models only");

  // provider 前缀过滤
  const goo = cmd.getArgumentCompletions("set goo") ?? [];
  assert.deepStrictEqual(goo.map((i) => i.label), ["google/gemini-3.1-flash-lite"]);
  ok("set completion filters by provider prefix");

  // provider + model 前缀;value 为完整可执行参数
  const gm = cmd.getArgumentCompletions("set google gemini-3") ?? [];
  assert.strictEqual(gm.length, 1);
  assert.strictEqual(gm[0]!.value, "set google gemini-3.1-flash-lite");
  ok("set completion filters by model prefix, yields runnable value");

  // 未认证的 vision 模型不在补全中
  assert.strictEqual((cmd.getArgumentCompletions("set google gemini-2") ?? []).length, 0);
  ok("set completion excludes unauthenticated models");

  // 当前配置的模型用前导 ● 标注在 label 且排到列表首位;description 不再带尾部标记
  saveConfig({ ...DEFAULT_CONFIG, provider: "google", model: "gemini-3.1-flash-lite" });
  const cur = cmd.getArgumentCompletions("set ") ?? [];
  assert.strictEqual(cur[0]?.value, "set google gemini-3.1-flash-lite", "current selection first");
  assert.strictEqual(cur[0]?.label, "● google/gemini-3.1-flash-lite", "current selection highlighted in label");
  assert.match(cur[0]?.description ?? "", /← current/, "current tag back in description tail");
  assert.ok(cur.some((i) => i.label === "sensenova-anthropic/sensenova-6.8-flash-lite"), "non-current label unprefixed");
  ok("set completion highlights current selection first with leading bullet + trailing tag");

  // session_start 前(registry 未缓存)→ 空补全
  const fake0 = makeFakePi();
  extension(fake0.pi as never);
  fake0.markReady();
  const bare0 = (fake0.command("vision")! as unknown as { getArgumentCompletions(p: string): unknown[] }).getArgumentCompletions("set ");
  assert.deepStrictEqual(bare0, []);
  ok("set completion empty before session_start");
}

// ---- 14. 无参数 /vision = 用法+状态;status 保留且与 bare 同源(共享 statusText)----
{
  const blind = { provider: "sensenova", id: "deepseek-v4-flash", api: "openai-completions", input: ["text"], contextWindow: 1048576, maxTokens: 65536 };

  async function bootStatus(model?: unknown, setup?: (dir: string) => void) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aux-vision-status-"));
    setTestAgentDir(dir);
    const fake = makeFakePi();
    extension(fake.pi as never);
    fake.markReady();
    setup?.(dir);
    const ctx = makeFakeCtx(undefined, model as never);
    await fake.fire("session_start", {}, ctx);
    return { fake, ctx };
  }

  // 已配置+启用:bare /vision 一条通知含用法与状态(level info)
  {
    const { fake, ctx } = await bootStatus(blind, () => saveConfig({ ...DEFAULT_CONFIG, provider: "google", model: "gemini-3.1-flash-lite" }));
    await (fake.command("vision")! as never as { handler(a: string, c: unknown): Promise<unknown> }).handler("", ctx);
    const n = ctx.uiNotifies.at(-1)!;
    assert.match(n.text, /Usage:/);
    assert.match(n.text, /─{10,}/, "divider between usage and status");
    assert.match(n.text, /enabled \| google\/gemini-3\.1-flash-lite/);
    assert.match(n.text, /Gating:/);
    assert.strictEqual(n.level, "info");
    ok("bare /vision shows usage + status in one notification");
  }

  // /vision status 同源:同一状态块,但不带 Usage 行
  {
    const { fake, ctx } = await bootStatus(blind, () => saveConfig({ ...DEFAULT_CONFIG, provider: "google", model: "gemini-3.1-flash-lite" }));
    await (fake.command("vision")! as never as { handler(a: string, c: unknown): Promise<unknown> }).handler("status", ctx);
    const n = ctx.uiNotifies.at(-1)!;
    assert.ok(!/Usage:/.test(n.text), "status output has no usage line");
    assert.match(n.text, /enabled \| google\/gemini-3\.1-flash-lite/);
    assert.match(n.text, /Gating:/);
    ok("/vision status shows the same status block");
  }

  // 未配置:bare 为 warning,含用法与未配置状态(用视觉主模型,避免盲模型触发自动发现)
  {
    const vision = { provider: "google", id: "gemini-3.1-flash-lite", api: "google-generative-ai", input: ["text", "image"], contextWindow: 1048576, maxTokens: 65536 };
    const { fake, ctx } = await bootStatus(vision);
    await (fake.command("vision")! as never as { handler(a: string, c: unknown): Promise<unknown> }).handler("", ctx);
    const n = ctx.uiNotifies.at(-1)!;
    assert.match(n.text, /Usage:/);
    assert.match(n.text, /no vision model configured/);
    assert.strictEqual(n.level, "warning");
    ok("bare /vision warns when unconfigured");
  }

  // enabled 但 provider/model 为空(手改/旧配置)→ 仍为 warning,级别与正文一致
  {
    const vision = { provider: "google", id: "gemini-3.1-flash-lite", api: "google-generative-ai", input: ["text", "image"], contextWindow: 1048576, maxTokens: 65536 };
    const { fake, ctx } = await bootStatus(vision, () => saveConfig({ ...DEFAULT_CONFIG, provider: "", model: "" }));
    await (fake.command("vision")! as never as { handler(a: string, c: unknown): Promise<unknown> }).handler("", ctx);
    const n = ctx.uiNotifies.at(-1)!;
    assert.match(n.text, /no vision model configured/);
    assert.strictEqual(n.level, "warning");
    ok("bare /vision warns when enabled but provider/model unset");
  }
  // /vision list:当前行前导 ● 标注,其余行不带标记(顺序保持 registry)
  {
    const blind = { provider: "sensenova", id: "deepseek-v4-flash", api: "openai-completions", input: ["text"], contextWindow: 1048576, maxTokens: 65536 };
    const { fake, ctx } = await bootStatus(blind, () => saveConfig({ ...DEFAULT_CONFIG, provider: "google", model: "gemini-3.1-flash-lite" }));
    await (fake.command("vision")! as never as { handler(a: string, c: unknown): Promise<unknown> }).handler("list", ctx);
    const n = ctx.uiNotifies.at(-1)!;
    assert.match(
      n.text,
      /sensenova-anthropic\/sensenova-6\.8-flash-lite\n● google\/gemini-3\.1-flash-lite ← current/,
      "current line marked with leading bullet + trailing tag",
    );
    ok("/vision list marks the current line with a leading bullet");
  }
}

console.log(`\n${passed} tests passed`);
