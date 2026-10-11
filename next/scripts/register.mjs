import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { configDir, projectRoot, HOST_NAME, loadConfig } from '../dist/config.js';
const dir = configDir(), key = `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`;
const args = process.argv.slice(2);
function run(command, argv) {
  const result = spawnSync(command, argv, { encoding: 'utf8', windowsHide: true });
  if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr || result.stdout || `${command} failed`);
  return result.stdout.trim();
}
try {
  if (process.platform !== 'win32') throw new Error('This activation script currently supports Windows. See docs/setup.md for manual native-host registration on other platforms.');
  if (args[0] === '--uninstall' && args.length === 1) {
    const result = spawnSync('reg.exe', ['query', key], { windowsHide: true });
    if (result.status === 0) {
      const entry = result.stdout.toString();
      if (!entry.includes(join(dir, 'native-host.json'))) throw new Error('Registry key belongs to another installation; refusing to remove it');
      run('reg.exe', ['delete', key, '/f']);
    }
    console.log('Unregistered native host. Disable/remove extension in Chrome. Backups and config are preserved.'); process.exit(0);
  }
  if (args.length !== 1 || args[0] !== '--activate') throw new Error('Explicit activation required: npm run setup -- --activate. This registers local Chrome access for this installation.');
  const config = loadConfig();
  const manifest = JSON.parse(readFileSync(join(projectRoot, 'dist', 'extension', 'manifest.json'), 'utf8'));
  const extensionId = [...createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32)].map(c => String.fromCharCode(97 + parseInt(c,16))).join('');
  const old = spawnSync('reg.exe', ['query', key], { windowsHide: true });
  if (old.status === 0 && !old.stdout.toString().includes(join(dir, 'native-host.json'))) throw new Error('Another native-host registration exists; refusing to overwrite it');
  const sid = run('whoami.exe', ['/user', '/fo', 'csv', '/nh']).match(/S-1-[\d-]+/)?.[0];
  if (!sid) throw new Error('Could not determine Windows user SID');
  mkdirSync(dir, { recursive: true });
  run('icacls.exe', [dir, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F']);
  const csc = [join(process.env.WINDIR, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'), join(process.env.WINDIR, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe')].find(existsSync);
  if (!csc) throw new Error('Windows .NET Framework compiler is unavailable; native launcher must be built on a machine with .NET Framework');
  const literal = s => `@"${s.replaceAll('"','""')}"`;
  const source = readFileSync(join(projectRoot, 'scripts', 'launcher.cs'), 'utf8')
    .replace('@@NODE@@', literal(process.execPath)).replace('@@HOST@@', literal(join(projectRoot, 'dist', 'native-host.js'))).replace('@@CONFIG@@', literal(dir));
  writeFileSync(join(dir, 'launcher.cs'), source);
  const launcher = join(dir, 'bookmark-agent-host.exe');
  run(csc, ['/nologo', '/target:winexe', `/out:${launcher}`, join(dir, 'launcher.cs')]);
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ ...config, extensionId }, null, 2));
  const path = join(dir, 'native-host.json');
  writeFileSync(path, JSON.stringify({ name: HOST_NAME, description: 'Bookmark Agent Chrome bridge', path: launcher, type: 'stdio', allowed_origins: [`chrome-extension://${extensionId}/`] }, null, 2));
  run('reg.exe', ['add', key, '/ve', '/t', 'REG_SZ', '/d', path, '/f']);
  console.log(JSON.stringify({ activated: true, extensionId, extensionDirectory: join(projectRoot, 'dist', 'extension'), next: 'Start npm start; load this unpacked extension in the chosen Chrome profile; enable access in extension settings.' }, null, 2));
} catch (e) { console.error(`Registration failed: ${e.message}`); process.exitCode = 1; }
