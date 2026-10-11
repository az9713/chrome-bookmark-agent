import WebSocket from 'ws';
import { loadConfig } from './config.js';
import { NativeDecoder, encode } from './framing.js';
import { helloSchema } from './protocol.js';
const config = loadConfig();
if (!config.extensionId || process.argv[2] !== `chrome-extension://${config.extensionId}/`) {
  process.stderr.write('Unexpected extension origin\n'); process.exit(1);
}
const decoder = new NativeDecoder();
let socket: WebSocket | undefined, hello: unknown, retry: ReturnType<typeof setTimeout> | undefined, stopping = false;
const send = (message: unknown) => { try { process.stdout.write(encode(message)); } catch { stop(); } };
function stop() { stopping = true; clearTimeout(retry); socket?.terminate(); process.exit(0); }
function connect() {
  if (stopping || !hello) return;
  const current = new WebSocket(`ws://127.0.0.1:${config.port}/bridge`, { headers: { Authorization: `Bearer ${config.bridgeToken}` }, maxPayload: 1024 * 1024, handshakeTimeout: 5000 });
  socket = current;
  current.on('open', () => current.send(JSON.stringify(hello)));
  current.on('message', bytes => { try { send(JSON.parse(bytes.toString())); } catch { current.terminate(); } });
  current.on('error', () => {});
  current.on('close', () => { if (socket !== current) return; socket = undefined; send({ type: 'offline', message: 'Local service unavailable. Start npm start. In-flight writes are never replayed.' }); retry = setTimeout(connect, 2000); });
}
decoder.on('message', message => {
  if (!hello) {
    try { const parsed = helloSchema.parse(message); if (parsed.extensionId !== config.extensionId) throw new Error('Origin mismatch'); hello = parsed; connect(); }
    catch { stop(); }
    return;
  }
  if (message.type !== 'response') return;
  // Reconnection never buffers or replays responses or mutation requests.
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
});
decoder.on('error', stop); process.stdin.on('data', chunk => decoder.push(chunk));
process.stdin.on('end', stop); process.stdout.on('error', stop);
process.on('SIGTERM', stop); process.on('SIGINT', stop);
