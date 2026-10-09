const { execFileSync } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { build } = require('esbuild');
let root, Engine, SyncError, CommandError, DEFAULT_CONFIG, parseConfig;
const env = { ...process.env, GIT_TERMINAL_PROMPT:'0', GCM_INTERACTIVE:'Never', GIT_CONFIG_NOSYSTEM:'1' };
function git(cwd,...args) { return execFileSync('git',args,{cwd,env,encoding:'utf8',stdio:['ignore','pipe','pipe'],windowsHide:true}).trim(); }
async function write(cwd,file,text) { await fs.mkdir(path.dirname(path.join(cwd,file)),{recursive:true}); await fs.writeFile(path.join(cwd,file),text); }
async function commit(cwd,file,text) { await write(cwd,file,text);git(cwd,'add','--',file);git(cwd,'commit','-m',`test: ${file}`); }
function setup(cwd) { git(cwd,'config','user.name','OGit Integration');git(cwd,'config','user.email','ogit-test@example.invalid');git(cwd,'config','commit.gpgsign','false');git(cwd,'config','core.autocrlf','false');git(cwd,'config','core.hooksPath','.git/hooks');git(cwd,'lfs','install','--local'); }
async function fixture(name) {
 const base=path.join(root,name),remote=path.join(base,'remote.git'),seed=path.join(base,'seed'),local=path.join(base,'local'),peer=path.join(base,'peer');
 await fs.mkdir(base,{recursive:true});git(base,'init','--bare','--initial-branch=main',remote);git(base,'init','--initial-branch=main',seed);setup(seed);await commit(seed,'note.md','base\n');git(seed,'remote','add','origin',remote);git(seed,'push','-u','origin','main');git(base,'clone',remote,local);git(base,'clone',remote,peer);setup(local);setup(peer);
 const logs=[];const engine=new Engine(local,(...x)=>logs.push(x),path.join(base,'state'));
 return {base,remote,local,peer,engine,logs};
}
async function run(f,event='onLoad',strategy) { return f.engine.run(event,strategy?{strategy}:undefined,new AbortController().signal); }
async function expectCode(fn,code) { await assert.rejects(fn,e=>e instanceof SyncError && e.code===code); }
function refs(f) { return git(f.remote,'for-each-ref','--format=%(refname)','refs/heads/ogit'); }
function assertMerged(f) { assert.notEqual(git(f.remote,'rev-list','--min-parents=2','--max-count=1','main'),''); }

async function failuresAndConfiguration() {
 const f=await fixture('network-failure');await run(f);
 let fetches=0;const originalFetch=f.engine.fetch.bind(f.engine);
 f.engine.fetch=async()=>{fetches++;return originalFetch()};
 await write(f.local,'retry.md','first local snapshot\n');
 const originalGit=f.engine.git.bind(f.engine);let failLfs=true;
 f.engine.git=async(args,...rest)=>{
   if(failLfs&&args[0]==='lfs'&&args[1]==='push')throw new CommandError(args,'Failed to connect to server',false);
   return originalGit(args,...rest);
 };
 const remoteBefore=git(f.remote,'rev-parse','main');
 await assert.rejects(()=>run(f,'onSave'),e=>e.code==='network'&&e.transient);
 assert.equal(git(f.remote,'rev-parse','main'),remoteBefore);
 assert.equal(git(f.local,'status','--porcelain'),'');
 assert.equal(fetches,0); // A failed LFS upload cannot be mistaken for a successful Git push.
 await write(f.local,'retry.md','latest local snapshot\n');failLfs=false;
 await run(f,'onSave');
 assert.equal(fetches,0);assert.equal(git(f.remote,'show','main:retry.md'),'latest local snapshot');
 const record=JSON.parse(git(f.local,'log','-1','--format=%B').split('Ogit-Metadata-Begin\n')[1].split('\nOgit-Metadata-End')[0]);
 assert.equal(record.event,'onSave');assert.equal(record.retryOf,undefined);
 // Explicit manual retry remains available for a blocked task.
 await f.engine.run('onRetry',{retryOf:'onSave'},new AbortController().signal);assert.equal(fetches,0);
 await f.engine.run('onRetry',{retryOf:'onLoad'},new AbortController().signal);assert.equal(fetches,1);

 await write(f.local,'retry.md','push transport failure\n');let failPush=true;
 f.engine.git=async(args,...rest)=>{
   if(failPush&&args[0]==='push')throw new CommandError(args,'Connection reset by peer',false);
   return originalGit(args,...rest);
 };
 await assert.rejects(()=>run(f,'onSave'),e=>e.code==='network'&&e.transient);
 failPush=false;await run(f,'onCron');
 assert.equal(git(f.remote,'show','main:retry.md'),'push transport failure');
 await write(f.local,'retry.md','accepted before disconnect\n');
 f.engine.git=async(args,...rest)=>{
   const result=await originalGit(args,...rest);
   if(args[0]==='push')throw new CommandError(args,'Connection reset by peer',false);
   return result;
 };
 await run(f,'onSave');assert.equal(git(f.remote,'show','main:retry.md'),'accepted before disconnect');
 f.engine.git=originalGit;

 // Failed protection must not apply the remote tree. A later startup can merge safely.
 const b=await fixture('backup-failure');await run(b);git(b.peer,'pull','--ff-only');
 await commit(b.peer,'remote.md','remote\n');git(b.peer,'push');await write(b.local,'local.md','local\n');
 const backupGit=b.engine.git.bind(b.engine);let failBackup=true;
 b.engine.git=async(args,...rest)=>{
   if(failBackup&&args[0]==='push'&&args.some(arg=>arg.includes('ogit/recovery/')))throw new CommandError(args,'Could not resolve host: example.invalid',false);
   return backupGit(args,...rest);
 };
 await assert.rejects(()=>run(b),e=>e.code==='backup'&&e.transient);
 assert.equal(await fs.readFile(path.join(b.local,'local.md'),'utf8'),'local\n');
 assert.equal(git(b.local,'ls-tree','--name-only','HEAD','remote.md'),'');
 failBackup=false;await run(b);assertMerged(b);
 assert.equal(await fs.readFile(path.join(b.local,'remote.md'),'utf8'),'remote\n');

 // A timeout after checkout but before update-ref leaves pending evidence and blocks all retries.
 const t=await fixture('timeout-apply');await run(t);git(t.peer,'pull','--ff-only');
 await commit(t.peer,'remote.md','remote\n');git(t.peer,'push');
 const timeoutGit=t.engine.git.bind(t.engine);
 t.engine.git=async(args,...rest)=>{
   const result=await timeoutGit(args,...rest);
   if(args[0]==='read-tree'&&args[1]==='-m')throw new CommandError(args,'Connection timed out',true);
   return result;
 };
 await assert.rejects(()=>run(t),e=>e.code==='operation'&&!e.transient);
 const stateDir=path.join(t.base,'state',(await fs.readdir(path.join(t.base,'state')))[0]);
 const pending=JSON.parse(await fs.readFile(path.join(stateDir,'pending.json'),'utf8'));
 assert.equal(pending.phase,'apply');assert.ok(pending.resultCommit);assert.ok(pending.temporaryWorktree);
 await expectCode(()=>run(t),'interrupted');
 assert.ok(refs(t).includes('/result'));

 // Repository identity must still match at the push boundary.
 const r=await fixture('config-race');await run(r);const previous=git(r.remote,'rev-parse','main');
 const other=path.join(r.base,'other.git');git(r.base,'init','--bare','--initial-branch=main',other);
 let action;const engine=new Engine(r.local,(_,d)=>{if(d?.phase==='push'&&action){const execute=action;action=undefined;execute()}},path.join(r.base,'state'));
 await write(r.local,'changed.md','keep locally\n');action=()=>git(r.local,'remote','set-url','origin',other);
 await expectCode(()=>engine.run('onSave',undefined,new AbortController().signal),'changed');
 assert.equal(git(r.remote,'rev-parse','main'),previous);assert.equal(git(other,'for-each-ref','--format=%(refname)'),'');
 git(r.local,'remote','set-url','origin',r.remote);git(r.local,'branch','alternate');
 await write(r.local,'branch-check.md','keep locally\n');action=()=>git(r.local,'checkout','alternate');
 await expectCode(()=>engine.run('onSave',undefined,new AbortController().signal),'changed');
 assert.equal(git(r.remote,'rev-parse','main'),previous);git(r.local,'checkout','main');
 git(r.local,'update-index','--assume-unchanged','note.md');await expectCode(()=>run(r),'unsupported');git(r.local,'update-index','--no-assume-unchanged','note.md');

 const cfg=parseConfig('{"maxFileMiB":1,"monthlyBackupEnabled":false,"lfsExtensions":["bin"]}');
 const custom=await fixture('custom-config');custom.engine=new Engine(custom.local,()=>{},path.join(custom.base,'state'),cfg);
 await write(custom.local,'asset.BIN',Buffer.from([0,1,2]));await run(custom);
 assert.match(git(custom.remote,'show','main:asset.BIN'),/^version https:\/\/git-lfs.github.com\/spec\/v1/);
 assert.equal(git(custom.remote,'for-each-ref','--format=%(refname)','refs/heads/ogit/monthly'),'');
 await write(custom.local,'large.md',Buffer.alloc(1024*1024+1));await expectCode(()=>run(custom,'onSave'),'size');
 console.log('PASS normal events after transport failures, manual retry modes, accepted push confirmation, backup before apply, uncertain timeout evidence, repository races, configurable limits/LFS/monthly');
}

async function sizes() {
 const f=await fixture('size');const {local,engine}=f,limit=DEFAULT_CONFIG.maxFileMiB*1024*1024;
 const hook=path.join(local,'.git/hooks/pre-commit'),hookText='#!/bin/sh\nexit 0\n';await write(local,'.git/hooks/pre-commit',hookText);await fs.chmod(hook,0o755);
 await commit(local,'.gitattributes','*.bin filter=lfs diff=lfs merge=lfs -text\n');await run(f);
 for(const ext of ['md','bin']){
   const name='中文 空格.'+ext;
   for(const bytes of [limit-1,limit,limit+1]){
     await write(local,name,Buffer.alloc(bytes,65));git(local,'add','--',name);
     if(bytes>limit)await assert.rejects(()=>engine.checkCommitSize(),e=>e.code==='size'&&e.files[0].path===name&&e.files[0].bytes===bytes);
     else await engine.checkCommitSize();
     git(local,'restore','--staged','--',name);
   }
   await fs.rm(path.join(local,name));
 }
 await write(local,'staged.md',Buffer.alloc(limit+1,66));git(local,'add','staged.md');await write(local,'staged.md','small worktree\n');
 await expectCode(()=>engine.checkCommitSize(),'size');git(local,'restore','--staged','staged.md');await fs.rm(path.join(local,'staged.md'));
 await write(local,'oversized.md',Buffer.alloc(limit+1,67));const before=git(local,'rev-parse','HEAD');
 await expectCode(()=>run(f,'onSave'),'size');assert.equal(git(local,'rev-parse','HEAD'),before);
 assert.equal((await fs.stat(path.join(local,'oversized.md'))).size,limit+1);
 assert.ok(git(local,'diff','--cached','--name-only').includes('oversized.md'));assert.equal(await fs.readFile(hook,'utf8'),hookText);
 git(local,'commit','-m','test: manual commit is not constrained');await run(f,'onSave');
 console.log('PASS ordinary/LFS size boundaries, staged content, data retention, existing hooks and manual commits');
}

async function monthly() {
 const f=await fixture('monthly'),{local,remote,engine}=f;
 const hook=path.join(remote,'hooks/pre-receive');await write(remote,'hooks/pre-receive','#!/bin/sh\nwhile read old new ref; do\ncase "$ref" in refs/heads/ogit/monthly/*) exit 1;; esac\ndone\nexit 0\n');await fs.chmod(hook,0o755);
 const NativeDate=Date;let fakeTime=new NativeDate(2026,0,20,12).getTime();
 global.Date=class extends NativeDate{constructor(...args){super(...(args.length?args:[fakeTime]))}static now(){return fakeTime}};
 try {
   await run(f);const first=git(local,'rev-parse','HEAD');assert.equal(git(remote,'rev-parse','main'),first);
   assert.equal(git(remote,'for-each-ref','--format=%(refname)','refs/heads/ogit/monthly'),'');
   const stateDir=path.join(f.base,'state',(await fs.readdir(path.join(f.base,'state')))[0]);
   const pendingFile=path.join(stateDir,'monthly-pending.json'),pending=JSON.parse(await fs.readFile(pendingFile,'utf8'));
   assert.equal(pending.length,1);assert.equal(pending[0].commit,first);assert.ok(pending[0].ref.includes('/2026-01/'));
   assert.equal(git(local,'status','--porcelain'),'');
   const failures=f.logs.filter(x=>x[0]==='Monthly backup deferred').length;
   await write(local,'note.md','second\n');await run(f,'onSave');
   assert.equal(f.logs.filter(x=>x[0]==='Monthly backup deferred').length,failures);
   assert.equal(JSON.parse(await fs.readFile(pendingFile,'utf8'))[0].commit,first);
   await fs.rm(hook);await run(f,'onCron');assert.equal(git(remote,'for-each-ref','--format=%(refname)','refs/heads/ogit/monthly'),'');
   fakeTime=new NativeDate(2026,2,5,12).getTime();f.engine=new Engine(local,(...x)=>f.logs.push(x),path.join(f.base,'state'));
   await run(f);const branches=git(remote,'for-each-ref','--format=%(refname)','refs/heads/ogit/monthly').split('\n');
   assert.equal(branches.length,2);assert.ok(branches.some(ref=>ref.includes('/2026-01/')));assert.ok(branches.some(ref=>ref.includes('/2026-03/')));
   assert.ok(!branches.some(ref=>ref.includes('/2026-02/')));assert.equal(git(remote,'rev-parse',pending[0].ref),first);
   assert.equal(JSON.parse(await fs.readFile(pendingFile,'utf8')).length,0);
 } finally { global.Date=NativeDate; }
 console.log('PASS optional monthly failure, quiet daily checks, cross-month restart retry, first snapshot preservation');
}

async function main() {
 root=await fs.mkdtemp(path.join(os.tmpdir(),'ogit-integration-'));
 const bundle=path.join(root,'engine.cjs');await build({stdin:{contents:"export * from './src/sync'; export * from './src/git'; export * from './src/config';",resolveDir:process.cwd()},bundle:true,platform:'node',format:'cjs',outfile:bundle});({GitSyncEngine:Engine,SyncError,CommandError,DEFAULT_CONFIG,parseConfig}=require(bundle));
 console.log('Isolated fixtures:',root);
 const f=await fixture('normal');await run(f);assert.equal(git(f.local,'rev-parse','HEAD'),git(f.remote,'rev-parse','main'));assert.ok(refs(f).includes('ogit/monthly/'));
 const monthlyBefore=git(f.remote,'for-each-ref','--format=%(objectname)','refs/heads/ogit/monthly');
 await fs.rename(path.join(f.local,'note.md'),path.join(f.local,'moved-note.md'));await run(f,'onSave');
 assert.equal(git(f.remote,'ls-tree','--name-only','main','note.md'),'');assert.equal(git(f.remote,'show','main:moved-note.md'),'base');
 await fs.rm(path.join(f.local,'moved-note.md'));await run(f,'onSave');assert.equal(git(f.remote,'ls-tree','--name-only','main','moved-note.md'),'');
 await write(f.local,'photo.PNG',Buffer.from([137,80,78,71,0,1,2,3,4]));await run(f,'onSave');
 assert.match(git(f.remote,'show','main:photo.PNG'),/^version https:\/\/git-lfs.github.com\/spec\/v1/);assert.equal(git(f.remote,'for-each-ref','--format=%(objectname)','refs/heads/ogit/monthly'),monthlyBefore);
 const clone=path.join(f.base,'lfs-verify');git(f.base,'clone',f.remote,clone);setup(clone);git(clone,'lfs','pull');assert.deepEqual(await fs.readFile(path.join(clone,'photo.PNG')),Buffer.from([137,80,78,71,0,1,2,3,4]));
 git(f.peer,'pull','--ff-only');await commit(f.peer,'remote.md','remote\n');git(f.peer,'push');await write(f.local,'local.md','local\n');git(f.local,'config','rebase.updateRefs','true');await run(f,'onLoad');assert.equal(await fs.readFile(path.join(f.local,'remote.md'),'utf8'),'remote\n');assertMerged(f);assert.ok(refs(f).includes('startup-merge'));
 console.log('PASS startup, snapshots, tracked renames/deletions, monthly immutability, LFS roundtrip, automatic merge with both histories');
 git(f.peer,'pull','--ff-only');await commit(f.peer,'new.md','new remote\n');git(f.peer,'push');await write(f.local,'daily.md','daily\n');const beforeRemote=git(f.remote,'rev-parse','main');await expectCode(()=>run(f,'onSave'),'rejected');assert.equal(git(f.remote,'rev-parse','main'),beforeRemote);assert.equal(await fs.readFile(path.join(f.local,'daily.md'),'utf8'),'daily\n');assert.ok(refs(f).includes('push-rejected'));
 await run(f,'onResolve','local');assertMerged(f);assert.equal(git(f.remote,'ls-tree','--name-only','main','new.md'),'');
 const msg=git(f.remote,'log','-1','--format=%B','main');const metadata=JSON.parse(msg.split('Ogit-Metadata-Begin\n')[1].split('\nOgit-Metadata-End')[0]);assert.equal(metadata.schemaVersion,2);assert.deepEqual(metadata.parents,git(f.remote,'rev-list','--parents','-n','1','main').split(' ').slice(1));assert.equal(metadata.parents[0],beforeRemote);assert.equal(metadata.parents[1],metadata.localCommit);assert.equal(metadata.strategy,'local');assert.equal(metadata.resultTree,git(f.remote,'rev-parse','main^{tree}'));assert.equal(git(f.remote,'rev-parse',metadata.remoteRecoveryRef),beforeRemote);
 console.log('PASS daily rejection without merge, recovery uploads, keep-local merge commit, JSON recovery metadata');
 const c=await fixture('conflict');await run(c);git(c.peer,'pull','--ff-only');await commit(c.peer,'note.md','remote conflict\n');git(c.peer,'push');await write(c.local,'note.md','local conflict\n');await expectCode(()=>run(c),'conflict');assert.equal(await fs.readFile(path.join(c.local,'note.md'),'utf8'),'local conflict\n');assert.equal(git(c.local,'status','--porcelain'),'');await run(c,'onResolve','remote');assert.equal(await fs.readFile(path.join(c.local,'note.md'),'utf8'),'remote conflict\n');assertMerged(c);
 const remoteMeta=JSON.parse(git(c.remote,'log','-1','--format=%B','main').split('Ogit-Metadata-Begin\n')[1].split('\nOgit-Metadata-End')[0]);assert.equal(remoteMeta.strategy,'remote');assert.equal(git(c.remote,'show',`${remoteMeta.localRecoveryRef}:note.md`),'local conflict');
 console.log('PASS conflicting merge leaves Vault intact, keep-remote, both original contents recoverable');
 await write(c.local,'stage.md','stage\n');git(c.local,'add','stage.md');await expectCode(()=>run(c),'staged');git(c.local,'restore','--staged','stage.md');
 const outer=path.join(root,'not-repo');await fs.mkdir(outer);await expectCode(()=>new Engine(outer,()=>{},path.join(root,'state')).run('onLoad',undefined,new AbortController().signal),'root');
 git(c.local,'branch','--unset-upstream');await expectCode(()=>run(c),'upstream');git(c.local,'branch','--set-upstream-to=origin/main');
 await fs.writeFile(path.join(c.local,'.git','ogit-sync.lock'),'test lock');await expectCode(()=>run(c),'locked');await fs.rm(path.join(c.local,'.git','ogit-sync.lock'));
 const signal=new AbortController();signal.abort();await expectCode(()=>c.engine.run('onLoad',undefined,signal.signal),'cancelled');
 console.log('PASS staged protection, invalid root/upstream, repository lock, cancelled start');
  const r=await fixture('concurrent-edit');await run(r);git(r.peer,'pull','--ff-only');await commit(r.peer,'remote.md','remote\n');git(r.peer,'push');await write(r.local,'local.md','before\n');
 let edited=false;r.engine=new Engine(r.local,(event,details)=>{if(!edited&&details?.phase==='prepare-worktree'){edited=true;require('node:fs').writeFileSync(path.join(r.local,'local.md'),'edited during sync\n')}},path.join(r.base,'state'));
 await expectCode(()=>run(r),'changed');assert.equal(await fs.readFile(path.join(r.local,'local.md'),'utf8'),'edited during sync\n');assert.equal(git(r.remote,'ls-tree','--name-only','main','local.md'),'');
 console.log('PASS concurrent edits prevent Vault replacement');
 const o=await fixture('ignored-obstruction');await write(o.local,'.gitignore','obstruct.txt\n');await run(o);git(o.peer,'pull','--ff-only');await write(o.peer,'obstruct.txt','remote tracked\n');git(o.peer,'add','-f','obstruct.txt');git(o.peer,'commit','-m','test: remote obstruction');git(o.peer,'push');await write(o.local,'obstruct.txt','local ignored\n');await expectCode(()=>run(o),'changed');assert.equal(await fs.readFile(path.join(o.local,'obstruct.txt'),'utf8'),'local ignored\n');
 console.log('PASS ignored files are never overwritten by checkout');
 const h=await fixture('merge-history');git(h.local,'checkout','-b','feature');await commit(h.local,'feature.md','feature\n');git(h.local,'checkout','main');git(h.local,'merge','--no-ff','feature','-m','test: existing merge');const existingMerge=git(h.local,'rev-parse','HEAD');await run(h);assert.equal(git(h.remote,'merge-base',existingMerge,'main'),existingMerge);
 console.log('PASS existing merge history is accepted and preserved');
 const b=await fixture('backup-rejected');await run(b);git(b.peer,'pull','--ff-only');await commit(b.peer,'remote.md','remote\n');git(b.peer,'push');await write(b.local,'local.md','local\n');await write(b.remote,'hooks/pre-receive','#!/bin/sh\nwhile read old new ref; do\ncase "$ref" in refs/heads/ogit/*) exit 1;; esac\ndone\nexit 0\n');await fs.chmod(path.join(b.remote,'hooks/pre-receive'),0o755);await expectCode(()=>run(b),'backup');assert.equal(await fs.readFile(path.join(b.local,'local.md'),'utf8'),'local\n');assert.ok(git(b.local,'for-each-ref','--format=%(refname)','refs/heads/ogit/recovery').includes('startup-merge'));
 console.log('PASS backup rejection stops integration and preserves local refs');
 const i=await fixture('interrupted');await run(i);const stateEntries=await fs.readdir(path.join(i.base,'state'));await fs.writeFile(path.join(i.base,'state',stateEntries[0],'pending.json'),JSON.stringify({phase:'apply'}));await expectCode(()=>run(i),'interrupted');
 console.log('PASS interrupted operation requires manual audit');
  const rw=await fixture('remote-rewritten');await run(rw);const previous=git(rw.local,'rev-parse','HEAD');const detached=git(rw.peer,'commit-tree','HEAD^{tree}','-m','test: unrelated rewritten root');git(rw.peer,'update-ref','refs/heads/main',detached);git(rw.peer,'push','--force','origin','main');await expectCode(()=>run(rw),'conflict');const previousRefs=git(rw.remote,'for-each-ref','--format=%(refname) %(objectname)','refs/heads/ogit/recovery');assert.ok(previousRefs.includes('/previous-remote '+previous));
 console.log('PASS rewritten upstream preserves previous remote snapshot');
 const u=await fixture('unrelated');const unrelated=git(u.local,'commit-tree','HEAD^{tree}','-m','test: unrelated local root');git(u.local,'update-ref','refs/heads/main',unrelated);await expectCode(()=>run(u),'conflict');await run(u,'onResolve','remote');assertMerged(u);
 console.log('PASS unrelated histories require explicit resolution, resolved main retains both histories');
 await failuresAndConfiguration();
 await sizes();
 await monthly();
 console.log('ALL SYNC CHECKS PASSED');
 // Preserve fixtures for audit; their location is printed above. No user repository is touched.
}
main().catch(e=>{console.error(e);console.error('Fixtures retained:',root);process.exitCode=1});





