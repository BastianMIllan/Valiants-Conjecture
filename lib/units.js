// Exact amounts: everything is kept in base units (lamports, token atoms) as BigInt.
export const toUnits = (str, d) => {
  const m = String(str ?? '').trim().match(/^(\d+)(?:\.(\d+))?$/);
  if (!m) return null;
  return BigInt(m[1] + (m[2] || '').slice(0, d).padEnd(d, '0'));
};

export const fmtUnits = (u, d) => {
  const v = BigInt(u);
  const neg = v < 0n;
  const a = neg ? -v : v;
  if (!d) return `${neg ? '-' : ''}${a}`;
  const s = a.toString().padStart(d + 1, '0');
  return `${neg ? '-' : ''}${`${s.slice(0, -d)}.${s.slice(-d)}`.replace(/\.?0+$/, '')}`;
};

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function b58decode(s) {
  const bytes = [];
  for (const ch of s) {
    const v = B58.indexOf(ch);
    if (v < 0) return null;
    let carry = v;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (const ch of s) {
    if (ch !== '1') break;
    bytes.push(0);
  }
  return bytes.reverse();
}

export function b58encode(buf) {
  const bytes = [...buf];
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let s = '';
  while (n > 0n) {
    s = B58[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    s = `1${s}`;
  }
  return s;
}
