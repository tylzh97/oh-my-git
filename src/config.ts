import defaults from "../config.json";
import { SyncError } from "./git";

export type SyncConfig = typeof defaults;

// 外部 config.json 缺失时使用构建时打包的默认值
export const DEFAULT_CONFIG: SyncConfig = defaults;

export function parseConfig(text: string): SyncConfig {
  const config: SyncConfig = { ...defaults, ...JSON.parse(text) };
  config.lfsExtensions = config.lfsExtensions.map(ext => ext.toLowerCase());
  return config;
}

export async function loadConfig(adapter: {
  exists(file: string): Promise<boolean>;
  read(file: string): Promise<string>;
}, pluginDir: string): Promise<SyncConfig> {
  const file = `${pluginDir}/config.json`;
  try { return await adapter.exists(file) ? parseConfig(await adapter.read(file)) : DEFAULT_CONFIG; }
  catch (error) { throw new SyncError("config", `${file}: ${error}`); }
}
