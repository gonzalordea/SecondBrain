import { useState, type FormEvent } from 'react';
import { api, type Note, type NoteSummary } from '../api.ts';
import { useSession } from '../session.ts';
import { fmtNum, timeAgo } from '../text.tsx';
import { errMsg, Icon, navigate, Skeleton, Spinner, useAsync, useToast } from '../ui.tsx';

const today = () => new Date().toISOString().slice(0, 10);
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

function greeting() {
  const h = new Date().getHours();
  return h < 6 ? 'Buenas noches' : h < 13 ? 'Buenos días' : h < 21 ? 'Buenas tardes' : 'Buenas noches';
}

export function HomeView() {
  const { user, refreshFacets } = useSession();
  const toast = useToast();
  const tasks = useAsync((signal) => api<{ items: NoteSummary[] }>('/notes?type=task&sort=due&limit=50', { signal }), []);
  const recent = useAsync((signal) => api<{ items: NoteSummary[]; total: number }>('/notes?sort=updated&limit=7', { signal }), []);
  const stats = useAsync((signal) => api<{ totals: { notes: number; words: number; links: number }; orphans: number; indexing: { pending: number } }>('/stats', { signal }), []);
  const connections = useAsync((signal) => api<{ items: { a: { id: string; title: string }; b: { id: string; title: string }; similarity: number }[] }>(
    '/insights/connections?limit=3', { signal }), []);
  const [capture, setCapture] = useState('');
  const [saving, setSaving] = useState(false);
  const [busyTask, setBusyTask] = useState<string | null>(null);

  // Overdue, due within a week, or in progress — what deserves attention today.
  const focus = (tasks.data?.items ?? []).filter((t) => t.status !== 'done' && (t.status === 'doing' || (t.dueDate && t.dueDate <= inDays(7)))).slice(0, 7);

  async function save(e: FormEvent) {
    e.preventDefault();
    const text = capture.trim();
    if (!text) return;
    const [first, ...rest] = text.split(/(?<=[.!?])\s+/);
    setSaving(true);
    try {
      const n = await api<Note>('/notes', { method: 'POST', body: { title: first.slice(0, 200), content: rest.join(' ') } });
      setCapture('');
      recent.reload();
      refreshFacets();
      toast({ message: 'Idea guardada', action: { label: 'Abrir', run: () => navigate(`#/notes/${n.id}`) } });
    } catch (err) { toast({ message: errMsg(err), tone: 'error' }); }
    finally { setSaving(false); }
  }

  async function complete(t: NoteSummary) {
    setBusyTask(t.id);
    try {
      await api(`/notes/${t.id}`, { method: 'PATCH', body: { version: t.version, status: 'done' } });
      tasks.setData((d) => d && { items: d.items.map((x) => (x.id === t.id ? { ...x, status: 'done' as const, version: x.version + 1 } : x)) });
    } catch (err) { toast({ message: errMsg(err), tone: 'error' }); }
    finally { setBusyTask(null); }
  }

  const dateLabel = new Date().toLocaleDateString('es', { weekday: 'long', day: 'numeric', month: 'long' });

  return (
    <div className="page home">
      <header className="page-head">
        <div>
          <span className="eyebrow">{dateLabel}</span>
          <h1>{greeting()}, {user.displayName}</h1>
        </div>
      </header>

      <form className="capture" onSubmit={save}>
        <Icon name="plus" size={16} />
        <label className="sr-only" htmlFor="capture">Captura rápida</label>
        <input id="capture" value={capture} onChange={(e) => setCapture(e.target.value)} maxLength={4000} autoComplete="off"
          placeholder="Anota una idea. La primera frase será el título." />
        {saving ? <Spinner /> : <kbd>Intro</kbd>}
      </form>

      <div className="home-grid">
        <section className="home-section" aria-labelledby="h-focus">
          <header><h2 id="h-focus">Para esta semana</h2><a href="#/notes?type=task">todas las tareas →</a></header>
          {tasks.error ? <p className="quiet">{errMsg(tasks.error)}</p> : !tasks.data ? <Skeleton lines={4} /> : focus.length === 0 ? (
            <p className="quiet">Nada vence en los próximos siete días.</p>
          ) : focus.map((t) => {
            const done = t.status === 'done';
            const overdue = !!t.dueDate && t.dueDate < today();
            return (
              <div key={t.id} className={`task-row ${done ? 'done' : ''}`}>
                <button className="task-check" role="checkbox" aria-checked={done} disabled={done || busyTask === t.id}
                  aria-label={`Marcar «${t.title}» como hecha`} onClick={() => complete(t)}>
                  {done && <Icon name="check" size={11} />}
                </button>
                <a href={`#/notes/${t.id}`}>{t.title}</a>
                <span className={`due ${overdue && !done ? 'overdue' : ''}`}>
                  {t.status === 'doing' && !t.dueDate ? 'en curso' : t.dueDate ? (overdue ? `venció ${t.dueDate.slice(5)}` : t.dueDate === today() ? 'hoy' : t.dueDate.slice(5)) : ''}
                </span>
              </div>
            );
          })}
        </section>

        <section className="home-section" aria-labelledby="h-recent">
          <header><h2 id="h-recent">Recientes</h2><a href="#/notes">ver todo →</a></header>
          {recent.error ? <p className="quiet">{errMsg(recent.error)}</p> : !recent.data ? <Skeleton lines={5} /> : recent.data.items.length === 0 ? (
            <p className="quiet">Aún no hay notas. Escribe la primera arriba.</p>
          ) : recent.data.items.map((n) => (
            <a key={n.id} href={`#/notes/${n.id}`} className="recent-row">
              <strong>{n.title}</strong>
              <span>{timeAgo(n.updatedAt)}</span>
            </a>
          ))}
        </section>

        {!!connections.data?.items.length && (
          <section className="home-section home-wide" aria-labelledby="h-conn">
            <header><h2 id="h-conn">Por conectar</h2><a href="#/insights">panorama →</a></header>
            <ul className="connections">
              {connections.data.items.map((p) => (
                <li key={`${p.a.id}:${p.b.id}`}>
                  <a href={`#/notes/${p.a.id}`}>{p.a.title}</a>
                  <span className="conn-mid"><span className="meter"><span style={{ width: `${p.similarity * 100}%` }} /></span><small>{Math.round(p.similarity * 100)} % afinidad</small></span>
                  <a href={`#/notes/${p.b.id}`}>{p.b.title}</a>
                  <span />
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>

      {stats.data && (
        <p className="pulse" aria-label="Resumen de tu biblioteca">
          <span><b>{fmtNum(stats.data.totals.notes)}</b> elementos</span>
          <span><b>{fmtNum(stats.data.totals.words)}</b> palabras</span>
          <span><b>{fmtNum(stats.data.totals.links)}</b> enlaces</span>
          <span><b>{stats.data.orphans}</b> sin conectar</span>
          {stats.data.indexing.pending > 0 && <span><b>{stats.data.indexing.pending}</b> indexando</span>}
          <a href="#/insights">más en Panorama →</a>
        </p>
      )}
    </div>
  );
}
