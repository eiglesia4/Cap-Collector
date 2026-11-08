// ULID generator for client-made ids (CONVENTIONS § Identifiers): the `scanId` of a capture (CAP-41). 48-bit time in
// ms + 80 random bits, Crockford base32, 26 chars; the shared `Ulid` schema validates the result.
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export type RandomFill = (bytes: Uint8Array) => Uint8Array;

const cryptoFill: RandomFill = (bytes) => crypto.getRandomValues(bytes);

export function newUlid(now: number = Date.now(), fill: RandomFill = cryptoFill): string {
  let time = '';
  let rest = Math.floor(now);
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD.charAt(rest % 32) + time;
    rest = Math.floor(rest / 32);
  }
  // 16 bytes, one char each: 256 is a multiple of 32, so `% 32` keeps every char equally likely.
  const bytes = fill(new Uint8Array(16));
  let random = '';
  for (const byte of bytes) random += CROCKFORD.charAt(byte % 32);
  return time + random;
}
