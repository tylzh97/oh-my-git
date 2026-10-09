import defaults from "../config.json";
import { SyncError } from "./git";

export interface SyncConfig {
  readonly syncIntervalSeconds: number;
  readonly gitTimeoutSeconds: number;
  readonly maxFileMiB: number;
  readonly successDisplayMs: number;
  readonly monthlyBackupEnabled: boolean;
  readonly lfsExtensions: readonly string[];
}

// Bundled defaults also let the plugin run when the external file is absent.
export const DEFAULT_CONFIG: SyncConfig = Object.freeze({
  ...defaults, lfsExtensions: Object.freeze(defaults.lfsExtensions),
});

export function parseConfig(text: string): SyncConfig {
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        Object.keys(value).some(key => !Object.prototype.hasOwnProperty.call(defaults, key))) throw new Error();
    const config = { ...DEFAULT_CONFIG, ...value };
    for (const [key, min, max] of [
      ["syncIntervalSeconds", 1, 2_147_483],
      ["gitTimeoutSeconds", 1, 2_147_483],
      ["maxFileMiB", 1, Math.floor(Number.MAX_SAFE_INTEGER / 1024 / 1024)],
      ["successDisplayMs", 0, 2_147_483_647],
    ] as const) {
      if (!Number.isSafeInteger(config[key]) || config[key] < min || config[key] > max) throw new Error();
    }
    if (typeof config.monthlyBackupEnabled !== "boolean" || !Array.isArray(config.lfsExtensions) ||
        config.lfsExtensions.some((ext: unknown) => typeof ext !== "string" || !/^[a-z0-9]+$/i.test(ext))) throw new Error();
    config.lfsExtensions = [...new Set<string>(config.lfsExtensions.map((ext: string) => ext.toLowerCase()))];
    return config;
  } catch { throw new SyncError("config"); }
}

export async function loadConfig(adapter: {
  exists(file: string): Promise<boolean>;
  read(file: string): Promise<string>;
}, pluginDir: string): Promise<SyncConfig> {
  const file = `${pluginDir}/config.json`;
  try { return await adapter.exists(file) ? parseConfig(await adapter.read(file)) : DEFAULT_CONFIG; }
  catch { throw new SyncError("config"); }
}
