// No real interfaces, `tailscale` or `dns-sd`: a home address, a Tailscale one and its MagicDNS name, and what
// was advertised in T.advertised (stopped: T.advertised.stopped), the first of each start; every one in
// T.advertisedAll.
export async function addresses() {
  return [
    { address: "192.168.1.20", kind: "lan", interface: "en0" },
    { address: "100.101.102.103", kind: "tailscale", interface: "utun4" },
    { address: "test-mac.tail1a2b3c.ts.net", kind: "tailscale", interface: "MagicDNS" },
  ];
}
export function hostname() {
  return "test-mac.local";
}
export function advertise(name: string, type: string, port: number, txt: Record<string, string>) {
  const T = (globalThis as any).T;
  const ad = { name, type, port, txt, stopped: false };
  // A new start: the list begins again.
  if (!T.advertisedAll || T.advertisedAll.every((a: { stopped: boolean }) => a.stopped)) T.advertisedAll = [];
  T.advertisedAll.push(ad);
  T.advertised = T.advertisedAll[0];
  return {
    stop: () => {
      ad.stopped = true;
    },
  };
}
