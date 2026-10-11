#!/usr/bin/env node
import { readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { request } from './client.js';
import { actionSchema, rpcSchema, errorData, AppError, type RPC } from './protocol.js';
export const help = `Bookmark Agent — JSON output, automatic single-profile selection

  status
  tree [ID]
  get ID | children ID
  search [TEXT] [--domain HOST] [--folder ID] [--limit N] [--offset N]
  duplicates [--ignore-fragment]
  rediscover [--limit N]
  export --output FILE

  create --parent ID --title TEXT --url URL
  folder --parent ID --title TEXT
  update ID [--title TEXT] [--url URL]
  move ID --parent ID [--index N]
  remove ID [--recursive]
  preview --file PLAN.json
  commit PREVIEW_UUID --confirm

  The sole connected Chrome profile is selected automatically.
  With multiple profiles, add --profile "LABEL" (or a stable profile ID).
  --session UUID remains available for explicit session selection.

  All change commands return a preview. Commit is a separate explicit command.
  PLAN.json is an array of actions, e.g. [{"op":"move","id":"10","parentId":"2"}].
  Export never overwrites an existing file. No automatic request retries.
  Add --scope FOLDER_ID (repeat for multiple folders) to restrict reads and writes.
  Subfolders are included by default; --direct-only excludes their contents.
  Selected scope folders themselves cannot be renamed, moved or deleted.
  Exit codes: 0 success, 1 service failure, 2 invalid command.
`;
export function parse(argv: string[]) {
  const [command, ...rest] = argv;
  if (!command || ['help', '--help', '-h'].includes(command)) return { help: true } as const;
  const flags: Record<string, unknown> = {}, positional: string[] = [];
  const names: Record<string, string> = { session: 'sessionId', profile: 'profile', parent: 'parentId', title: 'title', url: 'url', index: 'index',
    limit: 'limit', offset: 'offset', domain: 'domain', folder: 'folderId', output: 'output', file: 'file', recursive: 'recursive', confirm: 'confirm', 'ignore-fragment': 'ignoreFragment', scope: 'scopeIds', 'direct-only': 'directOnly' };
  for (let i = 0; i < rest.length; i++) {
    const argument = rest[i];
    if (!argument.startsWith('--')) { positional.push(argument); continue; }
    const name = names[argument.slice(2)];
    if (!name || name !== 'scopeIds' && Object.hasOwn(flags, name)) throw new Error(`Unknown or duplicate flag ${argument}`);
    if (['recursive', 'confirm', 'ignoreFragment', 'directOnly'].includes(name)) flags[name] = true;
    else {
      const value = rest[++i]; if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for ${argument}`);
      if (['index', 'limit', 'offset'].includes(name) && !/^\d+$/.test(value)) throw new Error(`${argument} requires an integer`);
      if (name === 'scopeIds') flags[name] = [...flags[name] as string[] ?? [], value];
      else flags[name] = ['index', 'limit', 'offset'].includes(name) ? Number(value) : value;
    }
  }
  const { sessionId, profile, output, file, scopeIds, directOnly, ...params } = flags;
  if (directOnly && !scopeIds) throw new Error('--direct-only requires --scope');
  const scope = scopeIds ? { folderIds: scopeIds as string[], includeDescendants: !directOnly } : undefined;
  if (sessionId !== undefined && (typeof sessionId !== 'string' || !/^[a-f0-9-]{36}$/i.test(sessionId))) throw new Error('--session must be a UUID');
  if (profile !== undefined && (typeof profile !== 'string' || !profile.trim() || profile.length > 256)) throw new Error('--profile needs a nonempty label or stable profile ID (maximum 256 characters)');
  if (sessionId && profile !== undefined) throw new Error('Use either --session or --profile, not both');
  let method = command;
  if (['get', 'children', 'update', 'move', 'remove', 'commit'].includes(command)) {
    if (positional.length !== 1) throw new Error(`${command} needs one ID`);
    params[command === 'commit' ? 'previewId' : 'id'] = positional[0];
  } else if (command === 'tree') {
    if (positional.length > 1) throw new Error('tree accepts at most one ID');
    if (positional[0]) params.id = positional[0];
  } else if (command === 'search') {
    if (positional.length > 1) throw new Error('Quote multiword queries');
    if (positional[0]) params.query = positional[0];
  } else if (positional.length) throw new Error('Unexpected positional argument');
  if (command === 'status') {
    if (sessionId || profile !== undefined || output || file || scope || Object.keys(params).length) throw new Error('status takes no arguments');
    return { method: 'status', params: {} } as const;
  }
  if (output && command !== 'export') throw new Error('--output is only for export');
  if (file && command !== 'preview') throw new Error('--file is only for preview');
  if (command === 'export' && typeof output !== 'string') throw new Error('export requires --output FILE');
  let finalParams: Record<string, unknown> = params;
  if (['create', 'folder', 'update', 'move', 'remove'].includes(command)) {
    const action = actionSchema.parse({ op: command, ...params });
    method = 'preview'; finalParams = { actions: [action] };
  } else if (command === 'preview') {
    if (typeof file !== 'string' || Object.keys(params).length) throw new Error('preview requires --file and no action flags');
    finalParams = { actions: JSON.parse(readFileSync(file, 'utf8')) };
  }
  const rpc = rpcSchema.parse({ method, params: { ...finalParams, ...(scope ? { scope } : {}) } });
  return { method: rpc.method, params: rpc.params, sessionId: sessionId as string | undefined, profile: (profile as string | undefined)?.trim(), output: output as string | undefined };
}
async function main() {
  let p;
  try { p = parse(process.argv.slice(2)); }
  catch (e) { console.log(JSON.stringify({ ok: false, error: { code: 'INVALID_COMMAND', message: e instanceof Error ? e.message : String(e) } })); process.exitCode = 2; return; }
  if ('help' in p) { console.log(help); return; }
  try {
    let result = await request(p.method, p.params, { sessionId: 'sessionId' in p ? p.sessionId : undefined, profile: 'profile' in p ? p.profile : undefined });
    if (p.method === 'export' && result.ok && 'output' in p && p.output) {
      writeFileSync(p.output, JSON.stringify(result.data, null, 2), { flag: 'wx', mode: 0o600 }); result = { ok: true, data: { output: p.output } };
    }
    console.log(JSON.stringify(result, null, 2)); if (!result.ok) process.exitCode = 1;
  } catch (e) { console.log(JSON.stringify({ ok: false, error: errorData(e) })); process.exitCode = 1; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href) await main();
