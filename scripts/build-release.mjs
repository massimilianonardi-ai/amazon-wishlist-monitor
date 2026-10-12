import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { name, version } = JSON.parse(await fs.readFile(path.join(root, 'package.json')));
if (name !== 'amazon-wishlist-monitor' || !/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error('invalid monitor version');
}
const dist = path.join(root, 'dist');
const stage = path.join(dist, 'stage');
const target = path.join(stage, name);
await fs.rm(dist, { recursive: true, force: true });
await fs.mkdir(target, { recursive: true });
for (const entry of ['README.md', 'package.json', 'bin', 'src']) {
  await fs.cp(path.join(root, entry), path.join(target, entry), { recursive: true });
}
const archiveName = name + '-v' + version + '-all.tar.gz';
const archive = path.join(dist, archiveName);
await new Promise((resolve, reject) => {
  const child = spawn('tar', ['-czf', archive, '-C', stage, name], { stdio: 'inherit' });
  child.once('error', reject);
  child.once('exit', code => code === 0 ? resolve() : reject(new Error('tar exited with ' + code)));
});
await fs.writeFile(path.join(dist, 'release-artifact'), archiveName + '\n');
process.stdout.write(archive + '\n');
