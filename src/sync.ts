import { CommandError, SyncError, commandFailure, remoteFailure, runGit, type ErrorCode, type OversizedFile } from "./git";
import { DEFAULT_CONFIG, type SyncConfig } from "./config";
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

export type SyncEvent = "onClick" | "onLoad" | "onOpen" | "onSave" | "onClose" | "onCron" | "onResolve" | "onRetry";
export type Strategy = "local" | "remote";
export interface SyncDetails { path?: string | null; source?: string; strategy?: Strategy; reason?: string; retryOf?: Exclude<SyncEvent, "onRetry"> }
interface Context { branch: string; remote: string; remoteRef: string; upstream: string; gitDir: string; urlsHash: string }
interface Journal {
  schemaVersion: 1; operationId: string; event: SyncEvent; phase: string;
  retryOf?: SyncDetails["retryOf"];
  branch?: string; upstream?: string; localCommit?: string; remoteCommit?: string;
  localRecoveryRef?: string; remoteRecoveryRef?: string; resultCommit?: string;
  previousRemoteCommit?: string; previousRemoteRecoveryRef?: string;
  temporaryWorktree?: string;
  outcome?: "running" | "success" | "error" | "cancelled"; errorCode?: ErrorCode;
}
interface RepoState { schemaVersion: 1; upstream?: string; lastRemote?: string }
interface MonthlyTask { ref: string; commit: string; upstream: string; urlsHash: string }

export class GitSyncEngine {
  private readonly repoId: string;
  private readonly stateDir: string;
  private signal?: AbortSignal;
  private journal?: Journal;
  private device = "";
  private context?: Context;
  private applying = false;
  private readonly maxFileBytes: number;
  private readonly lfsRules: string;

  constructor(private readonly root: string, private readonly log: (event: string, details?: unknown) => void,
    stateBase = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), ".local", "state"), "ObsidianCustomGitSync"),
    private readonly config: SyncConfig = DEFAULT_CONFIG) {
    const resolved = path.resolve(root);
    this.repoId = createHash("sha256").update(process.platform === "win32" ? resolved.toLowerCase() : resolved).digest("hex").slice(0, 16);
    this.stateDir = path.join(stateBase, this.repoId);
    this.maxFileBytes = config.maxFileMiB * 1024 * 1024;
    // Git attribute patterns are case-sensitive, so match both cases explicitly.
    this.lfsRules = config.lfsExtensions.map(ext => `*.${[...ext].map(c => /[a-z]/.test(c) ? `[${c}${c.toUpperCase()}]` : c).join("")} filter=lfs diff=lfs merge=lfs -text`).join("\n");
  }

  private checkCancelled(): void { if (this.signal?.aborted) throw new SyncError("cancelled"); }
  private async git(args: string[], cwd = this.root, inputEnv: NodeJS.ProcessEnv = {}, allowFailure = false, input?: string): Promise<string> {
    this.checkCancelled();
    return runGit(args, cwd, { timeoutMs: this.config.gitTimeoutSeconds * 1000, inputEnv, allowFailure, input });
  }
  private async remoteGit(args: string[], code: "network" | "backup" = "network"): Promise<string> {
    try { return await this.git(args); }
    catch (error) { throw remoteFailure(error, code); }
  }
  private async exists(file: string): Promise<boolean> {
    try { await fs.lstat(file); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  }
  private async saveJson(file: string, value: unknown): Promise<void> {
    const temp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
    const handle = await fs.open(temp, "wx");
    try { await handle.writeFile(JSON.stringify(value, null, 2)); await handle.sync(); } finally { await handle.close(); }
    await fs.rename(temp, file);
  }
  private async phase(phase: string, extra: Partial<Journal> = {}): Promise<void> {
    this.checkCancelled();
    Object.assign(this.journal!, extra, { phase });
    await this.saveJson(path.join(this.stateDir, "pending.json"), this.journal);
    this.log("Git phase", { operationId: this.journal!.operationId, phase });
  }
  private async validate(): Promise<Context> {
    let version: string;
    try { version = await this.git(["--version"]); } catch (error) { throw commandFailure(error, "git"); }
    const match = version.match(/git version (\d+)\.(\d+)/);
    if (!match || Number(match[1]) < 2 || (Number(match[1]) === 2 && Number(match[2]) < 38)) throw new SyncError("unsupported");
    try { await this.git(["lfs", "version"]); } catch (error) { throw commandFailure(error, "lfs"); }
    let top: string;
    try { top = await this.git(["rev-parse", "--show-toplevel"]); } catch (error) { throw commandFailure(error, "root"); }
    const canonical = (file: string): string => process.platform === "win32" ? file.toLowerCase() : file;
    if (canonical(await fs.realpath(top)) !== canonical(await fs.realpath(this.root))) throw new SyncError("root");
    const branch = await this.git(["symbolic-ref", "--quiet", "--short", "HEAD"], this.root, {}, true);
    if (!branch || branch.startsWith("ogit/")) throw new SyncError("branch");
    const remote = await this.git(["config", "--get", `branch.${branch}.remote`], this.root, {}, true);
    const remoteRef = await this.git(["config", "--get", `branch.${branch}.merge`], this.root, {}, true);
    const upstream = await this.git(["rev-parse", "--symbolic-full-name", "@{upstream}"], this.root, {}, true);
    if (!remote || remote === "." || remote.startsWith("-") || !remoteRef.startsWith("refs/heads/") || !upstream.startsWith("refs/remotes/")) throw new SyncError("upstream");
    await this.git(["check-ref-format", remoteRef]);
    const gitDir = await this.git(["rev-parse", "--absolute-git-dir"]);
    if (await this.git(["rev-parse", "--show-object-format"]) !== "sha1") throw new SyncError("unsupported");
    for (const marker of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-apply", "rebase-merge", "sequencer", "BISECT_LOG"]) {
      if (await this.exists(path.join(gitDir, marker))) throw new SyncError("unfinished");
    }
    if (await this.exists(path.join(gitDir, "index.lock"))) throw new SyncError("locked");
    if (await this.git(["diff", "--cached", "--name-only"])) throw new SyncError("staged");
    if (/^[a-zS] /m.test(await this.git(["ls-files", "-v"]))) throw new SyncError("unsupported");
    if (await this.git(["rev-parse", "--is-shallow-repository"]) === "true" ||
        await this.git(["config", "--bool", "core.sparseCheckout"], this.root, {}, true) === "true") throw new SyncError("unsupported");
    await this.checkTree("HEAD");
    if (!(await this.git(["config", "user.name"], this.root, {}, true)) || !(await this.git(["config", "user.email"], this.root, {}, true))) throw new SyncError("operation");
    return { branch, remote, remoteRef, upstream, gitDir, urlsHash: await this.urlsHash(remote) };
  }
  private async urlsHash(remote: string): Promise<string> {
    return createHash("sha256").update(await this.git(["remote", "get-url", "--all", remote]))
      .update("\0").update(await this.git(["remote", "get-url", "--push", "--all", remote])).digest("hex");
  }
  private async assertContext(head: string): Promise<void> {
    const c = this.context!;
    if (await this.git(["rev-parse", "HEAD"]) !== head ||
        await this.git(["symbolic-ref", "--short", "HEAD"]) !== c.branch ||
        await this.git(["config", "--get", `branch.${c.branch}.remote`]) !== c.remote ||
        await this.git(["config", "--get", `branch.${c.branch}.merge`]) !== c.remoteRef ||
        await this.urlsHash(c.remote) !== c.urlsHash) throw new SyncError("changed");
  }
  private async checkTree(commit: string): Promise<void> {
    const tree = await this.git(["ls-tree", "-r", "-z", commit]);
    const names = new Set<string>();
    const directories = new Map<string,string>();
    for (const entry of tree.split("\0").filter(Boolean)) {
      const split = entry.indexOf("\t"); const name = entry.slice(split + 1);
      if (entry.startsWith("160000 ") || entry.startsWith("120000 ")) throw new SyncError("unsupported");
      const key = name.toLowerCase();
      if (process.platform === "win32" && names.has(key)) throw new SyncError("unsupported");
      names.add(key);
      if (process.platform === "win32") {
        const parts = name.split("/");
        for (let i = 1; i < parts.length; i++) {
          const directory = parts.slice(0,i).join("/");
          const existing = directories.get(directory.toLowerCase());
          if (existing && existing !== directory) throw new SyncError("unsupported");
          directories.set(directory.toLowerCase(), directory);
        }
      }
    }
  }
  private metadata(action: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return { schemaVersion: 2, pluginVersion: "0.3.0", operationId: this.journal!.operationId,
      event: this.journal!.event, action, device: this.device, time: new Date().toISOString(),
      branch: this.context!.branch, upstream: this.context!.upstream,
      ...(this.journal!.retryOf ? { retryOf: this.journal!.retryOf } : {}), ...extra };
  }
  private message(title: string, data: Record<string, unknown>): string {
    return `${title}\n\nOgit-Metadata-Begin\n${JSON.stringify(data, null, 2)}\nOgit-Metadata-End\n`;
  }
  private async commit(title: string, data: Record<string, unknown>, cwd = this.root, allowEmpty = false): Promise<string> {
    await this.checkCommitSize(cwd);
    const tree = await this.git(["write-tree"],cwd);
    const parents = [await this.git(["rev-parse","HEAD"],cwd)];
    const mergeHead = await this.git(["rev-parse","--quiet","--verify","MERGE_HEAD"],cwd,{},true);
    if (mergeHead) parents.push(mergeHead);
    const file = path.join(this.stateDir, `message-${randomBytes(5).toString("hex")}.txt`);
    await fs.writeFile(file, this.message(title, { ...data, resultTree:tree, parents }), "utf8");
    try { await this.git(["commit", ...(allowEmpty ? ["--allow-empty"] : []), "-F", file], cwd); }
    finally { await fs.rm(file, { force: true }); }
    const result = await this.git(["rev-parse", "HEAD"], cwd);
    const actualTree = await this.git(["rev-parse","HEAD^{tree}"],cwd);
    const actualParents = (await this.git(["rev-list","--parents","-n","1",result],cwd)).split(" ").slice(1);
    if (actualTree !== tree || actualParents.join(" ") !== parents.join(" ")) {
      this.log("Commit changed during hooks",{commit:result,expectedTree:tree,actualTree});
      throw new SyncError("changed");
    }
    return result;
  }
  private async checkCommitSize(cwd = this.root): Promise<void> {
    const changed = (await this.git(["diff", "--cached", "--no-renames", "--name-only", "-z", "--diff-filter=ACMT"], cwd)).split("\0").filter(Boolean);
    if (!changed.length) return;
    const index = new Map<string,string>();
    for (const entry of (await this.git(["ls-files", "--stage", "-z"], cwd)).split("\0").filter(Boolean)) {
      const tab = entry.indexOf("\t"); const [mode, oid, stage] = entry.slice(0,tab).split(" ");
      if (stage === "0" && mode !== "160000") index.set(entry.slice(tab+1),oid);
    }
    const ids = [...new Set(changed.map(name => index.get(name)).filter((id): id is string => Boolean(id)))];
    const sizes = new Map<string,number>();
    const output = await this.git(["cat-file", "--batch-check=%(objectname) %(objectsize)"], cwd, {}, false, ids.join("\n")+"\n");
    for (const line of output.split("\n")) {
      const [id, bytes] = line.split(" ");
      if (!Number.isSafeInteger(Number(bytes))) throw new SyncError("operation");
      sizes.set(id,Number(bytes));
    }
    const filters = new Map<string,string>();
    for (let offset=0; offset<changed.length; offset+=50) {
      const attrs = (await this.git(["check-attr", "--cached", "-z", "filter", "--", ...changed.slice(offset,offset+50)], cwd)).split("\0");
      for (let i=0; i+2<attrs.length; i+=3) filters.set(attrs[i],attrs[i+2]);
    }
    const oversized: OversizedFile[] = [];
    let mediaDir: string | undefined;
    for (const name of changed) {
      const oid = index.get(name); if (!oid) throw new SyncError("operation");
      let bytes = sizes.get(oid); if (bytes === undefined) throw new SyncError("operation");
      if (filters.get(name) === "lfs" && bytes !== 0) {
        if (bytes > 1024) throw new SyncError("lfs");
        const pointer = await this.git(["cat-file", "blob", oid], cwd);
        const temp = path.join(os.tmpdir(),`ogit-pointer-${randomBytes(8).toString("hex")}.txt`);
        await fs.writeFile(temp,pointer+"\n",{flag:"wx"});
        try { await this.git(["lfs","pointer","--check",`--file=${temp}`],cwd); }
        catch (error) { throw commandFailure(error, "lfs"); }
        finally { await fs.rm(temp,{force:true}); }
        const declared = pointer.match(/^size (\d+)$/m), object = pointer.match(/^oid sha256:([a-f0-9]{64})$/m);
        if (!declared || !object || !Number.isSafeInteger(Number(declared[1]))) throw new SyncError("lfs");
        bytes = Number(declared[1]);
        if (!mediaDir) mediaDir = (await this.git(["lfs","env"],cwd)).match(/^LocalMediaDir=(.+)$/m)?.[1].trim();
        if (!mediaDir) throw new SyncError("lfs");
        const hash = object[1];
        let actual: number;
        try { actual = (await fs.stat(path.join(mediaDir,hash.slice(0,2),hash.slice(2,4),hash))).size; }
        catch { throw new SyncError("lfs"); }
        if (actual > this.maxFileBytes) bytes = actual;
        else if (actual !== bytes) throw new SyncError("lfs");
      }
      if (bytes > this.maxFileBytes) oversized.push({path:name,bytes});
    }
    if (oversized.length) throw new SyncError("size", { files: oversized });
  }
  private async snapshot(): Promise<string> {
    await this.phase("snapshot");
    const parent = await this.git(["rev-parse", "HEAD"]);
    if ((await this.git(["ls-files", "--stage", "--", ".gitattributes"])).startsWith("120000 ")) throw new SyncError("unsupported");
    await this.ensureAttributes(this.root);
    // Install without --force: a user pre-push hook must not silently be overwritten.
    await this.git(["lfs", "install", "--local"]);
    const staged = await this.git(["diff", "--cached", "--name-only"]);
    if (staged) throw new SyncError("staged");
    // Remove missing tracked paths from the index before renormalizing survivors.
    await this.git(["add", "-A", "--", "."]);
    await this.git(["add", "--renormalize", "."]);
    if (/^(120000|160000) /m.test(await this.git(["ls-files", "--stage"]))) throw new SyncError("unsupported");
    if (!(await this.git(["ls-files", "--", ".gitattributes"]))) throw new SyncError("lfs");
    await this.verifyLfsIndex();
    await this.assertContext(parent);
    if (await this.git(["diff", "--cached", "--name-only"])) {
      const stats = await this.git(["diff", "--cached", "--shortstat"]);
      await this.commit(`ogit: snapshot local changes (${this.journal!.event})`, this.metadata("snapshot", { stats }));
    }
    return this.git(["rev-parse", "HEAD"]);
  }
  private async verifyLfsIndex(cwd = this.root): Promise<void> {
    const files = (await this.git(["ls-files", "-z"], cwd)).split("\0").filter(Boolean);
    for (const name of files) {
      if (!this.config.lfsExtensions.includes(path.extname(name).slice(1).toLowerCase())) continue;
      const attr = await this.git(["check-attr", "--cached", "filter", "--", name], cwd);
      if (!attr.endsWith(": lfs")) throw new SyncError("lfs");
      const oid = await this.git(["rev-parse", `:${name}`], cwd);
      const size = Number(await this.git(["cat-file", "-s", oid], cwd));
      if (size > 1024) throw new SyncError("lfs");
      const blob = await this.git(["cat-file", "blob", oid], cwd);
      if (size !== 0 && !/^version https:\/\/git-lfs.github.com\/spec\/v1\r?\noid sha256:[0-9a-f]{64}\r?\nsize \d+/.test(blob)) throw new SyncError("lfs");
    }
  }
  private async fetch(): Promise<string> {
    const c = this.context!;
    await this.phase("fetch");
    // Fetch only the configured upstream, independent of user fetch refspecs.
    await this.remoteGit(["fetch", "--no-tags", c.remote, `+${c.remoteRef}:${c.upstream}`]);
    const remote = await this.git(["rev-parse", c.upstream]);
    await this.checkTree(remote);
    return remote;
  }
  private async ancestor(a: string, b: string): Promise<boolean> {
    return (await this.git(["merge-base", a, b], this.root, {}, true)) === a;
  }
  private async protect(reason: string, local: string, remote: string, previousRemote?: string): Promise<{localRef: string; remoteRef: string}> {
    await this.assertContext(local);
    const base = `refs/heads/ogit/recovery/${reason}/${this.journal!.operationId}`;
    const localRef = `${base}/local`, remoteRef = `${base}/remote`;
    await this.phase("backup", { localCommit: local, remoteCommit: remote, localRecoveryRef: localRef, remoteRecoveryRef: remoteRef });
    await this.git(["update-ref", localRef, local, "0000000000000000000000000000000000000000"]);
    await this.git(["update-ref", remoteRef, remote, "0000000000000000000000000000000000000000"]);
    const refs = [localRef, remoteRef];
    if (previousRemote) {
      const ref = `${base}/previous-remote`;
      await this.phase("backup", { previousRemoteCommit: previousRemote, previousRemoteRecoveryRef: ref });
      await this.git(["update-ref", ref, previousRemote, "0000000000000000000000000000000000000000"]);
      refs.push(ref);
    }
    for (const ref of refs) {
      await this.remoteGit(["lfs", "fetch", this.context!.remote, ref], "backup");
      await this.remoteGit(["lfs", "push", "--all", this.context!.remote, ref], "backup");
      await this.remoteGit(["push", "--porcelain", this.context!.remote, `${ref}:${ref}`], "backup");
      await this.confirmRemote(ref, await this.git(["rev-parse", ref]), "backup");
    }
    return { localRef, remoteRef };
  }
  private async confirmRemote(ref: string, expected: string, code: "network" | "backup" = "network"): Promise<void> {
    const result = await this.remoteGit(["ls-remote", "--refs", this.context!.remote, ref], code);
    if (result.split(/\s/)[0] !== expected) throw new SyncError(code);
  }
  private async stable(local: string): Promise<void> {
    await this.assertContext(local);
    if (await this.git(["status","--porcelain=v1","-z","--untracked-files=all"]) ||
        await this.git(["diff","--no-ext-diff","--name-only"]) ||
        await this.git(["diff","--cached",local,"--name-only"])) throw new SyncError("changed");
  }
  private async integrate(local: string, remote: string, strategy?: Strategy, conflictReason?: string): Promise<string> {
    const reason = strategy ? `keep-${strategy}` : "startup-merge";
    const refs = await this.protect(reason, local, remote);
    const temp = path.join(this.stateDir, `worktree-${randomBytes(6).toString("hex")}`);
    await this.phase("prepare-worktree", { temporaryWorktree: temp });
    await this.git(["worktree", "add", "--detach", temp, strategy ? remote : local]);
    let result: string;
    try {
      if (strategy) {
        if (strategy === "local") await this.git(["read-tree", "--reset", "-u", local], temp);
        // The temporary worktree only: normalize chosen current binaries, not historical commits.
        await this.ensureAttributes(temp);
        await this.git(["add", "-A", "--", "."], temp);
        await this.git(["add", "--renormalize", "."], temp);
        await this.verifyLfsIndex(temp);
        const tree = await this.git(["write-tree"], temp);
        const parents = [remote];
        if (local !== remote && !(await this.ancestor(local,remote))) {
          // Only the plugin's isolated worktree receives merge state.
          await this.git(["update-ref","MERGE_HEAD",local],temp);
          parents.push(local);
        }
        result = await this.commit(`ogit: resolve repository using ${strategy}`, this.metadata("resolve", {
          strategy, reason: conflictReason || "history-divergence", localCommit: local, remoteCommit: remote,
          localRecoveryRef: refs.localRef, remoteRecoveryRef: refs.remoteRef, resultTree: tree, parents,
        }), temp, true);
        if (await this.git(["rev-parse", "HEAD^{tree}"], temp) !== tree) throw new SyncError("operation");
      } else {
        const common = await this.git(["merge-base", local, remote], temp, {}, true);
        if (!common) throw new SyncError("conflict", { resolvable: true });
        if (await this.ancestor(local,remote)) {
          await this.git(["merge","--ff-only",remote],temp);
        } else {
          try { await this.git(["merge","--no-commit","--no-ff","--no-autostash",remote],temp); }
          catch (error) {
            if (error instanceof CommandError && error.timedOut) throw error;
            if (await this.git(["ls-files","--unmerged","-z"],temp)) throw new SyncError("conflict", { resolvable: true });
            throw commandFailure(error, "operation");
          }
          await this.verifyLfsIndex(temp);
          const tree = await this.git(["write-tree"],temp);
          await this.commit("ogit: merge upstream on startup",this.metadata("merge",{
            localCommit:local,remoteCommit:remote,localRecoveryRef:refs.localRef,
            remoteRecoveryRef:refs.remoteRef,resultTree:tree,parents:[local,remote],
          }),temp);
          if (await this.git(["rev-parse","HEAD^{tree}"],temp) !== tree) throw new SyncError("operation");
        }
        result = await this.git(["rev-parse", "HEAD"], temp);
      }
      await this.checkTree(result);
      await this.verifyLfsIndex(temp);
      if (await this.git(["status", "--porcelain"], temp)) throw new SyncError("changed");
      // Keep the computed result reachable even if applying or pushing fails.
      const resultRef = `refs/heads/ogit/recovery/${reason}/${this.journal!.operationId}/result`;
      await this.git(["update-ref", resultRef, result, "0000000000000000000000000000000000000000"]);
      await this.remoteGit(["lfs", "push", "--all", this.context!.remote, resultRef], "backup");
      await this.remoteGit(["push", "--porcelain", this.context!.remote, `${resultRef}:${resultRef}`], "backup");
      await this.confirmRemote(resultRef, result, "backup");
      await this.stable(local);
      await this.checkObstructions(local, result);
      await this.phase("apply", { resultCommit: result });
      this.applying = true;
      // Two-tree checkout refuses overwritten tracked edits and untracked obstructions.
      await this.git(["read-tree", "-m", "-u", local, result]);
      await this.git(["update-ref", `refs/heads/${this.context!.branch}`, result, local]);
      this.applying = false;
      await this.phase("applied");
      return result;
    } finally {
      // Only delete this plugin-created temporary checkout. Never abort in the Vault.
      try { await this.git(["worktree", "remove", "--force", temp]); } catch { /* journal retains path via operation */ }
    }
  }
  private async checkObstructions(local: string, result: string): Promise<void> {
    const old = new Set((await this.git(["ls-tree", "-r", "-z", "--name-only", local])).split("\0").filter(Boolean));
    const target = (await this.git(["ls-tree", "-r", "-z", "--name-only", result])).split("\0").filter(Boolean);
    for (const file of target) {
      // Git checkout can overwrite ignored files. Refuse all untracked obstructions explicitly.
      if (!old.has(file) && await this.exists(path.join(this.root,file))) throw new SyncError("changed");
      const parts = file.split("/");
      for (let i = 1; i < parts.length; i++) {
        const relative = parts.slice(0,i).join("/");
        const full = path.join(this.root,relative);
        if (await this.exists(full) && !(await fs.lstat(full)).isDirectory() && !old.has(relative)) throw new SyncError("changed");
      }
    }
  }
  private async ensureAttributes(cwd: string): Promise<void> {
    const file = path.join(cwd, ".gitattributes");
    if (await this.exists(file) && !(await fs.lstat(file)).isFile()) throw new SyncError("unsupported");
    const text = await this.exists(file) ? await fs.readFile(file, "utf8") : "";
    const begin = "# BEGIN OGIT LFS", end = "# END OGIT LFS";
    const b = text.indexOf(begin), e = text.indexOf(end);
    if ((b >= 0) !== (e >= 0) || (b >= 0 && e < b)) throw new SyncError("lfs");
    const block = `${begin}\n${this.lfsRules}\n${end}\n`;
    const updated = b >= 0 ? text.slice(0,b) + block + text.slice(e + end.length).replace(/^\r?\n/, "") : text + (text && !text.endsWith("\n") ? "\n" : "") + block;
    if (updated !== text) await fs.writeFile(file, updated, "utf8");
  }
  private async push(local: string): Promise<void> {
    const c = this.context!;
    await this.phase("push", { resultCommit: local });
    await this.assertContext(local);
    // An accepted Git ref cannot prove that a failed LFS upload succeeded.
    await this.remoteGit(["lfs", "push", "--all", c.remote, local]);
    try {
      await this.git(["push", "--porcelain", c.remote, `${local}:${c.remoteRef}`]);
    } catch (error) {
      const failure = remoteFailure(error);
      if (failure instanceof CommandError) throw failure;
      // Fetch for diagnostics/protection only; no integration on ordinary events.
      let remote: string;
      try { remote = await this.fetch(); }
      catch (diagnosticError) {
        if (diagnosticError instanceof CommandError || (diagnosticError instanceof SyncError && diagnosticError.code === "cancelled")) throw diagnosticError;
        throw failure.transient ? diagnosticError : failure;
      }
      if (!(await this.ancestor(remote, local))) {
        await this.protect("push-rejected", local, remote);
        throw new SyncError("rejected", { resolvable: true });
      }
      // A failed connection may happen after the server accepted the push.
      try { await this.confirmRemote(c.remoteRef, local); return; }
      catch (confirmationError) {
        if (confirmationError instanceof CommandError || (confirmationError instanceof SyncError && confirmationError.code === "cancelled")) throw confirmationError;
        throw failure;
      }
    }
    await this.confirmRemote(c.remoteRef, local);
  }
  private branchKey(branch: string): string {
    return `${branch.replace(/[^a-zA-Z0-9_-]/g,"-").slice(0,48)}-${createHash("sha256").update(branch).digest("hex").slice(0,8)}`;
  }
  private async uploadMonthly(task: MonthlyTask): Promise<void> {
    const { ref, commit } = task;
    await this.phase("monthly-backup");
    if (await this.urlsHash(this.context!.remote) !== task.urlsHash) throw new SyncError("changed");
    const remote = await this.remoteGit(["ls-remote", "--refs", this.context!.remote, ref], "backup");
    if (remote) return;
    try {
      await this.remoteGit(["lfs", "fetch", this.context!.remote, commit], "backup");
      await this.remoteGit(["lfs", "push", "--all", this.context!.remote, commit], "backup");
      // Empty lease is a create-only check, not permission to overwrite an existing ref.
      await this.git(["push", "--porcelain", `--force-with-lease=${ref}:`, this.context!.remote, `${commit}:${ref}`]);
      await this.confirmRemote(ref, commit);
    } catch (error) {
      if (error instanceof CommandError && error.timedOut) throw error;
      if (!(await this.remoteGit(["ls-remote", "--refs", this.context!.remote, ref], "backup"))) throw remoteFailure(error, "backup");
    }
  }

  private async monthly(commit: string, retryPending: boolean): Promise<void> {
    if (!this.config.monthlyBackupEnabled) return;
    // Optional backup: failures never change the result of a confirmed main push.
    const file = path.join(this.stateDir, "monthly-pending.json");
    try {
      let queue: MonthlyTask[] = await this.exists(file) ? JSON.parse(await fs.readFile(file, "utf8")) : [];
      const c = this.context!;
      const matches = (task: MonthlyTask): boolean => task.upstream === c.upstream && task.urlsHash === c.urlsHash;
      const date = new Date();
      const month = `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}`;
      const ref = `refs/heads/ogit/monthly/${month}/${this.branchKey(c.branch)}`;
      let current = queue.find(task => task.ref === ref && matches(task));
      const newlyQueued = !current;
      if (!current) {
        const existing = await this.git(["rev-parse", "--verify", ref], this.root, {}, true);
        if (!existing) await this.git(["update-ref", ref, commit, "0000000000000000000000000000000000000000"]);
        current = { ref, commit: existing || commit, upstream: c.upstream, urlsHash: c.urlsHash };
        queue.push(current);
        // Persist before transport, retaining the first successful snapshot across restarts/months.
        await this.saveJson(file, queue);
      }
      const tasks = retryPending ? queue.filter(matches) : newlyQueued ? [current] : [];
      for (const task of tasks) {
        try {
          await this.uploadMonthly(task);
          queue = queue.filter(entry => entry !== task);
        } catch (error) {
          if (this.signal?.aborted) throw new SyncError("cancelled");
          this.log("Monthly backup deferred", { ref: task.ref, code: error instanceof SyncError ? error.code : "backup" });
        }
        await this.saveJson(file, queue);
      }
    } catch (error) {
      if (this.signal?.aborted) throw new SyncError("cancelled");
      this.log("Monthly backup deferred", { code: error instanceof SyncError ? error.code : "backup" });
    }
  }

  async run(event: SyncEvent, details: SyncDetails | undefined, signal: AbortSignal): Promise<void> {
    const operationEvent = event === "onRetry" ? details?.retryOf ?? "onClick" : event;
    this.signal = signal;
    this.checkCancelled();
    this.applying = false;
    await fs.mkdir(this.stateDir, { recursive: true });
    if (await this.exists(path.join(this.stateDir, "pending.json"))) throw new SyncError("interrupted");
    const deviceFile = path.join(this.stateDir, "device.txt");
    if (!(await this.exists(deviceFile))) {
      try { await fs.writeFile(deviceFile, randomBytes(6).toString("hex"), { flag: "wx" }); } catch { /* another instance */ }
    }
    this.device = (await fs.readFile(deviceFile, "utf8")).trim();
    this.context = await this.validate();
    // Common Git directory makes the lock effective across linked worktrees/instances.
    const common = path.resolve(this.root, await this.git(["rev-parse", "--git-common-dir"]));
    const lockPath = path.join(common, "ogit-sync.lock");
    let lock;
    try { lock = await fs.open(lockPath, "wx"); } catch { throw new SyncError("locked"); }
    let createdJournal = false;
    try {
      await lock.writeFile(JSON.stringify({ pid: process.pid, stateDir: this.stateDir })); await lock.sync();
      if (await this.exists(path.join(this.stateDir, "pending.json"))) throw new SyncError("interrupted");
      this.journal = { schemaVersion: 1,
        operationId: `${new Date().toISOString().replace(/[-:.]/g, "")}-${this.device}-${randomBytes(4).toString("hex")}`,
        event, retryOf: event === "onRetry" ? operationEvent : undefined,
        phase: "start", outcome: "running", branch: this.context.branch, upstream: this.context.upstream };
      createdJournal = true;
      await this.phase("start");
      // Revalidate after acquiring the lock.
      const validated = await this.validate();
      if (JSON.stringify(validated) !== JSON.stringify(this.context)) throw new SyncError("changed");
      let local = await this.snapshot();
      await this.phase("snapshotted", { localCommit: local });
      if (operationEvent === "onLoad" || operationEvent === "onResolve") {
        await this.stable(local);
        const remote = await this.fetch();
        await this.phase("fetched", { localCommit: local, remoteCommit: remote });
        const statePath = path.join(this.stateDir, "state.json");
        const state: RepoState = await this.exists(statePath) ? JSON.parse(await fs.readFile(statePath,"utf8")) : { schemaVersion: 1 };
        if (operationEvent !== "onResolve" && state.upstream === this.context.upstream && state.lastRemote && !(await this.ancestor(state.lastRemote, remote))) {
          await this.protect("remote-rewritten", local, remote, state.lastRemote);
          throw new SyncError("conflict", { resolvable: true });
        }
        if (operationEvent === "onResolve") {
          if (!details?.strategy) throw new SyncError("operation");
          local = await this.integrate(local, remote, details.strategy, details.reason);
        } else if (!(await this.ancestor(remote, local))) {
          local = await this.integrate(local, remote);
        }
      }
      await this.push(local);
      await this.saveJson(path.join(this.stateDir, "state.json"), { schemaVersion: 1, upstream: this.context.upstream, lastRemote: local });
      await this.monthly(local, operationEvent === "onLoad");
      await this.phase("done", { outcome: "success" });
    } catch (error) {
      if (error instanceof CommandError && error.timedOut) this.applying = true; // unknown outcome: manual audit required
      if (createdJournal && this.journal) {
        this.journal.outcome = signal.aborted ? "cancelled" : "error";
        this.journal.errorCode = error instanceof SyncError ? error.code : "operation";
        await this.saveJson(path.join(this.stateDir,"pending.json"), this.journal);
      }
      if (error instanceof SyncError) throw error;
      throw new SyncError(signal.aborted ? "cancelled" : "operation");
    } finally {
      try {
        if (createdJournal && !this.applying) {
          if (this.journal) await fs.appendFile(path.join(this.stateDir,"history.jsonl"), JSON.stringify(this.journal)+"\n");
          await fs.rm(path.join(this.stateDir,"pending.json"), { force: true });
        }
      } finally {
        await lock.close();
        await fs.rm(lockPath, { force: true });
      }
    }
  }
}
