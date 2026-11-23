import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from 'node:dns';
import { BlockList, isIP } from 'node:net';

/** Error code for a host that resolves to a refused address; classified as blocked. */
export const BLOCKED_ADDRESS_CODE = 'EBLOCKEDADDRESS';

/** Private, loopback, link-local, shared, documentation, multicast and reserved ranges (docs/security.md). */
const REFUSED_IPV4: ReadonlyArray<[string, number]> = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
];
const REFUSED_IPV6: ReadonlyArray<[string, number]> = [
  ['::', 128], ['::1', 128], ['2001:db8::', 32], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
];
const IPV4_MAPPED_PREFIX = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i;
const NAT64_PREFIX = /^64:ff9b::([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i;
const BITS_PER_HEX_GROUP = 16;
const BYTE_MASK = 0xff;
const BITS_PER_BYTE = 8;

const REFUSED = new BlockList();
for (const [address, prefix] of REFUSED_IPV4) {
  REFUSED.addSubnet(address, prefix, 'ipv4');
}
for (const [address, prefix] of REFUSED_IPV6) {
  REFUSED.addSubnet(address, prefix, 'ipv6');
}

/** The IPv4 address embedded in an IPv4-mapped or NAT64 IPv6 address, or null. */
function embeddedIpv4(address: string): string | null {
  const mapped = IPV4_MAPPED_PREFIX.exec(address);
  const nat64 = NAT64_PREFIX.exec(address);
  let embedded: string | null = null;
  if (mapped?.[1] !== undefined) {
    embedded = mapped[1];
  } else if (nat64?.[1] !== undefined && nat64[2] !== undefined) {
    const value = (Number.parseInt(nat64[1], BITS_PER_HEX_GROUP) * 2 ** BITS_PER_HEX_GROUP) + Number.parseInt(nat64[2], BITS_PER_HEX_GROUP);
    embedded = [3, 2, 1, 0].map((shift) => Math.floor(value / 2 ** (shift * BITS_PER_BYTE)) & BYTE_MASK).join('.');
  }
  return embedded;
}

/** True when an IP address is one compfinder may connect to. */
export function isAddressAllowed(address: string): boolean {
  const family = isIP(address);
  const embedded = family === 6 ? embeddedIpv4(address) : null;
  let isAllowed: boolean;
  if (family === 0) {
    isAllowed = false;
  } else if (embedded !== null) {
    isAllowed = !REFUSED.check(embedded, 'ipv4');
  } else {
    isAllowed = !REFUSED.check(address, family === 4 ? 'ipv4' : 'ipv6');
  }
  return isAllowed;
}

type LookupCallback = (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/** A dns.lookup replacement that refuses a host when any address it resolves to is refused. Checked at connect time. */
export function guardedLookup(hostname: string, options: LookupOptions, callback: LookupCallback): void {
  dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error !== null) {
      callback(error, []);
    } else {
      const refused = addresses.find((entry) => !isAddressAllowed(entry.address));
      const first = addresses[0];
      if (refused !== undefined) {
        const blocked: NodeJS.ErrnoException = new Error(`${hostname} resolves to ${refused.address}, a private or reserved address`);
        blocked.code = BLOCKED_ADDRESS_CODE;
        callback(blocked, []);
      } else if (options.all === true) {
        callback(null, addresses);
      } else if (first === undefined) {
        const notFound: NodeJS.ErrnoException = new Error(`${hostname} has no address`);
        notFound.code = 'ENOTFOUND';
        callback(notFound, []);
      } else {
        callback(null, first.address, first.family);
      }
    }
  });
}
