// Shared by routes/reviews.js (the CRUD layer) and services/reports.js (the
// Review Report and the Technician & Sales report's own Positive Reviews
// figure) so a review's classification can never read differently in two
// places. Never stored — always calculated from the star rating, per the
// rule that a review's Positive/Neutral/Negative label must follow its
// rating rather than be chosen separately (see schema.sql's comment on
// reviews.rating).
export function classifyRating(rating) {
  const n = Number(rating);
  if (n >= 4) return 'Positive';
  if (n === 3) return 'Neutral';
  return 'Negative';
}
