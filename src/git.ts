import { execFile } from "node:child_process";

export type ErrorCode = "config" | "repo" | "unfinished" | "remote" | "refused" | "conflict" | "size" | "failed" | "nogit" | "nolfs";
export interface OversizedFile { path: string; bytes: number }

// 同步层面的错误：code 决定 UI 表现，message 仅用于显示和日志
export class SyncError extends Error {
  constructor(readonly code: ErrorCode, detail?: string, readonly files?: OversizedFile[]) {
    super(detail ?? code);
  }
}

// Git 原始失败：调用方依据退出码和结构化输出判断含义，不匹配报错文字
export class GitError extends Error {
  constructor(readonly args: string[], readonly exitCode: number | null, readonly stdout: string, readonly stderr: string) {
    super(`git ${args.join(" ")}: ${(stdout + stderr).trim() || `exit ${exitCode}`}`);
  }
}

export function runGit(args: string[], cwd: string, timeoutMs: number, input?: string): Promise<string> {
  // 显式开启 smudge，避免用户环境变量让 Vault 中出现 LFS 指针
  // macOS GUI 进程不继承 shell PATH，追加 Homebrew 目录以找到 git-lfs；git 本身仍用原 PATH 中的
  const PATH = process.platform === "darwin"
    ? [process.env.PATH, "/opt/homebrew/bin", "/usr/local/bin"].filter(Boolean).join(":")
    : process.env.PATH;
  const env = { ...process.env, PATH, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never", GIT_LFS_SKIP_SMUDGE: "0" };
  return new Promise((resolve, reject) => {
    const child = execFile("git", ["-c", "credential.interactive=false", ...args], {
      cwd, env, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, encoding: "utf8", windowsHide: true,
    }, (error, stdout, stderr) => {
      if (!error) return resolve(stdout.trimEnd());
      // 可执行文件不存在：进程根本没启动，与 Git 自身的失败区分开
      if (error.code === "ENOENT") return reject(new SyncError("nogit", `git not found in PATH: ${PATH}`));
      reject(new GitError(args, typeof error.code === "number" ? error.code : null, stdout, stderr));
    });
    if (input !== undefined) child.stdin?.end(input);
  });
}
