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
  AbortController, Date,
};
vm.runInNewContext(fs.readFileSync('main.js', 'utf8'), context);
const Plugin = context.module.exports.default;
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function plugin() {
  const p = new Plugin(); p.enabled = true; p.button = button;
  p.config = { ...p.config, successDisplayMs: 0 };
  return p;
}
function startup(adapter, manifest = { id: 'custom-git-sync', dir: '.custom/plugins/renamed' }) {
  const p = new Plugin(); p.manifest = manifest;
  p.app = {
    vault: { adapter, configDir: '.custom', on() { return {}; } },
    workspace: { on() { return {}; }, onLayoutReady(fn) { fn(); }, iterateAllLeaves() {} },
  };
  p.addStatusBarItem = () => button;
  p.registerDomEvent = p.registerEvent = p.registerInterval = () => {};
  // Test initialization without launching Git against an actual Vault.
  p.trigger = event => requests.push({ event });
  return p;
}

(async () => {
  const p = plugin();
  p.engine = { async run(event, details) { requests.push({ event, details }); throw new Error('failure'); } };
  await p.sync('onLoad'); assert.equal(icon, 'x'); assert.equal(p.state, 'error');
  assert.ok(tooltip.includes('Git 操作失败')); const SyncError = p.failure.constructor;
  for (const event of ['onClick', 'onLoad', 'onOpen', 'onSave', 'onClose', 'onCron']) await p.sync(event);
  assert.equal(requests.length, 1);
  p.activate(); assert.deepEqual(p.menu.items.map(item => item.title), ['重试']);
  p.menu.items[0].click(); await tick(); assert.equal(requests.at(-1).event, 'onRetry');
  assert.equal(requests.at(-1).details.retryOf, 'onLoad'); assert.equal(p.state, 'error');

  p.state = 'idle';
  p.engine = { async run(event, details) { requests.push({ event, details }); throw new SyncError('conflict', { resolvable: true }); } };
  await p.sync('onSave'); p.activate();
  assert.deepEqual(p.menu.items.map(item => item.title), ['重试', '保持远程', '保持本地']);
  p.menu.items[1].click(); await tick(); assert.equal(requests.at(-1).details.strategy, 'remote');
  p.activate(); p.menu.items[0].click(); await tick();
  assert.equal(requests.at(-1).details.retryOf, 'onResolve'); assert.equal(requests.at(-1).details.strategy, 'remote');
  language = 'en'; p.activate();
  assert.deepEqual(p.menu.items.map(item => item.title), ['Retry', 'Keep remote', 'Keep local']); p.menu.hide();

  language = 'zh'; const w = plugin();
  w.engine = { async run(event, details) { requests.push({ event, details }); throw new SyncError('network', { transient: true }); } };
  await w.sync('onLoad'); assert.equal(w.state, 'warning'); assert.equal(icon, 'triangle-alert');
  assert.equal(color, 'var(--text-warning)'); assert.ok(tooltip.includes('后续同步正常触发'));
  assert.equal(w.manualRetry, undefined);
  for (const event of ['onOpen', 'onSave', 'onClose', 'onCron']) {
    const count = requests.length;
    await w.sync(event);
    assert.equal(requests.length, count + 1);
    assert.equal(requests.at(-1).event, event); assert.equal(requests.at(-1).details, undefined);
    assert.equal(w.state, 'warning'); assert.equal(w.manualRetry, undefined);
  }
  w.activate(); await tick(); assert.equal(requests.at(-1).event, 'onClick'); assert.equal(w.menu, undefined);
  assert.equal(requests.at(-1).details, undefined);
  language = 'en'; w.render(); assert.ok(tooltip.includes('normal sync remains available'));
  w.engine = { async run(event, details) { requests.push({ event, details }); } };
  await w.sync('onCron'); assert.equal(w.state, 'idle'); assert.equal(icon, 'refresh-cw');

  // A warning must not retain a previous resolution or startup task.
  w.engine = { async run(event, details) { requests.push({ event, details }); throw new SyncError('backup', { transient: true }); } };
  await w.sync('onResolve', { strategy: 'local', reason: 'conflict' }); await w.sync('onCron');
  assert.equal(requests.at(-1).event, 'onCron'); assert.equal(requests.at(-1).details, undefined);
  assert.equal(w.manualRetry, undefined);
  w.engine = { async run(event, details) { requests.push({ event, details }); throw new SyncError('interrupted'); } };
  await w.sync('onCron'); assert.equal(w.state, 'error'); const stopped = requests.length;
  await w.sync('onCron'); assert.equal(requests.length, stopped);

  const busy = plugin(); busy.config = { ...busy.config, successDisplayMs: 30 };
  let complete;
  busy.engine = { run(event) { requests.push({ event }); return new Promise(resolve => { complete = resolve; }); } };
  const active = busy.sync('onClick'); const busyCount = requests.length;
  await busy.sync('onCron'); assert.equal(requests.length, busyCount);
  complete(); await tick(); assert.equal(busy.state, 'success'); assert.equal(icon, 'check');
  await busy.sync('onRetry', { retryOf: 'onClick' }); assert.equal(requests.length, busyCount);
  await active; assert.equal(busy.state, 'idle'); busy.onunload(); assert.equal(busy.enabled, false);

  let configPath;
  const adapter = new FileSystemAdapter(); adapter.exists = async file => { configPath = file; return true; };
  adapter.read = async () => '{"syncIntervalSeconds":10,"maxFileMiB":1}';
  const loaded = startup(adapter); await loaded.onload();
  assert.equal(configPath, '.custom/plugins/renamed/config.json'); assert.equal(intervalMs, 10000);
  assert.equal(loaded.engine.config.maxFileMiB, 1); assert.equal(requests.at(-1).event, 'onLoad');
  cron(); assert.equal(requests.at(-1).event, 'onCron'); loaded.onunload();
  const fallback = startup(new FileSystemAdapter(), { id: 'custom-git-sync' }); await fallback.onload();
  assert.equal(intervalMs, 300000); fallback.onunload();

  adapter.read = async () => '{"syncIntervalSeconds":0}';
  const bad = startup(adapter); const beforeBad = requests.length; await bad.onload();
  assert.equal(bad.state, 'error'); assert.equal(icon, 'x'); assert.ok(tooltip.includes('config.json'));
  assert.equal(bad.engine, undefined); bad.activate(); assert.equal(requests.length, beforeBad); bad.onunload();
  let finishReading;
  adapter.read = () => new Promise(resolve => { finishReading = resolve; });
  const unloaded = startup(adapter); const loading = unloaded.onload(); await tick(); unloaded.onunload();
  finishReading('{}'); await loading; assert.equal(unloaded.engine, undefined);
  console.log('PASS warning allows normal events without replay, blocked manual retry, busy/success hold, bilingual UI, startup config and unload');
})().catch(error => { console.error(error); process.exitCode = 1; });

