/* The vocabulary BMFinder uses to describe how you know someone.

   This lives on its own rather than in db.js because the dashboard and the popup
   need the labels but must not pull in the persistence layer - they talk to the
   background worker over messages and never open IndexedDB themselves.

   These categories replaced admin/suspect/player/other. The old set framed the
   extension as an investigation tool: it asked the user to file people under a
   suspicion, which is not what saving someone you played a good round with is
   for. Databases created before v4 still hold the old values, so every read path
   normalises through toRelationship() and the v4 migration rewrites them. */

export const RELATIONSHIPS = ["friend", "teammate", "community", "staff", "other"];

export const RELATIONSHIP_LABEL = {
  friend: "Friend",
  teammate: "Teammate",
  community: "Community member",
  staff: "Server staff",
  other: "Other",
};

/* Same categories, fewer characters. Used where the control is compact enough
   that the full label would be clipped mid-word by a native select, which reads
   as a rendering fault rather than as a shortened label. Only "Community member"
   and "Server staff" actually differ; the rest are already short. */
export const RELATIONSHIP_SHORT = {
  friend: "Friend",
  teammate: "Teammate",
  community: "Community",
  staff: "Staff",
  other: "Other",
};

/* Short hints for the relationship picker, so the categories describe a
   connection rather than a classification. */
export const RELATIONSHIP_HINT = {
  friend: "Someone you play with regularly",
  teammate: "Someone from your squad or unit",
  community: "A familiar face from a server you play on",
  staff: "Runs or moderates a server you play on",
  other: "Anyone else you want to remember",
};

/* "suspect" maps to "other" deliberately. There is no neutral equivalent of an
   accusation, and carrying it forward under a gentler name would defeat the
   point of retiring it. */
export const RELATIONSHIP_FROM_LEGACY = {
  player: "community",
  admin: "staff",
  suspect: "other",
  other: "other",
};

/** Normalise any stored value, old or new, to a current relationship. */
export function toRelationship(value) {
  const v = String(value || "").toLowerCase();
  if (RELATIONSHIPS.includes(v)) return v;
  return RELATIONSHIP_FROM_LEGACY[v] || "other";
}
