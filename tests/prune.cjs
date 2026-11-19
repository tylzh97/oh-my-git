const { execFileSync } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

const script = path.resolve(__dirname, '../scripts/prune-recovery.cjs');
const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' };
function git(cwd, ...args) { return execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
function prune(...args) { return execFileSync('node', [script, ...args], { env, encoding: 'utf8' }); }
// 与插件 operationId 相同的时间格式
const stamp = daysAgo => new Date(Date.now() - daysAgo * 86400000).toISOString().replace(/[-:.]/g, '');
const refs = cwd => git(cwd, 'for-each-ref', '--format=%(refname)', 'refs/heads/ogit').split('\n').filter(Boolean).sort();

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ogit-prune-'));
  const remote = path.join(root, 'remote.git'), local = path.join(root, 'local');
  git(root, 'init', '--bare', '--initial-branch=main', remote); git(root, 'init', '--initial-branch=main', local);
  git(local, 'config', 'user.name', 'OGit Prune'); git(local, 'config', 'user.email', 'ogit-test@example.invalid');
  git(local, 'config', 'commit.gpgsign', 'false');
  await fs.writeFile(path.join(local, 'note.md'), 'base\n'); git(local, 'add', '.'); git(local, 'commit', '-m', 'base');
  git(local, 'remote', 'add', 'origin', remote); git(local, 'push', '-u', 'origin', 'main');

  const old = `refs/heads/ogit/recovery/merge/${stamp(100)}-aabbccddeeff-11223344`;
  const mid = `refs/heads/ogit/recovery/push-rejected/${stamp(60)}-aabbccddeeff-55667788`;
  const monthly = 'refs/heads/ogit/monthly/2020-01/main-12345678';
  const odd = 'refs/heads/ogit/recovery/merge/not-a-timestamp/local';
  // local、remote 在两侧，result 只在本地；月度备份和无法解析的名字不受影响
  const pushed = [`${old}/local`, `${old}/remote`, `${mid}/local`, `${mid}/remote`, monthly, odd];
  for (const ref of [...pushed, `${old}/result`, `${mid}/result`]) git(local, 'update-ref', ref, 'HEAD');
  git(local, 'push', 'origin', ...pushed.map(ref => `${ref}:${ref}`));
  const localBefore = refs(local), remoteBefore = refs(remote);

  // 默认只列出
  const listed = prune(local);
  assert.ok(listed.includes(`origin\t${old}/local`) && listed.includes(`local\t${old}/result`) && listed.includes('Nothing deleted'));
  assert.ok(!listed.includes(mid) && !listed.includes(monthly) && !listed.includes(odd));
  assert.deepEqual(refs(local), localBefore); assert.deepEqual(refs(remote), remoteBefore);

  // --delete：只删超过 90 天的，两侧都删
  prune(local, '--delete');
  assert.deepEqual(refs(local), localBefore.filter(ref => !ref.startsWith(old)));
  assert.deepEqual(refs(remote), remoteBefore.filter(ref => !ref.startsWith(old)));

  // 自定义天数；参数顺序不限
  prune('30', '--delete', local);
  assert.deepEqual(refs(local), [monthly, odd].sort()); assert.deepEqual(refs(remote), [monthly, odd].sort());
  assert.equal(git(remote, 'rev-parse', 'main'), git(local, 'rev-parse', 'HEAD'));
  console.log('PASS prune-recovery lists by default, deletes only old recovery branches on both sides, keeps monthly and unparsed names');
  console.log(`Fixtures retained: ${root}`);
}
main().catch(error => { console.error(error); process.exit(1); });
