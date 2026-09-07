// 打包测试:把扩展模块与 pi 依赖的 mock 打成单个可执行 mjs
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);

// esbuild 随 pi 安装;候选探测(可用 PI_ESBUILD_DIR 覆盖)。
const esbuildCandidates = [
  process.env.PI_ESBUILD_DIR,
  path.join(
    process.env.USERPROFILE, "AppData", "Local", "mise", "installs", "node",
    process.versions.node, "node_modules", "@earendil-works", "pi-coding-agent", "node_modules", "esbuild",
  ),
];
const esbuildDir = esbuildCandidates.find(
  (c) => c && existsSync(path.join(c, "package.json")),
);
if (!esbuildDir) {
  throw new Error(
    "找不到 esbuild:设置 PI_ESBUILD_DIR 指向 esbuild 包目录,或检查 pi 安装路径。",
  );
}
const { build } = require(esbuildDir);

const dir = path.join(process.env.USERPROFILE, ".pi", "agent", "extensions", "aux-vision");
const mock = path.join(dir, ".test", "mock-pi.ts");

await build({
  entryPoints: [path.join(dir, ".test", "test-run.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: path.join(dir, ".test", "test-run.mjs"),
  logLevel: "silent",
  plugins: [
    {
      name: "alias",
      setup(build) {
        build.onResolve({ filter: /^@earendil-works\/pi-coding-agent$/ }, () => ({ path: mock }));
        build.onResolve({ filter: /^typebox$/ }, () => ({ path: mock }));
      },
    },
  ],
});
console.log("bundled -> .test/test-run.mjs");
