// The address a request came from, as the relay's per-address limits count it (src/index.ts,
// src/limiter.ts): CF-Connecting-IP, which Cloudflare sets itself (a client can't choose it). An IPv4
// address as it is; an IPv6 one by its /64, since one network is handed a whole /64 and counting
// single addresses there would count nothing. No imports, so the tests can load it in Node as it is.

export function addressOf(ip: string | null | undefined): string {
  const a = ip?.trim().toLowerCase();
  if (!a) return "unknown";
  if (!a.includes(":")) return a;
  // An IPv4 address written as IPv6 (::ffff:1.2.3.4): the IPv4 one.
  const v4 = a.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (v4) return v4[1];
  const [head, tail] = a.split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const groups = a.includes("::") ? [...h, ...Array<string>(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t] : h;
  const prefix = groups
    .slice(0, 4)
    .map((g) => (Number.parseInt(g, 16) || 0).toString(16))
    .join(":");
  return `${prefix}::/64`;
}
