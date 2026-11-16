import { StrictMode, useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { api, setCsrf, setUnauthorizedHandler, type Facets, type User } from './api.ts';
import { SessionCtx } from './session.ts';
import { Icon, navigate, Spinner, ToastProvider, useAsync, useRoute } from './ui.tsx';
import { AuthView } from './views/Auth.tsx';
import { NotesView } from './views/Notes.tsx';
import { SearchView, CommandPalette } from './views/Search.tsx';
import { AskView } from './views/Ask.tsx';
import { GraphView } from './views/Graph.tsx';
import { InsightsView } from './views/Insights.tsx';
import { TrashView } from './views/Trash.tsx';
import { SettingsView } from './views/Settings.tsx';


function useTheme() {
  const [theme, setTheme] = useState<string>(() => { try { return localStorage.getItem('theme') ?? 'system'; } catch { return 'system'; } });
  useEffect(() => {
    if (theme === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem('theme', theme); } catch { /* private mode */ }
  }, [theme]);
  const dark = theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  return { dark, toggle: () => setTheme(dark ? 'light' : 'dark') };
}

function App() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  useEffect(() => {
    setUnauthorizedHandler(() => setUser(null));
    api('/auth/me').then((r) => { setCsrf(r.csrfToken); setUser(r.user); }, () => setUser(null));
  }, []);
  if (user === undefined) return <div className="boot"><Spinner /></div>;
  if (!user) return <AuthView onAuth={(u, csrf) => { setCsrf(csrf); setUser(u); }} />;
  return <Shell user={user} setUser={setUser} />;
}

const NAV = [
  { to: 'notes', label: 'Todas las notas', icon: 'note' },
  { to: 'notes?type=task', label: 'Tareas', icon: 'task' },
  { to: 'notes?type=document', label: 'Documentos', icon: 'document' },
  { to: 'notes?scope=shared', label: 'Compartidas conmigo', icon: 'people' },
  { to: 'ask', label: 'Preguntar', icon: 'sparkle' },
  { to: 'graph', label: 'Grafo', icon: 'graph' },
  { to: 'insights', label: 'Panorama', icon: 'chart' },
  { to: 'trash', label: 'Papelera', icon: 'trash' },
];

function Shell({ user, setUser }: { user: User; setUser: (u: User | null) => void }) {
  const route = useRoute();
  const theme = useTheme();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const facets = useAsync((s) => api<Facets>('/facets', { signal: s }), []);
  const refreshFacets = facets.reload;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPaletteOpen(true); }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => setDrawer(false), [route]);

  const logout = useCallback(async () => { await api('/auth/logout', { method: 'POST' }).catch(() => {}); setUser(null); }, [setUser]);

  const [section = 'notes'] = route.parts;
  const current = `${section}${route.query.get('type') ? `?type=${route.query.get('type')}` : route.query.get('scope') ? `?scope=${route.query.get('scope')}` : ''}`;
  const isActive = (to: string) => (to === 'notes' ? current === 'notes' && !route.query.get('tag') : current === to);

  let view;
  switch (section) {
    case 'ask': view = <AskView conversationId={route.parts[1]} />; break;
    case 'graph': view = <GraphView />; break;
    case 'insights': view = <InsightsView />; break;
    case 'trash': view = <TrashView />; break;
    case 'search': view = <SearchView query={route.query} />; break;
    case 'settings': view = <SettingsView />; break;
    default: view = <NotesView noteId={route.parts[1]} query={route.query} />;
  }

  return (
    <SessionCtx.Provider value={{ user, facets: facets.data, refreshFacets, setUser }}>
      <a className="skip" href="#main">Saltar al contenido</a>
      <div className={`shell ${drawer ? 'drawer-open' : ''}`}>
        <header className="topbar">
          <button className="icon-btn" onClick={() => setDrawer(true)} aria-label="Abrir menú"><Icon name="menu" /></button>
          <span className="wordmark">Second<em>Brain</em></span>
          <button className="icon-btn" onClick={() => setPaletteOpen(true)} aria-label="Buscar"><Icon name="search" /></button>
        </header>
        <div className="scrim" onClick={() => setDrawer(false)} />
        <nav className="sidebar" aria-label="Principal">
          <div className="side-head">
            <a href="#/notes" className="wordmark">Second<em>Brain</em></a>
            <button className="icon-btn drawer-close" onClick={() => setDrawer(false)} aria-label="Cerrar menú"><Icon name="x" /></button>
          </div>
          <button className="search-trigger" onClick={() => setPaletteOpen(true)}>
            <Icon name="search" size={16} /> <span>Buscar…</span> <kbd>Ctrl K</kbd>
          </button>
          <button className="btn primary block" onClick={() => navigate('#/notes/new')}>
            <Icon name="plus" size={16} /> Nueva nota
          </button>
          <ul className="nav">
            {NAV.map((n) => (
              <li key={n.to}>
                <a href={`#/${n.to}`} aria-current={isActive(n.to) ? 'page' : undefined}><Icon name={n.icon} size={17} />{n.label}</a>
              </li>
            ))}
          </ul>
          {!!facets.data?.tags.length && (
            <section className="side-tags" aria-label="Etiquetas">
              <h2>Etiquetas</h2>
              <ul>
                {facets.data.tags.slice(0, 14).map((t) => (
                  <li key={t.name}>
                    <a href={`#/notes?tag=${encodeURIComponent(t.name)}`}
                      aria-current={route.query.get('tag') === t.name ? 'page' : undefined}>
                      <span>#{t.name}</span><span className="count">{t.count}</span>
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <div className="side-foot">
            <a href="#/settings" className="me" aria-current={section === 'settings' ? 'page' : undefined}>
              <span className="avatar" aria-hidden="true">{user.displayName.slice(0, 1).toUpperCase()}</span>
              <span className="me-text"><strong>{user.displayName}</strong><small>{user.role === 'admin' ? 'Administrador' : user.email}</small></span>
            </a>
            <button className="icon-btn" onClick={theme.toggle} aria-label={theme.dark ? 'Tema claro' : 'Tema oscuro'}>
              <Icon name={theme.dark ? 'sun' : 'moon'} />
            </button>
            <button className="icon-btn" onClick={logout} aria-label="Cerrar sesión"><Icon name="logout" /></button>
          </div>
        </nav>
        <main id="main" className="main" tabIndex={-1}>{view}</main>
      </div>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </SessionCtx.Provider>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ToastProvider><App /></ToastProvider>
  </StrictMode>,
);
