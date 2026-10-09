// Read-only recovery metadata inspection. Usage: node scripts/read-record.cjs <commit>
const {execFileSync} = require('node:child_process');
const path = require('node:path');
const ref = process.argv[2];
if (!ref || !/^[0-9a-f]{7,64}$/i.test(ref)) throw new Error('Supply a hexadecimal commit ID');
const cwd = process.argv[3] ? path.resolve(process.argv[3]) : path.resolve(__dirname,'../../../..');
const message = execFileSync('git',['show','-s','--format=%B',ref],{cwd,encoding:'utf8',windowsHide:true});
const match = message.match(/^Ogit-Metadata-Begin\r?\n([\s\S]*?)\r?\nOgit-Metadata-End$/m);
if (!match) throw new Error('No OGit metadata in this commit');
const data = JSON.parse(match[1]);
if (![1,2].includes(data.schemaVersion)) throw new Error('Unsupported metadata schema');
console.log(JSON.stringify(data,null,2));

