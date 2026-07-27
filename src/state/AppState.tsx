import { createContext, useContext, useEffect, useReducer, type ReactNode, type Dispatch } from 'react';
import { DEFAULT_TURN_CONFIG, type TurnConfig } from '../model/turns';
import { encodeShared, decodeShared } from './hashState';

export interface Group {
  id: string;
  name: string;
  count: number;
}

export interface AppState {
  deckSize: number;
  groups: Group[];
  turnCfg: TurnConfig;
  /** The single source of truth for the query. Everything else (builder rows,
   * AST, curve) is derived from this on every render — never stored separately,
   * so there's no way for a derived view to drift from what the text says. */
  query: string;
  target: number;
  adviseTurn: number;
}

export type Action =
  | { type: 'setDeckSize'; deckSize: number }
  | { type: 'addGroup' }
  | { type: 'renameGroup'; id: string; name: string }
  | { type: 'setGroupCount'; id: string; count: number }
  | { type: 'removeGroup'; id: string }
  | { type: 'setTurnCfg'; turnCfg: Partial<TurnConfig> }
  | { type: 'setQuery'; query: string }
  | { type: 'setTarget'; target: number }
  | { type: 'setAdviseTurn'; adviseTurn: number };

let seq = 2;
const nextGroupId = (): string => `g${seq++}`;

export const initialState: AppState = {
  deckSize: 40,
  groups: [
    { id: 'g0', name: 'Blink ETB', count: 4 },
    { id: 'g1', name: 'Blink Spell', count: 3 },
  ],
  turnCfg: { ...DEFAULT_TURN_CONFIG },
  query: '"Blink ETB">=1 & "Blink Spell">=1',
  target: 0.9,
  adviseTurn: 4,
};

/** Reads the URL hash exactly once at mount (via useReducer's lazy init,
 * not on every render) -- a bad/missing/malformed hash just means "start
 * with defaults," never a crash. */
function computeInitialState(): AppState {
  if (typeof window === 'undefined') return initialState;
  const shared = decodeShared(window.location.hash);
  if (!shared) return initialState;
  return {
    ...initialState,
    deckSize: shared.deckSize,
    groups: shared.groups.map((g) => ({ id: nextGroupId(), name: g.name, count: g.count })),
    query: shared.query,
  };
}

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'setDeckSize':
      return { ...state, deckSize: Math.max(1, Math.min(1024, action.deckSize)) };
    case 'addGroup':
      return {
        ...state,
        groups: [...state.groups, { id: nextGroupId(), name: `Group ${state.groups.length + 1}`, count: 1 }],
      };
    case 'renameGroup':
      return {
        ...state,
        groups: state.groups.map((g) => (g.id === action.id ? { ...g, name: action.name } : g)),
      };
    case 'setGroupCount':
      return {
        ...state,
        groups: state.groups.map((g) => (g.id === action.id ? { ...g, count: Math.max(0, action.count) } : g)),
      };
    case 'removeGroup':
      return { ...state, groups: state.groups.filter((g) => g.id !== action.id) };
    case 'setTurnCfg':
      return { ...state, turnCfg: { ...state.turnCfg, ...action.turnCfg } };
    case 'setQuery':
      return { ...state, query: action.query };
    case 'setTarget':
      return { ...state, target: Math.max(0.001, Math.min(1, action.target)) };
    case 'setAdviseTurn':
      return { ...state, adviseTurn: Math.max(0, action.adviseTurn) };
  }
}

const StateCtx = createContext<AppState | null>(null);
const DispatchCtx = createContext<Dispatch<Action> | null>(null);

export function AppStateProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, null, computeInitialState);

  // Auto-sync on every change to the SHARED slice only (deck size, groups,
  // query) -- target/turnCfg/adviseTurn are session/view preferences, never
  // part of the link (see UI_DESIGN.md §6, hashState.ts). replaceState, never
  // pushState: updating on every keystroke must not pollute back-button history.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const hash = '#' + encodeShared(state.deckSize, state.groups, state.query);
    if (window.location.hash !== hash) {
      window.history.replaceState(null, '', hash);
    }
  }, [state.deckSize, state.groups, state.query]);

  return (
    <StateCtx.Provider value={state}>
      <DispatchCtx.Provider value={dispatch}>{children}</DispatchCtx.Provider>
    </StateCtx.Provider>
  );
}

export function useAppState(): AppState {
  const ctx = useContext(StateCtx);
  if (!ctx) throw new Error('useAppState must be used within AppStateProvider');
  return ctx;
}

export function useAppDispatch(): Dispatch<Action> {
  const ctx = useContext(DispatchCtx);
  if (!ctx) throw new Error('useAppDispatch must be used within AppStateProvider');
  return ctx;
}
