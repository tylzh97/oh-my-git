const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');

let language = 'zh', icon, tooltip, color, intervalMs, cron;
const logs = [], requests = [];
class Menu {
  items = [];
  addItem(callback) {
    const item = {
      setTitle(title) { this.title = title; return this; }, setIcon() { return this; },
      onClick(fn) { this.click = fn; return this; },
    };
    callback(item); this.items.push(item); return this;
  }
  onHide(fn) { this.hidden = fn; }
  hide() { this.hidden?.(); }
  showAtPosition() {}
}
class FileSystemAdapter {
  async exists() { return false; }
  async read() { return '{}'; }
  getBasePath() { return 'test-vault-unused'; }
}
const button = {
  addClass() {}, setAttribute() {}, removeAttribute() {},
  style: { removeProperty() { color = undefined; }, setProperty(_, value) { color = value; } },
  querySelector() { return { animate() { return { cancel() {} }; } }; },
  getBoundingClientRect() { return { left: 0, top: 0 }; },
};
const sdk = {
  Plugin: class {}, FileSystemAdapter, FileView: class {}, TFile: class {}, Menu,
  getLanguage() { return language; }, setIcon(_, value) { icon = value; }, setTooltip(_, value) { tooltip = value; },
};
const context = {
  module: { exports: {} }, require(name) { return name === 'obsidian' ? sdk : require(name); }, process,
  console: { log(...args) { logs.push(args); } },
  window: { setTimeout, clearTimeout, setInterval(fn, ms) { intervalMs = ms; cron = fn; return 123; } },
  AbortController, Date, document: {},
};
vm.runInNewContext(fs.readFileSync('dist/main.js', 'utf8'), context);
const Plugin = context.module.exports.default;
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const ok = { skipped: [] };
function plugin() {
  const p = new Plugin(); p.enabled = true; p.button = button;
  p.config = { ...p.config, successDisplayMs: 0 };
  return p;
}
function startup(adapter, manifest = { id: 'custom-git-sync', dir: '.custom/plugins/renamed' }) {
  const p = new Plugin(); p.manifest = manifest; p.vaultEvents = {}; p.workspaceEvents = {}; p.keyTargets = []; p.cleanups = [];
  // 模拟 Obsidian 内部命令表中的保存命令
  p.saveCalls = []; p.saveCommand = { id: 'editor:save-file', checkCallback(checking) { p.saveCalls.push(checking); return true; } };
  p.app = {
    vault: { adapter, configDir: '.custom', on(name, fn) { p.vaultEvents[name] = fn; return {}; } },
    workspace: { on(name, fn) { p.workspaceEvents[name] = fn; return {}; }, onLayoutReady(fn) { fn(); }, iterateAllLeaves() {} },
    commands: { commands: { 'editor:save-file': p.saveCommand } },
  };
  p.addStatusBarItem = () => button;
  p.registerEvent = p.registerInterval = () => {};
  p.register = fn => p.cleanups.push(fn);
  p.registerDomEvent = (target, type, fn, options) => {
    if (type !== 'keydown' || target === button) return;
    p.keyTargets.push({ target, capture: options?.capture }); p.saveKey = fn;
  };
  // Test initialization without launching Git against an actual Vault.
  p.trigger = (event, details) => requests.push({ event, details });
  return p;
}

(async () => {
  const p = plugin();
  p.engine = { async run(event, details) { requests.push({ event, details }); throw new Error('failure'); } };
  await p.sync('onLoad'); assert.equal(icon, 'triangle-alert'); assert.equal(p.state, 'warning');
  const SyncError = p.failure.constructor;
  p.engine = { async run(event, details) { requests.push({ event, details }); throw new SyncError('refused', 'pre-receive hook declined'); } };
  await p.sync('onLoad'); assert.equal(icon, 'x'); assert.equal(p.state, 'error');
  assert.ok(tooltip.includes('远程拒绝推送'));
  const blocked = requests.length;
  for (const event of ['onClick', 'onLoad', 'onOpen', 'onSave', 'onClose', 'onCron']) await p.sync(event);
  assert.equal(requests.length, blocked);
  p.activate(); assert.deepEqual(p.menu.items.map(item => item.title), ['重试']);
  p.menu.items[0].click(); await tick(); assert.equal(requests.at(-1).event, 'onRetry');
  assert.equal(requests.at(-1).details, undefined); assert.equal(p.state, 'error');

  p.state = 'idle';
  p.engine = { async run(event, details) { requests.push({ event, details }); throw new SyncError('conflict'); } };
  await p.sync('onSave'); p.activate();
  assert.deepEqual(p.menu.items.map(item => item.title), ['重试', '保持远程', '保持本地']);
  p.menu.items[1].click(); await tick(); assert.equal(requests.at(-1).details.strategy, 'remote');
  p.activate(); p.menu.items[0].click(); await tick();
  assert.equal(requests.at(-1).event, 'onRetry'); assert.equal(requests.at(-1).details, undefined);
  language = 'en'; p.activate();
  assert.deepEqual(p.menu.items.map(item => item.title), ['Retry', 'Keep remote', 'Keep local']); p.menu.hide();

  language = 'zh'; const w = plugin();
  w.engine = { async run(event, details) { requests.push({ event, details }); throw new SyncError('failed', 'git push: Connection reset'); } };
  await w.sync('onLoad'); assert.equal(w.state, 'warning'); assert.equal(icon, 'triangle-alert');
  assert.equal(color, 'var(--text-warning)'); assert.ok(tooltip.includes('后续同步正常触发'));
  assert.ok(logs.some(args => args[1]?.message === 'git push: Connection reset'));
  for (const event of ['onOpen', 'onSave', 'onClose']) {
    const count = requests.length;
    await w.sync(event);
    assert.equal(requests.length, count + 1); assert.equal(requests.at(-1).event, event); assert.equal(w.state, 'warning');
  }
  language = 'en'; w.render(); assert.ok(tooltip.includes('normal sync remains available'));
  w.activate(); await tick(); assert.equal(requests.at(-1).event, 'onClick'); assert.equal(w.menu, undefined);
  assert.equal(w.state, 'error'); // 第 5 次连续失败
  w.engine = { async run(event, details) { requests.push({ event, details }); return ok; } };
  await w.sync('onCron'); assert.equal(w.state, 'idle'); assert.equal(icon, 'refresh-cw');
  w.engine = { async run(event, details) { requests.push({ event, details }); throw new SyncError('repo'); } };
  await w.sync('onCron'); assert.equal(w.state, 'error'); const stopped = requests.length;
  await w.sync('onCron'); assert.equal(requests.length, stopped);

  // 非阻塞失败（remote/failed）连续 5 次显示 ×，但普通事件仍然执行；成功一次清零
  language = 'zh'; const r = plugin();
  r.engine = { async run(event, details) { requests.push({ event, details }); throw new SyncError('remote', 'git fetch: Could not resolve host'); } };
  for (let i = 1; i <= 4; i++) { await r.sync('onCron'); assert.equal(r.state, 'warning'); }
  r.engine.run = async (event, details) => { requests.push({ event, details }); throw new SyncError('failed'); };
  await r.sync('onOpen'); assert.equal(r.state, 'error'); assert.equal(icon, 'x'); assert.ok(tooltip.includes('连续多次失败') && tooltip.includes('(5)'));
  const escalated = requests.length; await r.sync('onSave'); assert.equal(requests.length, escalated + 1); assert.equal(r.state, 'error');
  r.activate(); assert.deepEqual(r.menu.items.map(item => item.title), ['重试']); r.menu.hide();
  r.engine.run = async (event, details) => { requests.push({ event, details }); return ok; };
  await r.sync('onCron'); assert.equal(r.state, 'idle'); assert.equal(r.failures, 0);
  r.engine.run = async (event, details) => { requests.push({ event, details }); throw new SyncError('remote'); };
  await r.sync('onCron'); assert.equal(r.state, 'warning');

  // 跳过超限文件：同步成功，显示 ! 和文件列表，计数清零，不阻塞
  r.engine.run = async (event, details) => { requests.push({ event, details }); return { skipped: [{ path: 'big.mp4', bytes: 40 * 1024 * 1024 }] }; };
  await r.sync('onCron'); assert.equal(r.state, 'warning'); assert.equal(r.failures, 0);
  assert.ok(tooltip.includes('已跳过') && tooltip.includes('big.mp4 (40.00 MiB)'));
  const sizeCount = requests.length; await r.sync('onSave'); assert.equal(requests.length, sizeCount + 1);

  // 连续保存只在静默期满后触发一次；其他同步开始或卸载时取消
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const d = plugin(); d.config = { ...d.config, saveDebounceSeconds: 0.02 };
  d.engine = { async run(event, details) { requests.push({ event, details }); return ok; } };
  let count = requests.length;
  d.scheduleSave('a.md'); await sleep(10); d.scheduleSave('b.md'); await sleep(10); d.scheduleSave('c.md');
  await sleep(10); assert.equal(requests.length, count);
  await sleep(40); assert.equal(requests.length, count + 1);
  assert.equal(requests.at(-1).event, 'onSave'); assert.equal(requests.at(-1).details.path, 'c.md');
  await sleep(10); count = requests.length;
  d.scheduleSave('d.md'); await d.sync('onClick'); await sleep(40);
  assert.equal(requests.length, count + 1); assert.equal(requests.at(-1).event, 'onClick');
  d.scheduleSave('e.md'); d.onunload(); await sleep(40); assert.equal(requests.length, count + 1);

  const busy = plugin(); busy.config = { ...busy.config, successDisplayMs: 30 };
  let complete;
  busy.engine = { run(event) { requests.push({ event }); return new Promise(resolve => { complete = resolve; }); } };
  const active = busy.sync('onClick'); const busyCount = requests.length;
  await busy.sync('onCron'); assert.equal(requests.length, busyCount);
  complete(ok); await tick(); assert.equal(busy.state, 'success'); assert.equal(icon, 'check');
  await busy.sync('onRetry'); assert.equal(requests.length, busyCount);
  await active; assert.equal(busy.state, 'idle'); busy.onunload(); assert.equal(busy.enabled, false);

  let configPath;
  const adapter = new FileSystemAdapter(); adapter.exists = async file => { configPath = file; return true; };
  adapter.read = async () => '{"syncIntervalSeconds":10,"maxFileMiB":1,"placeboMode":"default"}';
  const loaded = startup(adapter); await loaded.onload();
  assert.equal(configPath, '.custom/plugins/renamed/config.jsonc'); assert.equal(intervalMs, 10000);
  assert.equal(loaded.engine.config.maxFileMiB, 1); assert.equal(requests.at(-1).event, 'onLoad');
  cron(); assert.equal(requests.at(-1).event, 'onCron');
  loaded.vaultEvents.rename({ path: 'new.md' }, 'old.md');
  assert.equal(requests.at(-1).event, 'onRename'); assert.equal(requests.at(-1).details.path, 'new.md');
  assert.equal(requests.at(-1).details.source, 'vault:rename from old.md');

  // Ctrl/Cmd+S 安慰剂：只改状态栏，不调用 engine；! 和 × 下不响应；真实同步可接管
  loaded.config = { ...loaded.config, successDisplayMs: 200 };
  const placeboCount = requests.length;
  // 方案 A：监听 window 捕获阶段，不再监听 document；弹出窗口打开时同样注册
  assert.equal(loaded.keyTargets.length, 1); assert.equal(loaded.keyTargets[0].target, context.window); assert.equal(loaded.keyTargets[0].capture, true);
  const popout = {}; loaded.workspaceEvents['window-open']({}, popout);
  assert.equal(loaded.keyTargets[1].target, popout); assert.equal(loaded.keyTargets[1].capture, true);
  assert.equal(typeof loaded.saveCommand.checkCallback, 'function'); assert.equal(loaded.saveCommand.checkCallback.name, 'checkCallback');
  loaded.saveKey({ ctrlKey: true, key: 'a', code: 'KeyA' }); assert.equal(loaded.state, 'idle');
  loaded.saveKey({ key: 's', code: 'KeyS' }); assert.equal(loaded.state, 'idle');
  // 输入法开启时 key 为 Process，按物理键位识别
  loaded.saveKey({ ctrlKey: true, key: 'Process', code: 'KeyS' }); assert.equal(loaded.state, 'syncing');
  assert.ok(logs.some(args => args[0].includes('Save shortcut detected') && args[1].code === 'KeyS'));
  await sleep(900); assert.equal(loaded.state, 'idle');
  loaded.saveKey({ ctrlKey: true, key: 's' }); assert.equal(loaded.state, 'syncing'); assert.equal(icon, 'refresh-cw');
  await sleep(650); assert.equal(loaded.state, 'success'); assert.equal(icon, 'check');
  await sleep(250); assert.equal(loaded.state, 'idle'); assert.equal(requests.length, placeboCount);
  loaded.saveKey({ metaKey: true, key: 'S' }); assert.equal(loaded.state, 'syncing'); await sleep(900); assert.equal(loaded.state, 'idle');
  for (const blocked of ['warning', 'error']) { loaded.state = blocked; loaded.saveKey({ ctrlKey: true, key: 's' }); assert.equal(loaded.state, blocked); }
  assert.ok(logs.some(args => args[0].includes('Placebo skipped') && args[1].state === 'error'));
  loaded.state = 'idle'; loaded.saveKey({ ctrlKey: true, key: 's' });
  loaded.engine = { async run(event) { requests.push({ event }); throw new SyncError('failed'); } };
  await loaded.sync('onCron'); assert.equal(loaded.state, 'warning');
  await sleep(900); assert.equal(loaded.state, 'warning'); assert.equal(icon, 'triangle-alert');
  loaded.state = 'idle'; loaded.saveKey({ ctrlKey: true, key: 's' }); loaded.onunload(); await sleep(900); assert.equal(loaded.state, 'syncing');
  const fallback = startup(new FileSystemAdapter(), { id: 'custom-git-sync' }); await fallback.onload();
  assert.equal(intervalMs, 300000);

  // 方案 B（默认配置 hidden）：包装内部保存命令，不监听按键；checking=true 只是询问，不触发安慰剂
  assert.equal(fallback.keyTargets.length, 0);
  fallback.config = { ...fallback.config, successDisplayMs: 0 };
  const original = fallback.saveCommand.checkCallback; assert.notEqual(original.name, 'checkCallback');
  assert.equal(fallback.saveCommand.checkCallback(true), true); assert.equal(fallback.state, 'idle');
  assert.equal(fallback.saveCommand.checkCallback(false), true); assert.equal(fallback.state, 'syncing');
  assert.deepEqual([...fallback.saveCalls], [true, false]);
  assert.ok(logs.some(args => args[0].includes('Save command executed') && args[1].via === 'checkCallback'));
  await sleep(700); assert.equal(fallback.state, 'idle');
  fallback.state = 'warning'; fallback.saveCommand.checkCallback(false); assert.equal(fallback.state, 'warning'); fallback.state = 'idle';
  fallback.onunload(); fallback.cleanups.forEach(fn => fn());
  assert.equal(fallback.saveCommand.checkCallback.name, 'checkCallback'); // 卸载后恢复原回调
  const missing = startup(new FileSystemAdapter(), { id: 'custom-git-sync' }); delete missing.app.commands; await missing.onload();
  assert.ok(logs.some(args => args[0].includes('Save command not found'))); missing.onunload();

  adapter.read = async () => '{';
  const bad = startup(adapter); const beforeBad = requests.length; await bad.onload();
  assert.equal(bad.state, 'error'); assert.equal(icon, 'x'); assert.ok(tooltip.includes('config.jsonc'));
  assert.equal(bad.engine, undefined); bad.activate(); assert.equal(requests.length, beforeBad); bad.onunload();
  let finishReading;
  adapter.read = () => new Promise(resolve => { finishReading = resolve; });
  const unloaded = startup(adapter); const loading = unloaded.onload(); await tick(); unloaded.onunload();
  finishReading('{}'); await loading; assert.equal(unloaded.engine, undefined);
  console.log('PASS placebo default(window capture)/hidden(save command), failure escalation without blocking, oversized skip warning, save debounce, rename triggers immediate sync, Ctrl/Cmd+S placebo, warning allows normal events, refused/conflict block until retry, busy/success hold, bilingual UI, startup config and unload');
})().catch(error => { console.error(error); process.exitCode = 1; });

