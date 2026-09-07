// 逻辑测试:esbuild 打包(pi 依赖 alias 到 mock-pi.ts)后由 node 执行。
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig, saveConfig, DEFAULT_CONFIG } from "../config";
import { findConfiguredModel, findFirstVisionModel, formatModelDescription, formatProviderDescription, groupVisionProviders, isVisionModel, listVisionModels, resolveVisionCandidates } from "../discovery";
import { describeImage } from "../vision";
import { generateTestImage } from "../test-image";
import { makeFakeCtx, setTestAgentDir, tmpfile, writePng } from "./mock-pi";

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

console.log(`\n${passed} tests passed`);
