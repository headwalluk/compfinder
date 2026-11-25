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
const IPV6_GROUPS = 8;
const HEX_RADIX = 16;
/** Groups 6 and 7 hold an embedded IPv4 address in the mapped and NAT64 prefixes; the first 6 are the prefix. */
const PREFIX_GROUP_COUNT = 6;
const EMBEDDED_HIGH_GROUP = 6;
const EMBEDDED_LOW_GROUP = 7;
/** 6to4 carries its IPv4 address in groups 1 and 2. */
const SIX_TO_FOUR_HIGH_GROUP = 1;
const SIX_TO_FOUR_LOW_GROUP = 2;
const BYTE_MASK = 0xff;
const BITS_PER_BYTE = 8;
const HEX_GROUP = /^[0-9a-f]{1,4}$/i;
/** First groups of prefixes that carry an IPv4 address in their last 32 bits: IPv4-mapped (::ffff:0:0/96) and NAT64 (64:ff9b::/96). */
const MAPPED_GROUPS = [0, 0, 0, 0, 0, 0xffff];
const NAT64_GROUPS = [0x64, 0xff9b, 0, 0, 0, 0];
/** NAT64's local-use prefix (64:ff9b:1::/48, RFC 8215) can put the IPv4 address anywhere, so it is refused. */
const NAT64_LOCAL_GROUPS = [0x64, 0xff9b, 1];
/** 6to4's first group (2002::/16). */
const SIX_TO_FOUR_GROUP = 0x2002;

const REFUSED = new BlockList();
for (const [address, prefix] of REFUSED_IPV4) {
  REFUSED.addSubnet(address, prefix, 'ipv4');
}
for (const [address, prefix] of REFUSED_IPV6) {
  REFUSED.addSubnet(address, prefix, 'ipv6');
}

/** An IPv6 address as its eight 16-bit groups, however it is written (compressed, padded, dotted tail); null if invalid. */
function ipv6Groups(address: string): number[] | null {
  const halves = address.toLowerCase().split('::');
  const parts = (text: string): string[] => (text === '' ? [] : text.split(':'));
  const head = parts(halves[0] ?? '');
  const tail = parts(halves[1] ?? '');
  const last = (halves.length === 1 ? head : tail).at(-1) ?? '';
  // A dotted IPv4 tail ("::ffff:10.0.0.1") stands for two groups.
  const dotted = isIP(last) === 4 ? last.split('.').map(Number) : null;
  const words = (list: string[]): string[] => (dotted !== null && list.at(-1) === last ? list.slice(0, -1) : list);
  const toGroups = (list: string[]): number[] | null => (list.every((part) => HEX_GROUP.test(part)) ? list.map((part) => Number.parseInt(part, HEX_RADIX)) : null);
  const headGroups = toGroups(halves.length === 1 ? words(head) : head);
  const tailGroups = toGroups(halves.length === 1 ? [] : words(tail));
  const dottedGroups = dotted === null ? [] : [((dotted[0] ?? 0) << BITS_PER_BYTE) | (dotted[1] ?? 0), ((dotted[2] ?? 0) << BITS_PER_BYTE) | (dotted[3] ?? 0)];
  let groups: number[] | null = null;
  if (halves.length <= 2 && headGroups !== null && tailGroups !== null) {
    const written = headGroups.length + tailGroups.length + dottedGroups.length;
    const zeros = halves.length === 2 ? IPV6_GROUPS - written : 0;
    groups = zeros >= 0 && written + zeros === IPV6_GROUPS && (halves.length === 1 || zeros > 0)
      ? [...headGroups, ...Array<number>(zeros).fill(0), ...tailGroups, ...dottedGroups]
      : null;
  }
  return groups;
}

/** Two 16-bit groups as a dotted IPv4 address. */
function ipv4From(high: number, low: number): string {
  return [high >> BITS_PER_BYTE, high & BYTE_MASK, low >> BITS_PER_BYTE, low & BYTE_MASK].join('.');
}

/** True when the groups start with a given prefix. */
function startsWith(groups: readonly number[], prefix: readonly number[]): boolean {
  return prefix.every((value, index) => groups[index] === value);
}

/** True when an IPv6 address may be connected to: its embedded IPv4 address, if it carries one, is checked instead. */
function isIpv6Allowed(address: string): boolean {
  const groups = ipv6Groups(address);
  let isAllowed: boolean;
  if (groups === null || startsWith(groups, NAT64_LOCAL_GROUPS)) {
    isAllowed = false;
  } else if (startsWith(groups, MAPPED_GROUPS) || startsWith(groups, NAT64_GROUPS)) {
    isAllowed = !REFUSED.check(ipv4From(groups[EMBEDDED_HIGH_GROUP] ?? 0, groups[EMBEDDED_LOW_GROUP] ?? 0), 'ipv4');
  } else if (groups[0] === SIX_TO_FOUR_GROUP) {
    isAllowed = !REFUSED.check(ipv4From(groups[SIX_TO_FOUR_HIGH_GROUP] ?? 0, groups[SIX_TO_FOUR_LOW_GROUP] ?? 0), 'ipv4');
  } else if (groups.slice(0, PREFIX_GROUP_COUNT).every((group) => group === 0)) {
    // ::/96, the deprecated IPv4-compatible form (and :: and ::1): never a public destination.
    isAllowed = false;
  } else {
    isAllowed = !REFUSED.check(groups.map((group) => group.toString(HEX_RADIX)).join(':'), 'ipv6');
  }
  return isAllowed;
}

/** True when an IP address is one compfinder may connect to. */
export function isAddressAllowed(address: string): boolean {
  const family = isIP(address);
  return family === 4 ? !REFUSED.check(address, 'ipv4') : family === 6 && isIpv6Allowed(address);
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
