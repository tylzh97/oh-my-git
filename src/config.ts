import defaultsText from "../config.jsonc";
import { SyncError } from "./git";

export interface SyncConfig {
  syncIntervalSeconds: number;
  saveDebounceSeconds: number;
  gitTimeoutSeconds: number;
  maxFileMiB: number;
  successDisplayMs: number;
  escalateAfterFailures: number;
  placeboMode: "default" | "hidden";
  monthlyBackupEnabled: boolean;
  lfsExtensions: string[];
}

const STRING = /"(?:\\.|[^"\\])*"/.source;
const COMMENT = new RegExp(`(${STRING})|//[^\\n]*|/\\*[\\s\\S]*?\\*/`, "g");
const TRAILING_COMMA = new RegExp(`(${STRING})|,(\\s*[}\\]])`, "g");

// 先去注释再去尾随逗号；字符串整体匹配后原样保留，避免误伤 "http://..."
export function parseJsonc(text: string): unknown {
  const noComments = text.replace(COMMENT, (_, str) => str ?? "");
  return JSON.parse(noComments.replace(TRAILING_COMMA, (_, str, tail) => str ?? tail));
}

// 外部 config.jsonc 缺失时使用构建时打包的默认值
export const DEFAULT_CONFIG = parseJsonc(defaultsText) as SyncConfig;

export function parseConfig(text: string): SyncConfig {
  const config: SyncConfig = { ...DEFAULT_CONFIG, ...(parseJsonc(text) as Partial<SyncConfig>) };
  config.lfsExtensions = config.lfsExtensions.map(ext => ext.toLowerCase());
  return config;
}

export async function loadConfig(adapter: {
  exists(file: string): Promise<boolean>;
  read(file: string): Promise<string>;
}, pluginDir: string): Promise<SyncConfig> {
  const file = `${pluginDir}/config.jsonc`;
  try { return await adapter.exists(file) ? parseConfig(await adapter.read(file)) : DEFAULT_CONFIG; }
  catch (error) { throw new SyncError("config", `${file}: ${error}`); }
}
