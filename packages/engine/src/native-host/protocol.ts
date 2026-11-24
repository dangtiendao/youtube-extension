import type { NativeRequest, NativeResponse } from '@tubevault/shared';

/**
 * Chrome Native Messaging uses 32-bit unsigned little-endian length prefix followed by UTF-8 JSON.
 */
export function writeNativeMessage(payload: NativeResponse): void {
  const jsonBuf = Buffer.from(JSON.stringify(payload), 'utf8');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32LE(jsonBuf.length, 0);
  process.stdout.write(Buffer.concat([lenBuf, jsonBuf]));
}

export function listenNativeMessages(onMessage: (req: NativeRequest) => Promise<void> | void): void {
  let buffer = Buffer.alloc(0);
  let inFlight = 0;
  let stdinEnded = false;

  const maybeExit = () => {
    if (stdinEnded && inFlight === 0) {
      process.stdout.end(() => process.exit(0));
    }
  };

  process.stdin.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);

    while (buffer.length >= 4) {
      const msgLen = buffer.readUInt32LE(0);
      if (msgLen === 0 || msgLen > 1024 * 1024) {
        writeNativeMessage({ ok: false, error: 'Invalid native message length' });
        process.exit(1);
      }
      if (buffer.length < 4 + msgLen) {
        break;
      }

      const rawJson = buffer.subarray(4, 4 + msgLen).toString('utf8');
      buffer = buffer.subarray(4 + msgLen);

      try {
        const parsed = JSON.parse(rawJson) as NativeRequest;
        inFlight++;
        void Promise.resolve(onMessage(parsed))
          .catch((err) => {
            writeNativeMessage({ ok: false, error: err instanceof Error ? err.message : String(err) });
          })
          .finally(() => {
            inFlight--;
            maybeExit();
          });
      } catch {
        writeNativeMessage({ ok: false, error: 'Invalid JSON message' });
      }
    }
  });

  process.stdin.on('end', () => {
    stdinEnded = true;
    maybeExit();
  });
}
