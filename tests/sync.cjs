const { execFileSync } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { build } = require('esbuild');
let root, Engine, DEFAULT_CONFIG;
const env = { ...process.env, GIT_TERMINAL_PROMPT:'0', GCM_INTERACTIVE:'Never', GIT_CONFIG_NOSYSTEM:'1' };
function git(cwd,...args) { return execFileSync('git',args,{cwd,env,encoding:'utf8',stdio:['ignore','pipe','pipe'],windowsHide:true}).trim(); }
async function write(cwd,file,text) { await fs.mkdir(path.dirname(path.join(cwd,file)),{recursive:true}); await fs.writeFile(path.join(cwd,file),text); }
async function read(cwd,file) { return fs.readFile(path.join(cwd,file),'utf8'); }
async function commit(cwd,file,text) { await write(cwd,file,text);git(cwd,'add','--',file);git(cwd,'commit','-m',`test: ${file}`); }
async function hook(cwd,name,text) { await write(cwd,`hooks/${name}`,text);await fs.chmod(path.join(cwd,'hooks',name),0o755); }
function setup(cwd) { git(cwd,'config','user.name','OGit Integration');git(cwd,'config','user.email','ogit-test@example.invalid');git(cwd,'config','commit.gpgsign','false');git(cwd,'config','core.autocrlf','false');git(cwd,'config','core.hooksPath','.git/hooks');git(cwd,'lfs','install','--local'); }
async function fixture(name,config=DEFAULT_CONFIG,log=()=>{}) {
 const base=path.join(root,name),remote=path.join(base,'remote.git'),seed=path.join(base,'seed'),local=path.join(base,'local'),peer=path.join(base,'peer');
 await fs.mkdir(base,{recursive:true});git(base,'init','--bare','--initial-branch=main',remote);git(base,'init','--initial-branch=main',seed);setup(seed);await commit(seed,'note.md','base\n');git(seed,'remote','add','origin',remote);git(seed,'push','-u','origin','main');git(base,'clone',remote,local);git(base,'clone',remote,peer);setup(local);setup(peer);
 const logs=[];const engine=new Engine(local,(...x)=>{logs.push(x);log(...x)},path.join(base,'state'),config);
 return {base,remote,local,peer,engine,logs};
}
async function run(f,event='onLoad',strategy) { return f.engine.run(event,strategy?{strategy}:undefined,new AbortController().signal); }
async function expectCode(fn,code) { await assert.rejects(fn,e=>e.code===code); }
async function remoteCommit(f,file,text) { git(f.peer,'pull','--ff-only');await commit(f.peer,file,text);git(f.peer,'push'); }
function refs(f,prefix='refs/heads/ogit') { return git(f.remote,'for-each-ref','--format=%(refname)',prefix); }
function metadata(cwd,rev) { return JSON.parse(git(cwd,'log','-1','--format=%B',rev).split('Ogit-Metadata-Begin\n')[1].split('\nOgit-Metadata-End')[0]); }
function assertMerged(f) { assert.notEqual(git(f.remote,'rev-list','--min-parents=2','--max-count=1','main'),''); }

async function basics() {
 const f=await fixture('normal');await run(f);
 assert.equal(git(f.local,'rev-parse','HEAD'),git(f.remote,'rev-parse','main'));assert.ok(refs(f).includes('ogit/monthly/'));
 const monthlyBefore=git(f.remote,'for-each-ref','--format=%(objectname)','refs/heads/ogit/monthly');
 await fs.rename(path.join(f.local,'note.md'),path.join(f.local,'moved-note.md'));await run(f,'onSave');
 assert.equal(git(f.remote,'ls-tree','--name-only','main','note.md'),'');assert.equal(git(f.remote,'show','main:moved-note.md'),'base');
 await fs.rm(path.join(f.local,'moved-note.md'));await run(f,'onSave');assert.equal(git(f.remote,'ls-tree','--name-only','main','moved-note.md'),'');
 await write(f.local,'photo.PNG',Buffer.from([137,80,78,71,0,1,2,3,4]));await run(f,'onSave');
 assert.match(git(f.remote,'show','main:photo.PNG'),/^version https:\/\/git-lfs.github.com\/spec\/v1/);
 assert.equal(git(f.remote,'for-each-ref','--format=%(objectname)','refs/heads/ogit/monthly'),monthlyBefore);
 assert.equal(metadata(f.remote,'main').event,'onSave');
 const clone=path.join(f.base,'lfs-verify');git(f.base,'clone',f.remote,clone);setup(clone);git(clone,'lfs','pull');
 assert.deepEqual(await fs.readFile(path.join(clone,'photo.PNG')),Buffer.from([137,80,78,71,0,1,2,3,4]));
 // 改名单独提交为 100% 相似度的重命名；随后大幅改写仍可 --follow 追溯
 await write(f.local,'draft.md','alpha\nbeta\ngamma\n');await run(f,'onSave');const created=git(f.local,'rev-parse','HEAD');
 await fs.rename(path.join(f.local,'draft.md'),path.join(f.local,'final.md'));await run(f,'onRename');
 assert.match(git(f.local,'diff-tree','-M','--name-status','HEAD~1','HEAD'),/^R100\tdraft\.md\tfinal\.md$/m);
 await write(f.local,'final.md','completely rewritten\n');await run(f,'onSave');
 assert.ok(git(f.local,'log','--follow','--format=%H','--','final.md').split('\n').includes(created));
 console.log('PASS startup, snapshots, renames/deletions, rename traceability, monthly immutability, LFS roundtrip');

 await remoteCommit(f,'remote.md','remote\n');await write(f.local,'local.md','local\n');await run(f,'onLoad');
 assert.equal(await read(f.local,'remote.md'),'remote\n');assertMerged(f);
 assert.ok(refs(f).includes('startup-merge'));assert.ok(git(f.local,'for-each-ref','--format=%(refname)','refs/heads/ogit/recovery').includes('/result'));
 console.log('PASS startup merge keeps both histories and recovery refs');

 await remoteCommit(f,'new.md','new remote\n');await write(f.local,'daily.md','daily\n');const beforeRemote=git(f.remote,'rev-parse','main');
 await expectCode(()=>run(f,'onSave'),'conflict');assert.equal(git(f.remote,'rev-parse','main'),beforeRemote);
 assert.equal(await read(f.local,'daily.md'),'daily\n');assert.ok(refs(f).includes('push-rejected'));
 await run(f,'onResolve','local');assertMerged(f);assert.equal(git(f.remote,'ls-tree','--name-only','main','new.md'),'');
 const record=metadata(f.remote,'main');assert.equal(record.schemaVersion,2);assert.equal(record.strategy,'local');
 assert.deepEqual(record.parents,git(f.remote,'rev-list','--parents','-n','1','main').split(' ').slice(1));
 assert.equal(record.parents[0],beforeRemote);assert.equal(record.parents[1],record.localCommit);
 assert.equal(record.resultTree,git(f.remote,'rev-parse','main^{tree}'));assert.equal(git(f.remote,'rev-parse',record.remoteRecoveryRef),beforeRemote);
 console.log('PASS daily rejection protects both sides, keep-local merge commit, JSON metadata');

 await remoteCommit(f,'retry.md','retry remote\n');await write(f.local,'retry-local.md','x\n');
 await expectCode(()=>run(f,'onSave'),'conflict');await run(f,'onRetry');assert.equal(await read(f.local,'retry.md'),'retry remote\n');assertMerged(f);
 console.log('PASS retry runs full startup mode and merges');
}

async function conflicts() {
 const c=await fixture('conflict');await run(c);await remoteCommit(c,'note.md','remote conflict\n');await write(c.local,'note.md','local conflict\n');
 await expectCode(()=>run(c),'conflict');assert.equal(await read(c.local,'note.md'),'local conflict\n');assert.equal(git(c.local,'status','--porcelain'),'');
 await run(c,'onResolve','remote');assert.equal(await read(c.local,'note.md'),'remote conflict\n');assertMerged(c);
 const record=metadata(c.remote,'main');assert.equal(record.strategy,'remote');assert.equal(git(c.remote,'show',`${record.localRecoveryRef}:note.md`),'local conflict');
 console.log('PASS conflicting merge leaves Vault intact, keep-remote, both contents recoverable');

 const u=await fixture('unrelated');const unrelated=git(u.local,'commit-tree','HEAD^{tree}','-m','test: unrelated local root');git(u.local,'update-ref','refs/heads/main',unrelated);
 await expectCode(()=>run(u),'conflict');await run(u,'onResolve','remote');assertMerged(u);
 const h=await fixture('merge-history');git(h.local,'checkout','-b','feature');await commit(h.local,'feature.md','feature\n');git(h.local,'checkout','main');git(h.local,'merge','--no-ff','feature','-m','test: existing merge');
 const existingMerge=git(h.local,'rev-parse','HEAD');await run(h);assert.equal(git(h.remote,'merge-base',existingMerge,'main'),existingMerge);
 console.log('PASS unrelated histories need explicit choice, existing merges preserved');
}

async function stateDir(f) { const base=path.join(f.base,'state');return path.join(base,(await fs.readdir(base))[0]); }
async function history(f) { return (await fs.readFile(path.join(await stateDir(f),'history.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line)); }

async function failures() {
 const n=await fixture('no-upstream');git(n.local,'branch','--unset-upstream');await expectCode(()=>run(n),'repo');
 // hook 拒绝：porcelain 中有 ! 行且远程未分叉 → refused
 const a=await fixture('refused');await run(a);await hook(a.remote,'pre-receive','#!/bin/sh\nexit 1\n');await write(a.local,'x.md','x\n');
 await assert.rejects(()=>run(a,'onSave'),e=>e.code==='refused'&&e.message.includes('hook declined'));
 // 无法与远程通信：没有 ! 行 → remote；本地快照仍已提交
 const u=await fixture('unreachable');await run(u);git(u.local,'remote','set-url','origin',path.join(u.base,'missing.git'));
 await write(u.local,'offline.md','offline\n');await expectCode(()=>run(u,'onSave'),'remote');
 assert.equal(git(u.local,'show','HEAD:offline.md'),'offline');await expectCode(()=>run(u,'onLoad'),'remote');
 console.log('PASS missing upstream, refused push, unreachable remote keeps local snapshots');

 // 同步期间写入的未跟踪文件会被 read-tree 拒绝覆盖；失败不留下 pending，不阻塞后续同步
 let edited=false;const r=await fixture('concurrent-edit',DEFAULT_CONFIG,(event,details)=>{
   if(!edited&&details?.phase==='apply'){edited=true;require('node:fs').writeFileSync(path.join(r.local,'remote.md'),'edited during sync\n')}
 });
 await run(r);await remoteCommit(r,'remote.md','remote\n');await write(r.local,'local.md','local\n');
 await expectCode(()=>run(r),'failed');assert.equal(await read(r.local,'remote.md'),'edited during sync\n');
 assert.deepEqual((await fs.readdir(await stateDir(r))).filter(name=>name.startsWith('.omg.')),[]);
 const last=(await history(r)).at(-1);assert.equal(last.outcome,'error');assert.equal(last.phase,'apply');
 console.log('PASS concurrent edit is never overwritten, apply failure leaves no pending state');

 // read-tree 完成后才收到取消：update-ref 和临时 worktree 清理仍然执行，分支与工作区一致
 const x=await fixture('cancel-apply');await run(x);await remoteCommit(x,'remote.md','remote\n');await write(x.local,'local.md','local\n');
 const controller=new AbortController(),originalGit=x.engine.git.bind(x.engine);
 x.engine.git=async(args,...rest)=>{const out=await originalGit(args,...rest);if(args[0]==='read-tree'&&args[1]==='-m')controller.abort();return out;};
 await assert.rejects(()=>x.engine.run('onLoad',undefined,controller.signal),e=>e.message==='Sync cancelled');
 const applied=(await history(x)).at(-1);assert.equal(applied.phase,'push');assert.equal(git(x.local,'rev-parse','HEAD'),applied.resultCommit);
 assert.equal(git(x.local,'status','--porcelain'),'');assert.equal(await read(x.local,'remote.md'),'remote\n');
 assert.equal(git(x.local,'worktree','list','--porcelain').split('\n').filter(line=>line.startsWith('worktree ')).length,1);
 assert.deepEqual((await fs.readdir(await stateDir(x))).filter(name=>name.startsWith('.omg.')),[]);
 console.log('PASS cancellation after read-tree still completes branch update and worktree cleanup');

 // 启动时清理强制退出的残留：pending 归档为 interrupted，.omg.* 和插件留下的 index.lock 被删除
 const c=await fixture('cleanup');await run(c);const dir=await stateDir(c),lock=path.join(c.local,'.git','index.lock');
 await fs.writeFile(lock,'');await write(c.local,'locked.md','locked\n');
 await expectCode(()=>run(c,'onSave'),'failed');await expectCode(()=>run(c,'onLoad'),'failed'); // 无残留 pending 时不删用户的锁
 await fs.writeFile(path.join(dir,'.omg.pending.json'),JSON.stringify({operationId:'killed',phase:'push'}));
 await fs.mkdir(path.join(dir,'.omg.worktree-stale'));await run(c,'onLoad');
 assert.equal(git(c.remote,'show','main:locked.md'),'locked');
 assert.deepEqual((await fs.readdir(dir)).filter(name=>name.startsWith('.omg.')),[]);
 assert.ok((await history(c)).some(entry=>entry.operationId==='killed'&&entry.outcome==='interrupted'&&entry.phase==='push'));
 const running=Symbol.for('omg-sync.running');globalThis[running]=true;
 await assert.rejects(()=>run(c,'onLoad'),e=>e.code==='failed'&&e.message.includes('previous plugin instance'));globalThis[running]=false;
 console.log('PASS startup cleanup of interrupted state, user locks untouched, previous instance guard');
}

async function sizes() {
 const config={...DEFAULT_CONFIG,maxFileMiB:1},limit=1024*1024;
 const f=await fixture('size',config);await run(f);
 for(const name of ['中文 空格.md','big.bin','big.png']){
   await write(f.local,name,Buffer.alloc(limit,65));assert.deepEqual((await run(f,'onSave')).skipped,[]);
   // 修改为超限：该文件跳过，其余内容照常提交推送
   await write(f.local,name,Buffer.alloc(limit+1,66));await write(f.local,'small.md',name);
   assert.deepEqual((await run(f,'onSave')).skipped,[{path:name,bytes:limit+1}]);
   assert.equal(git(f.remote,'show','main:small.md'),name);assert.equal(git(f.local,'diff','--name-only','-z','--',name),`${name}\0`);assert.equal(git(f.local,'diff','--cached','--name-only'),'');
   await fs.rm(path.join(f.local,name));assert.deepEqual((await run(f,'onSave')).skipped,[]);
 }
 await write(f.local,'new-big.md',Buffer.alloc(limit+1,67));assert.equal((await run(f,'onSave')).skipped[0].path,'new-big.md');
 assert.equal(git(f.local,'status','--porcelain','--','new-big.md'),'?? new-big.md');await fs.rm(path.join(f.local,'new-big.md'));
 // 远程已有的大文件（终端提交）不受限制，启动合并照常完成；本地再修改时才受限
 git(f.peer,'pull','--ff-only');await write(f.peer,'remote-big.bin',Buffer.alloc(limit+5,68));git(f.peer,'add','remote-big.bin');git(f.peer,'commit','-m','test: big');git(f.peer,'push');
 await write(f.local,'local.md','local\n');assert.deepEqual((await run(f,'onLoad')).skipped,[]);assertMerged(f);
 assert.equal((await fs.stat(path.join(f.local,'remote-big.bin'))).size,limit+5);
 await write(f.local,'remote-big.bin',Buffer.alloc(limit+6,69));assert.equal((await run(f,'onSave')).skipped[0].path,'remote-big.bin');
 console.log('PASS oversized new/modified files skipped while the rest syncs, remote big files merge freely');
}

async function monthly() {
 const f=await fixture('monthly');
 await hook(f.remote,'pre-receive','#!/bin/sh\nwhile read old new ref; do\ncase "$ref" in refs/heads/ogit/monthly/*) exit 1;; esac\ndone\nexit 0\n');
 await run(f);assert.equal(git(f.remote,'rev-parse','main'),git(f.local,'rev-parse','HEAD'));
 assert.equal(refs(f,'refs/heads/ogit/monthly'),'');assert.ok(f.logs.some(x=>x[0]==='Monthly backup deferred'));
 await fs.rm(path.join(f.remote,'hooks/pre-receive'));await write(f.local,'note.md','second\n');await run(f,'onSave');
 const created=git(f.remote,'for-each-ref','--format=%(objectname)','refs/heads/ogit/monthly');assert.equal(created,git(f.local,'rev-parse','HEAD'));
 await write(f.local,'note.md','third\n');await run(f,'onSave');
 assert.equal(git(f.remote,'for-each-ref','--format=%(objectname)','refs/heads/ogit/monthly'),created);
 const disabled=await fixture('monthly-disabled',{...DEFAULT_CONFIG,monthlyBackupEnabled:false});await run(disabled);
 assert.equal(refs(disabled,'refs/heads/ogit/monthly'),'');
 console.log('PASS optional monthly backup retries until created, never overwritten');
}

async function main() {
 root=await fs.mkdtemp(path.join(os.tmpdir(),'ogit-integration-'));
 const bundle=path.join(root,'engine.cjs');
 await build({stdin:{contents:"export * from './src/sync'; export * from './src/config';",resolveDir:process.cwd()},bundle:true,platform:'node',format:'cjs',loader:{'.jsonc':'text'},outfile:bundle});
 ({GitSyncEngine:Engine,DEFAULT_CONFIG}=require(bundle));
 console.log('Isolated fixtures:',root);
 await basics();
 await conflicts();
 await failures();
 await sizes();
 await monthly();
 console.log('ALL SYNC CHECKS PASSED');
 // 保留临时目录供审计，路径已在上方打印
}
main().catch(e=>{console.error(e);console.error('Fixtures retained:',root);process.exitCode=1});
