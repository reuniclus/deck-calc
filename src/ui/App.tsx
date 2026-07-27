import { AppStateProvider } from '../state/AppState';
import { QueryModelProvider } from '../state/useQueryModel';
import { DeckEditor } from './DeckEditor';
import { CombosEditor } from './CombosEditor';
import { ResultView } from './ResultView';

function Layout() {
  return (
    <div className="app-grid">
      <div className="rail">
        <DeckEditor />
        <CombosEditor />
      </div>
      <div className="main">
        <ResultView />
      </div>
    </div>
  );
}

export function App() {
  return (
    <AppStateProvider>
      <QueryModelProvider>
        <main>
          <h1>deck-calc</h1>
          <Layout />
        </main>
      </QueryModelProvider>
    </AppStateProvider>
  );
}
