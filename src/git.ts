import { execFile } from "node:child_process";

// failed 为普通失败（!，后续事件照常触发），其余均需人工处理（×）
export type ErrorCode = "config" | "repo" | "auth" | "conflict" | "size" | "interrupted" | "failed";
export interface OversizedFile { path: string; bytes: number }

export class SyncError extends Error {
  constructor(readonly code: ErrorCode, detail?: string, readonly files?: OversizedFile[]) {
    super(detail ?? code);
  }
}

// 认证、权限、证书或远程 hook 拒绝：重试无意义，必须停下
const AUTH = /authentication|could not read (?:username|password)|permission denied|access denied|unauthori[sz]ed|forbidden|certificate|publickey|host key verification|hook declined|protected branch|(?:HTTP|error|status(?: code)?)[ :]*(?:401|403)\b/i;

export function runGit(args: string[], cwd: string, timeoutMs: number, input?: string): Promise<string> {
  // 显式开启 smudge，避免用户环境变量让 Vault 中出现 LFS 指针
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never", GIT_LFS_SKIP_SMUDGE: "0" };
  return new Promise((resolve, reject) => {
    const child = execFile("git", ["-c", "credential.interactive=false", ...args], {
      cwd, env, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, encoding: "utf8", windowsHide: true,
    }, (error, stdout, stderr) => {
      if (!error) return resolve(stdout.trimEnd());
      const output = (stdout + stderr).trim() || error.message;
      reject(new SyncError(AUTH.test(output) ? "auth" : "failed", `git ${args.join(" ")}: ${output}`));
    });
    if (input !== undefined) child.stdin?.end(input);
  });
}
