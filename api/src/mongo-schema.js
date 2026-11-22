/**
 * MongoDB $jsonSchema validator for activity_events.
 *
 * The collection is polymorphic: "interval" and "tab_switch" documents share a
 * core and differ in required/forbidden fields. oneOf + additionalProperties:false
 * makes MongoDB itself reject any shape the API would never produce, in addition
 * to the API's own strict Zod validation.
 */
export const CATEGORIES = ["study", "necessary", "leisure", "uncategorized"];
const idPattern = "^[0-9a-fA-F-]{36}$";

export const activityEventValidator = {
  $jsonSchema: {
    bsonType: "object",
    required: [
      "userId",
      "deviceId",
      "eventId",
      "type",
      "at",
      "epoch",
      "digest",
      "expiresAt",
    ],
    additionalProperties: false,
    properties: {
      _id: {},
      userId: { bsonType: "string", pattern: idPattern },
      deviceId: { bsonType: "string", pattern: idPattern },
      eventId: { bsonType: "string", pattern: idPattern },
      type: { enum: ["interval", "tab_switch"] },
      at: { bsonType: "date" },
      start: { bsonType: "date" },
      end: { bsonType: "date" },
      state: { enum: ["active", "idle"] },
      domain: { bsonType: ["string", "null"], maxLength: 253 },
      category: { enum: CATEGORIES },
      epoch: { bsonType: "number", minimum: 0 },
      digest: { bsonType: "string", pattern: "^[a-f0-9]{64}$" },
      expiresAt: { bsonType: "date" },
    },
    oneOf: [
      {
        properties: { type: { enum: ["interval"] } },
        required: ["start", "end", "state", "domain", "category"],
      },
      {
        properties: { type: { enum: ["tab_switch"] } },
        not: {
          anyOf: [
            { required: ["start"] },
            { required: ["end"] },
            { required: ["state"] },
            { required: ["domain"] },
            { required: ["category"] },
          ],
        },
      },
    ],
  },
};
