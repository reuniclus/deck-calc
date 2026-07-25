import { sfAtLeast } from '../math/hyper';

// M0 smoke view. Replaced by the deck editor at M2.
const N = 40;
const K = 4;

export function App() {
  const rows = [5, 6, 7, 10, 12].map((n) => ({ n, p: sfAtLeast(N, K, n, 1) }));

  return (
    <main>
      <h1>deck-calc</h1>
      <p style={{ color: 'var(--dim)' }}>
        M0 skeleton. <code>P(X&ge;1)</code> for {K} copies in a {N}-card deck.
      </p>
      <table>
        <thead>
          <tr><th>cards drawn</th><th>P</th></tr>
        </thead>
        <tbody>
          {rows.map(({ n, p }) => (
            <tr key={n}><td>{n}</td><td>{(p * 100).toFixed(2)}%</td></tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
