// ids.mjs — time-sortable ids for notes, decisions and batches (spec §11.4):
// `n_<ulid>`, `d_<ulid>`, `b_<ulid>`. A ULID is 48 bits of millisecond time
// followed by 80 bits of randomness, Crockford base32, 26 characters. It is
// ~15 lines, so no library (spec §10 names none for ids).

import { randomBytes } from "node:crypto";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function ulid(now = Date.now(), random = randomBytes) {
  let t = Math.max(0, Math.trunc(now));
  let time = "";
  for (let i = 0; i < 10; i++) {
    time = ALPHABET[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const bytes = random(10);
  let acc = 0n;
  for (const b of bytes) acc = (acc << 8n) | BigInt(b);
  let rand = "";
  for (let i = 0; i < 16; i++) {
    rand = ALPHABET[Number(acc & 31n)] + rand;
    acc >>= 5n;
  }
  return time + rand;
}

export const newNoteId = (now, random) => `n_${ulid(now, random)}`;
export const newDecisionId = (now, random) => `d_${ulid(now, random)}`;
export const newBatchId = (now, random) => `b_${ulid(now, random)}`;
export const newChangeId = (now, random) => `c_${ulid(now, random)}`;
