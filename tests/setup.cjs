// setup-git.cmd 的 sh 部分：定位、初始化、区块幂等、取消跟踪、提交；cmd 部分需在 Windows 上手动验证
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { build } = require('esbuild');

let root, env;
function git(cwd, ...args) { return execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim(); }
async function write(cwd, file, text) { await fs.mkdir(path.dirname(path.join(cwd, file)), { recursive: true }); await fs.writeFile(path.join(cwd, file), text); }
const read = (cwd, file) => fs.readFile(path.join(cwd, file), 'utf8');
const exists = file => fs.stat(file).then(() => true, () => false);
// 从无关目录调用，验证定位不依赖当前目录
function setup(vault) {
  const result = spawnSync('sh', [path.join(vault, '.obsidian/plugins/oh-my-git/scripts/setup-git.cmd')], { cwd: root, env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); return result.stdout;
}
async function vault(name) {
  const dir = path.join(root, name);
  await fs.mkdir(path.join(dir, '.obsidian/plugins/oh-my-git/scripts'), { recursive: true });
  await fs.copyFile('dist/scripts/setup-git.cmd', path.join(dir, '.obsidian/plugins/oh-my-git/scripts/setup-git.cmd'));
  await write(dir, 'note.md', 'note\n'); await write(dir, '.obsidian/app.json', '{}');
  await write(dir, '.obsidian/workspace.json', '{}'); await write(dir, '.DS_Store', 'x');
  return dir;
}

(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ogit-setup-'));
  await write(root, 'gitconfig', '[user]\n\tname = OGit Setup\n\temail = ogit-setup@example.invalid\n[commit]\n\tgpgsign = false\n');
  env = { ...process.env, GIT_CONFIG_GLOBAL: path.join(root, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };
  const bundle = path.join(root, 'engine.cjs');
  await build({ stdin: { contents: "export * from './src/sync';", resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'cjs', loader: { '.jsonc': 'text' }, outfile: bundle });
  // 脚本的 LFS 区块必须与插件按默认配置生成的完全一致，否则插件同步时会改写它
  const lfsRules = new (require(bundle).GitSyncEngine)(root, () => {}, path.join(root, 'state')).lfsRules;

  // 新 vault：初始化并提交整个 vault，忽略的文件不入库，大文件走 LFS
  const v = await vault('fresh');
  await write(v, 'photo.PNG', 'binary'); await write(v, 'Icon\r', ''); await write(v, 'Icons/a.md', 'icon note\n');
  const out = setup(v);
  assert.ok(out.includes(`Vault: ${v}`) && out.includes('Initialized Git repository'));
  assert.equal(git(v, 'symbolic-ref', '--short', 'HEAD'), 'main');
  assert.equal(git(v, 'log', '--format=%s'), 'ogit: initialize vault (setup-git)');
  const files = git(v, 'ls-files').split('\n');
  for (const file of ['note.md', '.obsidian/app.json', 'Icons/a.md', '.gitignore', '.gitattributes', '.obsidian/plugins/oh-my-git/scripts/setup-git.cmd']) assert.ok(files.includes(file), file);
  for (const file of ['.obsidian/workspace.json', '.DS_Store', '"Icon\\r"']) assert.ok(!files.includes(file), file);
  assert.match(git(v, 'show', 'HEAD:photo.PNG'), /^version https:\/\/git-lfs.github.com\/spec\/v1/);
  assert.equal(await read(v, '.gitattributes'), lfsRules);
  assert.match(await read(v, '.gitignore'), /^# BEGIN OGIT IGNORE\n\*\*\/node_modules\/\n[\s\S]*\.obsidian\/graph\.json\n# END OGIT IGNORE\n$/);
  // 重复执行：区块跳过，不产生提交
  const again = setup(v);
  assert.ok(again.includes('block exists, skipped') && again.includes('Nothing to commit'));
  assert.equal(git(v, 'rev-list', '--count', 'HEAD'), '1');
  console.log('PASS fresh vault: locate from script, init main, LFS, ignore rules (Icon\\r only), initial commit, idempotent');

  // 已有仓库：保留用户规则，按全部规则取消跟踪，磁盘文件保留，单独提交
  const e = await vault('existing');
  await write(e, '.gitignore', 'secret/'); await write(e, 'secret/a.md', 'a\n'); await write(e, 'odd[1].md', 'odd\n');
  git(e, 'init', '-q', '-b', 'main'); git(e, 'add', '-A'); git(e, 'add', '-f', 'secret/a.md', '.DS_Store', '.obsidian/workspace.json');
  git(e, 'commit', '-q', '-m', 'user history');
  const output = setup(e);
  for (const file of ['secret/a.md', '.DS_Store', '.obsidian/workspace.json']) {
    assert.ok(output.includes(`Untracking: ${file}`), file);
    assert.equal(git(e, 'ls-files', '--', file), ''); assert.ok(await exists(path.join(e, file)), file);
  }
  assert.equal(git(e, 'log', '-1', '--format=%s'), 'ogit: apply ignore and LFS rules (setup-git)');
  assert.equal(git(e, 'ls-files', '--', 'odd[1].md', 'note.md'), 'note.md\nodd[1].md');
  assert.equal(git(e, 'status', '--porcelain'), '');
  const ignore = await read(e, '.gitignore');
  assert.ok(ignore.startsWith('secret/\n\n# BEGIN OGIT IGNORE\n'));
  assert.equal(await read(e, '.gitattributes'), lfsRules);
  const head = git(e, 'rev-parse', 'HEAD'); setup(e); assert.equal(git(e, 'rev-parse', 'HEAD'), head);
  console.log('PASS existing repo: user rules kept, all ignored files untracked but kept on disk, single commit, idempotent');

  // 上层没有 .obsidian：报错退出，不创建任何东西
  const lost = path.join(root, 'lost'); await fs.mkdir(lost);
  await fs.copyFile('dist/scripts/setup-git.cmd', path.join(lost, 'setup-git.cmd'));
  const failed = spawnSync('sh', [path.join(lost, 'setup-git.cmd')], { cwd: root, env, encoding: 'utf8' });
  assert.notEqual(failed.status, 0); assert.match(failed.stderr, /No \.obsidian directory/);
  assert.ok(!(await exists(path.join(lost, '.git'))));
  console.log('PASS missing .obsidian aborts without changes');
  console.log('Fixtures retained:', root);
})().catch(error => { console.error(error); console.error('Fixtures retained:', root); process.exitCode = 1; });
