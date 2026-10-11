import { EventEmitter } from 'node:events';
export class NativeDecoder extends EventEmitter {
  private buffer = Buffer.alloc(0); private failed = false;
  constructor(private maxBytes = 64 * 1024 * 1024) { super(); }
  push(chunk: Buffer) {
    if (this.failed) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    try {
      while (this.buffer.length >= 4) {
        const size = this.buffer.readUInt32LE(0);
        if (!size || size > this.maxBytes) throw new Error('Native frame exceeds allowed size');
        if (this.buffer.length < size + 4) break;
        const message = JSON.parse(this.buffer.subarray(4, size + 4).toString('utf8'));
        this.buffer = this.buffer.subarray(size + 4); this.emit('message', message);
      }
    } catch (e) { this.failed = true; this.emit('error', e); }
  }
}
export function encode(message: unknown, maxBytes = 1024 * 1024) {
  const body = Buffer.from(JSON.stringify(message));
  if (body.length > maxBytes) throw new Error('Native frame exceeds 1 MiB');
  const header = Buffer.alloc(4); header.writeUInt32LE(body.length); return Buffer.concat([header, body]);
}
