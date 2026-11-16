import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { api, type NoteType } from '../api.ts';
import { useSession } from '../session.ts';
import { highlight, timeAgo } from '../text.tsx';
import { Empty, ErrorState, Icon, navigate, Skeleton, Spinner, TYPE_LABEL, useAsync, useDebounced } from '../ui.tsx';

interface Hit {
  id: string; type: NoteType; title: string; tags: string[]; updatedAt: string; snippet: string;
  scores: { score: number; semantic: number; keyword: number; recency: number };
}

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const dq = useDebounced(q.trim(), 220);
  const res = useAsync((signal) => (dq ? api<{ items: Hit[] }>(`/search?q=${encodeURIComponent(dq)}&limit=8`, { signal }) : Promise.resolve({ items: [] as Hit[] })), [dq]);
  const items = res.data?.items ?? [];

  useEffect(() => {
    const d = ref.current!;
    if (open && !d.open) { d.showModal(); setQ(''); setSel(0); }
    if (!open && d.open) d.close();
  }, [open]);
  useEffect(() => setSel(0), [dq]);

  const go = (href: string) => { onClose(); navigate(href); };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(s + 1, items.length)); }
    if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (sel < items.length && items[sel]) go(`#/notes/${items[sel].id}`);
      else if (q.trim()) go(`#/search?q=${encodeURIComponent(q.trim())}`);
    }
  };

  return (
    <dialog ref={ref} className="palette" onClose={onClose} aria-label="Buscar" onClick={(e) => e.target === ref.current && onClose()}>
      {open && (
        <div onKeyDown={onKey}>
          <div className="palette-input">
            <Icon name="search" />
            <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Busca por idea, no solo por palabras…"
              role="combobox" aria-expanded={items.length > 0} aria-controls="palette-results" aria-activedescendant={items[sel] ? `hit-${items[sel].id}` : undefined}
              aria-label="Buscar en tus notas" maxLength={500} />
            {res.loading && dq && <Spinner />}
            <kbd>Esc</kbd>
          </div>
          <ul id="palette-results" role="listbox" className="palette-results">
            {items.map((h, i) => (
              <li key={h.id} id={`hit-${h.id}`} role="option" aria-selected={i === sel}
                onMouseMove={() => sel !== i && setSel(i)} onClick={() => go(`#/notes/${h.id}`)}>
                <span className={`type-dot t-${h.type}`}><Icon name={h.type} size={14} /></span>
                <span className="grow">
                  <strong>{h.title}</strong>
                  <span className="palette-snippet">{highlight(h.snippet.slice(0, 160))}</span>
                </span>
                <span className="score" title="Relevancia">{Math.round(h.scores.score * 100)}</span>
              </li>
            ))}
            {dq && !res.loading && !items.length && <li className="palette-empty">Nada parecido a «{dq}».</li>}
            {dq && (
              <li role="option" aria-selected={sel === items.length} className="palette-more" onMouseMove={() => sel !== items.length && setSel(items.length)}
                onClick={() => go(`#/search?q=${encodeURIComponent(dq)}`)}>
                <Icon name="search" size={15} /> Búsqueda avanzada con filtros para «{dq}»
              </li>
            )}
            {!dq && <li className="palette-empty">Prueba «qué decidimos sobre el presupuesto» o «recetas con poco tiempo».</li>}
          </ul>
        </div>
      )}
    </dialog>
  );
}

export function SearchView({ query }: { query: URLSearchParams }) {
  const { facets } = useSession();
  const [q, setQ] = useState(query.get('q') ?? '');
  const [mode, setMode] = useState('hybrid');
  const [alpha, setAlpha] = useState(0.6);
  const [recency, setRecency] = useState(0);
  const [type, setType] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [category, setCategory] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  useEffect(() => setQ(query.get('q') ?? ''), [query]);

  const params = new URLSearchParams({ q: q.trim(), mode, alpha: String(alpha), recency: String(recency), limit: '30' });
  if (type) params.set('type', type);
  if (tags.length) params.set('tags', tags.join(','));
  if (category) params.set('category', category);
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  const key = useDebounced(params.toString(), 250);
  const res = useAsync((signal) => (q.trim() ? api<{ items: Hit[]; tookMs: number }>(`/search?${key}`, { signal }) : Promise.resolve(null)), [key]);

  return (
    <div className="page search-page">
      <header className="page-head">
        <div><span className="eyebrow">Por significado y por palabras</span><h1>Buscar</h1></div>
        <div className="search-big">
          <Icon name="search" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="¿Qué quieres encontrar?" aria-label="Consulta" maxLength={500} autoFocus />
        </div>
      </header>
      <div className="search-grid">
        <aside className="filters card" aria-label="Filtros">
          <fieldset>
            <legend>Modo</legend>
            <div className="segmented sm">
              {[['hybrid', 'Híbrido'], ['semantic', 'Significado'], ['keyword', 'Palabras']].map(([v, l]) => (
                <button key={v} aria-pressed={mode === v} onClick={() => setMode(v)}>{l}</button>
              ))}
            </div>
          </fieldset>
          {mode === 'hybrid' && (
            <label className="field">
              <span className="row between"><span>Peso semántico</span><output>{Math.round(alpha * 100)}%</output></span>
              <input type="range" min={0} max={1} step={0.05} value={alpha} onChange={(e) => setAlpha(+e.target.value)} />
              <span className="row between tiny muted"><span>Palabras exactas</span><span>Significado</span></span>
            </label>
          )}
          <label className="field">
            <span className="row between"><span>Prioridad a lo reciente</span><output>{Math.round(recency * 100)}%</output></span>
            <input type="range" min={0} max={1} step={0.05} value={recency} onChange={(e) => setRecency(+e.target.value)} />
          </label>
          <label className="field">
            <span>Tipo</span>
            <select className="select" value={type} onChange={(e) => setType(e.target.value)}>
              <option value="">Todos</option>
              {Object.entries(TYPE_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
          {!!facets?.categories.length && (
            <label className="field">
              <span>Categoría</span>
              <select className="select" value={category} onChange={(e) => setCategory(e.target.value)}>
                <option value="">Todas</option>
                {facets.categories.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
              </select>
            </label>
          )}
          <div className="row gap-s">
            <label className="field grow"><span>Desde</span><input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
            <label className="field grow"><span>Hasta</span><input className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
          </div>
          {!!facets?.tags.length && (
            <fieldset>
              <legend>Etiquetas (todas)</legend>
              <div className="chips">
                {facets.tags.slice(0, 20).map((t) => (
                  <button key={t.name} className="chip toggle" aria-pressed={tags.includes(t.name)}
                    onClick={() => setTags((ts) => (ts.includes(t.name) ? ts.filter((x) => x !== t.name) : [...ts, t.name].slice(0, 10)))}>#{t.name}</button>
                ))}
              </div>
            </fieldset>
          )}
        </aside>
        <section aria-live="polite" aria-busy={res.loading}>
          {!q.trim() ? <Empty title="Escribe algo para buscar">La búsqueda combina el significado (embeddings) con las palabras exactas. Ajusta el peso a la izquierda.</Empty>
            : res.error ? <ErrorState error={res.error} retry={res.reload} />
            : !res.data ? <Skeleton lines={6} />
            : res.data.items.length === 0 ? <Empty title="Sin resultados">Prueba otro modo, baja los filtros o reformula la idea.</Empty>
            : (
              <>
                <p className="muted small">{res.data.items.length} resultados · {res.data.tookMs} ms</p>
                <ol className="results">
                  {res.data.items.map((h) => (
                    <li key={h.id} className="result">
                      <a href={`#/notes/${h.id}`}>
                        <span className="row gap-s"><span className={`type-dot t-${h.type}`}><Icon name={h.type} size={14} /></span><strong>{h.title}</strong></span>
                        <p className="result-snippet">{highlight(h.snippet)}</p>
                        <span className="row gap-s wrap tiny muted">
                          <span>{timeAgo(h.updatedAt)}</span>
                          {h.tags.slice(0, 4).map((t) => <span key={t}>#{t}</span>)}
                        </span>
                      </a>
                      <ScoreBreakdown s={h.scores} />
                    </li>
                  ))}
                </ol>
              </>
            )}
        </section>
      </div>
    </div>
  );
}

function ScoreBreakdown({ s }: { s: Hit['scores'] }) {
  const rows: [string, number][] = [['Significado', s.semantic], ['Palabras', s.keyword], ['Reciente', s.recency]];
  return (
    <div className="score-box" aria-label={`Relevancia ${Math.round(s.score * 100)} sobre 100`}>
      <span className="score-total">{Math.round(s.score * 100)}</span>
      <dl>
        {rows.map(([l, v]) => (
          <div key={l}><dt>{l}</dt><dd><span className="meter"><span style={{ width: `${Math.max(2, v * 100)}%` }} /></span></dd></div>
        ))}
      </dl>
    </div>
  );
}

