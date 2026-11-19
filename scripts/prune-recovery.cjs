// Manual cleanup of old ogit/recovery/* branches (local and on the upstream remote); ogit/monthly/* is never touched.
// Usage: node scripts/prune-recovery.cjs [Vault path] [days=90] [--delete]
// Lists matching branches by default; nothing is deleted without --delete. Deletion cannot be undone.
// Age comes from the UTC timestamp in the branch name only: it does NOT check whether the commits were merged.
const {execFileSync} = require('node:child_process');
const path = require('node:path');
const args = process.argv.slice(2).filter(arg => arg !== '--delete');
const remove = process.argv.includes('--delete');
const days = Number(args.find(arg => /^\d+$/.test(arg)) ?? 90);
const cwd = path.resolve(args.find(arg => !/^\d+$/.test(arg)) ?? path.join(__dirname,'../../../..'));
const git = (...argv) => execFileSync('git',argv,{cwd,encoding:'utf8',windowsHide:true}).trim();
const lines = text => text.split('\n').filter(Boolean);

// refs/heads/ogit/recovery/<reason>/<YYYYMMDD>T<HHMMSSmmm>Z-<device>-<random>/<local|remote|result>
const NAME = /^refs\/heads\/ogit\/recovery\/[^/]+\/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})\d{3}Z-/;
const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
// Names that do not parse are kept
const old = ref => { const m = ref.match(NAME); return !!m && Date.UTC(m[1],m[2]-1,m[3],m[4],m[5],m[6]) < cutoff; };

const branch = git('symbolic-ref','--short','HEAD');
const remote = git('config','--get',`branch.${branch}.remote`);
const remoteRefs = lines(git('ls-remote','--refs',remote,'refs/heads/ogit/recovery/*')).map(line => line.split('\t')[1]).filter(old);
const localRefs = lines(git('for-each-ref','--format=%(refname)','refs/heads/ogit/recovery')).filter(old);

for (const ref of remoteRefs) console.log(`${remote}\t${ref}`);
for (const ref of localRefs) console.log(`local\t${ref}`);
console.log(`${remoteRefs.length} on ${remote}, ${localRefs.length} local, older than ${days} days`);
if (!remove) { console.log('Nothing deleted. Add --delete to delete them.'); return; }

// Batched to stay below command-line length limits
for (let i = 0; i < remoteRefs.length; i += 100) git('push',remote,'--delete',...remoteRefs.slice(i,i + 100));
for (const ref of localRefs) git('update-ref','-d',ref);
console.log('Deleted.');
