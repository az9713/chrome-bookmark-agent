import { z } from 'zod';
import { readOperation, applyActions } from '../operations.js';
import { AppError, errorData, actionSchema, type BookmarkAPI } from '../protocol.js';
const HOST = 'com.bookmark_agent.next';
let port: chrome.runtime.Port | undefined, connecting = false, tail = Promise.resolve();
let status: Record<string, unknown> = { connected: false, enabled: false, message: 'Enable access in extension settings' };
async function digest(tree: unknown) { const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(tree))); return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join(''); }
const applySchema = z.object({ method: z.literal('apply'), params: z.object({ actions: z.array(actionSchema).min(1).max(100), digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict() }).strict();
async function connect() {
  if (port || connecting) return;
  connecting = true;
  try {
    const prefs = await chrome.storage.local.get(['enabled', 'profileId', 'profileLabel']);
    if (!prefs.enabled) return;
    const profileId = prefs.profileId || crypto.randomUUID(), profileLabel = prefs.profileLabel || 'Chrome profile';
    await chrome.storage.local.set({ profileId });
    const current = chrome.runtime.connectNative(HOST); port = current;
    status = { connected: false, enabled: true, profileId, profileLabel, message: 'Connecting to local service' };
    current.onDisconnect.addListener(() => {
      const message = chrome.runtime.lastError?.message || 'Native host disconnected';
      if (port !== current) return;
      port = undefined; status = { ...status, connected: false, message };
      void chrome.action.setBadgeText({ text: 'OFF' });
      setTimeout(() => { void connect(); }, 5000);
    });
    current.onMessage.addListener(message => {
      if (message.type === 'ready') {
        status = { ...status, connected: true, sessionId: message.sessionId, port: message.port, message: 'Connected' };
        void chrome.action.setBadgeText({ text: 'ON' }); void chrome.action.setBadgeBackgroundColor({ color: '#227a60' });
      } else if (message.type === 'offline') {
        status = { ...status, connected: false, message: message.message }; void chrome.action.setBadgeText({ text: 'OFF' });
      } else if (message.type === 'request') {
        tail = tail.catch(() => {}).then(async () => {
          if (port !== current || !status.connected) return;
          try {
            const api = chrome.bookmarks as unknown as BookmarkAPI;
            let data: unknown;
            if (message.command?.method === 'apply') {
              const p = applySchema.parse(message.command).params;
              const tree = await api.getTree();
              if (await digest(tree) !== p.digest) throw new AppError('STALE_PREVIEW', 'Bookmarks changed; preview again');
              data = await applyActions(api, p.actions, JSON.stringify(tree));
            } else data = await readOperation(api, message.command);
            if (port === current) current.postMessage({ type: 'response', id: message.id, ok: true, data });
          } catch (e) {
            if (port === current) current.postMessage({ type: 'response', id: message.id, ok: false, error: errorData(e) });
          }
        });
      }
    });
    current.postMessage({ type: 'hello', profileId, profileLabel, extensionId: chrome.runtime.id });
  } catch (e) { status = { connected: false, enabled: true, message: e instanceof Error ? e.message : String(e) }; port = undefined; }
  finally { connecting = false; }
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('options.html')) return;
  if (message.type === 'status') { reply(status); return; }
  if (message.type === 'configure') {
    void (async () => {
      const settings = z.object({ enabled: z.boolean(), profileLabel: z.string().trim().min(1).max(100) }).parse(message.settings);
      await chrome.storage.local.set(settings);
      const old = port; port = undefined; old?.disconnect();
      status = { enabled: settings.enabled, connected: false, profileLabel: settings.profileLabel, message: settings.enabled ? 'Connecting' : 'Access disabled' };
      if (settings.enabled) await connect();
      reply({ ok: true, status });
    })().catch(e => reply({ ok: false, error: errorData(e) })); return true;
  }
});
const initialize = () => { void chrome.alarms.create('reconnect', { periodInMinutes: 0.5 }); void connect(); };
chrome.runtime.onInstalled.addListener(initialize); chrome.runtime.onStartup.addListener(initialize);
chrome.alarms.onAlarm.addListener(a => { if (a.name === 'reconnect') void connect(); });
chrome.action.onClicked.addListener(() => { void chrome.runtime.openOptionsPage(); });
void connect();
