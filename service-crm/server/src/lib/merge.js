/**
 * Merges an optional foreign-key field for a PATCH update: undefined means
 * "not sent, keep the existing value"; anything else (including '' from a
 * cleared <select>) is used as-is, with '' normalized to null so it never
 * hits an INTEGER FK column — SQLite's foreign-key check rejects '' outright
 * (it's neither NULL nor a valid id), which is what caused the 500s.
 */
export function mergeId(bodyValue, existingValue) {
  return bodyValue !== undefined ? bodyValue || null : existingValue;
}
