/**
 * Who may talk to md3's AI: everyone (owner, 2026-10-09: "roll out AI for
 * everybody on cohort/md3, but haiku-only, unless you're logged in then you
 * get the opus/sonnet/haiku ladder"). Every signed-in learner gets the ladder;
 * a guest gets Haiku from the front desk, decided on the server from the
 * user row (front-desk.server.ts), so this answers only for signed-in users.
 * The laptop's AI watch and the owner can still pause anyone (ai-block.server.ts).
 * The image tier no longer gates AI; it only gates which images reach the model.
 */
export function hasAiAccess(email: string | null | undefined): boolean {
  return Boolean(email);
}
