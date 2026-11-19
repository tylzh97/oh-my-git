import { FileSystemAdapter, Menu, Plugin, TFile, setIcon, setTooltip } from "obsidian";
import { GitSyncEngine, type SyncDetails, type SyncEvent } from "./sync";
import { SyncError, type ErrorCode } from "./git";
import { DEFAULT_CONFIG, loadConfig, type SyncConfig } from "./config";
import { errorText, t } from "./i18n";

type SyncState = "idle" | "syncing" | "success" | "warning" | "error";
const MANUAL_SAVE_DEBOUNCE_MS = 500;
// 只有这些错误会暂停普通事件；其余失败不阻塞，本地快照照常进行
const BLOCKING: ErrorCode[] = ["config", "repo", "refused", "conflict", "nogit", "nolfs"];
const SAVE_CALLBACKS = ["callback", "checkCallback", "editorCallback", "editorCheckCallback"] as const;
type SaveCommand = Partial<Record<typeof SAVE_CALLBACKS[number], (...args: unknown[]) => unknown>>;

export default class OhMyGitPlugin extends Plugin {
  private enabled = false;
  private button?: HTMLElement;
  private task?: AbortController;
  // 待处理的同步请求；due 是最早可开始的时间（手动保存的前防抖），0 表示不额外等待
  private pending?: { event: SyncEvent; details?: SyncDetails; due: number };
  private cooldownUntil = 0;
  private syncTimer?: number;
  private animation?: Animation;
  private state: SyncState = "idle";
  private menu?: Menu;
  private engine?: GitSyncEngine;
  private failure?: SyncError;
  private config: SyncConfig = DEFAULT_CONFIG;
  private saveTimer?: number;
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
      if (this.enabled && this.state === "error" && this.failure?.code === "conflict") this.trigger("onResolve", { strategy });
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
  // due：最早可开始的时间，仅手动保存的前防抖使用
  private trigger(event: SyncEvent, details?: SyncDetails, due = 0): void { this.log(event, details); void this.sync(event, details, due); }
  // modify 只重置计时器，静默期满后才触发一次 onSave
  private scheduleSave(path: string): void {
    window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = undefined;
      this.trigger("onSave", { path, source: "vault:modify" });
    }, this.config.saveDebounceSeconds * 1000);
  }
  // 手动保存只登记请求；原始保存仍由 Obsidian 完成。
  private scheduleManualSave(): void {
    if (!this.enabled || !this.engine || this.blocked()) return;
    this.trigger("onManualSave", { source: "save-command" }, Date.now() + MANUAL_SAVE_DEBOUNCE_MS);
  }
  private canSync(event: SyncEvent, details?: SyncDetails): boolean {
    return !this.blocked() || event === "onRetry"
      || (event === "onResolve" && !!details?.strategy && this.failure?.code === "conflict");
  }
  private queueSync(event: SyncEvent, details?: SyncDetails, due = 0): void {
    const explicit = (e?: SyncEvent): boolean => e === "onRetry" || e === "onResolve";
    const old = this.pending;
    // 重试和选边保留原意；其余事件合并为一次完整同步，排过手动保存就保持为手动保存。
    let next: { event: SyncEvent; details?: SyncDetails };
    if (explicit(event)) next = { event, details };
    else if (old && explicit(old.event)) next = { event: old.event, details: old.details };
    else if (event === "onManualSave" || old?.event === "onManualSave") next = { event: "onManualSave", details: { source: "save-command" } };
    else next = { event: "onCron" };
    // 前防抖只会推迟：后到的请求不能让已登记的手动保存提前
    this.pending = { ...next, due: Math.max(due, old?.due ?? 0) };
    this.log("Sync queued", { event });
    this.schedulePending();
  }
  // 一个计时器同时负责成功展示结束、前防抖和后防抖。
  private schedulePending(): void {
    window.clearTimeout(this.syncTimer); this.syncTimer = undefined;
    if (!this.enabled || this.task) return;
    const now = Date.now();
    if (this.state === "success" && now >= this.cooldownUntil) { this.state = "idle"; this.render(); }
    if (this.pending && !this.canSync(this.pending.event, this.pending.details)) this.pending = undefined;
    const due = Math.max(this.pending?.due ?? 0, this.cooldownUntil);
    if (this.pending && now >= due) {
      const pending = this.pending;
      this.pending = undefined;
      this.trigger(pending.event, pending.details);
      return;
    }
    let next = this.pending ? due : Infinity;
    if (this.state === "success") next = Math.min(next, this.cooldownUntil);
    if (Number.isFinite(next)) {
      this.syncTimer = window.setTimeout(() => { this.syncTimer = undefined; this.schedulePending(); }, Math.max(0, next - now));
    }
  }
  private spin(): void {
    this.animation?.cancel();
    this.animation = this.button?.querySelector("svg")?.animate([{ transform: "rotate(0deg)" }, { transform: "rotate(360deg)" }], { duration: 1000, iterations: Infinity, easing: "linear" });
  }
  // 方案 A（keydown）：Obsidian 快捷键系统在 window 捕获阶段处理 Mod+S 并 stopPropagation，事件到不了 document；
  // 同一 window 上的其他监听器不受影响。只观察不拦截；弹出窗口有各自的 window，打开时同样注册
  private listenSaveKey(): void {
    // 同时匹配物理键位 KeyS，兼容输入法（key 为 "Process"）和非 QWERTY 布局
    const onKey = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey) || (event.code !== "KeyS" && event.key?.toLowerCase() !== "s")) return;
      this.log("Save shortcut detected", { key: event.key, code: event.code, repeat: event.repeat, state: this.state, busy: !!this.task });
      if (!event.repeat) this.scheduleManualSave();
    };
    this.registerDomEvent(window, "keydown", onKey, { capture: true });
    this.registerEvent(this.app.workspace.on("window-open", (_, win) => this.registerDomEvent(win, "keydown", onKey, { capture: true })));
    this.log("Listening to save shortcut", { mode: "keydown" });
  }
  // 方案 B（command）：包装内部命令 editor:save-file（未公开 API），覆盖快捷键、命令面板和自定义快捷键。
  // 先执行原逻辑，完成后登记同步请求；卸载时若包装仍在最外层才恢复，避免覆盖其他插件的包装
  private hookSaveCommand(): void {
    const registry = (this.app as unknown as { commands?: { commands?: Record<string, SaveCommand> } }).commands?.commands;
    const command = registry?.["editor:save-file"];
    if (!command) { this.log("Save command not found; manual sync shortcut disabled", { mode: "command" }); return; }
    const hooked: string[] = [];
    for (const key of SAVE_CALLBACKS) {
      const original = command[key];
      if (typeof original !== "function") continue;
      // check 系列回调的首参 checking 为 true 时只是询问命令是否可用，不算保存
      const checking = key === "checkCallback" || key === "editorCheckCallback";
      const wrapped = (...args: unknown[]): unknown => {
        const result = original.apply(command, args);
        if (!(checking && (args[0] === true || result === false))) {
          const saved = (): void => {
            this.log("Save command executed", { via: key, state: this.state, busy: !!this.task });
            this.scheduleManualSave();
          };
          // 保留原返回值；异步保存失败不触发同步。
          if (result && typeof (result as PromiseLike<unknown>).then === "function") {
            void Promise.resolve(result).then(saved, error => this.log("Save command failed", String(error)));
          } else saved();
        }
        return result;
      };
      command[key] = wrapped;
      this.register(() => { if (command[key] === wrapped) command[key] = original; });
      hooked.push(key);
    }
    this.log("Hooked save command", { mode: "command", callbacks: hooked });
  }
  private async sync(event: SyncEvent, details?: SyncDetails, due = 0): Promise<void> {
    if (!this.enabled || !this.button || !this.engine) return;
    if (!this.canSync(event, details)) {
      this.log("Sync dropped (error state)", { event }); return;
    }
    if (this.task || this.pending || due || Date.now() < this.cooldownUntil) {
      this.queueSync(event, details, due); return;
    }
    const task = new AbortController(); this.task = task;
    window.clearTimeout(this.syncTimer); this.syncTimer = undefined;
    // 本次同步提交整个仓库，已包含待同步的保存
    window.clearTimeout(this.saveTimer); this.saveTimer = undefined;
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
      this.log("Sync succeeded", { event });
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
      this.cooldownUntil = Date.now() + this.config.successDisplayMs;
      if (this.enabled && this.button === button) this.render();
      this.schedulePending();
    }
  }
  // 核心插件「日记」的目录；读不到或位于 Vault 根目录时返回 ""，引擎不做 onLoad 旧空日记清理
  private async diaryDir(): Promise<string> {
    const text = await this.app.vault.adapter.read(`${this.app.vault.configDir}/daily-notes.json`).catch(() => "");
    try { return String(JSON.parse(text).folder ?? "").replace(/^\/+|\/+$/g, ""); } catch { return ""; }
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
      const diaryDir = await this.diaryDir();
      if (!this.enabled) return;
      this.log("Diary folder", { diaryDir });
      this.engine = new GitSyncEngine(adapter.getBasePath(), (event, details) => this.log(event, details), undefined, this.config, diaryDir);
    } catch (error) {
      if (!this.enabled) return;
      this.failure = error instanceof SyncError ? error : new SyncError("config", String(error)); this.state = "error";
      this.log("Plugin initialization failed", { code: this.failure.code, message: this.failure.message }); this.render(); return;
    }
    this.registerInterval(window.setInterval(() => this.trigger("onCron"), this.config.syncIntervalSeconds * 1000));
    this.registerEvent(this.app.vault.on("modify", file => { if (file instanceof TFile) this.scheduleSave(file.path); }));
    // 改名绕过自动保存防抖；忙时或前后防抖窗口内仍合并排队
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => this.trigger("onRename", { path: file.path, source: `vault:rename from ${oldPath}` })));
    this.app.workspace.onLayoutReady(() => {
      if (!this.enabled) return;
      // 布局就绪后核心命令已全部注册
      if (this.config.saveHook === "command") this.hookSaveCommand(); else this.listenSaveKey();
    });
    this.trigger("onLoad");
  }
  onunload(): void {
    this.log("onUnload");
    this.enabled = false;
    this.pending = undefined;
    window.clearTimeout(this.saveTimer);
    window.clearTimeout(this.syncTimer);
    this.menu?.hide();
    this.task?.abort();
    this.animation?.cancel();
    this.button = undefined;
  }
}
