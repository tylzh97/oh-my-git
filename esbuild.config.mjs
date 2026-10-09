import { build } from "esbuild";
import { cp, rm } from "node:fs/promises";

// dist/ 即分发内容：每次重建，避免残留旧文件
await rm("dist", { recursive: true, force: true });

await build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  platform: "node",
  external: ["obsidian"],
  format: "cjs",
  target: "es2018",
  loader: { ".jsonc": "text" },
  outfile: "dist/main.js",
  logLevel: "info"
});

for (const file of ["manifest.json", "config.jsonc", "scripts/read-record.cjs"]) await cp(file, `dist/${file}`);
