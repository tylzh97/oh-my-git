import { build } from "esbuild";

await build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  platform: "node",
  external: ["obsidian"],
  format: "cjs",
  target: "es2018",
  outfile: "main.js",
  logLevel: "info"
});
