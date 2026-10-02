<div align="center">

# pi-aux-vision

为无图像输入的 Pi 主模型添加 `describe_image` 工具,让它也能看图。

[![npm version](https://img.shields.io/npm/v/pi-aux-vision)](https://www.npmjs.com/package/pi-aux-vision)
[![License](https://img.shields.io/badge/License-MIT-blue)](LICENSE)

[English](README.md)

</div>

Pi 扩展,注册一个 `describe_image` 原生工具。无图像输入的主模型(如 `deepseek-v4-flash`)自行决定何时调用,传入图片路径与具体问题;扩展经 pi SDK 调用已配置的视觉模型,结果作为 `tool_result` 回到会话上下文。

具备原生读图能力的会话模型直接读图,永远看不到该工具。

## 特性

- **只对无读图模型声明** —— `describe_image` 仅对不具备图像输入的模型声明;可见性随模型切换与会话恢复同步,在 `/vision status` 中展示。
- **自动发现** —— 首次运行无需配置:扩展自动发现第一个可用(已认证、支持图像输入)的视觉模型并写入磁盘。
- **经 pi SDK 路由** —— 认证、协议序列化、重试全部走 `ctx.modelRegistry.complete`,支持 `google-generative-ai` / `openai-completions` / `anthropic-messages` 三种协议。
- **转录底座** —— 每次结果以「图像类型 + 全部可见文字逐字转录」开头,再回答问题,末尾附完整性自证。
- **10 MB 上限** —— 超限图片由 pi 官方 `resizeImage` 压缩后再提交,压不动才报错。
- **TUI footer** —— 会话内第一次调用 `describe_image` 或执行 `/vision test` 后,footer 显示 `vision: provider/model` 直到会话结束;失败调用追加 error 色的 `!`。

## 安装

```bash
pi install npm:pi-aux-vision
```

不想安装、临时试用:

```bash
pi -e npm:pi-aux-vision
```

手动安装:把 `pi-aux-vision/` 目录放到 `~/.pi/agent/extensions/` 下,在 Pi 中执行 `/reload`。

## 命令

| 命令 | 说明 |
|---|---|
| `/vision status` | 当前 provider/model、协议、启用状态、footer 开关、工具是否介入 |
| `/vision set <provider> <model>` | 手动指定视觉模型并启用,写入配置 |
| `/vision list` | 列出可用(已认证)的图像识别模型,标注当前 |
| `/vision enable` / `/vision disable` | 开关;禁用时或当前模型具备原生读图能力时,`describe_image` 对模型不可见 |
| `/vision test [path]` | 用自动生成的测试图验证全链路;可指定图片路径 |

## 配置

`<agent-dir>/extensions/aux-vision.json`(经 pi 官方 `getAgentDir()` 解析,`PI_AGENT_DIR` 生效):

```json
{
  "enabled": true,
  "provider": "google",
  "model": "gemini-2.5-flash",
  "maxOutputTokens": 8192,
  "maxRetries": 2,
  "maxRetryDelayMs": 5000,
  "showInFooter": true
}
```

- `enabled` —— `false` 时 `describe_image` 对主模型不可见
- `provider` / `model` —— `describe_image` 使用的视觉模型
- `maxOutputTokens` —— 视觉模型输出 token 上限。每次结果都以穷尽转录底座开头,密集截图需要更大预算;命中上限时工具在头部显式提示截断,而非静默返回残缺底座
- `maxRetries` —— 重试次数(初始 + N 次;4xx 不重试,由官方管线处理)
- `maxRetryDelayMs` —— 退避上限,单位毫秒
- `showInFooter` —— 会话内第一次调用 `describe_image` 或执行 `/vision test` 后是否在 TUI footer 显示 `vision: provider/model`(默认 `true`)

> [!NOTE]
> 旧路径 `~/.pi/agent/aux-vision.json`(0.4.0 之前)仅在新文件缺失时兜底读取。新文件一旦存在即优先,且每次写入都指向新路径。旧文件保留不动。

## 工具

`describe_image(image_path, question)` —— 读盘 → 编码 → 单次调用视觉模型 → 返回文本。

- `image_path` —— 绝对路径或相对工作目录路径,支持 png / jpeg / gif / webp / bmp
- `question` —— 具体问题,如「提取第 4 行报错的堆栈」「按钮为何向右偏移 10px」

视觉模型以提问原语言作答。错误(文件不存在、格式不支持、调用失败)以结构化文本返回,由主模型自行处理,不弹确认框。

### Codemode 脚本

工具声明了 `outputSchema`,因此 [codemode](https://github.com/earendil-works/pi-coding-agent) 脚本收到的是机器可读的 `structuredContent` 而非文本:成功为 `{ ok, model, usage, transcription, truncated, resize_note? }`,预期失败为 `{ ok: false, error }`。脚本可以并行批量调用 `describe_image`,按 `ok` / `truncated` / `error` 过滤,让转录底座完全留在脚本内,只把摘要回给主模型:

```js
// @options: {"timeout_ms": 300000}
const files = ["/tmp/shot-a.png", "/tmp/shot-b.png", "/tmp/shot-c.png"];
const results = await Promise.allSettled(
  files.map((f) =>
    tools.describe_image({
      image_path: f,
      question: "Extract every error message verbatim. If there is none, say OK.",
    }),
  ),
);
const summary = results.map((r, i) => {
  if (r.status === "rejected") return { image: files[i], error: String(r.reason) };
  if (!r.value.ok) return { image: files[i], error: r.value.error };
  return { image: files[i], truncated: r.value.truncated, transcription_chars: r.value.transcription.length };
});
return { failed: summary.filter((s) => s.error).length, items: summary };
```

示例刻意不做转录文本解析——工具契约让转录保持为普通字符串字段(ADR-0005),脚本只依赖程序字段(`ok` / `error` / `truncated` / `usage`)并丢弃文本。需要某张图的实际答案时,直接对该图调用 `describe_image`;此时转录进入主模型上下文,是主模型自己的选择。

该能力在**未启用 codemode 时静默不生效**——需在 pi 设置(`~/.pi/agent/settings.json`)的 `defaultTools` 中加入 `"codemode"`,例如 `"defaultTools": ["+codemode"]`。未启用时,工具、门控与错误契约与先前完全一致;结构化字段只是没有消费者。

## 兼容性

已针对 pi `1.0.0` 验证。peer dependency 范围仍为 `"*"`;源码通过 `npm run typecheck` 对当前 SDK 进行类型检查。结构化结果(`outputSchema`)与 codemode 需要 pi `1.0.0+`;在旧版 pi 上工具回退为纯文本契约。

## 开发

```bash
npm test          # esbuild 打包扩展模块与 pi 依赖的 mock,然后跑测试套件
npm run typecheck # 对当前 pi SDK 做类型检查
```

`.test/` 覆盖配置读写(规范路径 + 旧版路径)、模型发现、`describe_image` 成功/失败路径、测试图生成、footer 状态机与集成,以及工具声明行为。
