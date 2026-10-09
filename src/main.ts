import { FileSystemAdapter, FileView, Menu, Plugin, TFile, getLanguage, setIcon, setTooltip } from "obsidian";
import { GitSyncEngine, type SyncDetails, type SyncEvent } from "./sync";
import { SyncError, type ErrorCode } from "./git";
import { DEFAULT_CONFIG, loadConfig, type SyncConfig } from "./config";

type SyncState = "idle" | "syncing" | "success" | "warning" | "error";
const messages = {
  en: { idle: "Git Sync", syncing: "Git Sync: Syncing…", success: "Git Sync: Synced", resolve: "Click for options", warning: "Last sync failed; normal sync remains available", reload: "Fix the problem and reload the plugin", retry: "Retry", keepRemote: "Keep remote", keepLocal: "Keep local" },
  zh: { idle: "Git Sync", syncing: "Git Sync：同步中", success: "Git Sync：同步成功", resolve: "点击处理", warning: "上次同步失败，后续同步正常触发", reload: "处理问题后重新启用插件", retry: "重试", keepRemote: "保持远程", keepLocal: "保持本地" },
};
const errors: Record<ErrorCode, [string, string]> = {
  config: ["Cannot read config.json or its values are invalid", "config.json 无法读取或配置值无效"],
  git: ["System Git is unavailable", "系统 Git 不可用"],
  lfs: ["Git LFS or binary tracking is unavailable", "Git LFS 或二进制跟踪规则不可用"],
  root: ["Vault must be the Git repository root", "Vault 必须是 Git 仓库根目录"],
  upstream: ["A valid remote upstream is required", "当前分支必须配置有效的远程 upstream"],
  branch: ["Detached HEAD or backup branch", "当前处于分离 HEAD 或备份分支"],
  unfinished: ["An existing Git operation is unfinished", "仓库已有未完成的 Git 操作"],
  staged: ["Existing staged changes require manual handling", "已有暂存内容，请先手动处理"],
  size: ["A staged file exceeds the configured limit", "暂存文件超过配置上限"],
  conflict: ["History conflict needs a repository-wide choice", "历史冲突，需要选择整个仓库的版本"],
  rejected: ["Remote advanced; push rejected", "远程已更新，推送被拒绝"],
  network: ["Remote access, authentication or push failed", "远程访问、认证或推送失败"],
  backup: ["Backup upload failed; replacement stopped", "备份上传失败，已停止替换内容"],
  changed: ["Files or repository configuration changed during sync", "同步期间文件或仓库配置发生变化"],
  locked: ["Repository is locked; inspect existing Git processes", "仓库被锁定，请检查正在运行的 Git 进程"],
  interrupted: ["Previous operation is incomplete", "上次操作未完成"],
  unsupported: ["Unsupported Git version, repository, file type or path collision", "不支持的 Git 版本、仓库、文件类型或路径冲突"],
  cancelled: ["Sync cancelled", "同步已取消"],
  operation: ["Git operation failed; inspect Git identity, hooks, signing and permissions", "Git 操作失败，请检查身份、钩子、签名和权限"],
};

export default class CustomGitSyncPlugin extends Plugin {
  private enabled = false;
  private openFiles = new Set<string>();
  private button?: HTMLElement;
  private task?: AbortController;
  private animation?: Animation;
  private state: SyncState = "idle";
  private menu?: Menu;
  private engine?: GitSyncEngine;
  private failure?: SyncError;
  private manualRetry?: SyncDetails;
  private config: SyncConfig = DEFAULT_CONFIG;
  private zh(): boolean { return getLanguage().toLowerCase().startsWith("zh"); }
  private t(key: keyof typeof messages.en): string { return messages[this.zh() ? "zh" : "en"][key]; }
  private errorLabel(): string {
    const error = this.failure ?? new SyncError("operation");
    const files = error.files?.map(file => `${file.path} (${(file.bytes / 1024 / 1024).toFixed(2)} MiB)`).join("; ");
    const limit = error.code === "size" ? ` (${this.config.maxFileMiB} MiB)` : "";
    const action = this.state === "warning" ? "warning" : this.engine ? "resolve" : "reload";
    return `Git Sync: ${errors[error.code][this.zh() ? 1 : 0]}${limit}${files ? ` — ${files}` : ""} — ${this.t(action)}`;
  }
  private render(): void {
    if (!this.button) return;
    const icons: Record<SyncState, string> = { idle: "refresh-cw", syncing: "refresh-cw", success: "check", warning: "triangle-alert", error: "x" };
    setIcon(this.button, icons[this.state]);
    this.button.style.removeProperty("color");
    if (this.state === "warning" || this.state === "error" || this.state === "success") {
      this.button.style.setProperty("color", `var(--text-${this.state})`);
    }
    const label = this.state === "warning" || this.state === "error" ? this.errorLabel() : this.t(this.state);
    setTooltip(this.button, label, { placement: "top" }); this.button.setAttribute("aria-label", label);
    if (this.task) this.button.setAttribute("aria-busy", "true"); else this.button.removeAttribute("aria-busy");
  }
  private activate(): void {
    if (!this.engine) return;
    if (this.state !== "error") { this.trigger("onClick"); return; }
    if (!this.button || this.menu) return;
    const menu = new Menu(); this.menu = menu;
    menu.addItem(item => item.setTitle(this.t("retry")).setIcon("refresh-cw").onClick(() => {
      menu.hide();
      if (this.enabled && this.state === "error") this.trigger("onRetry", this.manualRetry);
    }));
    const choose = (strategy: "local" | "remote"): void => {
      menu.hide();
      if (this.enabled && this.state === "error" && this.failure?.resolvable) this.trigger("onResolve", { strategy, reason: this.failure.code });
    };
    if (this.failure?.resolvable) {
      menu.addItem(item => item.setTitle(this.t("keepRemote")).setIcon("cloud").onClick(() => choose("remote")));
      menu.addItem(item => item.setTitle(this.t("keepLocal")).setIcon("hard-drive").onClick(() => choose("local")));
    }
    menu.onHide(() => { if (this.menu === menu) this.menu = undefined; });
    const rect = this.button.getBoundingClientRect(); menu.showAtPosition({ x: rect.left, y: rect.top });
  }
  private log(event: string, details?: unknown): void {
    const message = `[Custom Git Sync] ${event} at ${new Date().toISOString()}`;
    if (details === undefined) console.log(message); else console.log(message, details);
  }
  private trigger(event: SyncEvent, details?: SyncDetails): void { this.log(event, details); void this.sync(event, details); }
  private sleep(signal: AbortSignal): Promise<void> {
    return new Promise(resolve => {
      const done = (): void => { window.clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
      const timer = window.setTimeout(done, this.config.successDisplayMs); signal.addEventListener("abort", done, { once: true });
      if (signal.aborted) done();
    });
  }
  private async sync(event: SyncEvent, details?: SyncDetails): Promise<void> {
    if (this.task) { this.log("Sync dropped (busy)", { event }); return; }
    if (this.state === "error" && event !== "onRetry" && !(event === "onResolve" && details?.strategy && this.failure?.resolvable)) {
      this.log("Sync dropped (error state)", { event }); return;
    }
    if (!this.enabled || !this.button || !this.engine) return;
    const task = new AbortController(); this.task = task;
    this.menu?.hide(); this.state = "syncing"; this.failure = undefined; this.manualRetry = undefined;
    const button = this.button;
    this.render();
    const icon = button.querySelector("svg");
    if (icon) this.animation = icon.animate([{ transform: "rotate(0deg)" }, { transform: "rotate(360deg)" }], { duration: 1000, iterations: Infinity, easing: "linear" });
    try {
      await this.engine.run(event, details, task.signal);
      if (task.signal.aborted) return;
      this.animation?.cancel(); this.animation = undefined;
      this.state = "success"; this.render();
      this.log("Sync succeeded", { event }); await this.sleep(task.signal);
      this.state = "idle";
    } catch (error) {
      if (task.signal.aborted) { this.state = "idle"; this.log("Sync cancelled", { event }); }
      else {
        this.failure = error instanceof SyncError ? error : new SyncError("operation");
        this.state = this.failure.transient ? "warning" : "error";
        if (this.state === "error") this.manualRetry = { ...details, retryOf: event === "onRetry" ? details?.retryOf ?? "onClick" : event };
        this.log("Sync failed", { event, code: this.failure.code, transient: this.failure.transient, resolvable: this.failure.resolvable, files: this.failure.files });
      }
    } finally {
      this.animation?.cancel(); this.animation = undefined;
      if (this.task === task) this.task = undefined;
      if (this.enabled && this.button === button) this.render();
    }
  }
  private collectOpenFiles(): Set<string> {
    const files = new Set<string>();
    this.app.workspace.iterateAllLeaves(leaf => { if (leaf.view instanceof FileView && leaf.view.file) files.add(leaf.view.file.path); });
    return files;
  }
  async onload(): Promise<void> {
    this.enabled = true; this.state = "idle";
    const adapter = this.app.vault.adapter;
    const button = this.addStatusBarItem(); this.button = button;
    button.addClass("mod-clickable"); button.setAttribute("role", "button"); button.setAttribute("tabindex", "0");
    this.render();
    this.registerDomEvent(button, "click", () => this.activate());
    this.registerDomEvent(button, "keydown", (event: KeyboardEvent) => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); if (!event.repeat) this.activate(); }
    });
    try {
      this.config = await loadConfig(adapter, this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`);
      if (!this.enabled) return;
      if (!(adapter instanceof FileSystemAdapter)) throw new SyncError("root");
      this.engine = new GitSyncEngine(adapter.getBasePath(), (event, details) => this.log(event, details), undefined, this.config);
    } catch (error) {
      if (!this.enabled) return;
      this.failure = error instanceof SyncError ? error : new SyncError("operation"); this.state = "error";
      this.log("Plugin initialization failed", { code: this.failure.code }); this.render(); return;
    }
    this.registerInterval(window.setInterval(() => this.trigger("onCron"), this.config.syncIntervalSeconds * 1000));
    this.registerEvent(this.app.workspace.on("file-open", file => this.trigger("onOpen", { path: file?.path ?? null, source: "workspace:file-open" })));
    this.registerEvent(this.app.vault.on("modify", file => { if (file instanceof TFile) this.trigger("onSave", { path: file.path, source: "vault:modify" }); }));
    this.app.workspace.onLayoutReady(() => {
      if (!this.enabled) return;
      this.openFiles = this.collectOpenFiles();
      this.registerEvent(this.app.workspace.on("layout-change", () => {
        const current = this.collectOpenFiles();
        for (const file of this.openFiles) if (!current.has(file)) this.trigger("onClose", { path: file, source: "last file view removed" });
        this.openFiles = current;
      }));
    });
    this.trigger("onLoad");
  }
  onunload(): void {
    this.log("onUnload"); this.enabled = false; this.menu?.hide(); this.task?.abort(); this.animation?.cancel();
    this.openFiles.clear(); this.button = undefined;
  }
}
