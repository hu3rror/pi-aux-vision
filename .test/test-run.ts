// 逻辑测试:esbuild 打包(pi 依赖 alias 到 mock-pi.ts)后由 node 执行。
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig, saveConfig, DEFAULT_CONFIG, type AuxVisionConfig } from "../config";
import { findConfiguredModel, findFirstVisionModel, formatModelDescription, formatProviderDescription, groupVisionProviders, isVisionModel, listVisionModels, resolveVisionCandidates } from "../discovery";
import { describeImage } from "../vision";
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

// ---- 1. 配置往返 ----
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aux-vision-cfg-"));
  setTestAgentDir(dir);
  const cfg = { ...DEFAULT_CONFIG, provider: "google", model: "gemini-2.5-flash" };
  saveConfig(cfg);
  const loaded = loadConfig();
  assert.deepStrictEqual(loaded, cfg);
  ok("config round-trip");
  // showInFooter 缺失 → 默认 true(旧配置文件兼容)
  fs.writeFileSync(path.join(dir, "aux-vision.json"), JSON.stringify({ provider: "google", model: "gemini-2.5-flash" }));
  assert.strictEqual(loadConfig()?.showInFooter, true);
  ok("showInFooter missing -> defaults true");
  // showInFooter: false 往返
  saveConfig({ ...DEFAULT_CONFIG, provider: "google", model: "gemini-2.5-flash", showInFooter: false });
  assert.strictEqual(loadConfig()?.showInFooter, false);
  ok("showInFooter false round-trips");
  // 损坏文件 → null
  fs.writeFileSync(path.join(dir, "aux-vision.json"), "{ not json");
  assert.strictEqual(loadConfig(), null);
  ok("config corrupt -> null");
  // 缺失 → null
  fs.rmSync(path.join(dir, "aux-vision.json"));
  assert.strictEqual(loadConfig(), null);
  ok("config missing -> null");
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
  assert.strictEqual(res.isError, undefined);
  assert.match(res.content[0].text, /mock-answer/);
  ok("describeImage success path");
}

// ---- 5. describeImage 失败路径 ----
{
  const ctx = makeFakeCtx();
  const cfg = { ...DEFAULT_CONFIG, provider: "sensenova-anthropic", model: "sensenova-6.8-flash-lite" };
  const model = findConfiguredModel(ctx, cfg.provider, cfg.model)!;
  const missing = await describeImage({ image_path: tmpfile("nope.png"), question: "?" }, ctx, model, cfg, undefined);
  assert.strictEqual(missing.isError, true);
  assert.match(missing.content[0].text, /不存在/);
  ok("missing file -> error");
  const doc = tmpfile("doc.txt");
  fs.writeFileSync(doc, "hello");
  const badType = await describeImage({ image_path: doc, question: "?" }, ctx, model, cfg, undefined);
  assert.match(badType.content[0].text, /不支持的图片格式/);
  ok("unsupported format -> error");
  const boom = await describeImage({ image_path: writePng("boom.png"), question: "?" }, makeFakeCtx(async () => {
    throw new Error("401 unauthorized");
  }), model, cfg, undefined);
  assert.strictEqual(boom.isError, true);
  assert.match(boom.content[0].text, /401/);
  ok("complete throw -> error passthrough");
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

  assert.strictEqual(formatProviderDescription(1, 1), "1 个模型");
  assert.strictEqual(formatProviderDescription(2, 1), "2 个模型 · 1 未认证");
  ok("formatProviderDescription marks unauthenticated count");

  const m6 = groups[0].models[0];
  const mG25 = groups[1].models[0];
  assert.strictEqual(formatModelDescription(m6, true), "256K ctx · anthropic-messages");
  assert.strictEqual(formatModelDescription(mG25, false), "1M ctx · google-generative-ai · 需 /login");
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

  const ctx = makeFakeCtx();
  await fake.fire("session_start", {}, ctx);

  // 新会话 → reset → footer 清除
  assert.deepStrictEqual(ctx.uiStatusCalls, [{ key: "aux-vision", text: undefined }]);
  ok("session_start resets footer to hidden");

  const tool = fake.tool("describe_image");
  assert.ok(tool, "describe_image tool registered");

  // 成功调用 → footer 显示上色文本(dim 前缀 + accent 模型名)
  const res = await tool.execute("1", { image_path: writePng("wire.png"), question: "?" }, undefined, undefined, ctx);
  assert.strictEqual(res.isError, undefined);
  const last = ctx.uiStatusCalls.at(-1)!;
  assert.strictEqual(last.key, "aux-vision");
  assert.strictEqual(
    last.text,
    "[dim]vision: [/dim][accent]sensenova-anthropic/sensenova-6.8-flash-lite[/accent]",
  );
  ok("execute success -> footer shows colored vision status");

  // 失败调用 → 追加 error !
  const bad = await tool.execute("2", { image_path: tmpfile("nope.png"), question: "?" }, undefined, undefined, ctx);
  assert.strictEqual(bad.isError, true);
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

console.log(`\n${passed} tests passed`);
