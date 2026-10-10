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
    bundle: true, platform: 'node', format: 'cjs', loader: { '.jsonc': 'text' }, outfile: bundle,
  });
  const { DEFAULT_CONFIG, parseConfig, parseJsonc, loadConfig, runGit, GitError } = require(bundle);
  assert.deepEqual(parseConfig('{}'), DEFAULT_CONFIG);
  assert.deepEqual(parseConfig(await fs.readFile('config.jsonc', 'utf8')), DEFAULT_CONFIG);
  assert.equal(DEFAULT_CONFIG.syncIntervalSeconds, 300); assert.ok(DEFAULT_CONFIG.lfsExtensions.includes('png'));

  // JSONC：行/块注释、尾随逗号（包括注释夹在逗号与括号之间），字符串内容原样保留
  assert.deepEqual(parseJsonc(`{
    // line
    "url": "http://a/*b*/c", /* block
    spans */ "quote": "say \\"hi\\" // not a comment",
    "list": [1, 2, // trailing
    ],
    "comma": ",]",
  }`), { url: 'http://a/*b*/c', quote: 'say "hi" // not a comment', list: [1, 2], comma: ',]' });
  assert.throws(() => parseJsonc('{"a": 1 "b": 2}'), SyntaxError);
  const custom = parseConfig('{"syncIntervalSeconds":10,"maxFileMiB":1,"lfsExtensions":["BIN"]}');
  assert.equal(custom.syncIntervalSeconds, 10); assert.equal(custom.maxFileMiB, 1);
  assert.equal(custom.gitTimeoutSeconds, DEFAULT_CONFIG.gitTimeoutSeconds); assert.deepEqual(custom.lfsExtensions, ['bin']);

  let readPath;
  const adapter = { async exists(file) { readPath = file; return false; }, async read() { throw new Error('must not read'); } };
  assert.equal(await loadConfig(adapter, '.custom/plugins/sync'), DEFAULT_CONFIG);
  assert.equal(readPath, '.custom/plugins/sync/config.jsonc');
  adapter.exists = async () => true;
  adapter.read = async () => '{"maxFileMiB":1}';
  assert.equal((await loadConfig(adapter, '.custom/plugins/sync')).maxFileMiB, 1);
  adapter.read = async () => '{';
  await assert.rejects(() => loadConfig(adapter, 'plugins/sync'), e => e.code === 'config' && e.message.includes('plugins/sync/config.jsonc'));

  // GitError 携带退出码和原始输出，供调用方按结构判断；输出进入 message 便于日志
  await assert.rejects(() => runGit(['rev-parse', 'HEAD'], base, 5000),
    e => e instanceof GitError && e.exitCode === 128 && /not a git repository/i.test(e.stderr) && e.message.startsWith('git rev-parse HEAD:'));
  const remote = path.join(base, 'missing.git');
  await assert.rejects(() => runGit(['ls-remote', remote], base, 5000), e => e instanceof GitError && e.exitCode === 128);
  await assert.rejects(() => runGit(['merge-base', '--is-ancestor', 'HEAD', 'HEAD'], base, 5000), e => e.exitCode === 128);
  // PATH 中没有 git → nogit；macOS 会追加 Homebrew 目录，可能仍能找到 git，故跳过
  if (process.platform !== 'darwin') {
    const savedPath = process.env.PATH; process.env.PATH = base;
    try { await assert.rejects(() => runGit(['version'], base, 5000), e => e.code === 'nogit'); }
    finally { process.env.PATH = savedPath; }
  }
  console.log('PASS JSONC parsing, configuration defaults/overrides/path, GitError exit code and output, missing git');
  console.log('Fixtures retained:', base);
})().catch(error => { console.error(error); process.exitCode = 1; });
