import {
  randomBytes,
  scrypt as scryptCb,
  timingSafeEqual,
  createHash,
} from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb);

export const hashToken = (s) => createHash("sha256").update(s).digest("hex");

export const token = () => randomBytes(32).toString("base64url");

/** Constant-time UTF-8 string comparison for CSRF tokens and secrets. */
export function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || !a || !b) return false;
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

export async function passwordHash(password) {
  const salt = randomBytes(16).toString("hex");
  const derived = await scrypt(password, salt, 64, {
    N: 16384,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
  return salt + ":" + derived.toString("hex");
}

export async function passwordMatches(password, stored) {
  const [salt, hex] = stored.split(":");
  const actual = await scrypt(password, salt, 64, {
    N: 16384,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
  const expected = Buffer.from(hex, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
