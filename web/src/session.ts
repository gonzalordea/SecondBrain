import { createContext, useContext } from 'react';
import type { Facets, Theme, User } from './api.ts';

export interface Session {
  user: User;
  facets: Facets | undefined;
  refreshFacets: () => void;
  setUser: (u: User | null) => void;
  theme: Theme;
  setTheme: (t: Theme) => void;
}
export const SessionCtx = createContext<Session>(null as unknown as Session);
export const useSession = () => useContext(SessionCtx);

/** Apply a theme to the document and remember it locally so /theme-init.js can apply it before the next paint. */
export function applyTheme(t: Theme) {
  if (t === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
  try { localStorage.setItem('theme', t); } catch { /* storage blocked: the account still remembers it */ }
}

export const THEME_LABEL: Record<Theme, string> = { system: 'Sistema', light: 'Claro', dark: 'Oscuro' };
export const THEME_ORDER: Theme[] = ['system', 'light', 'dark'];
