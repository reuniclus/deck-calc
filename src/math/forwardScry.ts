/**
 * **TEST-ONLY.** Forward mass propagation: an INDEPENDENT exact implementation of
 * the scry model, used to cross-check `exactSelectionCurveDnf` at realistic deck
 * sizes.
 *
 * Why it exists: `bruteSelection.ts` plays out every deck ordering and is
 * therefore the strongest check available, but it caps out around 12 cards. This
 * agrees with the backward DP to floating point on 60-card decks, which no other
 * instrument could reach. It shares no code with the DP -- that one is a backward
 * value function with memoisation, this pushes probability MASS forward from the
 * opening hand and accumulates success as it absorbs.
 *
 * Scope: scry-shaped effects and MONOTONE AND queries only. Greedy keep is
 * provably optimal there, so a fixed policy is exact and no backward value
 * function is needed. For OR or upper-bound queries the keep decision depends on
 * future value, which forward propagation cannot see -- it would yield a lower
 * bound, not an answer.
 *
 * `epsilon` prunes states below that mass and banks what was dropped, so the
 * result is a rigorous INTERVAL `[p, p + dropped]`: a pruned state could at best
 * have contributed all its mass to success. Measured at 1e-9 the interval is
 * 0.0002-0.0045pt wide, far inside the 0.1pt bar.
 *
 * NOT a faster route than the DP, which is why nothing ships on it: pruning at
 * 1e-9 removes only 30-35% of states because the mass is not concentrated, and it
 * cannot be pushed much harder since the interval width is roughly
 * (pruned states x epsilon). Measured 222ms vs 195ms, 380ms vs 186ms, 457ms vs
 * 155ms, and faster only on a two-group row (412ms vs 700ms).
 */
export function comb(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1);
  return r;
}

/**
 * Forward mass propagation with error-bounded pruning, scry-shaped, MONOTONE
 * AND queries only (greedy keep is provably optimal there, so a fixed policy is
 * exact and no backward value function is needed).
 *
 * Returns [p, p + droppedMass]: a rigorous interval, since every pruned state
 * could at best have contributed all of its mass to success.
 */
export function forwardScry(
  deck: number, counts: number[], needs: number[], copies: number, look: number,
  draws: number, epsilon: number,
): { p: number; dropped: number; states: number } {
  const G = counts.length;
  const others0 = deck - counts.reduce((a, c) => a + c, 0) - copies;
  // state key: acq per group | rem per group | remC | remO | sLeft
  const key = (acq: number[], rem: number[], remC: number, remO: number, s: number): string =>
    `${acq.join(',')}|${rem.join(',')}|${remC}|${remO}|${s}`;

  let live = new Map<string, { m: number; acq: number[]; rem: number[]; remC: number; remO: number; s: number }>();
  const start = { m: 1, acq: new Array(G).fill(0) as number[], rem: [...counts], remC: copies, remO: others0, s: draws };
  live.set(key(start.acq, start.rem, start.remC, start.remO, start.s), start);

  let success = 0;
  let dropped = 0;
  let visited = 0;

  while (live.size > 0) {
    const next = new Map<string, { m: number; acq: number[]; rem: number[]; remC: number; remO: number; s: number }>();
    const push = (m: number, acq: number[], rem: number[], remC: number, remO: number, s: number): void => {
      if (m <= 0) return;
      // success absorbs (monotone)
      if (acq.every((a, g) => a >= needs[g]!)) { success += m; return; }
      if (s <= 0) return;                       // failed
      if (m < epsilon) { dropped += m; return; } // pruned, mass banked
      const k = key(acq, rem, remC, remO, s);
      const hit = next.get(k);
      if (hit === undefined) next.set(k, { m, acq, rem, remC, remO, s });
      else hit.m += m;
    };

    for (const st of live.values()) {
      visited++;
      const pool = st.rem.reduce((a, r) => a + r, 0) + st.remC + st.remO;
      if (pool <= 0) continue;
      // draw filler
      push(st.m * (st.remO / pool), st.acq, st.rem, st.remC, st.remO - 1, st.s - 1);
      // draw a tracked card
      for (let g = 0; g < G; g++) {
        if (st.rem[g]! <= 0) continue;
        const acq2 = [...st.acq]; acq2[g] = Math.min(needs[g]!, acq2[g]! + 1);
        const rem2 = [...st.rem]; rem2[g] = rem2[g]! - 1;
        push(st.m * (st.rem[g]! / pool), acq2, rem2, st.remC, st.remO, st.s - 1);
      }
      // draw a copy: resolve its window atomically, greedy keep
      if (st.remC > 0) {
        const pAfter = pool - 1;
        const w = Math.min(look, pAfter);
        const denom = comb(pAfter, w);
        const remC2 = st.remC - 1;
        if (denom <= 0 || w <= 0) {
          push(st.m * (st.remC / pool), st.acq, st.rem, remC2, st.remO, st.s - 1);
        } else {
          const comp: number[] = new Array(G).fill(0) as number[];
          const walk = (g: number, left: number, ways: number): void => {
            if (g === G) {
              for (let c = 0; c <= Math.min(remC2, left); c++) {
                const o = left - c;
                if (o < 0 || o > st.remO) continue;
                const pw = (ways * comb(remC2, c) * comb(st.remO, o)) / denom;
                if (pw <= 0) continue;
                const d = st.s - 1;
                const acq2 = [...st.acq];
                const rem2 = [...st.rem];
                let spent = 0;
                for (let i = 0; i < G; i++) {
                  const want = Math.max(0, needs[i]! - acq2[i]!);
                  const take = Math.min(comp[i]!, want, Math.max(0, d - spent));
                  acq2[i] = Math.min(needs[i]!, acq2[i]! + take);
                  spent += take;
                  rem2[i] = rem2[i]! - comp[i]!;   // whole window leaves the pool
                }
                push(st.m * (st.remC / pool) * pw, acq2, rem2, remC2 - c, st.remO - o, d - spent);
              }
              return;
            }
            const maxTake = Math.min(st.rem[g]!, left);
            for (let t = 0; t <= maxTake; t++) { comp[g] = t; walk(g + 1, left - t, ways * comb(st.rem[g]!, t)); }
            comp[g] = 0;
          };
          walk(0, w, 1);
        }
      }
    }
    live = next;
  }
  return { p: success, dropped, states: visited };
}

