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
  const { DEFAULT_CONFIG, parseConfig, loadConfig, runGit } = require(bundle);
  assert.deepEqual(parseConfig('{}'), DEFAULT_CONFIG);
  assert.deepEqual(parseConfig(await fs.readFile('config.json', 'utf8')), DEFAULT_CONFIG);
  const custom = parseConfig('{"syncIntervalSeconds":10,"maxFileMiB":1,"lfsExtensions":["BIN"]}');
  assert.equal(custom.syncIntervalSeconds, 10); assert.equal(custom.maxFileMiB, 1);
  assert.equal(custom.gitTimeoutSeconds, DEFAULT_CONFIG.gitTimeoutSeconds); assert.deepEqual(custom.lfsExtensions, ['bin']);

  let readPath;
  const adapter = { async exists(file) { readPath = file; return false; }, async read() { throw new Error('must not read'); } };
  assert.equal(await loadConfig(adapter, '.custom/plugins/sync'), DEFAULT_CONFIG);
  assert.equal(readPath, '.custom/plugins/sync/config.json');
  adapter.exists = async () => true;
  adapter.read = async () => '{"maxFileMiB":1}';
  assert.equal((await loadConfig(adapter, '.custom/plugins/sync')).maxFileMiB, 1);
  adapter.read = async () => '{';
  await assert.rejects(() => loadConfig(adapter, 'plugins/sync'), e => e.code === 'config' && e.message.includes('plugins/sync/config.json'));

  // Git stderr 进入错误信息；认证类失败归为 auth
  await assert.rejects(() => runGit(['rev-parse', 'HEAD'], base, 5000), e => e.code === 'failed' && /not a git repository/i.test(e.message));
  const remote = path.join(base, 'missing.git');
  await assert.rejects(() => runGit(['ls-remote', remote], base, 5000), e => e.code === 'failed' && e.message.startsWith('git ls-remote'));
  console.log('PASS configuration defaults/overrides/path, Git stderr in errors');
  console.log('Fixtures retained:', base);
})().catch(error => { console.error(error); process.exitCode = 1; });
