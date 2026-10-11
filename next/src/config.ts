import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { AppError } from './protocol.js';
export const HOST_NAME = 'com.bookmark_agent.next';
export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const configDir = () => resolve(process.env.BOOKMARK_AGENT_HOME || join(projectRoot, '.runtime'));
const schema = z.object({ version: z.literal(2), port: z.number().int().min(1024).max(65535),
  token: z.string().regex(/^[a-f0-9]{64}$/), bridgeToken: z.string().regex(/^[a-f0-9]{64}$/),
  extensionId: z.string().regex(/^[a-p]{32}$/).optional() }).strict();
export type Config = z.infer<typeof schema>;
export function loadConfig(): Config {
  try { return schema.parse(JSON.parse(readFileSync(join(configDir(), 'config.json'), 'utf8'))); }
  catch { throw new AppError('NOT_CONFIGURED', 'Run npm run init-local first. Configuration is kept in .runtime/config.json.'); }
}
export function initConfig(): Config {
  const dir = configDir();
  if (existsSync(join(dir, 'config.json'))) return loadConfig();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const config: Config = { version: 2, port: 32180, token: randomBytes(32).toString('hex'), bridgeToken: randomBytes(32).toString('hex') };
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config, null, 2), { flag: 'wx', mode: 0o600 });
  return config;
}
if (process.argv.includes('--init')) { initConfig(); console.log('Local configuration created (no service, Chrome access, or registry changes). Keep .runtime private.'); }
