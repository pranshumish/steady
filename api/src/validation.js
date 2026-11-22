/**
 * Server-side input policy shared by routes and unit tests.
 * The browser repeats a lightweight, advisory version of these rules for
 * immediate feedback; the server remains the only authority.
 */
export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 128;

// Small offline blocklist of very common passwords (>= 10 chars so they would
// otherwise pass the length rule). Compared case-insensitively.
const COMMON = new Set(
  [
    "password12",
    "password123",
    "password1234",
    "passw0rd123",
    "1234567890",
    "12345678910",
    "123456789012",
    "qwertyuiop",
    "qwerty12345",
    "qwerty123456",
    "iloveyou12",
    "iloveyou123",
    "letmein1234",
    "welcome123",
    "welcome1234",
    "administrator",
    "abcdefghij",
    "abc1234567",
    "1q2w3e4r5t",
    "monkey12345",
    "dragon12345",
    "football123",
    "baseball123",
    "superman123",
    "steady12345",
    "steadysteady",
    "changeme123",
  ].map((s) => s.toLowerCase()),
);

/**
 * Return a list of human-readable problems; empty list means acceptable.
 * Follows NIST SP 800-63B guidance: length and blocklist checks rather than
 * arbitrary composition rules.
 */
export function passwordIssues(password, { email = "", displayName = "" } = {}) {
  const issues = [];
  const p = String(password ?? "");
  if (p.length < PASSWORD_MIN)
    issues.push(`Use at least ${PASSWORD_MIN} characters`);
  if (p.length > PASSWORD_MAX)
    issues.push(`Use ${PASSWORD_MAX} characters or fewer`);
  const lower = p.toLowerCase();
  if (COMMON.has(lower)) issues.push("This password is too common");
  if (p.length >= 4 && new Set(p).size === 1)
    issues.push("Avoid repeating a single character");
  const local = String(email).split("@")[0].toLowerCase();
  if (local.length >= 4 && lower.includes(local))
    issues.push("Do not include your email name in the password");
  for (const part of String(displayName).toLowerCase().split(/\s+/)) {
    if (part.length >= 4 && lower.includes(part))
      issues.push("Do not include your name in the password");
  }
  return [...new Set(issues)];
}

/** Account lockout policy for repeated failed sign-ins. */
export const LOCKOUT = { maxFailures: 5, windowMinutes: 15 };
