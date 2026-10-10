// Pure, integer-only billing math. All money is minor units (e.g. cents); quantities are integers.
// rate is expressed as minor units per `per` units, so fractional cents never appear as floats.
export function calculateOverage({ used, included, rateMinor, per = 1 }) {
  const u = BigInt(used); const inc = BigInt(included);
  const over = u > inc ? u - inc : 0n;
  const units = (over + BigInt(per) - 1n) / BigInt(per); // round UP to whole billing units
  return { overageUnits: over, billableUnits: units, amountMinor: Number(units * BigInt(rateMinor)) };
}
export const periodStartUTC = (d = new Date()) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
