import { FileSystemAdapter, FileView, Menu, Plugin, TFile, setIcon, setTooltip } from "obsidian";
import { GitSyncEngine, type SyncDetails, type SyncEvent } from "./sync";
import { SyncError, type ErrorCode } from "./git";
import { DEFAULT_CONFIG, loadConfig, type SyncConfig } from "./config";
import { errorText, t } from "./i18n";

type SyncState = "idle" | "syncing" | "success" | "warning" | "error";
const PLACEBO_SPIN_MS = 600;
// 只有这些错误会暂停普通事件；其余失败不阻塞，本地快照照常进行
const BLOCKING: ErrorCode[] = ["config", "repo", "refused", "conflict"];
const SAVE_CALLBACKS = ["callback", "checkCallback", "editorCallback", "editorCheckCallback"] as const;
type SaveCommand = Partial<Record<typeof SAVE_CALLBACKS[number], (...args: unknown[]) => unknown>>;

export default class OhMyGitPlugin extends Plugin {
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
  private failures = 0;
  private blocked(): boolean {
    return this.state === "error" && !!this.failure && BLOCKING.includes(this.failure.code);
  }
  private errorLabel(): string {
    const error = this.failure ?? new SyncError("failed");
    const files = error.files?.map(file => `${file.path} (${(file.bytes / 1024 / 1024).toFixed(2)} MiB)`).join("; ");
    const limit = error.code === "size" ? ` (${this.config.maxFileMiB} MiB)` : "";
    // size 时同步其实已成功，不追加失败说明
    const action = error.code === "size" ? "" : this.state === "warning" ? t("warning")
      : !this.blocked() ? `${t("repeated")} (${this.failures})` : t(this.engine ? "resolve" : "reload");
    return `Git Sync: ${errorText(error.code)}${limit}${files ? ` — ${files}` : ""}${action ? ` — ${action}` : ""}`;
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
    const message = `[Oh My Git] ${event} at ${new Date().toISOString()}`;
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
    if (!this.enabled || this.task || this.state !== "idle") {
      this.log("Placebo skipped", { enabled: this.enabled, busy: !!this.task, state: this.state });
      return;
    }
    this.log("Placebo save feedback");
    this.state = "syncing"; this.render(); this.spin();
    this.placeboTimer = window.setTimeout(() => {
      this.animation?.cancel(); this.animation = undefined;
      this.state = "success"; this.render();
      this.placeboTimer = window.setTimeout(() => { this.placeboTimer = undefined; this.state = "idle"; this.render(); }, this.config.successDisplayMs);
    }, PLACEBO_SPIN_MS);
  }
  // 方案 A（default）：Obsidian 快捷键系统在 window 捕获阶段处理 Mod+S 并 stopPropagation，事件到不了 document；
  // 同一 window 上的其他监听器不受影响。只观察不拦截；弹出窗口有各自的 window，打开时同样注册
  private listenSaveKey(): void {
    // 同时匹配物理键位 KeyS，兼容输入法（key 为 "Process"）和非 QWERTY 布局
    const onKey = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey) || (event.code !== "KeyS" && event.key?.toLowerCase() !== "s")) return;
      this.log("Save shortcut detected", { key: event.key, code: event.code, repeat: event.repeat, state: this.state, busy: !!this.task });
      if (!event.repeat) this.placebo();
    };
    this.registerDomEvent(window, "keydown", onKey, { capture: true });
    this.registerEvent(this.app.workspace.on("window-open", (_, win) => this.registerDomEvent(win, "keydown", onKey, { capture: true })));
    this.log("Placebo listening to save shortcut", { mode: "default" });
  }
  // 方案 B（hidden）：包装内部命令 editor:save-file（未公开 API），覆盖快捷键、命令面板和自定义快捷键。
  // 先执行原逻辑再显示安慰剂；卸载时若包装仍在最外层才恢复，避免覆盖其他插件的包装
  private hookSaveCommand(): void {
    const registry = (this.app as unknown as { commands?: { commands?: Record<string, SaveCommand> } }).commands?.commands;
    const command = registry?.["editor:save-file"];
    if (!command) { this.log("Save command not found; placebo disabled", { mode: "hidden" }); return; }
    const hooked: string[] = [];
    for (const key of SAVE_CALLBACKS) {
      const original = command[key];
      if (typeof original !== "function") continue;
      // check 系列回调的首参 checking 为 true 时只是询问命令是否可用，不算保存
      const checking = key === "checkCallback" || key === "editorCheckCallback";
      const wrapped = (...args: unknown[]): unknown => {
        const result = original.apply(command, args);
        if (!(checking && args[0] === true)) {
          this.log("Save command executed", { via: key, state: this.state, busy: !!this.task });
          this.placebo();
        }
        return result;
      };
      command[key] = wrapped;
      this.register(() => { if (command[key] === wrapped) command[key] = original; });
      hooked.push(key);
    }
    this.log("Placebo hooked save command", { mode: "hidden", callbacks: hooked });
  }
  private async sync(event: SyncEvent, details?: SyncDetails): Promise<void> {
    if (this.task) { this.log("Sync dropped (busy)", { event }); return; }
    if (this.blocked() && event !== "onRetry" && !(event === "onResolve" && details?.strategy && this.failure?.code === "conflict")) {
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
      const { skipped } = await this.engine.run(event, details, task.signal);
      if (task.signal.aborted) return;
      this.animation?.cancel(); this.animation = undefined;
      this.failures = 0;
      if (skipped.length) {
        // 同步成功但跳过了超限文件：提示但不阻塞
        this.failure = new SyncError("size", undefined, skipped); this.state = "warning";
        this.log("Sync succeeded with oversized files skipped", { event, files: skipped });
        return;
      }
      this.state = "success"; this.render();
      this.log("Sync succeeded", { event }); await this.sleep(task.signal);
      this.state = "idle";
    } catch (error) {
      if (task.signal.aborted) { this.state = "idle"; this.log("Sync cancelled", { event }); }
      else {
        this.failure = error instanceof SyncError ? error : new SyncError("failed", String(error));
        if (BLOCKING.includes(this.failure.code)) this.state = "error";
        else this.state = ++this.failures >= this.config.escalateAfterFailures ? "error" : "warning";
        this.log("Sync failed", { event, code: this.failure.code, message: this.failure.message, failures: this.failures });
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
    // 改名立即单独提交，不走防抖：避免与后续编辑合并，保证 git log --follow 可追溯
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => this.trigger("onRename", { path: file.path, source: `vault:rename from ${oldPath}` })));
    this.app.workspace.onLayoutReady(() => {
      if (!this.enabled) return;
      // 布局就绪后核心命令已全部注册
      if (this.config.placeboMode === "hidden") this.hookSaveCommand(); else this.listenSaveKey();
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
