import { all } from '../db/index.js';

// AroFlo never carries a structured suburb on every job tested (location is
// always null) — the only reliable source is free-text locationText, e.g.
// "65 Tyne Avenue Kilburn SA 5084 AUSTRALIA". Splitting this by word position
// to find "the suburb" would break on multi-word suburbs (Windsor Gardens,
// Largs North) — instead this narrows by the POSTCODE (unambiguous, always a
// 4-digit number right before "AUSTRALIA"), then checks which of this CRM's
// own suburbs sharing that postcode actually appears as text in the address.
// Only a single, unambiguous match is ever returned — a postcode shared by
// several suburbs where more than one name appears (or none does) is
// deliberately left unmatched rather than guessed.
export function matchSuburbFromLocationText(locationText) {
  if (!locationText) return null;
  const postcodeMatch = locationText.match(/\bSA\s+(\d{4})\s+AUSTRALIA\b/i);
  if (!postcodeMatch) return null;
  const postcode = postcodeMatch[1];

  const candidates = all('SELECT name, postcode FROM suburbs WHERE postcode = ?', [postcode]);
  if (!candidates.length) return null;

  const haystack = locationText.toLowerCase();
  const nameMatches = candidates.filter((c) => haystack.includes(c.name.toLowerCase()));
  if (nameMatches.length !== 1) return null;

  return `${nameMatches[0].name} (${nameMatches[0].postcode})`;
}
