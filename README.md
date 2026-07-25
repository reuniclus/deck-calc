# deck-calc

Hypergeometric deck probability calculator. Like [deckulator](https://deckulator.appspot.com/), with:

- **locked deck size** and an automatic `others` group that always balances to it
- **arbitrary boolean combo queries** — AND / OR / NOT / "any *k* of these", over interval constraints (`at least 2`, `exactly 1`, `at most 3`)
- **two-variable views** — probability across *cards drawn* × *copies in deck*, as a heatmap with isoprobability contours
- **diminishing returns** — marginal probability per extra card drawn, and per extra deck slot spent
- **slot allocation optimizer** — "fewest deck slots to hit 90% by turn 3", reported as the full set of minimal tradeoffs rather than one arbitrary answer

Status: **M0** — skeleton. See `PLAN.md` for the roadmap, `CODEMAP.md` for the layout.

## Develop

```sh
npm install
npm run dev
npm test
```

MIT.
