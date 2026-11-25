// Careful reads from outside services: every call has a timeout and every body a size cap,
// so a slow or oversized answer can never hold the server up or fill its memory.
export class TooLarge extends Error {}

export async function fetchText(url, { headers = {}, timeoutMs = 30000, maxBytes = 1 << 20, redirect = 'follow' } = {}) {
  const r = await fetch(url, { headers, redirect, signal: AbortSignal.timeout(timeoutMs) });
  const declared = Number(r.headers.get('content-length') || 0);
  if (declared > maxBytes) {
    await r.body?.cancel().catch(() => {});
    throw new TooLarge(`answer larger than ${maxBytes} bytes`);
  }
  const chunks = [];
  let size = 0;
  if (r.body) {
    const reader = r.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new TooLarge(`answer larger than ${maxBytes} bytes`);
      }
      chunks.push(Buffer.from(value));
    }
  }
  return { status: r.status, ok: r.ok, headers: r.headers, text: Buffer.concat(chunks).toString('utf8') };
}
