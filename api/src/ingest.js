import { hashToken } from "./security.js";

/** Retention for browser observations, in milliseconds (30 days). */
export const RETENTION_MS = 30 * 86400000;

/**
 * Build the MongoDB document, its identity filter and a content digest for a
 * validated extension event. Pure function so the exact stored shape can be
 * tested against the collection validator without a running database.
 */
export function buildActivityDoc(e, device, epoch) {
  const filter = {
    userId: device.user_id,
    deviceId: device.id,
    eventId: e.eventId,
  };
  const digest = hashToken(JSON.stringify(e));
  const doc = {
    ...e,
    at: new Date(e.at),
    ...(e.type === "interval"
      ? { start: new Date(e.start), end: new Date(e.end) }
      : {}),
    ...filter,
    digest,
    epoch,
    expiresAt: new Date(+new Date(e.at) + RETENTION_MS),
  };
  return { filter, digest, doc };
}
