# pi-aux-vision

[English](README.md)

向 Pi 注册一个 `describe_image` 原生工具:主模型(如 deepseek-v4-flash,不支持图像输入)在推理时自行决定何时调用,传入图片路径与具体问题,扩展经 pi 官方管线调用已配置的视觉模型,单次调用,结果作为 tool_result 进入上下文。

## 安装

```bash
pi install npm:pi-aux-vision
```

不想安装、临时试用:

```bash
pi -e npm:pi-aux-vision
```

手动安装:把 `pi-aux-vision/` 目录放到 `~/.pi/agent/extensions/` 下,在 Pi 中执行 `/reload`。

## 工作方式

- 启动时读取 `~/.pi/agent/aux-vision.json`;无配置则自动发现第一个可用(已认证且支持图像输入)的视觉模型并写入配置;配置的模型失效时自动回退。
- 认证、协议序列化、重试全部走 pi 官方管线(`ctx.modelRegistry.complete`),支持 google-generative-ai / openai-completions / anthropic-messages 三种协议。
- 每次结果都以穷尽转录底座开头(图像类型、全部可见文字逐字转录、布局/顺序),再回答问题并以完整性自证句收尾——不具备图像输入的主模型可以直接从底座推理,而不只是依赖狭窄的回答。输出撞到 token 上限时,工具会在头部显式提示截断,而非静默返回残缺底座。
- 图片上限 10MB(三家服务商限制交集);超限时用 pi 官方 `resizeImage` 自动压缩,压不动才报错。
- 本会话内第一次调用 `describe_image`(无论成败)或执行 `/vision test` 后,TUI footer 显示 `vision: provider/model` 并保持到会话结束——dim 的 `vision:` 前缀 + accent 的模型名,调用失败时 `!` 以 error 色追加;新会话恢复不显示,可用 `showInFooter` 关闭。

## 配置

`~/.pi/agent/aux-vision.json`:

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

- `maxOutputTokens`:视觉模型输出 token 上限。每次结果都以穷尽转录底座开头(图像类型 + 全部可见文字逐字转录),密集截图需要更大预算;命中上限时工具会在头部显式提示截断,而非静默返回残缺底座
- `maxRetries`:重试次数(初始 + N 次,4xx 不重试,由官方管线处理)
- `maxRetryDelayMs`:退避上限,单位毫秒
- `showInFooter`:本会话第一次调用 `describe_image` 或 `/vision test` 后是否在 TUI footer 显示 `vision: provider/model`(默认 `true`)

## 命令

| 命令 | 说明 |
|---|---|
| `/vision status` | 当前 provider/model、协议、启用状态、footer 开关 |
| `/vision set <provider> <model>` | 手动指定视觉模型并启用,写入配置 |
| `/vision list` | 列出可用(已认证)的图像识别模型,标注当前 |
| `/vision enable` / `/vision disable` | 开关;禁用后 `describe_image` 对主模型不可见 |
| `/vision test [path]` | 用自动生成的测试图验证全链路;可指定图片路径 |

## 工具

`describe_image(image_path, question)` — 读盘 → 编码 → 单次调用视觉模型 → 返回文本。

- `image_path`:绝对路径或相对工作目录路径,支持 png / jpeg / gif / webp / bmp
- `question`:具体问题,如"提取第 4 行报错的堆栈""按钮为何向右偏移 10px"

视觉模型以提问原语言作答。错误(文件不存在、格式不支持、调用失败)以结构化文本返回,由主模型自行处理,不弹确认框。

## 测试

```bash
npm test
```

或直接:

```bash
node .test/build.js && node .test/test-run.mjs
```

`.test/` 用 esbuild 将扩展模块与 pi 依赖的 mock 打包后执行,覆盖配置读写、模型发现、describe_image 成功/失败路径、测试图生成、footer 状态机与接线。

## License

MIT
