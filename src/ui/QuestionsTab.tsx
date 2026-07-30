/**
 * Frequently-asked deck-building questions, each a preset over one of two
 * general engines rather than a bespoke tool per question -- see PLAN.md's
 * "Backlog: frequently asked deck-builder questions" section for the full
 * design history.
 *
 * "Is my hand safe to keep" needs no new math at all: it's exactly the same
 * per-hand keep/mulligan table already computed for the Suggestions tab
 * (useMulliganStrategyCtx()), shared via MulliganHandTable rather than
 * computed twice.
 *
 * Cantrips and "enough setup for my payoffs" are real, separately-scoped
 * math projects (a multi-type dilution model, and a resource-vs-consumer
 * joint distribution respectively) -- not yet built. Shown as explicit
 * placeholders rather than silently omitted, matching how this project
 * always states what it hasn't done yet instead of leaving a confusing gap.
 */
import { MulliganHandTable } from './MulliganHandTable';
import { CantripsCard } from './CantripsCard';

export function QuestionsTab() {
  return (
    <div>
      <div className="panel" style={{ marginBottom: 12 }}>
        <p className="q-title">Is my hand safe to keep?</p>
        <MulliganHandTable />
      </div>

      <div className="panel" style={{ marginBottom: 12 }}>
        <p className="q-title">How many cantrips should I run?</p>
        <CantripsCard />
      </div>

      <div className="panel">
        <p className="q-title">Enough setup for my payoffs?</p>
        <p className="hint">
          Not built yet &mdash; a resource-vs-consumer question (e.g. &quot;enough dark monsters for every
          Allure of Darkness I&apos;ve drawn&quot;), answerable from the same joint distribution machinery
          used elsewhere, just not wired up as its own tool yet. See PLAN.md.
        </p>
      </div>
    </div>
  );
}
