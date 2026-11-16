import { StrictMode, useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { api, setCsrf, setUnauthorizedHandler, type Facets, type Theme, type User } from './api.ts';
import { applyTheme, SessionCtx, THEME_LABEL, THEME_ORDER } from './session.ts';
import { Icon, navigate, Spinner, ToastProvider, useAsync, useRoute, useToast, errMsg } from './ui.tsx';
import { AuthView } from './views/Auth.tsx';
import { HomeView } from './views/Home.tsx';
import { NotesView } from './views/Notes.tsx';
import { SearchView, CommandPalette } from './views/Search.tsx';
import { AskView } from './views/Ask.tsx';
import { GraphView } from './views/Graph.tsx';
import { InsightsView } from './views/Insights.tsx';
import { TrashView } from './views/Trash.tsx';
import { SettingsView } from './views/Settings.tsx';

function App() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  useEffect(() => {
    setUnauthorizedHandler(() => setUser(null));
    api('/auth/me').then((r) => { setCsrf(r.csrfToken); setUser(r.user); }, () => setUser(null));
  }, []);
  // The account's saved theme wins over whatever this browser remembered.
  useEffect(() => { if (user) applyTheme(user.theme); }, [user]);
  if (user === undefined) return <div className="boot"><Spinner /></div>;
  if (!user) return <AuthView onAuth={(u, csrf) => { setCsrf(csrf); setUser(u); }} />;
  return <Shell user={user} setUser={setUser} />;
}

interface NavItem { to: string; label: string; icon: string }
const NAV: { title: string; items: NavItem[] }[] = [
  {
    title: 'Espacio',
    items: [
      { to: '', label: 'Inicio', icon: 'home' },
      { to: 'notes', label: 'Todas las notas', icon: 'note' },
      { to: 'notes?type=task', label: 'Tareas', icon: 'task' },
      { to: 'notes?type=document', label: 'Documentos', icon: 'document' },
      { to: 'notes?scope=shared', label: 'Compartidas conmigo', icon: 'people' },
    ],
  },
  {
    title: 'Inteligencia',
    items: [
      { to: 'ask', label: 'Preguntar', icon: 'sparkle' },
      { to: 'graph', label: 'Grafo', icon: 'graph' },
      { to: 'insights', label: 'Panorama', icon: 'chart' },
    ],
  },
];
const THEME_ICON: Record<Theme, string> = { system: 'monitor', light: 'sun', dark: 'moon' };

function Shell({ user, setUser }: { user: User; setUser: (u: User | null) => void }) {
  const route = useRoute();
  const toast = useToast();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const facets = useAsync((s) => api<Facets>('/facets', { signal: s }), []);

  const setTheme = useCallback(async (theme: Theme) => {
    applyTheme(theme);
    setUser({ ...user, theme });
    try { await api('/auth/preferences', { method: 'PATCH', body: { theme } }); }
    catch (e) { toast({ message: `No se pudo guardar el tema: ${errMsg(e)}`, tone: 'error' }); }
  }, [user, setUser, toast]);
  const nextTheme = THEME_ORDER[(THEME_ORDER.indexOf(user.theme) + 1) % THEME_ORDER.length];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPaletteOpen(true); }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => setDrawer(false), [route]);

  const logout = useCallback(async () => { await api('/auth/logout', { method: 'POST' }).catch(() => {}); setUser(null); }, [setUser]);

  const [section = ''] = route.parts;
  const filter = route.query.get('type') ? `?type=${route.query.get('type')}` : route.query.get('scope') ? `?scope=${route.query.get('scope')}` : '';
  const current = `${section}${filter}`;
  const isActive = (to: string) => (to === 'notes' ? current === 'notes' && !route.query.get('tag') : current === to);

  let view;
  switch (section) {
    case '': view = <HomeView />; break;
    case 'ask': view = <AskView conversationId={route.parts[1]} />; break;
    case 'graph': view = <GraphView />; break;
    case 'insights': view = <InsightsView />; break;
    case 'trash': view = <TrashView />; break;
    case 'search': view = <SearchView query={route.query} />; break;
    case 'settings': view = <SettingsView />; break;
    default: view = <NotesView noteId={route.parts[1]} query={route.query} />;
  }

  return (
    <SessionCtx.Provider value={{ user, facets: facets.data, refreshFacets: facets.reload, setUser, theme: user.theme, setTheme }}>
      <a className="skip" href="#main">Saltar al contenido</a>
      <div className={`shell ${drawer ? 'drawer-open' : ''}`}>
        <header className="topbar">
          <button className="icon-btn" onClick={() => setDrawer(true)} aria-label="Abrir menú"><Icon name="menu" /></button>
          <a href="#/" className="wordmark">Second<em>Brain</em></a>
          <button className="icon-btn" onClick={() => setPaletteOpen(true)} aria-label="Buscar"><Icon name="search" /></button>
        </header>
        <div className="scrim" onClick={() => setDrawer(false)} />
        <nav className="sidebar" aria-label="Principal">
          <div className="side-head">
            <a href="#/" className="wordmark">Second<em>Brain</em></a>
            <button className="icon-btn drawer-close" onClick={() => setDrawer(false)} aria-label="Cerrar menú"><Icon name="x" /></button>
          </div>
          <button className="search-trigger" onClick={() => setPaletteOpen(true)}>
            <Icon name="search" size={15} /> <span>Buscar…</span> <kbd>Ctrl K</kbd>
          </button>
          <button className="btn primary block" onClick={() => navigate('#/notes/new')}>
            <Icon name="plus" size={15} /> Nueva nota
          </button>
          {NAV.map((g) => (
            <div className="nav-group" key={g.title}>
              <h2>{g.title}</h2>
              <ul className="nav">
                {g.items.map((n) => (
                  <li key={n.to}>
                    <a href={`#/${n.to}`} aria-current={isActive(n.to) ? 'page' : undefined}><Icon name={n.icon} size={16} />{n.label}</a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
          {!!facets.data?.tags.length && (
            <section className="side-tags" aria-label="Etiquetas">
              <h2>Etiquetas</h2>
              <ul>
                {facets.data.tags.slice(0, 12).map((t) => (
                  <li key={t.name}>
                    <a href={`#/notes?tag=${encodeURIComponent(t.name)}`} aria-current={route.query.get('tag') === t.name ? 'page' : undefined}>
                      <span className="ellipsis">#{t.name}</span><span className="count">{t.count}</span>
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <ul className="nav nav-end">
            <li><a href="#/trash" aria-current={section === 'trash' ? 'page' : undefined}><Icon name="trash" size={16} />Papelera</a></li>
          </ul>
          <div className="side-foot">
            <a href="#/settings" className="me" aria-current={section === 'settings' ? 'page' : undefined}>
              <span className="avatar" aria-hidden="true">{user.displayName.slice(0, 1).toUpperCase()}</span>
              <span className="me-text"><strong>{user.displayName}</strong><small>{user.role === 'admin' ? 'administrador' : user.email}</small></span>
            </a>
            <button className="icon-btn" onClick={() => setTheme(nextTheme)}
              aria-label={`Tema: ${THEME_LABEL[user.theme]}. Cambiar a ${THEME_LABEL[nextTheme]}`} title={`Tema: ${THEME_LABEL[user.theme]}`}>
              <Icon name={THEME_ICON[user.theme]} />
            </button>
            <button className="icon-btn" onClick={logout} aria-label="Cerrar sesión" title="Cerrar sesión"><Icon name="logout" /></button>
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
