const $ = (id: string) => document.getElementById(id)!;
const label = $('label') as HTMLInputElement, enabled = $('enabled') as HTMLInputElement;
let localPort = 32180;
async function refresh() {
  const status = await chrome.runtime.sendMessage({ type: 'status' });
  $('status').textContent = `${status.message || 'Disconnected'}${status.profileId ? '\nProfile ID: ' + status.profileId : ''}${status.sessionId ? '\nSession ID: ' + status.sessionId : ''}`;
  if (status.port) localPort = status.port;
}
const prefs = await chrome.storage.local.get(['profileLabel', 'enabled']);
label.value = typeof prefs.profileLabel === 'string' ? prefs.profileLabel : 'Chrome profile'; enabled.checked = !!prefs.enabled;
$('settings').addEventListener('submit', async e => {
  e.preventDefault();
  const response = await chrome.runtime.sendMessage({ type: 'configure', settings: { profileLabel: label.value, enabled: enabled.checked } });
  if (!response.ok) $('status').textContent = response.error.message; else await refresh();
});
$('open').addEventListener('click', () => { void chrome.tabs.create({ url: `http://127.0.0.1:${localPort}/` }); });
await refresh(); setInterval(() => { void refresh(); }, 2000);
