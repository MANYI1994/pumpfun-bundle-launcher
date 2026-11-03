import { readFileSync, readdirSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const root = path.resolve(import.meta.dirname, '..');
const failures = [];
function check(test, message) { if (!test) failures.push(message); }
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json')));
check(JSON.stringify(pkg.dependencies) === JSON.stringify({ '@solana/kit': '8.6.0' }), 'Unexpected direct dependency');
check(Object.keys(pkg.devDependencies || {}).length === 0, 'Unexpected development dependency');
check(!Object.keys(pkg.scripts || {}).some(k => /^(pre|post)(install|start|test|check)/.test(k)), 'Unexpected application lifecycle hook');
const lock = JSON.parse(readFileSync(path.join(root, 'package-lock.json')));
check(Object.keys(lock.packages).length - 1 === 47, 'Dependency tree changed: review the new archives');
check(JSON.stringify(lock.packages[''].dependencies) === JSON.stringify(pkg.dependencies), 'Manifest/lockfile dependency mismatch');
for (const [name, p] of Object.entries(lock.packages)) {
  if (!name) continue;
  check(p.resolved?.startsWith('https://registry.npmjs.org/') && /^sha512-/.test(p.integrity || ''), 'Untrusted or unhashed dependency: ' + name);
  check(!p.hasInstallScript, 'Dependency installation script: ' + name);
  check(!/jsconvict|javascript-obfuscator|bigint-buffer|nft\.storage/.test(name), 'Banned dependency: ' + name);
}
const hashes = {};
function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (['node_modules', '.git'].includes(name)) continue;
    const file = path.join(dir, name), rel = path.relative(root, file), stat = lstatSync(file);
    check(!stat.isSymbolicLink(), 'Repository symlink: ' + rel);
    if (stat.isDirectory()) { walk(file); continue; }
    const b = readFileSync(file); hashes[rel] = createHash('sha256').update(b).digest('hex');
    check(!/\.(vault|pem|key|log)$/.test(name), 'Secret/log artifact: ' + rel);
    check(!['blockengine.json', 'keyInfo.json', 'config.ts', 'keys.json'].includes(name), 'Legacy key/config file: ' + rel);
    if (rel.startsWith('web/')) {
      const s = b.toString();
      check(!/\b(?:eval|Function)\s*\(|localStorage|sessionStorage|indexedDB|document\.cookie/.test(s), 'Unsafe browser execution/storage: ' + rel);
      check(!/https?:\/\/|<script[^>]+src=["']https?:/i.test(s), 'Remote browser resource: ' + rel);
      check(!/\.signAndSendTransaction\s*\(|sendRawTransaction\s*\(/.test(s), 'Browser broadcast path: ' + rel);
      check(!/secretKey|privateKey|keypair|seedPhrase|mnemonic/.test(s), 'Browser secret handling: ' + rel);
    }
    if (rel.startsWith('src/') && name.endsWith('.js')) {
      const s = b.toString();
      check(!/\bsignTransaction\b|\bsignReviewedBatch\b|crypto\.subtle\.sign\s*\(/.test(s), 'Local signing must stay outside application: ' + rel);
      check(!/async unlock\s*\(/.test(s), 'Raw vault unlock API: ' + rel);
      check(!/child_process|\beval\s*\(|new Function\s*\(|process\.env\.(?:PRIVATE|SECRET|SEED|PASSWORD)|uncaughtException/.test(s), 'Unsafe execution/secret access: ' + rel);
      check(!/console\.(?:log|error)\([^\n]*(?:secretKey|privateKey|password|seed\b)/.test(s), 'Potential secret logging: ' + rel);
      check(!/http\.request|https\.request|144\.172\.89\.234|\/exfiltrate/.test(s), 'Unexpected network payload: ' + rel);
    }
  }
}
walk(root);
if (failures.length) { console.error(failures.join('\n')); process.exitCode = 1; }
else console.log(JSON.stringify({ status: 'passed', dependencies: Object.keys(lock.packages).length - 1, files: Object.keys(hashes).length, sha256: hashes }, null, 2));
