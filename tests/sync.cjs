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
 console.log('PASS startup, snapshots, renames/deletions, monthly immutability, LFS roundtrip');

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

async function failures() {
 const n=await fixture('no-upstream');git(n.local,'branch','--unset-upstream');await expectCode(()=>run(n),'repo');
 const a=await fixture('auth');await run(a);await hook(a.remote,'pre-receive','#!/bin/sh\nexit 1\n');await write(a.local,'x.md','x\n');
 await assert.rejects(()=>run(a,'onSave'),e=>e.code==='auth'&&e.message.includes('hook declined'));
 console.log('PASS missing upstream and remote rejection stop with stderr');

 // 同步期间写入的未跟踪文件会被 read-tree 拒绝覆盖；apply 阶段失败保留 pending.json
 let edited=false;const r=await fixture('concurrent-edit',DEFAULT_CONFIG,(event,details)=>{
   if(!edited&&details?.phase==='apply'){edited=true;require('node:fs').writeFileSync(path.join(r.local,'remote.md'),'edited during sync\n')}
 });
 await run(r);await remoteCommit(r,'remote.md','remote\n');await write(r.local,'local.md','local\n');
 await expectCode(()=>run(r),'failed');assert.equal(await read(r.local,'remote.md'),'edited during sync\n');
 await expectCode(()=>run(r),'interrupted');
 console.log('PASS concurrent edit is never overwritten, apply failure requires manual audit');
}

async function sizes() {
 const config={...DEFAULT_CONFIG,maxFileMiB:1},limit=1024*1024;
 const f=await fixture('size',config);await run(f);
 for(const name of ['中文 空格.md','big.bin','big.png']){
   await write(f.local,name,Buffer.alloc(limit,65));await run(f,'onSave');
   await write(f.local,name,Buffer.alloc(limit+1,66));const before=git(f.local,'rev-parse','HEAD');
   await assert.rejects(()=>run(f,'onSave'),e=>e.code==='size'&&e.files[0].path===name&&e.files[0].bytes===limit+1);
   assert.equal(git(f.local,'rev-parse','HEAD'),before);assert.equal((await fs.stat(path.join(f.local,name))).size,limit+1);
   await fs.rm(path.join(f.local,name));await run(f,'onSave');
 }
 console.log('PASS size boundary for ordinary and LFS files, data retained');
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
