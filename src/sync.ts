import { GitError, SyncError, runGit, type ErrorCode, type OversizedFile } from "./git";
import { DEFAULT_CONFIG, type SyncConfig } from "./config";
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import type { Stats } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export type SyncEvent = "onClick" | "onLoad" | "onOpen" | "onSave" | "onClose" | "onRename" | "onCron" | "onResolve" | "onRetry";
export type Strategy = "local" | "remote";
export interface SyncDetails { path?: string | null; source?: string; strategy?: Strategy; reason?: string }
export interface SyncResult { skipped: OversizedFile[] }
interface Context { branch: string; remote: string; remoteRef: string; upstream: string }
interface RecoveryRefs { localRecoveryRef: string; remoteRecoveryRef: string }
interface Journal {
  operationId: string; event: SyncEvent; phase: string; branch: string; upstream: string;
  localCommit?: string; remoteCommit?: string; localRecoveryRef?: string; remoteRecoveryRef?: string;
  resultCommit?: string; temporaryWorktree?: string; skipped?: OversizedFile[];
  emptySkipped?: string[]; emptiesRemoved?: string[];
  outcome: "running" | "success" | "error" | "interrupted"; errorCode?: ErrorCode; error?: string;
}

const ZERO = "0".repeat(40);
const LFS_BLOCK = /# BEGIN OGIT LFS\r?\n[\s\S]*?# END OGIT LFS(?:\r?\n)?/;
// 这些事件会 fetch 并整合远程；其余事件只提交和推送（push 被拒时也会整合）
const FULL_EVENTS: SyncEvent[] = ["onLoad", "onRetry", "onResolve", "onCron"];
// 状态目录中以此开头的都是临时产物，启动时可安全删除
const TEMP_PREFIX = ".omg.";
const PENDING = `${TEMP_PREFIX}pending.json`;
// 同一 Obsidian 进程内跨插件实例可见：插件重载时旧实例的 run 可能仍在执行
const RUNNING = Symbol.for("omg-sync.running");
const shared = globalThis as typeof globalThis & { [RUNNING]?: boolean };
// 用户手动执行且尚未完成的 Git 操作标记（位于当前 worktree 的 git 目录）
const UNFINISHED = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply"];
const exists = (file: string): Promise<boolean> => fs.stat(file).then(() => true, () => false);
// 跨过零点不久的空日记先保留，避免刚创建就被删
const DIARY_GRACE_MS = 2 * 60 * 60 * 1000;
// Windows/macOS 的 birthtime 可靠；其他平台或拿不到时退回 mtime
const createdAt = (stat: Stats): number =>
  (process.platform === "win32" || process.platform === "darwin") && stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.mtimeMs;

export class GitSyncEngine {
  private readonly stateDir: string;
  private readonly lfsRules: string;
  private signal?: AbortSignal;
  private context!: Context;
  private journal!: Journal;
  private device = "";
  // 上次记录的空 md 列表；不变时不重复写入 history
  private lastEmpty = "";

  constructor(private readonly root: string, private readonly log: (event: string, details?: unknown) => void,
    stateBase = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), ".local", "state"), "ObsidianOhMyGit"),
    private readonly config: SyncConfig = DEFAULT_CONFIG,
    // Obsidian 日记目录（相对 Vault）；为空时不做 onLoad 旧空日记清理
    private readonly diaryDir = "") {
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
  // 一旦开始就必须做完的步骤：不检查取消信号，避免把 Vault 留在应用到一半的状态
  private gitAlways(args: string[], cwd = this.root): Promise<string> {
    return runGit(args, cwd, this.config.gitTimeoutSeconds * 1000);
  }
  private tryGit(args: string[], cwd = this.root): Promise<string> {
    return this.git(args, cwd).catch(() => "");
  }
  private isAncestor(a: string, b: string): Promise<boolean> {
    return this.git(["merge-base", "--is-ancestor", a, b]).then(() => true, () => false);
  }
  private async phase(phase: string, extra: Partial<Journal> = {}): Promise<void> {
    Object.assign(this.journal, extra, { phase });
    await fs.writeFile(path.join(this.stateDir, PENDING), JSON.stringify(this.journal, null, 2));
    this.log("Git phase", { operationId: this.journal.operationId, phase });
  }
  private async appendHistory(record: unknown): Promise<void> {
    await fs.appendFile(path.join(this.stateDir, "history.jsonl"), JSON.stringify(record) + "\n");
  }

  // 启动时清理上次强制退出留下的临时产物；正常结束的 run 不会留下 .omg.*
  private async cleanup(): Promise<void> {
    const pending = await fs.readFile(path.join(this.stateDir, PENDING), "utf8").catch(() => "");
    if (pending) {
      let record: unknown;
      try { record = { ...JSON.parse(pending), outcome: "interrupted" }; } catch { record = { outcome: "interrupted", raw: pending }; }
      await this.appendHistory(record);
      this.log("Previous sync was interrupted; cleaned up", record);
    }
    for (const name of await fs.readdir(this.stateDir)) {
      if (name.startsWith(TEMP_PREFIX)) await fs.rm(path.join(this.stateDir, name), { recursive: true, force: true });
    }
    await this.tryGit(["worktree", "prune"]);
    // 无法确认锁的归属（可能是用户之后启动的 Git，例如正在编辑提交信息的 git commit），不删除，交给用户确认
    const lock = path.join(await this.git(["rev-parse", "--absolute-git-dir"]), "index.lock");
    if (pending && await exists(lock)) throw new SyncError("repo", `${lock} exists after an interrupted sync; remove it if no Git process is running, then retry`);
  }
  // 未完成的 merge/cherry-pick/revert/rebase 中，add -A 会把冲突文件当作已解决提交并推送；在修改仓库前停下
  private async checkUnfinished(): Promise<void> {
    const gitDir = await this.git(["rev-parse", "--absolute-git-dir"]);
    for (const marker of UNFINISHED) {
      if (await exists(path.join(gitDir, marker))) throw new SyncError("unfinished", `Unfinished Git operation: ${marker} exists`);
    }
    if (await this.git(["ls-files", "-u"])) throw new SyncError("unfinished", "Index has unmerged files");
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
    const parents = [await this.git(["rev-parse", "HEAD"], cwd)];
    const mergeHead = await this.tryGit(["rev-parse", "--verify", "MERGE_HEAD"], cwd);
    if (mergeHead) parents.push(mergeHead);
    const resultTree = await this.git(["write-tree"], cwd);
    const record = JSON.stringify({ ...data, resultTree, parents }, null, 2);
    await this.git(["commit", "--allow-empty", "-F", "-"], cwd, `${title}\n\nOgit-Metadata-Begin\n${record}\nOgit-Metadata-End\n`);
    return this.git(["rev-parse", "HEAD"], cwd);
  }
  // 只取消暂存，工作区文件不动
  private async unstage(names: string[]): Promise<void> {
    if (!names.length) return;
    await this.git(["--literal-pathspecs", "reset", "-q", "--pathspec-from-file=-", "--pathspec-file-nul"], this.root, names.join("\0"));
  }
  // 0 字节普通文件返回 Stats，否则（含已消失、符号链接）返回 null
  private async emptyStat(name: string): Promise<Stats | null> {
    const stat = await fs.lstat(path.join(this.root, name)).catch(() => null);
    return stat?.isFile() && stat.size === 0 ? stat : null;
  }
  // 未跟踪的 0 字节 .md。Obsidian 会自动创建空日记，入库会与其他设备的同名日记冲突
  private async emptyMds(dir = "."): Promise<string[]> {
    const untracked = (await this.git(["--literal-pathspecs", "ls-files", "--others", "--exclude-standard", "-z", "--", dir])).split("\0");
    const empty: string[] = [];
    for (const name of untracked) {
      if (name.toLowerCase().endsWith(".md") && await this.emptyStat(name)) empty.push(name);
    }
    return empty;
  }
  // 删除前再确认一次仍为空，缩小与用户输入的竞争窗口
  private async removeEmpties(names: string[]): Promise<void> {
    const removed: string[] = [];
    for (const name of names) {
      if (!(await this.emptyStat(name))) continue;
      await fs.rm(path.join(this.root, name));
      removed.push(name);
    }
    if (!removed.length) return;
    (this.journal.emptiesRemoved ??= []).push(...removed);
    this.log("Empty files removed", removed);
  }
  // 仅 onLoad：删除日记目录中非今天创建、且已超过宽限期的空日记
  private async cleanEmptyDiaries(): Promise<void> {
    if (!this.diaryDir) return;
    const now = new Date();
    const stale: string[] = [];
    for (const name of await this.emptyMds(this.diaryDir)) {
      const stat = await this.emptyStat(name);
      if (!stat) continue;
      const created = createdAt(stat);
      if (new Date(created).toDateString() !== now.toDateString() && now.getTime() - created > DIARY_GRACE_MS) stale.push(name);
    }
    await this.removeEmpties(stale);
  }
  // 合并结果中已有同名文件时，本地未跟踪空 md 会挡住 read-tree；0 字节删掉无损，随后写入远程内容
  private async removeCollidingEmpties(result: string): Promise<void> {
    const empty = await this.emptyMds();
    if (!empty.length) return;
    const incoming = new Set((await this.git(["ls-tree", "-r", "--name-only", "-z", result])).split("\0"));
    await this.removeEmpties(empty.filter(name => incoming.has(name)));
  }
  // 只约束本次快照新引入的内容：新增或修改的超限文件取消暂存，不入库；已在历史中的文件不受影响
  private async skipOversized(): Promise<OversizedFile[]> {
    const limit = this.config.maxFileMiB * 1024 * 1024;
    const changed = (await this.git(["diff", "--cached", "--no-renames", "--name-only", "-z", "--diff-filter=ACMT"])).split("\0").filter(Boolean);
    const oversized: OversizedFile[] = [];
    for (const name of changed) {
      const bytes = (await fs.stat(path.join(this.root, name))).size;
      if (bytes > limit) oversized.push({ path: name, bytes });
    }
    await this.unstage(oversized.map(file => file.path));
    return oversized;
  }
  // 只维护 OGIT 区块，不动用户自己的规则；返回是否改写了文件
  private async ensureAttributes(cwd: string): Promise<boolean> {
    const file = path.join(cwd, ".gitattributes");
    const text = await fs.readFile(file, "utf8").catch(() => "");
    const updated = LFS_BLOCK.test(text) ? text.replace(LFS_BLOCK, () => this.lfsRules)
      : text + (text && !text.endsWith("\n") ? "\n" : "") + this.lfsRules;
    if (updated === text) return false;
    await fs.writeFile(file, updated);
    return true;
  }
  private async stageAll(cwd: string): Promise<void> {
    const changed = await this.ensureAttributes(cwd);
    await this.git(["add", "-A"], cwd);
    // renormalize 会重读全部已跟踪文件，只在 LFS 规则变化时执行
    if (changed) await this.git(["add", "--renormalize", "."], cwd);
  }

  private async snapshot(): Promise<{ head: string; skipped: OversizedFile[] }> {
    // 不加 --force：用户自定义的 pre-push hook 不能被静默覆盖
    try { await this.git(["lfs", "install", "--local"]); }
    catch (error) {
      // 已有 pre-push hook 等也会导致失败；lfs version 同样失败才判定为未安装 LFS
      if (error instanceof GitError && !(await this.git(["lfs", "version"]).then(() => true, () => false))) throw new SyncError("nolfs", error.message);
      throw error;
    }
    const empty = await this.emptyMds();
    await this.stageAll(this.root);
    await this.unstage(empty);
    const key = empty.join("\0");
    if (key !== this.lastEmpty) { this.journal.emptySkipped = empty; this.lastEmpty = key; }
    const skipped = await this.skipOversized();
    if (await this.git(["diff", "--cached", "--name-only"])) {
      const stats = await this.git(["diff", "--cached", "--shortstat"]);
      await this.commit(`ogit: snapshot local changes (${this.journal.event})`, this.metadata("snapshot", { stats }));
    }
    return { head: await this.git(["rev-parse", "HEAD"]), skipped };
  }
  private async fetch(): Promise<string> {
    const c = this.context;
    // 只拉取 upstream，不受用户 fetch refspec 影响
    try { await this.git(["fetch", "--no-tags", c.remote, `+${c.remoteRef}:${c.upstream}`]); }
    catch (error) { throw error instanceof GitError ? new SyncError("remote", error.message) : error; }
    return this.git(["rev-parse", c.upstream]);
  }
  // porcelain 输出中以 ! 开头的行表示该引用被拒绝；没有这类行说明根本没能与远程完成通信（网络、认证等）
  private async pushRefs(refspecs: string[], options: string[] = []): Promise<void> {
    try { await this.git(["push", "--porcelain", ...options, this.context.remote, ...refspecs]); }
    catch (error) {
      if (!(error instanceof GitError)) throw error;
      const rejected = error.stdout.split("\n").some(line => line.startsWith("!"));
      throw new SyncError(rejected ? "refused" : "remote", error.message);
    }
  }
  // 整合前把双方各推一个不可变恢复分支，推送失败则不继续
  private async protect(reason: string, local: string, remote: string): Promise<RecoveryRefs> {
    const base = `refs/heads/ogit/recovery/${reason}/${this.journal.operationId}`;
    const refs = { localRecoveryRef: `${base}/local`, remoteRecoveryRef: `${base}/remote` };
    await this.phase("backup", { localCommit: local, remoteCommit: remote, ...refs });
    await this.git(["update-ref", refs.localRecoveryRef, local, ZERO]);
    await this.git(["update-ref", refs.remoteRecoveryRef, remote, ZERO]);
    await this.pushRefs([`${refs.localRecoveryRef}:${refs.localRecoveryRef}`, `${refs.remoteRecoveryRef}:${refs.remoteRecoveryRef}`]);
    return refs;
  }

  // 本地领先或相同：不动；落后：快进（双方都已在 upstream 上，无需恢复分支）；分叉：保护双方后合并
  private async reconcile(local: string, remote: string, label: string): Promise<string> {
    if (await this.isAncestor(remote, local)) return local;
    if (await this.isAncestor(local, remote)) {
      await this.apply(local, remote);
      return remote;
    }
    return this.integrate(local, remote, label);
  }
  // 把 Vault 从 local 推进到 result
  private async apply(local: string, result: string): Promise<void> {
    await this.phase("apply", { resultCommit: result });
    await this.removeCollidingEmpties(result);
    // 两树 read-tree 拒绝覆盖未提交修改和未跟踪文件；不在 Vault 中 reset --hard
    await this.git(["read-tree", "-m", "-u", local, result]);
    await this.gitAlways(["update-ref", `refs/heads/${this.context.branch}`, result, local]);
    await this.phase("applied");
  }
  private async integrate(local: string, remote: string, label: string, strategy?: Strategy, reason?: string): Promise<string> {
    const refs = await this.protect(label, local, remote);
    const temp = path.join(this.stateDir, `${TEMP_PREFIX}worktree-${randomBytes(6).toString("hex")}`);
    await this.phase("merge", { temporaryWorktree: temp });
    await this.git(["worktree", "add", "--detach", temp, strategy ? remote : local]);
    try {
      const result = strategy ? await this.choose(temp, local, remote, strategy, reason, refs) : await this.merge(temp, local, remote, refs);
      // 结果也保留独立分支，应用或推送失败时仍可找回
      await this.git(["update-ref", refs.localRecoveryRef.replace(/local$/, "result"), result, ZERO]);
      await this.apply(local, result);
      return result;
    } finally {
      await this.gitAlways(["worktree", "remove", "--force", temp]).catch(() => "");
    }
  }
  // 仅用于已分叉的历史；快进由 reconcile 处理
  private async merge(temp: string, local: string, remote: string, refs: RecoveryRefs): Promise<string> {
    if (!(await this.tryGit(["merge-base", local, remote], temp))) throw new SyncError("conflict", "Local and remote histories are unrelated");
    try { await this.git(["merge", "--no-commit", "--no-ff", remote], temp); }
    catch (error) {
      // 退出码 1 且存在未合并条目即为内容冲突
      if (error instanceof GitError && error.exitCode === 1 && await this.git(["ls-files", "-u"], temp)) throw new SyncError("conflict", error.message);
      throw error;
    }
    return this.commit("ogit: merge upstream",
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

  // 返回最终推送的提交；无新提交时不访问远程
  private async push(local: string): Promise<string> {
    const c = this.context;
    if (local === await this.git(["rev-parse", c.upstream])) return local;
    await this.phase("push", { resultCommit: local });
    try {
      await this.pushRefs([`${local}:${c.remoteRef}`]);
      return local;
    } catch (error) {
      if (!(error instanceof SyncError) || error.code !== "refused") throw error;
      // 远程未前进则是服务端策略拒绝；前进了就整合后重推一次，内容冲突时 merge 抛 conflict
      const remote = await this.fetch();
      if (await this.isAncestor(remote, local)) throw error;
      const result = await this.reconcile(local, remote, "push-rejected");
      await this.phase("push", { resultCommit: result });
      try { await this.pushRefs([`${result}:${c.remoteRef}`]); }
      catch (retry) {
        // 重推期间远程又前进：其他设备在抢推送，不是服务端拒绝，下次同步再整合
        if (retry instanceof SyncError && retry.code === "refused" && !(await this.isAncestor(await this.fetch(), result))) {
          throw new SyncError("remote", "Remote advanced again during push retry");
        }
        throw retry;
      }
      return result;
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
        await this.pushRefs([`${commit}:${ref}`], [`--force-with-lease=${ref}:`]);
      }
      await fs.writeFile(statePath, JSON.stringify({ ...state, monthly: ref }));
    } catch (error) {
      this.log("Monthly backup deferred", { ref, error: (error as Error).message });
    }
  }

  async run(event: SyncEvent, details: SyncDetails | undefined, signal: AbortSignal): Promise<SyncResult> {
    if (shared[RUNNING]) throw new SyncError("failed", "A sync from a previous plugin instance is still running");
    shared[RUNNING] = true;
    try {
      this.signal = signal;
      await fs.mkdir(this.stateDir, { recursive: true });
      if (event === "onLoad") await this.cleanup();
      this.device = await this.loadDevice();
      // 先于分支检查：rebase 期间 HEAD 分离，应报可自动恢复的 unfinished 而非阻塞的 repo
      await this.checkUnfinished();
      this.context = await this.loadContext();
      this.journal = {
        operationId: `${new Date().toISOString().replace(/[-:.]/g, "")}-${this.device}-${randomBytes(4).toString("hex")}`,
        event, phase: "start", outcome: "running", branch: this.context.branch, upstream: this.context.upstream,
      };
      return await this.execute(event, details);
    } finally {
      shared[RUNNING] = false;
    }
  }
  private async execute(event: SyncEvent, details: SyncDetails | undefined): Promise<SyncResult> {
    try {
      await this.phase("snapshot");
      if (event === "onLoad") await this.cleanEmptyDiaries();
      const snapshot = await this.snapshot();
      let local = snapshot.head;
      await this.phase("snapshotted", { localCommit: local, skipped: snapshot.skipped });
      if (FULL_EVENTS.includes(event)) {
        const remote = await this.fetch();
        await this.phase("fetched", { remoteCommit: remote });
        local = event === "onResolve" && details?.strategy
          ? await this.integrate(local, remote, `keep-${details.strategy}`, details.strategy, details.reason)
          : await this.reconcile(local, remote, "merge");
      }
      local = await this.push(local);
      await this.monthly(local);
      this.journal.outcome = "success";
      return { skipped: snapshot.skipped };
    } catch (error) {
      const failure = error instanceof SyncError ? error : new SyncError("failed", (error as Error).message);
      Object.assign(this.journal, { outcome: "error", errorCode: failure.code, error: failure.message });
      throw failure;
    } finally {
      await this.appendHistory(this.journal);
      await fs.rm(path.join(this.stateDir, PENDING), { force: true });
    }
  }
}
