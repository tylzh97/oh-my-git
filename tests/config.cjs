const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { build } = require('esbuild');

(async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'ogit-config-'));
  const bundle = path.join(base, 'config.cjs');
  await build({
    stdin: { contents: "export * from './src/config'; export * from './src/git';", resolveDir: process.cwd() },
    bundle: true, platform: 'node', format: 'cjs', outfile: bundle,
  });
  const { DEFAULT_CONFIG, parseConfig, loadConfig, SyncError, CommandError, remoteFailure, commandFailure } = require(bundle);
  assert.deepEqual(parseConfig('{}'), DEFAULT_CONFIG);
  assert.deepEqual(parseConfig(await fs.readFile('config.json', 'utf8')), DEFAULT_CONFIG);
  const custom = parseConfig('{"syncIntervalSeconds":10,"gitTimeoutSeconds":3,"maxFileMiB":1,"successDisplayMs":0,"monthlyBackupEnabled":false,"lfsExtensions":["BIN","bin"]}');
  assert.equal(custom.syncIntervalSeconds, 10); assert.equal(custom.gitTimeoutSeconds, 3);
  assert.equal(custom.maxFileMiB, 1); assert.equal(custom.successDisplayMs, 0);
  assert.equal(custom.monthlyBackupEnabled, false); assert.deepEqual(custom.lfsExtensions, ['bin']);
  assert.deepEqual(parseConfig('{"lfsExtensions":[]}').lfsExtensions, []);
  for (const text of [
    '{', 'null', '[]', 'true', '{"unknown":1}', '{"syncIntervalSeconds":0}',
    '{"syncIntervalSeconds":2147484}', '{"gitTimeoutSeconds":-1}', '{"maxFileMiB":1.5}',
    '{"maxFileMiB":1e99}', '{"successDisplayMs":-1}', '{"successDisplayMs":"1000"}',
    '{"monthlyBackupEnabled":0}', '{"lfsExtensions":"png"}', '{"lfsExtensions":[null]}',
    '{"lfsExtensions":["*.png"]}', '{"lfsExtensions":[""]}',
  ]) assert.throws(() => parseConfig(text), e => e instanceof SyncError && e.code === 'config' && !e.transient);

  let readPath;
  const adapter = { async exists(file) { readPath = file; return false; }, async read() { throw new Error('must not read'); } };
  assert.equal(await loadConfig(adapter, '.custom/plugins/sync'), DEFAULT_CONFIG);
  assert.equal(readPath, '.custom/plugins/sync/config.json');
  adapter.exists = async () => true;
  adapter.read = async file => { readPath = file; return '{"maxFileMiB":1}'; };
  assert.equal((await loadConfig(adapter, '.custom/plugins/sync')).maxFileMiB, 1);
  assert.equal(readPath, '.custom/plugins/sync/config.json');
  adapter.read = async () => { throw new Error('private file details'); };
  await assert.rejects(() => loadConfig(adapter, 'plugins/sync'), e => e.code === 'config' && e.message === 'config');

  for (const output of [
    'Could not resolve host: server.invalid', 'ssh: Could not resolve hostname server.invalid',
    'Failed to connect to server', 'Connection reset by peer', 'Connection refused',
    'dial tcp: i/o timeout', 'fatal: unable to access remote: The requested URL returned error: 503',
    'HTTP 429', 'HTTP 502', 'HTTP 504',
  ]) {
    const error = remoteFailure(new CommandError(['fetch'], output, false));
    assert.equal(error.code, 'network'); assert.equal(error.transient, true, output);
    assert.equal(remoteFailure(new CommandError(['push'], output, false), 'backup').transient, true);
    assert.equal(error.message, 'network');
  }
  for (const output of [
    'Authentication failed', 'Permission denied (publickey)', 'SSL certificate problem',
    'Host key verification failed', 'The requested URL returned error: 403',
    'pre-receive hook declined', 'unknown failure',
    'Connection reset; Authentication failed', 'HTTP 503; certificate verification failed',
  ]) assert.equal(remoteFailure(new CommandError(['push'], output, false)).transient, false, output);
  const timeout = new CommandError(['push'], 'Connection timed out', true);
  assert.equal(remoteFailure(timeout), timeout); assert.equal(commandFailure(timeout, 'lfs'), timeout);
  const cancelled = new SyncError('cancelled'); assert.equal(remoteFailure(cancelled), cancelled);
  assert.equal(remoteFailure(new Error('Connection reset')).transient, false);
  console.log('PASS configuration defaults/overrides/validation/path, transient versus permanent errors, timeout and cancellation preservation');
  console.log('Fixtures retained:', base);
})().catch(error => { console.error(error); process.exitCode = 1; });
