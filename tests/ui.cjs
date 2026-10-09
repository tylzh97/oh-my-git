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
  p.registerEvent = p.registerInterval = () => {};
  p.registerDomEvent = (target, type, fn) => { if (target === context.document && type === 'keydown') p.saveKey = fn; };
  // Test initialization without launching Git against an actual Vault.
  p.trigger = event => requests.push({ event });
  return p;
}

(async () => {
  const p = plugin();
  p.engine = { async run(event, details) { requests.push({ event, details }); throw new Error('failure'); } };
  await p.sync('onLoad'); assert.equal(icon, 'triangle-alert'); assert.equal(p.state, 'warning');
  const SyncError = p.failure.constructor;
  p.engine = { async run(event, details) { requests.push({ event, details }); throw new SyncError('auth', 'git push: Authentication failed'); } };
  await p.sync('onLoad'); assert.equal(icon, 'x'); assert.equal(p.state, 'error');
  assert.ok(tooltip.includes('远程认证或权限被拒绝'));
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
  for (const event of ['onOpen', 'onSave', 'onClose', 'onCron']) {
    const count = requests.length;
    await w.sync(event);
    assert.equal(requests.length, count + 1); assert.equal(requests.at(-1).event, event); assert.equal(w.state, 'warning');
  }
  w.activate(); await tick(); assert.equal(requests.at(-1).event, 'onClick'); assert.equal(w.menu, undefined);
  language = 'en'; w.render(); assert.ok(tooltip.includes('normal sync remains available'));
  w.engine = { async run(event, details) { requests.push({ event, details }); } };
  await w.sync('onCron'); assert.equal(w.state, 'idle'); assert.equal(icon, 'refresh-cw');
  w.engine = { async run(event, details) { requests.push({ event, details }); throw new SyncError('interrupted'); } };
  await w.sync('onCron'); assert.equal(w.state, 'error'); const stopped = requests.length;
  await w.sync('onCron'); assert.equal(requests.length, stopped);

  // 连续保存只在静默期满后触发一次；其他同步开始或卸载时取消
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const d = plugin(); d.config = { ...d.config, saveDebounceSeconds: 0.02 };
  d.engine = { async run(event, details) { requests.push({ event, details }); } };
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
  complete(); await tick(); assert.equal(busy.state, 'success'); assert.equal(icon, 'check');
  await busy.sync('onRetry'); assert.equal(requests.length, busyCount);
  await active; assert.equal(busy.state, 'idle'); busy.onunload(); assert.equal(busy.enabled, false);

  let configPath;
  const adapter = new FileSystemAdapter(); adapter.exists = async file => { configPath = file; return true; };
  adapter.read = async () => '{"syncIntervalSeconds":10,"maxFileMiB":1}';
  const loaded = startup(adapter); await loaded.onload();
  assert.equal(configPath, '.custom/plugins/renamed/config.json'); assert.equal(intervalMs, 10000);
  assert.equal(loaded.engine.config.maxFileMiB, 1); assert.equal(requests.at(-1).event, 'onLoad');
  cron(); assert.equal(requests.at(-1).event, 'onCron');

  // Ctrl/Cmd+S 安慰剂：只改状态栏，不调用 engine；! 和 × 下不响应；真实同步可接管
  loaded.config = { ...loaded.config, successDisplayMs: 200 };
  const placeboCount = requests.length;
  loaded.saveKey({ ctrlKey: true, key: 'a' }); assert.equal(loaded.state, 'idle');
  loaded.saveKey({ ctrlKey: true, key: 's' }); assert.equal(loaded.state, 'syncing'); assert.equal(icon, 'refresh-cw');
  await sleep(650); assert.equal(loaded.state, 'success'); assert.equal(icon, 'check');
  await sleep(250); assert.equal(loaded.state, 'idle'); assert.equal(requests.length, placeboCount);
  loaded.saveKey({ metaKey: true, key: 'S' }); assert.equal(loaded.state, 'syncing'); await sleep(900); assert.equal(loaded.state, 'idle');
  for (const blocked of ['warning', 'error']) { loaded.state = blocked; loaded.saveKey({ ctrlKey: true, key: 's' }); assert.equal(loaded.state, blocked); }
  loaded.state = 'idle'; loaded.saveKey({ ctrlKey: true, key: 's' });
  loaded.engine = { async run(event) { requests.push({ event }); throw new SyncError('failed'); } };
  await loaded.sync('onCron'); assert.equal(loaded.state, 'warning');
  await sleep(900); assert.equal(loaded.state, 'warning'); assert.equal(icon, 'triangle-alert');
  loaded.state = 'idle'; loaded.saveKey({ ctrlKey: true, key: 's' }); loaded.onunload(); await sleep(900); assert.equal(loaded.state, 'syncing');
  const fallback = startup(new FileSystemAdapter(), { id: 'custom-git-sync' }); await fallback.onload();
  assert.equal(intervalMs, 300000); fallback.onunload();

  adapter.read = async () => '{';
  const bad = startup(adapter); const beforeBad = requests.length; await bad.onload();
  assert.equal(bad.state, 'error'); assert.equal(icon, 'x'); assert.ok(tooltip.includes('config.json'));
  assert.equal(bad.engine, undefined); bad.activate(); assert.equal(requests.length, beforeBad); bad.onunload();
  let finishReading;
  adapter.read = () => new Promise(resolve => { finishReading = resolve; });
  const unloaded = startup(adapter); const loading = unloaded.onload(); await tick(); unloaded.onunload();
  finishReading('{}'); await loading; assert.equal(unloaded.engine, undefined);
  console.log('PASS save debounce, Ctrl/Cmd+S placebo, warning allows normal events, auth/conflict block until retry, busy/success hold, bilingual UI, startup config and unload');
})().catch(error => { console.error(error); process.exitCode = 1; });

