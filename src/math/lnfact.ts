/** Lazily-grown log-factorial table. Deck sizes vary wildly by format (40 → 250+), so no fixed cap. */
const table: number[] = [0, 0];

export function lnFact(n: number): number {
  if (!Number.isInteger(n) || n < 0) throw new RangeError(`lnFact: bad n=${n}`);
  let acc = table[table.length - 1]!;
  for (let i = table.length; i <= n; i++) {
    acc += Math.log(i);
    table[i] = acc;
  }
  return table[n]!;
}

/** log C(n,k). -Infinity (i.e. C = 0) outside the valid range. */
export function lnC(n: number, k: number): number {
  if (k < 0 || k > n || n < 0) return -Number.POSITIVE_INFINITY;
  return lnFact(n) - lnFact(k) - lnFact(n - k);
}

/** C(n,k) as a float64. Exact up to 2^53; relative error ~1e-16 beyond that. */
export function binom(n: number, k: number): number {
  if (k < 0 || k > n || n < 0) return 0;
  return Math.exp(lnC(n, k));
}
