// netlify/functions/_aliases.js
//
// ONE list of reps who go by a different name in JobNimbus than on our roster.
//
// Juan Carlos is Juan Orozco in JN — same person, same JN user id, same company
// email, two names. Everything that matched reps BY NAME quietly dropped his
// work: his Sit-Sold on 20 Aug scored zero in the contest because the roster
// had no "Juan Orozco" (Neal, 2026-08-21). He keeps the name everyone calls
// him; anything Orozco resolves to it.
//
// The real fix is to join reps on jobnimbus_id, and the contest now does. This
// covers the reports that only ever SEE a name and have no id to work with.
//
// To add one: put every spelling on the left, the name we use on the right.

const ALIASES = {
  "juan orozco": "Juan Carlos",
  "juan carlos orozco": "Juan Carlos",
};

// Bare comparison key — lowercase, letters/numbers/spaces only.
function key(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

// The name we use for this person. Unknown names come back untouched, so this
// is safe to wrap around any name from anywhere.
export function canonicalName(name) {
  return ALIASES[key(name)] || name;
}

// Every alias we know, for a report that wants to say "also appears as…".
export function aliasesFor(name) {
  const canon = key(canonicalName(name));
  return Object.keys(ALIASES).filter((a) => key(ALIASES[a]) === canon);
}
