// 用虚拟时钟验证用户可观察到的执行时间，不依赖真实网络或墙上时间。
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
let now = 0, nextId = 0;
const timers = new Map();
class ClockDate extends Date {
  constructor(...args) { super(...(args.length ? args : [now])); }
  static now() { return now; }
}
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
async function advance(ms) {
  const target = now + ms;
  await flush();
  for (;;) {
    const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
    if (!next || next[1].at > target) break;
    now = next[1].at; timers.delete(next[0]); next[1].fn(); await flush();
  }
  now = target; await flush();
}
const sdk = {
  Plugin: class {}, getLanguage: () => 'en', setTooltip() {},
  setIcon(button, icon) { button.icon = icon; },
};
const context = {
  module: { exports: {} }, require: name => name === 'obsidian' ? sdk : require(name), process,
  console: { log() {} }, Date: ClockDate, AbortController,
  window: {
    setTimeout(fn, ms) { const id = ++nextId; timers.set(id, { fn, at: now + ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
  },
};
vm.runInNewContext(fs.readFileSync('dist/main.js', 'utf8'), context);
const Plugin = context.module.exports.default;
const ok = { skipped: [] };
const fail = code => Object.assign(new Error(code), { code });
function plugin() {
  const p = new Plugin(); p.enabled = true;
  p.button = {
    attributes: {}, style: { removeProperty() {}, setProperty() {} },
    setAttribute(key, value) { this.attributes[key] = value; }, removeAttribute(key) { delete this.attributes[key]; },
    querySelector() { return { animate() { return { cancel() {} }; } }; },
  };
  p.calls = [];
  p.engine = { async run(event) { p.calls.push({ event, at: now }); return ok; } };
  return p;
}
// 从真实 SyncError 实例取得构造器，保留插件 instanceof 检查。
async function syncError() {
  const p = plugin(); p.config = { ...p.config, successDisplayMs: 0 };
  p.engine.run = async () => { throw fail('failed'); };
  await p.sync('onLoad'); const ErrorType = p.failure.constructor; p.onunload(); return ErrorType;
}
function hook(p, command) {
  p.cleanups = []; p.register = fn => p.cleanups.push(fn);
  p.app = { commands: { commands: { 'editor:save-file': command } } };
  p.hookSaveCommand();
}
(async () => {
  const SyncError = await syncError();
  // 连按重置前防抖；没有真正完成同步之前不显示成功。
  const first = plugin(); const start = now;
  first.scheduleManualSave(); await advance(200); first.scheduleManualSave();
  await advance(499); assert.equal(first.calls.length, 0); assert.equal(first.state, 'idle');
  await advance(1); assert.deepEqual(first.calls, [{ event: 'onManualSave', at: start + 700 }]);
  assert.equal(first.state, 'success'); assert.equal(first.task, undefined);
  assert.equal(first.button.attributes['aria-busy'], undefined);
  await advance(1000); assert.equal(first.state, 'idle'); assert.equal(first.calls.length, 1);
  first.onunload();

  // 同步期间和成功展示期间的多次保存合并；按下保存立即修改的文件由下一次快照捕获。
  const busy = plugin(); let complete, disk = 'first'; const snapshots = [];
  busy.engine.run = event => { busy.calls.push({ event, at: now }); snapshots.push(disk); return new Promise(resolve => { complete = resolve; }); };
  const busyStart = now; busy.scheduleManualSave(); await advance(500);
  assert.equal(busy.state, 'syncing'); assert.equal(busy.button.icon, 'refresh-cw');
  await advance(100); disk = 'second'; busy.scheduleManualSave();
  await advance(100); disk = 'third'; busy.scheduleManualSave(); complete(ok); await flush();
  assert.equal(busy.state, 'success'); assert.equal(busy.task, undefined);
  busy.engine.run = async event => { busy.calls.push({ event, at: now }); snapshots.push(disk); return ok; };
  await advance(100); disk = 'fourth'; busy.scheduleManualSave();
  await advance(899); assert.equal(busy.calls.length, 1);
  await advance(1); assert.equal(busy.calls.length, 2); assert.equal(busy.calls[1].at, busyStart + 1700);
  assert.equal(busy.calls[1].event, 'onManualSave'); assert.deepEqual(snapshots, ['first', 'fourth']);
  await advance(2000); assert.equal(busy.calls.length, 2); busy.onunload();

  // 后防抖结束后仍须满足最后一次保存的前防抖；自动事件不能绕过等待。
  const late = plugin(); const lateStart = now;
  late.scheduleManualSave(); await advance(500); await advance(900); late.scheduleManualSave();
  await late.sync('onSave'); await late.sync('onCron');
  await advance(100); assert.equal(late.state, 'idle'); assert.equal(late.calls.length, 1);
  await advance(399); assert.equal(late.calls.length, 1);
  await advance(1); assert.equal(late.calls.length, 2); assert.equal(late.calls[1].at, lateStart + 1900);
  assert.equal(late.calls[1].event, 'onManualSave'); late.onunload();

  // 手动同步开始会取消 30 秒自动保存计时器，防止无新修改时重复执行。
  const automatic = plugin(); automatic.scheduleSave('note.md'); automatic.scheduleManualSave();
  await advance(500); await advance(30000); assert.equal(automatic.calls.length, 1); automatic.onunload();

  // 普通失败保留警告并等待后防抖；阻塞失败丢弃待处理请求，须显式重试。
  for (const code of ['remote', 'conflict']) {
    const p = plugin(); let reject;
    p.engine.run = event => { p.calls.push({ event, at: now }); return new Promise((_, no) => { reject = no; }); };
    p.scheduleManualSave(); await advance(500); p.scheduleManualSave(); reject(new SyncError(code)); await flush();
    assert.equal(p.state, code === 'remote' ? 'warning' : 'error'); assert.notEqual(p.button.icon, 'check');
    p.engine.run = async event => { p.calls.push({ event, at: now }); return ok; };
    await advance(999); assert.equal(p.calls.length, 1);
    await advance(1); assert.equal(p.calls.length, code === 'remote' ? 2 : 1);
    if (code === 'conflict') {
      p.scheduleManualSave(); await advance(500); assert.equal(p.calls.length, 1);
      await p.sync('onRetry'); assert.equal(p.calls.at(-1).event, 'onRetry');
    }
    p.onunload();
  }

  // 选边在后防抖期间排队时保留策略，其他保存请求不能覆盖。
  const resolve = plugin(); resolve.engine.run = async () => { throw new SyncError('conflict'); };
  await resolve.sync('onLoad'); await resolve.sync('onResolve', { strategy: 'remote' });
  resolve.scheduleManualSave();
  let chosen;
  resolve.engine.run = async (event, details) => { chosen = { event, ...details }; return ok; };
  await advance(1000); assert.deepEqual(chosen, { event: 'onResolve', strategy: 'remote' }); resolve.onunload();

  // command 模式保留原返回值、this 和参数；等异步保存完成才开始前防抖。
  const asyncSave = plugin(); let saved;
  const result = new Promise(resolve => { saved = resolve; });
  const command = { callback(...args) { assert.equal(this, command); assert.deepEqual(args, ['note']); return result; } };
  const original = command.callback; hook(asyncSave, command);
  assert.equal(command.callback('note'), result); await advance(1000); assert.equal(asyncSave.calls.length, 0);
  saved(); await flush(); await advance(499); assert.equal(asyncSave.calls.length, 0);
  await advance(1); assert.equal(asyncSave.calls.length, 1);
  asyncSave.onunload(); asyncSave.cleanups.forEach(fn => fn()); assert.equal(command.callback, original);

  // 异步失败、同步异常、不可执行的命令和 checking 查询都不请求同步。
  const invalid = plugin(); let rejected;
  const rejectedResult = new Promise((_, reject) => { rejected = reject; });
  const invalidCommand = {
    callback() { return rejectedResult; },
    checkCallback() { return false; },
    editorCallback() { throw new Error('save failed'); },
  };
  hook(invalid, invalidCommand); invalidCommand.callback(); rejected(new Error('save failed'));
  assert.equal(invalidCommand.checkCallback(true), false); assert.equal(invalidCommand.checkCallback(false), false);
  assert.throws(() => invalidCommand.editorCallback(), /save failed/);
  await advance(1000); assert.equal(invalid.calls.length, 0); invalid.onunload();

  // 卸载取消前/后防抖请求；卸载后才完成的原始保存也不得启动同步。
  const unloaded = plugin(); unloaded.scheduleManualSave(); unloaded.onunload(); await advance(1000);
  assert.equal(unloaded.calls.length, 0);
  const cooling = plugin(); cooling.scheduleManualSave(); await advance(500); cooling.scheduleManualSave(); cooling.onunload();
  await advance(2000); assert.equal(cooling.calls.length, 1);
  const saving = plugin(); let finishSave;
  hook(saving, { callback: () => new Promise(resolve => { finishSave = resolve; }) });
  saving.app.commands.commands['editor:save-file'].callback(); saving.onunload(); finishSave();
  await advance(1000); assert.equal(saving.calls.length, 0); assert.equal(timers.size, 0);
  console.log('PASS manual save front/trailing debounce, full sync requests, pending edits, real success only, auto-save cancellation, failure/retry/resolve, async command preservation, unload');
})().catch(error => { console.error(error); process.exitCode = 1; });
