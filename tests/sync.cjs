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
 assert.ok(refs(f).includes('/recovery/merge/'));assert.ok(git(f.local,'for-each-ref','--format=%(refname)','refs/heads/ogit/recovery').includes('/result'));
 console.log('PASS startup merge keeps both histories and recovery refs');

 // 日常 push 被拒且双方改了不同文件：自动合并并重推
 await remoteCommit(f,'new.md','new remote\n');await write(f.local,'daily.md','daily\n');
 await run(f,'onSave');assertMerged(f);assert.ok(refs(f).includes('push-rejected'));
 assert.equal(git(f.remote,'show','main:new.md'),'new remote');assert.equal(git(f.remote,'show','main:daily.md'),'daily');
 assert.equal(await read(f.local,'new.md'),'new remote\n');assert.equal(git(f.local,'rev-parse','HEAD'),git(f.remote,'rev-parse','main'));
 console.log('PASS daily rejection auto-merges different files and pushes');

 // 同一文件真冲突：保护双方后进入 conflict，由用户选边
 await remoteCommit(f,'daily.md','daily remote\n');await write(f.local,'daily.md','daily local\n');const beforeRemote=git(f.remote,'rev-parse','main');
 await expectCode(()=>run(f,'onSave'),'conflict');assert.equal(git(f.remote,'rev-parse','main'),beforeRemote);
 assert.equal(await read(f.local,'daily.md'),'daily local\n');
 await run(f,'onResolve','local');assertMerged(f);assert.equal(git(f.remote,'show','main:daily.md'),'daily local');
 const record=metadata(f.remote,'main');assert.equal(record.schemaVersion,3);assert.equal(record.strategy,'local');
 assert.deepEqual(git(f.remote,'rev-list','--parents','-n','1','main').split(' ').slice(1),[beforeRemote,record.localCommit]);
 assert.equal(git(f.remote,'rev-parse',record.remoteRecoveryRef),beforeRemote);
 console.log('PASS daily conflict protects both sides, keep-local merge commit, JSON metadata');

 // 闲置设备 onCron 拉取、启动快进：都不创建恢复分支
 const remoteRefs=refs(f),localRefs=git(f.local,'for-each-ref','--format=%(refname)','refs/heads/ogit/recovery');
 await remoteCommit(f,'idle.md','idle\n');await run(f,'onCron');
 assert.equal(await read(f.local,'idle.md'),'idle\n');assert.equal(git(f.local,'rev-parse','HEAD'),git(f.remote,'rev-parse','main'));
 await remoteCommit(f,'ff.md','ff\n');await run(f,'onLoad');assert.equal(await read(f.local,'ff.md'),'ff\n');
 assert.equal(refs(f),remoteRefs);assert.equal(git(f.local,'for-each-ref','--format=%(refname)','refs/heads/ogit/recovery'),localRefs);
 console.log('PASS idle onCron pulls, fast-forward creates no recovery refs');

 // 手动保存即使没有本地变化，也必须 fetch 并应用远程新提交
 await remoteCommit(f,'manual-pull.md','manual remote\n');await run(f,'onManualSave');
 assert.equal(await read(f.local,'manual-pull.md'),'manual remote\n');
 await remoteCommit(f,'manual-peer.md','peer\n');await write(f.local,'manual-local.md','local\n');
 await run(f,'onManualSave');assert.equal(git(f.remote,'show','main:manual-local.md'),'local');
 assert.equal(await read(f.local,'manual-peer.md'),'peer\n');assertMerged(f);
 assert.equal(metadata(f.remote,'main').event,'onManualSave');
 console.log('PASS manual save fetches with no local changes and merges/pushes concurrent changes');

 // 无新提交时不访问远程：远程拒绝一切推送也能成功
 await hook(f.remote,'pre-receive','#!/bin/sh\nexit 1\n');await run(f,'onSave');await fs.rm(path.join(f.remote,'hooks','pre-receive'));
 console.log('PASS no push without new commits');
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
async function history(f) {
 const now=new Date(),file=`history-${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}.jsonl`;
 return (await fs.readFile(path.join(await stateDir(f),file),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
}

async function failures() {
 const n=await fixture('no-upstream');git(n.local,'branch','--unset-upstream');await expectCode(()=>run(n),'repo');
 // hook 拒绝：porcelain 中有 ! 行且远程未分叉 → refused
 const a=await fixture('refused');await run(a);await hook(a.remote,'pre-receive','#!/bin/sh\nexit 1\n');await write(a.local,'x.md','x\n');
 await assert.rejects(()=>run(a,'onSave'),e=>e.code==='refused'&&e.message.includes('hook declined'));
 // 无法与远程通信：没有 ! 行 → remote；本地快照仍已提交
 const u=await fixture('unreachable');await run(u);git(u.local,'remote','set-url','origin',path.join(u.base,'missing.git'));
 await write(u.local,'offline.md','offline\n');await expectCode(()=>run(u,'onSave'),'remote');
 assert.equal(git(u.local,'show','HEAD:offline.md'),'offline');await expectCode(()=>run(u,'onLoad'),'remote');
 // 重推时远程又前进（设备抢推送）→ remote，可自动重试；下次同步整合成功
 const race=await fixture('race');await run(race);await remoteCommit(race,'first.md','first\n');await write(race.local,'mine.md','mine\n');
 const originalPush=race.engine.pushRefs.bind(race.engine);let mainPushes=0;
 race.engine.pushRefs=async(specs,...rest)=>{if(specs[0].endsWith(':refs/heads/main')&&++mainPushes===2)await remoteCommit(race,'second.md','second\n');return originalPush(specs,...rest);};
 await expectCode(()=>run(race,'onSave'),'remote');race.engine.pushRefs=originalPush;await run(race,'onSave');
 for(const file of ['first.md','second.md','mine.md'])assert.notEqual(git(race.remote,'ls-tree','--name-only','main',file),'');
 // 网络命令用独立超时：1ms 的 networkTimeoutSeconds 只让 fetch 失败（remote），本地命令不受影响，快照照常提交
 const t=await fixture('net-timeout',{...DEFAULT_CONFIG,networkTimeoutSeconds:0.001});await write(t.local,'slow.md','x\n');
 await expectCode(()=>run(t,'onCron'),'remote');assert.equal(git(t.local,'show','HEAD:slow.md'),'x');
 console.log('PASS missing upstream, refused push, push race, unreachable remote keeps local snapshots, separate network timeout');

 // PATH 只含 git → nolfs，且不提交任何内容。仅 Linux：其他平台 git 可能从自带目录或 Homebrew 找到 lfs
 if (process.platform==='linux') {
  const l=await fixture('no-lfs');await run(l);const head=git(l.local,'rev-parse','HEAD');await write(l.local,'nolfs.md','x\n');
  const bin=path.join(l.base,'bin');await fs.mkdir(bin);await fs.symlink(git(l.base,'--exec-path')+'/git',path.join(bin,'git'));
  const savedPath=process.env.PATH;process.env.PATH=bin;
  try { await expectCode(()=>run(l,'onSave'),'nolfs'); } finally { process.env.PATH=savedPath; }
  assert.equal(git(l.local,'rev-parse','HEAD'),head);assert.equal(git(l.local,'status','--porcelain'),'?? nolfs.md');
  console.log('PASS missing git-lfs reported as nolfs without touching the repository');
 }

 // 手动 merge 冲突未解决：不提交、不推送冲突标记；用户完成合并后自动恢复
 const m=await fixture('manual-merge');await run(m);await remoteCommit(m,'note.md','remote side\n');
 await commit(m.local,'note.md','local side\n');git(m.local,'fetch');
 assert.throws(()=>git(m.local,'merge','origin/main'));const before=git(m.local,'rev-parse','HEAD');
 await assert.rejects(()=>run(m,'onSave'),e=>e.code==='unfinished'&&e.message.includes('MERGE_HEAD'));
 assert.equal(git(m.local,'rev-parse','HEAD'),before);assert.notEqual(git(m.local,'ls-files','-u'),'');
 // 仓库检查阶段的失败同样写入 history
 assert.ok((await history(m)).some(entry=>entry.event==='onSave'&&entry.outcome==='error'&&entry.errorCode==='unfinished'));
 assert.ok(!git(m.remote,'show','main:note.md').includes('<<<<<<<'));
 await write(m.local,'note.md','resolved\n');git(m.local,'add','note.md');git(m.local,'commit','--no-edit');
 await run(m,'onSave');assert.equal(git(m.remote,'show','main:note.md'),'resolved');
 // cherry-pick 冲突同样拦截，取消后恢复
 git(m.local,'checkout','-q','-b','side');await commit(m.local,'note.md','side\n');const pick=git(m.local,'rev-parse','HEAD');
 git(m.local,'checkout','-q','main');await commit(m.local,'note.md','main\n');assert.throws(()=>git(m.local,'cherry-pick',pick));
 await assert.rejects(()=>run(m,'onCron'),e=>e.code==='unfinished'&&e.message.includes('CHERRY_PICK_HEAD'));
 git(m.local,'cherry-pick','--abort');await run(m,'onCron');assert.equal(git(m.remote,'show','main:note.md'),'main');
 // rebase 冲突（HEAD 分离）同样报 unfinished 而非 repo，取消后自动恢复
 git(m.local,'checkout','-q','side');assert.throws(()=>git(m.local,'rebase','main'));
 await assert.rejects(()=>run(m,'onCron'),e=>e.code==='unfinished'&&e.message.includes('rebase-merge'));
 git(m.local,'rebase','--abort');git(m.local,'checkout','-q','main');await run(m,'onCron');
 console.log('PASS unfinished merge/cherry-pick/rebase blocks snapshot without touching the repository, resumes after user finishes');

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
 const applied=(await history(x)).at(-1);assert.equal(applied.phase,'applied');assert.equal(git(x.local,'rev-parse','HEAD'),applied.resultCommit);
 assert.equal(git(x.local,'status','--porcelain'),'');assert.equal(await read(x.local,'remote.md'),'remote\n');
 assert.equal(git(x.local,'worktree','list','--porcelain').split('\n').filter(line=>line.startsWith('worktree ')).length,1);
 assert.deepEqual((await fs.readdir(await stateDir(x))).filter(name=>name.startsWith('.omg.')),[]);
 console.log('PASS cancellation after read-tree still completes branch update and worktree cleanup');

 // 启动时清理强制退出的残留：pending 归档为 interrupted，.omg.* 被删除；index.lock 归属无法确认，从不删除
 const c=await fixture('cleanup');await run(c);const dir=await stateDir(c),lock=path.join(c.local,'.git','index.lock');
 await fs.writeFile(lock,'');await write(c.local,'locked.md','locked\n');
 await expectCode(()=>run(c,'onSave'),'failed');await expectCode(()=>run(c,'onLoad'),'failed');
 await fs.writeFile(path.join(dir,'.omg.pending.json'),JSON.stringify({operationId:'killed',phase:'push'}));
 await fs.mkdir(path.join(dir,'.omg.worktree-stale'));
 await assert.rejects(()=>run(c,'onLoad'),e=>e.code==='repo'&&e.message.includes('index.lock'));
 assert.ok(await fs.stat(lock));assert.deepEqual((await fs.readdir(dir)).filter(name=>name.startsWith('.omg.')),[]);
 assert.ok((await history(c)).some(entry=>entry.operationId==='killed'&&entry.outcome==='interrupted'&&entry.phase==='push'));
 assert.ok((await history(c)).some(entry=>entry.event==='onLoad'&&entry.errorCode==='repo'&&entry.error.includes('index.lock')));
 await fs.rm(lock);await run(c,'onRetry');assert.equal(git(c.remote,'show','main:locked.md'),'locked');
 const running=Symbol.for('omg-sync.running');globalThis[running]=true;
 await assert.rejects(()=>run(c,'onLoad'),e=>e.code==='failed'&&e.message.includes('previous plugin instance'));globalThis[running]=false;
 console.log('PASS startup cleanup of interrupted state, locks never deleted, previous instance guard');
}

async function ignoredCollisions() {
 for (const [name,ignored,incoming] of [
  ['same-file','private.md','private.md'],
  ['incoming-directory','private','private/note.md'],
  ['incoming-file','private/note.md','private'],
 ]) {
  const f=await fixture('ignored-'+name);await run(f);
  await write(f.local,'.gitignore','private\nprivate.md\n');await run(f,'onSave');
  await write(f.local,ignored,'local secret\n');
  git(f.peer,'pull','--ff-only');await write(f.peer,incoming,'remote content\n');
  git(f.peer,'add','-f','--',incoming);git(f.peer,'commit','-m','test: incoming ignored path');git(f.peer,'push');
  const head=git(f.local,'rev-parse','HEAD');
  await assert.rejects(()=>run(f,'onCron'),e=>e.code==='failed'&&e.message.includes(ignored));
  assert.equal(await read(f.local,ignored),'local secret\n');assert.equal(git(f.local,'rev-parse','HEAD'),head);
  await fs.rm(path.join(f.local,'private'),{recursive:true,force:true});await fs.rm(path.join(f.local,'private.md'),{force:true});
  await run(f,'onRetry');assert.equal(await read(f.local,incoming),'remote content\n');
 }
 console.log('PASS ignored file and file/directory collisions stop apply, retry succeeds after moving local files');
}

async function sizes() {
 const config={...DEFAULT_CONFIG,maxFileMiB:1},limit=1024*1024;
 const f=await fixture('size',config);await run(f);
 // 超限内容不能先写入 Git 或 LFS 对象库；预先暂存的内容也必须取消暂存
 for (const name of ['never-added[1].bin','never-added[1].png']) {
  const content=Buffer.alloc(limit+7,71);await write(f.local,name,content);
  const oid=git(f.local,'hash-object','--no-filters','--',name);
  const lfsOid=require('node:crypto').createHash('sha256').update(content).digest('hex');
  const result=await run(f,'onSave');assert.equal(result.skipped[0].path,name);
  assert.throws(()=>git(f.local,'cat-file','-e',oid));
  assert.equal(await fs.stat(path.join(f.local,'.git/lfs/objects',lfsOid.slice(0,2),lfsOid.slice(2,4),lfsOid)).then(()=>true,()=>false),false);
  await fs.rm(path.join(f.local,name));
 }
 await write(f.local,'staged.bin',Buffer.alloc(limit+8,72));git(f.local,'add','staged.bin');
 assert.equal((await run(f,'onSave')).skipped[0].path,'staged.bin');assert.equal(git(f.local,'diff','--cached','--name-only'),'');
 await fs.rm(path.join(f.local,'staged.bin'));
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
 // 状态文件损坏只影响月度备份，不把已成功推送的主线标成失败
 const damaged=await fixture('monthly-damaged');await run(damaged);
 const statePath=path.join(await stateDir(damaged),'state.json');
 const originalMonthly=refs(damaged,'refs/heads/ogit/monthly');
 for (const invalid of ['{','null']) {
  await fs.writeFile(statePath,invalid);await write(damaged.local,'note.md','updated '+invalid+'\n');
  await run(damaged,'onSave');
  assert.equal(git(damaged.remote,'rev-parse','main'),git(damaged.local,'rev-parse','HEAD'));
  assert.equal((await history(damaged)).at(-1).outcome,'success');
  assert.equal(await fs.readFile(statePath,'utf8'),invalid);
 }
 assert.equal(damaged.logs.filter(x=>x[0]==='Monthly backup deferred').length,2);
 await fs.rm(statePath);await run(damaged,'onSave');
 assert.ok(JSON.parse(await fs.readFile(statePath,'utf8')).monthly);
 assert.equal(refs(damaged,'refs/heads/ogit/monthly'),originalMonthly);
 console.log('PASS optional monthly backup retries until created, never overwritten; damaged state does not fail main sync');
}

async function diaries() {
 const f=await fixture('empty-diary');await run(f);
 const exists=file=>fs.stat(path.join(f.local,file)).then(()=>true,()=>false);
 // R1：全 Vault 未跟踪的空 .md 不入库；非 .md 空文件、被清空的已跟踪文件照常提交
 await write(f.local,'Daily/2026/old.md','');await write(f.local,'other/empty.md','');await write(f.local,'other/UPPER.MD','');await write(f.local,'keep.gitkeep','');await write(f.local,'note.md','');
 await run(f,'onSave');
 assert.equal(git(f.remote,'ls-tree','-r','--name-only','main','--','Daily','other'),'');
 assert.equal(git(f.remote,'ls-tree','--name-only','main','keep.gitkeep'),'keep.gitkeep');assert.equal(git(f.remote,'show','main:note.md'),'');
 assert.deepEqual((await history(f)).at(-1).emptySkipped.sort(),['Daily/2026/old.md','other/UPPER.MD','other/empty.md']);
 // 列表不变时不重复记录
 await run(f,'onSave');assert.equal((await history(f)).at(-1).emptySkipped,undefined);
 // 旧的空 md 不会被清理：onLoad 也只是不入库
 const old=new Date(Date.now()-3*24*3600*1000);await fs.utimes(path.join(f.local,'Daily/2026/old.md'),old,old);
 await write(f.local,'Daily/today.md','');
 await run(f,'onLoad');for(const file of ['Daily/2026/old.md','other/empty.md','Daily/today.md'])assert.ok(await exists(file));
 // R2：远程已有同名文件时，本地的空 md 在应用前删除，远程内容写入；不撞名的保留
 await remoteCommit(f,'Daily/today.md','written on peer\n');
 await run(f,'onLoad');assert.equal(await read(f.local,'Daily/today.md'),'written on peer\n');
 assert.deepEqual((await history(f)).at(-1).emptiesRemoved,['Daily/today.md']);assert.ok(await exists('Daily/2026/old.md'));
 // 一次同步应用两次（整合后推送被拒，再整合）时，两次删除的空 md 都要记录
 const d=await fixture('empty-twice');await run(d);
 await remoteCommit(d,'a.md','peer a\n');await write(d.local,'a.md','');await write(d.local,'b.md','');await write(d.local,'mine.md','mine\n');
 const push=d.engine.pushRefs.bind(d.engine);let mainPushes=0;
 d.engine.pushRefs=async(specs,...rest)=>{if(specs[0].endsWith(':refs/heads/main')&&++mainPushes===1)await remoteCommit(d,'b.md','peer b\n');return push(specs,...rest);};
 await run(d,'onCron');assert.deepEqual((await history(d)).at(-1).emptiesRemoved,['a.md','b.md']);
 assert.equal(await read(d.local,'a.md'),'peer a\n');assert.equal(await read(d.local,'b.md'),'peer b\n');
 console.log('PASS empty .md never committed or cleaned up; colliding empty .md yield to remote, removals from both applies recorded');
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
 await ignoredCollisions();
 await sizes();
 await monthly();
 await diaries();
 console.log('ALL SYNC CHECKS PASSED');
 // 保留临时目录供审计，路径已在上方打印
}
main().catch(e=>{console.error(e);console.error('Fixtures retained:',root);process.exitCode=1});
