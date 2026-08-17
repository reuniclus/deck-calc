/**
 * Tempo cost of tapped lands, measured as a PAIRED counterfactual.
 *
 * The quantity is
 *
 *     loss = mana_spent(same game, every land untapped)
 *          - mana_spent(same game, actual tapped mix)
 *
 * Same shuffle, same hand, same draws -- the two worlds differ only in whether lands
 * enter tapped. That is what makes the number attributable: an absolute "mana wasted"
 * figure mostly measures the CURVE (a deck with no two-drop wastes two mana on turn two
 * whatever its lands do), while the difference isolates tappedness. Pairing also cancels
 * the shuffle, so the variance of the difference is far below the variance of either
 * world, which is why a few hundred thousand trials suffice.
 *
 * COLOURS ARE DELIBERATELY ABSENT. Colour screw is a separate failure mode and mixing it
 * in confounds the result; this answers "what does entering tapped cost me", full stop.
 * Use the hand simulator for colour.
 *
 * Ramp is handled by its mana, not by special cases: a card with `produces` spends its
 * mana value when cast and adds that much to later turns. Sol Ring is `{mv: 1,
 * produces: 2}` and is immediately positive; a signet is `{mv: 2, produces: 1}` and is a
 * tempo loss that repays over two turns.
 */

export interface CurveEntry {
  /** Mana value. */
  mv: number;
  /** Copies in the deck. */
  count: number;
  /** Mana this permanently adds from the following turn, for ramp. */
  produces?: number;
  /** Available from this turn onward (defaults to castable whenever affordable). */
  earliest?: number;
}

export interface TempoOptions {
  deckSize?: number;
  lands: number;
  /** How many of those lands enter tapped. */
  tapped: number;
  curve: CurveEntry[];
  turns?: number;
  openingHand?: number;
  /** EDH draws on turn one. */
  drawsOnFirstTurn?: boolean;
  runs?: number;
  seed?: number;
}

export interface TempoResult {
  /** Mean mana spent over the horizon with every land untapped. */
  spentUntapped: number;
  /** Mean mana spent with the actual tapped mix. */
  spentTapped: number;
  /** Mean paired difference: the tempo cost of the tapped lands. */
  loss: number;
  /** Standard error of that difference. Paired, so much smaller than either world's. */
  stderr: number;
  /** Share of games where the tapped mix cost nothing at all. */
  freeGames: number;
  /**
   * Mean number of TURNS on which the tapped world spent less than the untapped one.
   *
   * Reported because total mana over the horizon misses delays that catch up: casting a
   * three-drop on turn four instead of turn three spends the same total by turn six, so
   * the totals show zero loss for a full turn of tempo. This counts those.
   */
  turnsAffected: number;
  /** Mean mana behind, summed over turns -- delay weighted by how long it lasted. */
  cumulativeBehind: number;
}

type Card = { land: true; tapped: boolean } | { land: false; mv: number; produces: number; earliest: number };

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0x100000000; };
}

/**
 * Best mana spendable this turn from a multiset of costs. Exact rather than greedy:
 * greedy would misreport a hand of 3+3 against 5 available mana, and those cases are
 * exactly where a tapped land does or does not matter.
 */
function bestSpend(costs: number[], available: number): { spent: number; used: number[] } {
  let best = { spent: 0, used: [] as number[] };
  const walk = (i: number, left: number, spent: number, used: number[]): void => {
    if (spent > best.spent) best = { spent, used: [...used] };
    if (i >= costs.length || left <= 0) return;
    if (costs[i]! <= left) { used.push(i); walk(i + 1, left - costs[i]!, spent + costs[i]!, used); used.pop(); }
    walk(i + 1, left, spent, used);
  };
  walk(0, available, 0, []);
  return best;
}

/**
 * Play out one world; returns total mana spent over the horizon.
 *
 * A land played UNTAPPED is usable the same turn; one played tapped contributes nothing
 * that turn and one mana from the next. Both are permanently untapped afterwards, so the
 * only asymmetry is the turn they arrive -- which is exactly the effect being measured.
 */
function playOut(hand: Card[], draws: Card[], turns: number): number[] {
  const inHand = [...hand];
  let landsInPlay = 0;
  let rampMana = 0;
  const perTurn: number[] = [];
  for (let turn = 1; turn <= turns; turn++) {
    if (turn > 1) { const d = draws[turn - 2]; if (d) inHand.push(d); }
    const hasUntapped = inHand.some((c) => c.land && !c.tapped);
    const hasTapped = inHand.some((c) => c.land && c.tapped);
    const spells = inHand
      .map((c, idx) => ({ c, idx }))
      .filter((x): x is { c: Extract<Card, { land: false }>; idx: number } =>
        !x.c.land && x.c.earliest <= turn);

    // The only decision that matters: play an untapped land for mana now, or a tapped one
    // and keep the untapped for later. Try both and take whichever spends more.
    // Card REFERENCES, not indices: the land is spliced out before the spells resolve,
    // which shifts every later index. That bug silently mis-scored ramp.
    let best = { spent: -1, playTapped: false, used: [] as Array<Extract<Card, { land: false }>> };
    const tryOption = (playTapped: boolean, playable: boolean) => {
      if (!playable) return;
      const avail = landsInPlay + rampMana + (playTapped ? 0 : 1);
      const r = bestSpend(spells.map((x) => x.c.mv), avail);
      if (r.spent > best.spent) {
        best = { spent: r.spent, playTapped, used: r.used.map((i) => spells[i]!.c) };
      }
    };
    tryOption(false, hasUntapped);
    tryOption(true, hasTapped);
    if (best.spent < 0) {
      // no land to play at all
      const r = bestSpend(spells.map((x) => x.c.mv), landsInPlay + rampMana);
      best = { spent: r.spent, playTapped: false, used: r.used.map((i) => spells[i]!.c) };
    } else {
      const li = inHand.findIndex((c) => c.land && c.tapped === best.playTapped);
      if (li >= 0) { inHand.splice(li, 1); landsInPlay += 1; }
    }

    perTurn.push(Math.max(0, best.spent));
    for (const c of best.used) {
      const at = inHand.indexOf(c);
      if (at >= 0) inHand.splice(at, 1);
      rampMana += c.produces;
    }
  }
  return perTurn;
}

export function tempoLoss(opts: TempoOptions): TempoResult {
  const deckSize = opts.deckSize ?? 99;
  const turns = opts.turns ?? 6;
  const openingHand = opts.openingHand ?? 7;
  const drawsFirst = opts.drawsOnFirstTurn ?? true;
  const runs = opts.runs ?? 100000;
  const rand = rng(opts.seed ?? 12345);

  const spells: Card[] = [];
  for (const e of opts.curve) {
    for (let i = 0; i < e.count; i++) {
      spells.push({ land: false, mv: e.mv, produces: e.produces ?? 0, earliest: e.earliest ?? 1 });
    }
  }
  const filler = deckSize - opts.lands - spells.length;
  if (filler < 0) throw new Error('lands plus spells exceed the deck');

  let sum = 0, sumSq = 0, free = 0, sumU = 0, sumT = 0, turnsAff = 0, cumBehind = 0;
  for (let r = 0; r < runs; r++) {
    // one shuffle, two worlds
    const deck: Array<{ kind: 'land'; tapped: boolean } | { kind: 'spell'; i: number } | { kind: 'filler' }> = [];
    for (let i = 0; i < opts.tapped; i++) deck.push({ kind: 'land', tapped: true });
    for (let i = 0; i < opts.lands - opts.tapped; i++) deck.push({ kind: 'land', tapped: false });
    spells.forEach((_, i) => deck.push({ kind: 'spell', i }));
    for (let i = 0; i < filler; i++) deck.push({ kind: 'filler' });
    for (let k = deck.length - 1; k > 0; k--) {
      const j = Math.floor(rand() * (k + 1));
      [deck[k], deck[j]] = [deck[j]!, deck[k]!];
    }
    const toCard = (x: typeof deck[number], forceUntapped: boolean): Card | null => {
      if (x.kind === 'land') return { land: true, tapped: forceUntapped ? false : x.tapped };
      if (x.kind === 'spell') return spells[x.i]!;
      return null;
    };
    const drawCount = openingHand + (drawsFirst ? turns : turns - 1);
    const seen = deck.slice(0, drawCount);
    const build = (forceUntapped: boolean) => ({
      hand: seen.slice(0, openingHand).map((x) => toCard(x, forceUntapped))
        .filter((c): c is Card => c !== null),
      draws: seen.slice(openingHand).map((x) => toCard(x, forceUntapped))
        .filter((c): c is Card => c !== null),
    });
    const a = build(true), b = build(false);
    const pu = playOut(a.hand, a.draws, turns);
    const pt = playOut(b.hand, b.draws, turns);
    const su = pu.reduce((x, y) => x + y, 0);
    const st = pt.reduce((x, y) => x + y, 0);
    // per-turn: how many turns was the tapped world behind, and by how much cumulatively
    let cu = 0, ct = 0;
    for (let t = 0; t < turns; t++) {
      cu += pu[t] ?? 0; ct += pt[t] ?? 0;
      if (ct < cu) { turnsAff++; cumBehind += cu - ct; }
    }
    const d = su - st;
    sum += d; sumSq += d * d; sumU += su; sumT += st;
    if (d <= 0) free++;
  }
  const mean = sum / runs;
  return {
    spentUntapped: sumU / runs,
    spentTapped: sumT / runs,
    loss: mean,
    stderr: Math.sqrt(Math.max(0, sumSq / runs - mean * mean) / runs),
    freeGames: free / runs,
    turnsAffected: turnsAff / runs,
    cumulativeBehind: cumBehind / runs,
  };
}
