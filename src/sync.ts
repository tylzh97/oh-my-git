import { SyncError, runGit, type ErrorCode, type OversizedFile } from "./git";
import { DEFAULT_CONFIG, type SyncConfig } from "./config";
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

export type SyncEvent = "onClick" | "onLoad" | "onOpen" | "onSave" | "onClose" | "onCron" | "onResolve" | "onRetry";
export type Strategy = "local" | "remote";
export interface SyncDetails { path?: string | null; source?: string; strategy?: Strategy; reason?: string }
interface Context { branch: string; remote: string; remoteRef: string; upstream: string }
interface RecoveryRefs { localRecoveryRef: string; remoteRecoveryRef: string }
interface Journal {
  operationId: string; event: SyncEvent; phase: string; branch: string; upstream: string;
  localCommit?: string; remoteCommit?: string; localRecoveryRef?: string; remoteRecoveryRef?: string;
  resultCommit?: string; temporaryWorktree?: string;
  outcome: "running" | "success" | "error"; errorCode?: ErrorCode; error?: string;
}

const ZERO = "0".repeat(40);
const LFS_BLOCK = /# BEGIN OGIT LFS\r?\n[\s\S]*?# END OGIT LFS(?:\r?\n)?/;
// 这些事件会 fetch 并整合远程；其余事件只提交和推送
const FULL_EVENTS: SyncEvent[] = ["onLoad", "onRetry", "onResolve"];

export class GitSyncEngine {
  private readonly stateDir: string;
  private readonly lfsRules: string;
  private signal?: AbortSignal;
  private context!: Context;
  private journal!: Journal;
  private device = "";

  constructor(private readonly root: string, private readonly log: (event: string, details?: unknown) => void,
    stateBase = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), ".local", "state"), "ObsidianCustomGitSync"),
    private readonly config: SyncConfig = DEFAULT_CONFIG) {
    const resolved = path.resolve(root);
    const repoId = createHash("sha256").update(process.platform === "win32" ? resolved.toLowerCase() : resolved).digest("hex").slice(0, 16);
    this.stateDir = path.join(stateBase, repoId);
    // Git attributes 区分大小写，显式匹配两种写法
    const rules = config.lfsExtensions.map(ext =>
      `*.${[...ext].map(c => /[a-z]/.test(c) ? `[${c}${c.toUpperCase()}]` : c).join("")} filter=lfs diff=lfs merge=lfs -text`);
    this.lfsRules = ["# BEGIN OGIT LFS", ...rules, "# END OGIT LFS", ""].join("\n");
  }

  private async git(args: string[], cwd = this.root, input?: string): Promise<string> {
    if (this.signal?.aborted) throw new SyncError("failed", "Sync cancelled");
    return runGit(args, cwd, this.config.gitTimeoutSeconds * 1000, input);
  }
  private tryGit(args: string[], cwd = this.root): Promise<string> {
    return this.git(args, cwd).catch(() => "");
  }
  private isAncestor(a: string, b: string): Promise<boolean> {
    return this.git(["merge-base", "--is-ancestor", a, b]).then(() => true, () => false);
  }
  private async phase(phase: string, extra: Partial<Journal> = {}): Promise<void> {
    Object.assign(this.journal, extra, { phase });
    await fs.writeFile(path.join(this.stateDir, "pending.json"), JSON.stringify(this.journal, null, 2));
    this.log("Git phase", { operationId: this.journal.operationId, phase });
  }

  private async loadContext(): Promise<Context> {
    const branch = await this.tryGit(["symbolic-ref", "--quiet", "--short", "HEAD"]);
    if (!branch || branch.startsWith("ogit/")) throw new SyncError("repo", "HEAD is detached or on an ogit/ backup branch");
    const remote = await this.tryGit(["config", "--get", `branch.${branch}.remote`]);
    const remoteRef = await this.tryGit(["config", "--get", `branch.${branch}.merge`]);
    const upstream = await this.tryGit(["rev-parse", "--symbolic-full-name", "@{upstream}"]);
    if (!remote || !remoteRef || !upstream) throw new SyncError("repo", `Branch ${branch} has no remote upstream`);
    return { branch, remote, remoteRef, upstream };
  }
  private async loadDevice(): Promise<string> {
    const file = path.join(this.stateDir, "device.txt");
    const device = await fs.readFile(file, "utf8").catch(() => "");
    if (device) return device.trim();
    const created = randomBytes(6).toString("hex");
    await fs.writeFile(file, created);
    return created;
  }

  private metadata(action: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return { schemaVersion: 2, pluginVersion: "0.0.1", operationId: this.journal.operationId,
      event: this.journal.event, action, device: this.device, time: new Date().toISOString(),
      branch: this.context.branch, upstream: this.context.upstream, ...extra };
  }
  private async commit(title: string, data: Record<string, unknown>, cwd = this.root): Promise<string> {
    await this.checkSize(cwd);
    const parents = [await this.git(["rev-parse", "HEAD"], cwd)];
    const mergeHead = await this.tryGit(["rev-parse", "--verify", "MERGE_HEAD"], cwd);
    if (mergeHead) parents.push(mergeHead);
    const resultTree = await this.git(["write-tree"], cwd);
    const record = JSON.stringify({ ...data, resultTree, parents }, null, 2);
    await this.git(["commit", "--allow-empty", "-F", "-"], cwd, `${title}\n\nOgit-Metadata-Begin\n${record}\nOgit-Metadata-End\n`);
    return this.git(["rev-parse", "HEAD"], cwd);
  }
  // 只检查本次暂存的新增/修改；工作区是真实文件，LFS 也按实际大小计算
  private async checkSize(cwd: string): Promise<void> {
    const limit = this.config.maxFileMiB * 1024 * 1024;
    const changed = (await this.git(["diff", "--cached", "--no-renames", "--name-only", "-z", "--diff-filter=ACMT"], cwd)).split("\0").filter(Boolean);
    const oversized: OversizedFile[] = [];
    for (const name of changed) {
      const bytes = (await fs.stat(path.join(cwd, name))).size;
      if (bytes > limit) oversized.push({ path: name, bytes });
    }
    if (oversized.length) throw new SyncError("size", `Files exceed ${this.config.maxFileMiB} MiB`, oversized);
  }
  // 只维护 OGIT 区块，不动用户自己的规则
  private async ensureAttributes(cwd: string): Promise<void> {
    const file = path.join(cwd, ".gitattributes");
    const text = await fs.readFile(file, "utf8").catch(() => "");
    const updated = LFS_BLOCK.test(text) ? text.replace(LFS_BLOCK, () => this.lfsRules)
      : text + (text && !text.endsWith("\n") ? "\n" : "") + this.lfsRules;
    if (updated !== text) await fs.writeFile(file, updated);
  }
  private async stageAll(cwd: string): Promise<void> {
    await this.ensureAttributes(cwd);
    await this.git(["add", "-A"], cwd);
    await this.git(["add", "--renormalize", "."], cwd);
  }

  private async snapshot(): Promise<string> {
    // 不加 --force：用户自定义的 pre-push hook 不能被静默覆盖
    await this.git(["lfs", "install", "--local"]);
    await this.stageAll(this.root);
    if (await this.git(["diff", "--cached", "--name-only"])) {
      const stats = await this.git(["diff", "--cached", "--shortstat"]);
      await this.commit(`ogit: snapshot local changes (${this.journal.event})`, this.metadata("snapshot", { stats }));
    }
    return this.git(["rev-parse", "HEAD"]);
  }
  private async fetch(): Promise<string> {
    const c = this.context;
    // 只拉取 upstream，不受用户 fetch refspec 影响
    await this.git(["fetch", "--no-tags", c.remote, `+${c.remoteRef}:${c.upstream}`]);
    return this.git(["rev-parse", c.upstream]);
  }
  // 整合前把双方各推一个不可变恢复分支，推送失败则不继续
  private async protect(reason: string, local: string, remote: string): Promise<RecoveryRefs> {
    const base = `refs/heads/ogit/recovery/${reason}/${this.journal.operationId}`;
    const refs = { localRecoveryRef: `${base}/local`, remoteRecoveryRef: `${base}/remote` };
    await this.phase("backup", { localCommit: local, remoteCommit: remote, ...refs });
    await this.git(["update-ref", refs.localRecoveryRef, local, ZERO]);
    await this.git(["update-ref", refs.remoteRecoveryRef, remote, ZERO]);
    await this.git(["push", "--porcelain", this.context.remote,
      `${refs.localRecoveryRef}:${refs.localRecoveryRef}`, `${refs.remoteRecoveryRef}:${refs.remoteRecoveryRef}`]);
    return refs;
  }

  private async integrate(local: string, remote: string, strategy?: Strategy, reason?: string): Promise<string> {
    const refs = await this.protect(strategy ? `keep-${strategy}` : "startup-merge", local, remote);
    const temp = path.join(this.stateDir, `worktree-${randomBytes(6).toString("hex")}`);
    await this.phase("merge", { temporaryWorktree: temp });
    await this.git(["worktree", "add", "--detach", temp, strategy ? remote : local]);
    try {
      const result = strategy ? await this.choose(temp, local, remote, strategy, reason, refs) : await this.merge(temp, local, remote, refs);
      // 结果也保留独立分支，应用或推送失败时仍可找回
      await this.git(["update-ref", refs.localRecoveryRef.replace(/local$/, "result"), result, ZERO]);
      await this.phase("apply", { resultCommit: result });
      // 两树 read-tree 拒绝覆盖未提交修改和未跟踪文件；不在 Vault 中 reset --hard
      await this.git(["read-tree", "-m", "-u", local, result]);
      await this.git(["update-ref", `refs/heads/${this.context.branch}`, result, local]);
      await this.phase("applied");
      return result;
    } finally {
      await this.tryGit(["worktree", "remove", "--force", temp]);
    }
  }
  private async merge(temp: string, local: string, remote: string, refs: RecoveryRefs): Promise<string> {
    if (await this.isAncestor(local, remote)) {
      await this.git(["merge", "--ff-only", remote], temp);
      return remote;
    }
    try { await this.git(["merge", "--no-commit", "--no-ff", remote], temp); }
    catch (error) { throw new SyncError("conflict", (error as Error).message); }
    return this.commit("ogit: merge upstream on startup",
      this.metadata("merge", { localCommit: local, remoteCommit: remote, ...refs }), temp);
  }
  // 整仓库选一侧；以 upstream 为第一父提交，未包含本地历史时以本地为第二父提交
  private async choose(temp: string, local: string, remote: string, strategy: Strategy, reason: string | undefined, refs: RecoveryRefs): Promise<string> {
    if (strategy === "local") await this.git(["read-tree", "--reset", "-u", local], temp);
    await this.stageAll(temp);
    if (!(await this.isAncestor(local, remote))) {
      // 新版 Git 拒绝 update-ref 写伪引用，直接写临时 worktree 的 MERGE_HEAD
      await fs.writeFile(path.resolve(temp, await this.git(["rev-parse", "--git-path", "MERGE_HEAD"], temp)), `${local}\n`);
    }
    return this.commit(`ogit: resolve repository using ${strategy}`, this.metadata("resolve", {
      strategy, reason: reason || "history-divergence", localCommit: local, remoteCommit: remote, ...refs,
    }), temp);
  }

  private async push(local: string): Promise<void> {
    const c = this.context;
    await this.phase("push", { resultCommit: local });
    try {
      await this.git(["push", "--porcelain", c.remote, `${local}:${c.remoteRef}`]);
    } catch (error) {
      // 远程已分叉：保护双方，交给用户选择；否则原样抛出
      const remote = await this.fetch();
      if (await this.isAncestor(remote, local)) throw error;
      await this.protect("push-rejected", local, remote);
      throw new SyncError("conflict", "Remote advanced; push rejected");
    }
  }
  // 每月首次成功推送后创建一次；已存在则不覆盖。失败只记日志，下次同步再试
  private async monthly(commit: string): Promise<void> {
    if (!this.config.monthlyBackupEnabled) return;
    const c = this.context;
    const date = new Date();
    const month = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
    const key = `${c.branch.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 48)}-${createHash("sha256").update(c.branch).digest("hex").slice(0, 8)}`;
    const ref = `refs/heads/ogit/monthly/${month}/${key}`;
    const statePath = path.join(this.stateDir, "state.json");
    const state = JSON.parse(await fs.readFile(statePath, "utf8").catch(() => "{}"));
    if (state.monthly === ref) return;
    try {
      if (!(await this.git(["ls-remote", "--refs", c.remote, ref]))) {
        // 空 lease 表示只创建，不允许覆盖其他设备已创建的分支
        await this.git(["push", "--porcelain", `--force-with-lease=${ref}:`, c.remote, `${commit}:${ref}`]);
      }
      await fs.writeFile(statePath, JSON.stringify({ ...state, monthly: ref }));
    } catch (error) {
      this.log("Monthly backup deferred", { ref, error: (error as Error).message });
    }
  }

  async run(event: SyncEvent, details: SyncDetails | undefined, signal: AbortSignal): Promise<void> {
    this.signal = signal;
    await fs.mkdir(this.stateDir, { recursive: true });
    const pendingPath = path.join(this.stateDir, "pending.json");
    if (await fs.stat(pendingPath).then(() => true, () => false)) throw new SyncError("interrupted", `Inspect and remove ${pendingPath}`);
    this.device = await this.loadDevice();
    this.context = await this.loadContext();
    this.journal = {
      operationId: `${new Date().toISOString().replace(/[-:.]/g, "")}-${this.device}-${randomBytes(4).toString("hex")}`,
      event, phase: "start", outcome: "running", branch: this.context.branch, upstream: this.context.upstream,
    };
    try {
      await this.phase("snapshot");
      let local = await this.snapshot();
      await this.phase("snapshotted", { localCommit: local });
      if (FULL_EVENTS.includes(event)) {
        const remote = await this.fetch();
        await this.phase("fetched", { remoteCommit: remote });
        if (event === "onResolve") local = await this.integrate(local, remote, details?.strategy, details?.reason);
        else if (!(await this.isAncestor(remote, local))) local = await this.integrate(local, remote);
      }
      await this.push(local);
      await this.monthly(local);
      this.journal.outcome = "success";
    } catch (error) {
      const failure = error instanceof SyncError ? error : new SyncError("failed", String(error));
      Object.assign(this.journal, { outcome: "error", errorCode: failure.code, error: failure.message });
      throw failure;
    } finally {
      // apply 阶段失败时 Vault 状态不确定：保留 pending.json，阻止后续同步直到人工核对
      if (this.journal.outcome === "error" && this.journal.phase === "apply") {
        await fs.writeFile(pendingPath, JSON.stringify(this.journal, null, 2));
      } else {
        await fs.appendFile(path.join(this.stateDir, "history.jsonl"), JSON.stringify(this.journal) + "\n");
        await fs.rm(pendingPath, { force: true });
      }
    }
  }
}
