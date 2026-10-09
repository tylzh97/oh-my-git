import { execFile } from "node:child_process";

export type ErrorCode = "config" | "git" | "lfs" | "root" | "upstream" | "branch" | "unfinished" | "staged" | "size" | "conflict" | "rejected" | "network" | "backup" | "changed" | "locked" | "interrupted" | "unsupported" | "cancelled" | "operation";
export interface OversizedFile { path: string; bytes: number }
export interface ErrorOptions { transient?: boolean; resolvable?: boolean; files?: OversizedFile[] }

export class SyncError extends Error {
  readonly transient: boolean;
  readonly resolvable: boolean;
  readonly files?: OversizedFile[];
  constructor(public readonly code: ErrorCode, options: ErrorOptions = {}) {
    super(code);
    this.transient = options.transient ?? false;
    this.resolvable = options.resolvable ?? false;
    this.files = options.files;
  }
}

export class CommandError extends Error {
  constructor(public readonly args: string[], public readonly output: string, public readonly timedOut: boolean) {
    super("Git command failed"); // Raw output can contain remote URLs and credentials.
  }
}

export function commandFailure(error: unknown, code: ErrorCode): SyncError | CommandError {
  if (error instanceof SyncError || (error instanceof CommandError && error.timedOut)) return error;
  return new SyncError(code);
}

export function remoteFailure(error: unknown, code: ErrorCode = "network"): SyncError | CommandError {
  if (!(error instanceof CommandError) || error.timedOut) return commandFailure(error, code);
  const permanent = /authentication (?:failed|required)|could not read (?:username|password)|permission denied|access denied|unauthori[sz]ed|forbidden|certificate|publickey|host key verification|hook declined|protected branch|repository not found|(?:HTTP|error|status(?: code)?)[ :]*(?:401|403|404)\b/i;
  const transient = /could not resolve (?:host|hostname|proxy)|temporary failure in name resolution|no such host|failed to connect|unable to connect|connection (?:refused|reset|timed out)|network is unreachable|i\/o timeout|TLS handshake timeout|(?:HTTP|error|status(?: code)?)[ :]*(?:429|502|503|504)\b/i;
  return new SyncError(code, { transient: !permanent.test(error.output) && transient.test(error.output) });
}

export function runGit(args: string[], cwd: string, options: {
  timeoutMs: number; inputEnv?: NodeJS.ProcessEnv; allowFailure?: boolean; input?: string;
}): Promise<string> {
  const environment: NodeJS.ProcessEnv = {
    ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never", GIT_LFS_SKIP_SMUDGE: "0", ...options.inputEnv,
  };
  for (const variable of ["GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE"]) delete environment[variable];
  return new Promise((resolve, reject) => {
    const child = execFile("git", ["-c", "credential.interactive=false", ...args], {
      cwd, windowsHide: true, timeout: options.timeoutMs, maxBuffer: 32 * 1024 * 1024,
      env: environment, encoding: "utf8",
    }, (error, stdout, stderr) => {
      // Even an optional probe must not hide an uncertain timeout.
      if (error && (error.killed || !options.allowFailure)) reject(new CommandError(args, stdout + stderr, Boolean(error.killed)));
      else resolve(error ? "" : stdout.trimEnd());
    });
    if (options.input !== undefined) {
      child.stdin?.on("error", () => { /* execFile callback reports the failure */ });
      child.stdin?.end(options.input);
    }
  });
}
