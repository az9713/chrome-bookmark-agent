import { loadConfig, type Config } from './config.js';
import { AppError, type RPC } from './protocol.js';
type ProfileSession = { sessionId: string; profileId: string; profileLabel: string };
export function selectSession(sessions: ProfileSession[], profile?: string) {
  if (!sessions.length) throw new AppError('NO_CONNECTED_PROFILE', 'Open Chrome and enable Bookmark Agent access in extension settings.');
  const matches = profile === undefined ? sessions : sessions.filter(s => s.profileId === profile || s.profileLabel.toLowerCase() === profile.toLowerCase());
  const profiles = sessions.map(({ profileId, profileLabel }) => ({ profileId, profileLabel }));
  if (!matches.length) throw new AppError('PROFILE_NOT_FOUND', `No connected profile matches ${JSON.stringify(profile)}.`, { profiles });
  if (matches.length > 1) throw new AppError(profile === undefined ? 'PROFILE_REQUIRED' : 'PROFILE_AMBIGUOUS',
    profile === undefined ? 'Several Chrome profiles are connected. Select one by label with --profile (CLI) or profile (MCP).' : 'Several profiles share this label. Give them distinct labels in extension settings, or use a stable profile ID.', { profiles });
  return matches[0].sessionId;
}
async function send(method: 'status' | RPC['method'], params: Record<string, unknown>, config: Config, sessionId?: string) {
  const status = method === 'status';
  try {
    const response = await fetch(`http://127.0.0.1:${config.port}/api/v1/${status ? 'status' : 'rpc'}`, {
      method: status ? 'GET' : 'POST', headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
      ...(status ? {} : { body: JSON.stringify({ sessionId, request: { method, params } }) }),
      signal: AbortSignal.timeout(35000)
    });
    return await response.json() as { ok: boolean; data?: any; error?: { code: string; message: string; details?: unknown } };
  } catch (e) {
    throw new AppError(method === 'commit' ? 'OUTCOME_UNKNOWN' : 'UNREACHABLE',
      method === 'commit' ? 'Connection interrupted. A write may have completed. Inspect bookmarks and backups before retrying.' : 'Local service is unreachable. Run npm start, then enable the Chrome extension.');
  }
}
export async function request(method: 'status' | RPC['method'], params: Record<string, unknown> = {}, options: { sessionId?: string; profile?: string; config?: Config } = {}) {
  const config = options.config ?? loadConfig();
  if (options.sessionId && options.profile !== undefined) throw new AppError('INVALID_PROFILE_SELECTION', 'Use either sessionId or profile, not both.');
  if (method === 'status') return send(method, params, config);
  let sessionId = options.sessionId;
  if (!sessionId) {
    const status = await send('status', {}, config);
    if (!status.ok) return status;
    sessionId = selectSession(status.data.sessions, options.profile);
  }
  return send(method, params, config, sessionId);
}
