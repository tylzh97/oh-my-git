import { FileSystemAdapter, FileView, Menu, Plugin, TFile, setIcon, setTooltip } from "obsidian";
import { GitSyncEngine, type SyncDetails, type SyncEvent } from "./sync";
import { SyncError } from "./git";
import { DEFAULT_CONFIG, loadConfig, type SyncConfig } from "./config";
import { errorText, t } from "./i18n";

type SyncState = "idle" | "syncing" | "success" | "warning" | "error";
const PLACEBO_SPIN_MS = 600;

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
  private config: SyncConfig = DEFAULT_CONFIG;
  private saveTimer?: number;
  private placeboTimer?: number;
  private errorLabel(): string {
    const error = this.failure ?? new SyncError("failed");
    const files = error.files?.map(file => `${file.path} (${(file.bytes / 1024 / 1024).toFixed(2)} MiB)`).join("; ");
    const limit = error.code === "size" ? ` (${this.config.maxFileMiB} MiB)` : "";
    const action = this.state === "warning" ? "warning" : this.engine ? "resolve" : "reload";
    return `Git Sync: ${errorText(error.code)}${limit}${files ? ` — ${files}` : ""} — ${t(action)}`;
  }
  private render(): void {
    if (!this.button) return;
    const icons: Record<SyncState, string> = { idle: "refresh-cw", syncing: "refresh-cw", success: "check", warning: "triangle-alert", error: "x" };
    setIcon(this.button, icons[this.state]);
    this.button.style.removeProperty("color");
    if (this.state === "warning" || this.state === "error" || this.state === "success") {
      this.button.style.setProperty("color", `var(--text-${this.state})`);
    }
    const label = this.state === "warning" || this.state === "error" ? this.errorLabel() : t(this.state);
    setTooltip(this.button, label, { placement: "top" }); this.button.setAttribute("aria-label", label);
    if (this.task) this.button.setAttribute("aria-busy", "true"); else this.button.removeAttribute("aria-busy");
  }
  private activate(): void {
    if (!this.engine) return;
    if (this.state !== "error") { this.trigger("onClick"); return; }
    if (!this.button || this.menu) return;
    const menu = new Menu(); this.menu = menu;
    menu.addItem(item => item.setTitle(t("retry")).setIcon("refresh-cw").onClick(() => {
      menu.hide();
      if (this.enabled && this.state === "error") this.trigger("onRetry");
    }));
    const choose = (strategy: "local" | "remote"): void => {
      menu.hide();
      if (this.enabled && this.state === "error" && this.failure?.code === "conflict") this.trigger("onResolve", { strategy, reason: this.failure.code });
    };
    if (this.failure?.code === "conflict") {
      menu.addItem(item => item.setTitle(t("keepRemote")).setIcon("cloud").onClick(() => choose("remote")));
      menu.addItem(item => item.setTitle(t("keepLocal")).setIcon("hard-drive").onClick(() => choose("local")));
    }
    menu.onHide(() => { if (this.menu === menu) this.menu = undefined; });
    const rect = this.button.getBoundingClientRect(); menu.showAtPosition({ x: rect.left, y: rect.top });
  }
  private log(event: string, details?: unknown): void {
    const message = `[Custom Git Sync] ${event} at ${new Date().toISOString()}`;
    if (details === undefined) console.log(message); else console.log(message, details);
  }
  private trigger(event: SyncEvent, details?: SyncDetails): void { this.log(event, details); void this.sync(event, details); }
  // modify 只重置计时器，静默期满后才触发一次 onSave
  private scheduleSave(path: string): void {
    window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = undefined;
      this.trigger("onSave", { path, source: "vault:modify" });
    }, this.config.saveDebounceSeconds * 1000);
  }
  private sleep(signal: AbortSignal): Promise<void> {
    return new Promise(resolve => {
      const done = (): void => { window.clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
      const timer = window.setTimeout(done, this.config.successDisplayMs); signal.addEventListener("abort", done, { once: true });
      if (signal.aborted) done();
    });
  }
  private spin(): void {
    this.animation?.cancel();
    this.animation = this.button?.querySelector("svg")?.animate([{ transform: "rotate(0deg)" }, { transform: "rotate(360deg)" }], { duration: 1000, iterations: Infinity, easing: "linear" });
  }
  // Ctrl/Cmd+S 的安慰剂：只转圈并显示成功，不执行 Git；仅在待机时响应，不掩盖 ! 和 ×
  private placebo(): void {
    if (!this.enabled || this.task || this.state !== "idle") return;
    this.log("Placebo save feedback");
    this.state = "syncing"; this.render(); this.spin();
    this.placeboTimer = window.setTimeout(() => {
      this.animation?.cancel(); this.animation = undefined;
      this.state = "success"; this.render();
      this.placeboTimer = window.setTimeout(() => { this.placeboTimer = undefined; this.state = "idle"; this.render(); }, this.config.successDisplayMs);
    }, PLACEBO_SPIN_MS);
  }
  private async sync(event: SyncEvent, details?: SyncDetails): Promise<void> {
    if (this.task) { this.log("Sync dropped (busy)", { event }); return; }
    if (this.state === "error" && event !== "onRetry" && !(event === "onResolve" && details?.strategy && this.failure?.code === "conflict")) {
      this.log("Sync dropped (error state)", { event }); return;
    }
    if (!this.enabled || !this.button || !this.engine) return;
    const task = new AbortController(); this.task = task;
    // 本次同步提交整个仓库，已包含待同步的保存
    window.clearTimeout(this.saveTimer); this.saveTimer = undefined;
    // 真实同步接管状态栏
    window.clearTimeout(this.placeboTimer); this.placeboTimer = undefined;
    this.menu?.hide(); this.state = "syncing"; this.failure = undefined;
    const button = this.button;
    this.render(); this.spin();
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
        this.failure = error instanceof SyncError ? error : new SyncError("failed", String(error));
        this.state = this.failure.code === "failed" ? "warning" : "error";
        this.log("Sync failed", { event, code: this.failure.code, message: this.failure.message, files: this.failure.files });
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
      if (!(adapter instanceof FileSystemAdapter)) throw new SyncError("repo", "Vault is not on the local file system");
      this.engine = new GitSyncEngine(adapter.getBasePath(), (event, details) => this.log(event, details), undefined, this.config);
    } catch (error) {
      if (!this.enabled) return;
      this.failure = error instanceof SyncError ? error : new SyncError("config", String(error)); this.state = "error";
      this.log("Plugin initialization failed", { code: this.failure.code, message: this.failure.message }); this.render(); return;
    }
    this.registerInterval(window.setInterval(() => this.trigger("onCron"), this.config.syncIntervalSeconds * 1000));
    this.registerEvent(this.app.workspace.on("file-open", file => this.trigger("onOpen", { path: file?.path ?? null, source: "workspace:file-open" })));
    this.registerEvent(this.app.vault.on("modify", file => { if (file instanceof TFile) this.scheduleSave(file.path); }));
    // 不拦截按键，Obsidian 自己的保存照常执行
    this.registerDomEvent(document, "keydown", (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s" && !event.repeat) this.placebo();
    });
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
    this.log("onUnload"); this.enabled = false; window.clearTimeout(this.saveTimer); window.clearTimeout(this.placeboTimer); this.menu?.hide(); this.task?.abort(); this.animation?.cancel();
    this.openFiles.clear(); this.button = undefined;
  }
}
