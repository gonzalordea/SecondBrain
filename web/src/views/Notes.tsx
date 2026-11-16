import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { api, ApiError, type Note, type NoteSummary, type NoteType, type TaskStatus } from '../api.ts';
import { useSession } from '../session.ts';
import { fmtBytes, fmtDate, lineDiff, renderMarkdown, timeAgo } from '../text.tsx';
import {
  confirmAction, Dialog, Empty, errMsg, ErrorState, Icon, navigate, Skeleton, Spinner, STATUS_LABEL, TYPE_LABEL, useAsync, useToast,
} from '../ui.tsx';

const TITLES: Record<string, string> = { task: 'Tareas', document: 'Documentos', note: 'Notas' };
const PAGE = 100;

export function NotesView({ noteId, query }: { noteId?: string; query: URLSearchParams }) {
  const toast = useToast();
  const qs = query.toString();
  const [sort, setSort] = useState(query.get('type') === 'task' ? 'due' : 'updated');
  const list = useAsync((signal) => {
    const p = new URLSearchParams(query);
    p.set('sort', sort);
    p.set('limit', String(PAGE));
    return api<{ items: NoteSummary[]; total: number }>(`/notes?${p}`, { signal });
  }, [qs, sort]);
  const [loadingMore, setLoadingMore] = useState(false);
  async function loadMore() {
    const p = new URLSearchParams(query);
    p.set('sort', sort);
    p.set('limit', String(PAGE));
    p.set('offset', String(list.data?.items.length ?? 0));
    setLoadingMore(true);
    try {
      const next = await api<{ items: NoteSummary[]; total: number }>(`/notes?${p}`);
      list.setData((d) => d && { total: next.total, items: [...d.items, ...next.items.filter((n) => !d.items.some((i) => i.id === n.id))] });
    } catch (e) { toast({ message: errMsg(e), tone: 'error' }); }
    finally { setLoadingMore(false); }
  }

  // "New note" creates it right away so autosave, history and sharing work from the first keystroke.
  useEffect(() => {
    if (noteId !== 'new') return;
    const type = (query.get('type') as NoteType) || 'note';
    const tag = query.get('tag');
    api<Note>('/notes', { method: 'POST', body: { title: 'Sin título', type, ...(tag && { tags: [tag] }) } })
      .then((n) => { location.replace(`#/notes/${n.id}${qs ? `?${qs}` : ''}`); list.reload(); })
      .catch((e) => toast({ message: errMsg(e), tone: 'error' }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteId]);

  const scope = query.get('scope'), type = query.get('type'), tag = query.get('tag'), category = query.get('category');
  const heading = scope === 'shared' ? 'Compartidas conmigo' : tag ? `#${tag}` : category ? category : type ? TITLES[type] : 'Todas las notas';
  const open = noteId && noteId !== 'new' ? noteId : undefined;
  const newHref = `#/notes/new${qs ? `?${qs}` : ''}`;

  const patchListItem = (n: Note) => list.setData((d) => d && {
    ...d, items: d.items.map((i) => (i.id === n.id ? { ...i, title: n.title, excerpt: n.content.slice(0, 240), tags: n.tags, status: n.status, dueDate: n.dueDate, type: n.type, updatedAt: n.updatedAt } : i)),
  });
  const removeListItem = (id: string) => list.setData((d) => d && { total: d.total - 1, items: d.items.filter((i) => i.id !== id) });

  return (
    <div className={`notes-layout ${open ? 'has-open' : ''}`}>
      <section className="list-pane" aria-label="Lista de notas">
        <header className="pane-head">
          <div>
            <h1>{heading}</h1>
            <p className="muted small">{list.data ? `${list.data.total} ${list.data.total === 1 ? 'elemento' : 'elementos'}` : ' '}</p>
          </div>
          <div className="row gap-s">
            <label className="sr-only" htmlFor="sort">Ordenar</label>
            <select id="sort" className="select sm" value={sort} onChange={(e) => setSort(e.target.value)}>
              <option value="updated">Recientes</option>
              <option value="created">Creación</option>
              <option value="title">Título</option>
              <option value="due">Vencimiento</option>
            </select>
            {scope !== 'shared' && <a className="icon-btn accent" href={newHref} aria-label="Nueva nota"><Icon name="plus" /></a>}
          </div>
        </header>
        {list.error ? <ErrorState error={list.error} retry={list.reload} /> : !list.data ? <div className="pad"><Skeleton lines={6} /></div> : list.data.items.length === 0 ? (
          scope === 'shared'
            ? <Empty icon="people" title="Nadie ha compartido nada contigo todavía">Cuando alguien comparta una nota contigo aparecerá aquí.</Empty>
            : <Empty icon={type ?? 'note'} title="Aquí no hay nada aún" action={<a className="btn primary" href={newHref}><Icon name="plus" size={16} /> Crear {type ? TYPE_LABEL[type as NoteType].toLowerCase() : 'nota'}</a>}>
                Escribe, importa documentos o crea tareas. Usa <code>#etiquetas</code>, <code>@personas</code> y <code>[[enlaces]]</code> para conectar ideas.
              </Empty>
        ) : (
          <ul className="note-list">
            {list.data.items.map((n) => (
              <li key={n.id}>
                <a href={`#/notes/${n.id}${qs ? `?${qs}` : ''}`} className={`note-item ${n.id === open ? 'active' : ''} ${n.status === 'done' ? 'done' : ''}`}
                  aria-current={n.id === open ? 'true' : undefined}>
                  <span className={`type-dot t-${n.type}`} aria-label={TYPE_LABEL[n.type]}><Icon name={n.type} size={14} /></span>
                  <span className="note-item-body">
                    <span className="note-item-title">{n.title}</span>
                    <span className="note-item-excerpt">{n.excerpt.replace(/[#*_>`[\]]/g, '') || <em>Vacía</em>}</span>
                    <span className="note-item-meta">
                      {n.status && <span className={`status s-${n.status}`}>{STATUS_LABEL[n.status]}</span>}
                      {n.dueDate && <span className={isOverdue(n.dueDate, n.status) ? 'overdue' : ''}>vence {n.dueDate}</span>}
                      {scope === 'shared' && <span>de {n.ownerName}</span>}
                      <span>{timeAgo(n.updatedAt)}</span>
                      {n.tags.slice(0, 3).map((t) => <span key={t} className="tag-mini">#{t}</span>)}
                    </span>
                  </span>
                </a>
              </li>
            ))}
          </ul>
        )}
        {list.data && list.data.items.length < list.data.total && (
          <div className="pad center-x">
            <button className="btn sm" onClick={loadMore} disabled={loadingMore}>
              {loadingMore ? <Spinner /> : `Mostrar más (${list.data.total - list.data.items.length})`}
            </button>
          </div>
        )}
      </section>
      <section className="editor-pane" aria-label="Editor">
        {noteId === 'new' ? <div className="pad center"><Spinner label="Creando nota" /></div>
          : open ? <Editor key={open} id={open} backHref={`#/notes${qs ? `?${qs}` : ''}`} onChange={patchListItem} onDeleted={(id) => { removeListItem(id); list.reload(); }} onRestored={list.reload} />
          : <Empty icon="edit" title="Selecciona una nota" action={<a className="btn" href={newHref}>Empezar una nueva</a>}>O pulsa <kbd>Ctrl K</kbd> para buscar por significado.</Empty>}
      </section>
    </div>
  );
}

const isOverdue = (due: string, status: TaskStatus | null) => status !== 'done' && due < new Date().toISOString().slice(0, 10);

type SaveState = 'saved' | 'dirty' | 'saving' | 'conflict' | 'error';

function Editor({ id, backHref, onChange, onDeleted, onRestored }: {
  id: string; backHref: string; onChange: (n: Note) => void; onDeleted: (id: string) => void; onRestored: () => void;
}) {
  const toast = useToast();
  const { facets, refreshFacets } = useSession();
  const loaded = useAsync((signal) => api<Note>(`/notes/${id}`, { signal }), [id]);
  const [note, setNote] = useState<Note | null>(null);
  const [draft, setDraft] = useState({ title: '', content: '' });
  const [save, setSave] = useState<SaveState>('saved');
  const [mode, setMode] = useState<'edit' | 'preview'>('edit');
  const [dialog, setDialog] = useState<'history' | 'share' | null>(null);
  const chain = useRef(Promise.resolve());
  const latest = useRef<Note | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const pending = useRef<Partial<{ title: string; content: string }>>({});
  const titleRef = useRef<HTMLInputElement>(null);
  // Background enrichment only touches its own fields, so it can merge into the note while you type.
  const onEnriched = useCallback((e: Enriched) => setNote((n) => n && { ...n, ...e }), []);

  useEffect(() => {
    if (!loaded.data) return;
    latest.current = loaded.data;
    setNote(loaded.data);
    setDraft({ title: loaded.data.title, content: loaded.data.content });
    setMode(loaded.data.access === 'viewer' || (loaded.data.content && loaded.data.type === 'document') ? 'preview' : 'edit');
    // A brand-new note: select the placeholder title so typing replaces it.
    if (loaded.data.version === 1 && loaded.data.title === 'Sin título') requestAnimationFrame(() => titleRef.current?.select());
  }, [loaded.data]);

  const readOnly = note?.access === 'viewer';

  /** Serialised PATCH: each save waits for the previous one and uses the freshest version number. */
  const persist = (patch: Record<string, unknown>) => {
    chain.current = chain.current.then(async () => {
      if (!latest.current) return;
      setSave('saving');
      try {
        const n = await api<Note>(`/notes/${id}`, { method: 'PATCH', body: { ...patch, version: latest.current.version } });
        latest.current = n;
        setNote(n);
        onChange(n);
        setSave(Object.keys(pending.current).length ? 'dirty' : 'saved');
        if ('tags' in patch || 'content' in patch) refreshFacets();
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) setSave('conflict');
        else { setSave('error'); toast({ message: errMsg(e), tone: 'error' }); }
      }
    });
    return chain.current;
  };

  const flush = () => {
    clearTimeout(timer.current);
    const p = pending.current;
    pending.current = {};
    if (Object.keys(p).length) return persist(p);
    return chain.current;
  };

  const edit = (field: 'title' | 'content', value: string) => {
    setDraft((d) => ({ ...d, [field]: value }));
    pending.current[field] = value;
    setSave('dirty');
    clearTimeout(timer.current);
    timer.current = setTimeout(flush, 900);
  };

  // Save on unmount / tab close so nothing typed is lost.
  useEffect(() => {
    const beforeUnload = (e: BeforeUnloadEvent) => { if (Object.keys(pending.current).length) { flush(); e.preventDefault(); } };
    addEventListener('beforeunload', beforeUnload);
    return () => { removeEventListener('beforeunload', beforeUnload); flush(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function resolveConflict(keepMine: boolean) {
    const fresh = await api<Note>(`/notes/${id}`);
    latest.current = fresh;
    if (keepMine) {
      await persist({ title: draft.title, content: draft.content });
    } else {
      setNote(fresh);
      setDraft({ title: fresh.title, content: fresh.content });
      pending.current = {};
      setSave('saved');
    }
  }

  async function remove() {
    await flush();
    try {
      await api(`/notes/${id}`, { method: 'DELETE' });
      onDeleted(id);
      navigate(backHref);
      toast({
        message: 'Nota movida a la papelera',
        action: { label: 'Deshacer', run: () => api(`/trash/${id}/restore`, { method: 'POST' }).then(() => { onRestored(); navigate(`#/notes/${id}`); }) },
      });
    } catch (e) { toast({ message: errMsg(e), tone: 'error' }); }
  }

  if (loaded.error) return <ErrorState error={loaded.error} retry={loaded.reload} />;
  if (!note) return <div className="pad"><Skeleton lines={8} /></div>;

  return (
    <article className="editor">
      <div className="editor-main">
        <div className="editor-toolbar">
          <a className="icon-btn back" href={backHref} aria-label="Volver a la lista"><Icon name="back" /></a>
          <SaveBadge state={save} />
          <div className="toolbar-actions">
            <div className="segmented sm" role="group" aria-label="Modo">
              <button aria-pressed={mode === 'edit'} disabled={readOnly} onClick={() => setMode('edit')}><Icon name="edit" size={15} /><span>Editar</span></button>
              <button aria-pressed={mode === 'preview'} onClick={() => { flush(); setMode('preview'); }}><Icon name="eye" size={15} /><span>Leer</span></button>
            </div>
            <button className="icon-btn" onClick={() => { flush(); setDialog('history'); }} aria-label="Historial de versiones" title="Historial"><Icon name="history" /></button>
            {note.access === 'owner' && <button className="icon-btn" onClick={() => setDialog('share')} aria-label="Compartir" title="Compartir"><Icon name="share" /></button>}
            <a className="icon-btn" href={`/api/notes/${id}/export.md`} download aria-label="Exportar a Markdown" title="Exportar .md"><Icon name="download" /></a>
            {note.access === 'owner' && <button className="icon-btn danger" onClick={remove} aria-label="Mover a la papelera" title="Borrar"><Icon name="trash" /></button>}
          </div>
        </div>

        {save === 'conflict' && (
          <div className="banner warn" role="alert">
            <Icon name="alert" />
            <span>Esta nota se cambió en otra pestaña o por otra persona.</span>
            <button className="btn sm" onClick={() => resolveConflict(false)}>Cargar la suya</button>
            <button className="btn sm primary" onClick={() => resolveConflict(true)}>Mantener la mía</button>
          </div>
        )}
        {note.access !== 'owner' && (
          <div className="banner info"><Icon name="people" size={16} /> Compartida por {note.owner.displayName} · {note.access === 'viewer' ? 'solo lectura' : 'puedes editar'}</div>
        )}

        <input ref={titleRef} className="title-input" value={draft.title} readOnly={readOnly} aria-label="Título"
          onChange={(e) => edit('title', e.target.value)} maxLength={200} placeholder="Título" />

        <MetaBar note={note} readOnly={readOnly} tagSuggestions={facets?.tags.map((t) => t.name) ?? []}
          categories={facets?.categories.map((c) => c.name) ?? []} onPatch={(p) => persist(p)} />

        {mode === 'edit' && !readOnly ? (
          <textarea className="body-input" value={draft.content} onChange={(e) => edit('content', e.target.value)}
            aria-label="Contenido (Markdown)" placeholder={'Escribe en Markdown…\n\n#etiqueta · @Persona · [[Otra nota]]'}
            onKeyDown={(e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); flush(); } }} />
        ) : (
          draft.content.trim()
            ? <div className="prose" dangerouslySetInnerHTML={{ __html: renderMarkdown(draft.content, note.linksOut) }} />
            : <p className="muted pad-y">Esta nota está vacía.</p>
        )}
      </div>

      <Aside note={note} onEnriched={onEnriched} />

      <Dialog open={dialog === 'history'} onClose={() => setDialog(null)} title="Historial de versiones" wide>
        <History note={note} readOnly={readOnly} onRestored={(n) => {
          latest.current = n; setNote(n); setDraft({ title: n.title, content: n.content }); onChange(n); setDialog(null);
          toast({ message: 'Versión restaurada', tone: 'ok' });
        }} />
      </Dialog>
      {note.access === 'owner' && (
        <Dialog open={dialog === 'share'} onClose={() => setDialog(null)} title="Compartir nota">
          <Share noteId={id} />
        </Dialog>
      )}
    </article>
  );
}

function SaveBadge({ state }: { state: SaveState }) {
  const label = { saved: 'Guardado', dirty: 'Cambios sin guardar', saving: 'Guardando…', conflict: 'Conflicto', error: 'Error al guardar' }[state];
  return <span className={`save-badge ${state}`} role="status" aria-live="polite"><span className="dot" />{label}</span>;
}

function MetaBar({ note, readOnly, tagSuggestions, categories, onPatch }: {
  note: Note; readOnly: boolean; tagSuggestions: string[]; categories: string[]; onPatch: (p: Record<string, unknown>) => void;
}) {
  const [category, setCategory] = useState(note.category ?? '');
  useEffect(() => setCategory(note.category ?? ''), [note.category]);
  return (
    <div className="meta-bar">
      <label className="meta-field">
        <span className="sr-only">Tipo</span>
        <Icon name={note.type} size={15} />
        <select value={note.type} disabled={readOnly} onChange={(e) => onPatch({ type: e.target.value, ...(e.target.value === 'task' && !note.status && { status: 'todo' }) })}>
          {Object.entries(TYPE_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      </label>
      {note.type === 'task' && (
        <>
          <label className="meta-field">
            <span className="sr-only">Estado</span>
            <select value={note.status ?? 'todo'} disabled={readOnly} className={`s-${note.status}`} onChange={(e) => onPatch({ status: e.target.value })}>
              {Object.entries(STATUS_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
          <label className={`meta-field ${note.dueDate && isOverdue(note.dueDate, note.status) ? 'overdue' : ''}`}>
            <span className="small muted">Vence</span>
            <input type="date" value={note.dueDate ?? ''} disabled={readOnly} onChange={(e) => onPatch({ dueDate: e.target.value || null })} />
          </label>
        </>
      )}
      <label className="meta-field">
        <span className="sr-only">Categoría</span>
        <Icon name="inbox" size={15} />
        <input list="categories" value={category} placeholder="Categoría" disabled={readOnly} maxLength={60}
          onChange={(e) => setCategory(e.target.value)}
          onBlur={() => category !== (note.category ?? '') && onPatch({ category: category.trim() || null })}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
        <datalist id="categories">{categories.map((c) => <option key={c} value={c} />)}</datalist>
      </label>
      {/* Tags written as #hashtags live in the text; only manual tags are sent (and removable) here. */}
      <TagInput tags={note.tags} fromText={note.textTags} suggestions={tagSuggestions} readOnly={readOnly}
        onChange={(tags) => onPatch({ tags: tags.filter((t) => !note.textTags.includes(t)) })} />
    </div>
  );
}

function TagInput({ tags, fromText, suggestions, readOnly, onChange }: { tags: string[]; fromText: string[]; suggestions: string[]; readOnly: boolean; onChange: (t: string[]) => void }) {
  const [value, setValue] = useState('');
  const add = (raw: string) => {
    const t = raw.replace(/^#/, '').trim();
    if (!t || !/^[\p{L}\p{N}_ -]{1,50}$/u.test(t) || tags.some((x) => x.toLowerCase() === t.toLowerCase())) return setValue('');
    onChange([...tags, t]);
    setValue('');
  };
  return (
    <div className="tag-input">
      <Icon name="tag" size={15} />
      {tags.map((t) => (
        <span key={t} className="chip">
          <a href={`#/notes?tag=${encodeURIComponent(t)}`}>#{t}</a>
          {!readOnly && !fromText.includes(t) && <button onClick={() => onChange(tags.filter((x) => x !== t))} aria-label={`Quitar etiqueta ${t}`}><Icon name="x" size={12} /></button>}
        </span>
      ))}
      {!readOnly && (
        <>
          <input value={value} list="tag-suggestions" placeholder={tags.length ? '' : 'Añadir etiqueta'} aria-label="Añadir etiqueta" maxLength={50}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(value); }
              if (e.key === 'Backspace' && !value) { const last = [...tags].reverse().find((t) => !fromText.includes(t)); if (last) onChange(tags.filter((t) => t !== last)); }
            }}
            onBlur={() => value && add(value)} />
          <datalist id="tag-suggestions">{suggestions.filter((s) => !tags.includes(s)).map((s) => <option key={s} value={s} />)}</datalist>
        </>
      )}
    </div>
  );
}

type Enriched = Pick<Note, 'summary' | 'summaryMethod' | 'people' | 'aiPeople' | 'concepts' | 'enrichStatus' | 'embeddingStatus'>;
const enrichedFields = (n: Note): Enriched =>
  ({ summary: n.summary, summaryMethod: n.summaryMethod, people: n.people, aiPeople: n.aiPeople, concepts: n.concepts, enrichStatus: n.enrichStatus, embeddingStatus: n.embeddingStatus });

function Aside({ note, onEnriched }: { note: Note; onEnriched: (e: Enriched) => void }) {
  const toast = useToast();
  const [summarizing, setSummarizing] = useState(false);

  // Enrichment runs in the background after edits settle; refresh just its fields (never the text being edited).
  useEffect(() => {
    if (note.enrichStatus !== 'pending') return;
    const t = setInterval(() => {
      api<Note>(`/notes/${note.id}`).then((n) => n.enrichStatus !== 'pending' && onEnriched(enrichedFields(n))).catch(() => {});
    }, 5000);
    return () => clearInterval(t);
  }, [note.id, note.enrichStatus, onEnriched]);
  const related = useAsync((signal) => api<{ items: { id: string; title: string; type: NoteType; similarity: number; linked: boolean; sharedTags: number }[]; ready: boolean }>(
    `/notes/${note.id}/related`, { signal }), [note.id, note.embeddingStatus === 'ready', note.version]);
  const [linked, setLinked] = useState<Set<string>>(new Set());

  // Indexing runs in the background; poll briefly until related notes become available.
  useEffect(() => {
    if (!related.data || related.data.ready || note.access !== 'owner') return;
    const t = setTimeout(related.reload, 2500);
    return () => clearTimeout(t);
  }, [related.data, related.reload, note.access]);

  async function summarize() {
    setSummarizing(true);
    try {
      await api(`/notes/${note.id}/summarize`, { method: 'POST' });
      onEnriched(enrichedFields(await api<Note>(`/notes/${note.id}`)));
    } catch (e) { toast({ message: errMsg(e), tone: 'error' }); }
    finally { setSummarizing(false); }
  }

  async function link(targetId: string) {
    try {
      await api(`/notes/${note.id}/links`, { method: 'POST', body: { targetId } });
      setLinked((s) => new Set(s).add(targetId));
    } catch (e) { toast({ message: errMsg(e), tone: 'error' }); }
  }

  const links = useMemo(() => {
    const m = new Map<string, { id: string; title: string; dir: string }>();
    for (const l of note.linksOut) m.set(l.id, { ...l, dir: '→' });
    for (const l of note.linksIn) m.set(l.id, { ...l, dir: m.has(l.id) ? '↔' : '←' });
    return [...m.values()];
  }, [note.linksIn, note.linksOut]);

  return (
    <aside className="editor-aside" aria-label="Contexto de la nota">
      {note.files.length > 0 && (
        <section className="card">
          <h2>Fichero original</h2>
          <ul className="file-list">
            {note.files.map((f) => (
              <li key={f.id}>
                <span className="file-icon" aria-hidden="true">{f.mime === 'application/pdf' ? 'PDF' : f.mime.startsWith('text/markdown') ? 'MD' : 'TXT'}</span>
                <span className="grow">
                  <span className="file-name" title={f.filename}>{f.filename}</span>
                  <small className="muted">{fmtBytes(f.size)} · {fmtDate(f.createdAt)}</small>
                </span>
                <a className="icon-btn" href={`/api/notes/${note.id}/files/${f.id}`} download={f.filename}
                  aria-label={`Descargar ${f.filename}`} title="Descargar"><Icon name="download" /></a>
              </li>
            ))}
          </ul>
        </section>
      )}
      <section className="card">
        <header className="card-head">
          <h2>Resumen</h2>
          {note.access !== 'viewer' && (
            <button className="btn sm ghost" onClick={summarize} disabled={summarizing || !note.content.trim()}>
              {summarizing ? <Spinner /> : <Icon name="sparkle" size={14} />} {note.summary ? 'Regenerar' : 'Generar'}
            </button>
          )}
        </header>
        {note.summary
          ? <><p className="summary">{note.summary}</p><p className="tiny muted">{note.summaryMethod === 'llm' ? 'Generado con IA' : 'Extractivo: frases más representativas (IA no configurada)'}</p></>
          : <p className="muted small">Aún sin resumen.</p>}
        {note.enrichStatus === 'pending' && (
          <p className="tiny muted enrich-status" role="status"><Spinner /> Se actualizará solo cuando dejes de editar.</p>
        )}
        {note.enrichStatus === 'failed' && (
          <p className="tiny enrich-failed" role="status"><Icon name="alert" size={13} /> No se pudo analizar la última versión. Prueba «{note.summary ? 'Regenerar' : 'Generar'}».</p>
        )}
      </section>

      {note.access === 'owner' && (
        <section className="card">
          <header className="card-head"><h2>Conexiones</h2>{related.loading && <Spinner />}</header>
          {related.error ? <p className="muted small">No disponible.</p>
            : !related.data?.ready ? <p className="muted small"><Spinner /> Indexando para encontrar notas afines…</p>
            : related.data.items.length === 0 ? <p className="muted small">Todavía no hay notas parecidas.</p>
            : (
              <ul className="related">
                {related.data.items.slice(0, 6).map((r) => (
                  <li key={r.id}>
                    <a href={`#/notes/${r.id}`}>
                      <span className="related-title">{r.title}</span>
                      <span className="meter" aria-label={`Similitud ${Math.round(r.similarity * 100)}%`}><span style={{ width: `${Math.max(4, r.similarity * 100)}%` }} /></span>
                    </a>
                    {r.linked || linked.has(r.id)
                      ? <span className="tiny muted" title="Ya enlazadas"><Icon name="link" size={13} /></span>
                      : <button className="icon-btn xs" onClick={() => link(r.id)} aria-label={`Enlazar con ${r.title}`} title="Enlazar"><Icon name="plus" size={14} /></button>}
                  </li>
                ))}
              </ul>
            )}
        </section>
      )}

      {(links.length > 0 || note.people.length > 0 || note.concepts.length > 0) && (
        <section className="card">
          {links.length > 0 && (<>
            <h2>Enlaces</h2>
            <ul className="plain-list">{links.map((l) => <li key={l.id}><span className="muted">{l.dir}</span> <a href={`#/notes/${l.id}`}>{l.title}</a></li>)}</ul>
          </>)}
          {note.people.length > 0 && (<>
            <h2>Personas</h2>
            <div className="chips">{note.people.map((p) => (
              <a key={p} className="chip person" href={`#/search?q=${encodeURIComponent(p)}`} title={note.aiPeople.includes(p) ? 'Detectada por la IA' : 'Mencionada con @'}>
                {note.aiPeople.includes(p) ? <Icon name="sparkle" size={11} /> : '@'}{p}
              </a>
            ))}</div>
          </>)}
          {note.concepts.length > 0 && (<>
            <h2>Conceptos <span className="ai-badge" title="Detectados por la IA"><Icon name="sparkle" size={11} /> IA</span></h2>
            <div className="chips">{note.concepts.map((c) => <a key={c} className="chip concept" href={`#/search?q=${encodeURIComponent(c)}`}>{c}</a>)}</div>
          </>)}
        </section>
      )}

      <section className="card info">
        <dl>
          <dt>Creada</dt><dd>{fmtDate(note.createdAt)}</dd>
          <dt>Editada</dt><dd>{fmtDate(note.updatedAt)}</dd>
          <dt>Versión</dt><dd>{note.version}</dd>
          <dt>Origen</dt><dd>{{ manual: 'Escrita aquí', import: 'Importada', upload: 'Fichero subido' }[note.source] ?? note.source}</dd>
          <dt>Búsqueda semántica</dt><dd>{{ ready: 'Indexada', pending: 'Indexando…', failed: 'Error al indexar' }[note.embeddingStatus]}</dd>
        </dl>
      </section>
    </aside>
  );
}

function History({ note, readOnly, onRestored }: { note: Note; readOnly: boolean; onRestored: (n: Note) => void }) {
  const toast = useToast();
  const list = useAsync((signal) => api<{ versions: { version: number; title: string; createdAt: string; editedBy: string | null; length: number }[] }>(`/notes/${note.id}/versions`, { signal }), [note.id]);
  const [sel, setSel] = useState<number | null>(null);
  const version = useAsync((signal) => (sel ? api<{ version: number; title: string; content: string }>(`/notes/${note.id}/versions/${sel}`, { signal }) : Promise.resolve(null)), [sel]);
  const diff = useMemo(() => (version.data ? lineDiff(version.data.content, note.content) : []), [version.data, note.content]);

  if (list.error) return <ErrorState error={list.error} retry={list.reload} />;
  if (!list.data) return <Skeleton />;
  if (list.data.versions.length < 2) return <Empty icon="history" title="Aún no hay versiones anteriores">Cada sesión de edición guarda una versión (lo que escribes seguido en menos de 2 minutos cuenta como una). Restaurar una versión nunca borra las demás.</Empty>;

  return (
    <div className="history">
      <ul className="history-list">
        {list.data.versions.map((v) => (
          <li key={v.version}>
            <button aria-pressed={sel === v.version} onClick={() => setSel(v.version)}>
              <strong>v{v.version}</strong> <span>{v.title}</span>
              <small>{fmtDate(v.createdAt)}{v.editedBy && ` · ${v.editedBy}`}</small>
            </button>
          </li>
        ))}
      </ul>
      <div className="history-diff">
        {!sel ? <p className="muted">Elige una versión para ver qué ha cambiado desde entonces hasta ahora.</p>
          : version.loading ? <Skeleton lines={6} />
          : version.data && (
            <>
              <div className="row between">
                <p className="small"><span className="legend del">− v{version.data.version}</span> <span className="legend add">+ actual</span></p>
                {!readOnly && (
                  <button className="btn sm primary" onClick={async () => {
                    try { onRestored(await api<Note>(`/notes/${note.id}/versions/${sel}/restore`, { method: 'POST' })); }
                    catch (e) { toast({ message: errMsg(e), tone: 'error' }); }
                  }}>Restaurar v{version.data.version}</button>
                )}
              </div>
              {version.data.title !== note.title && <p className="small">Título: <del>{version.data.title}</del> → <ins>{note.title}</ins></p>}
              <pre className="diff">{diff.map((d, i) => <div key={i} className={d.kind}><span aria-hidden="true">{d.kind === 'add' ? '+' : d.kind === 'del' ? '−' : ' '}</span>{d.text || ' '}</div>)}</pre>
            </>
          )}
      </div>
    </div>
  );
}

function Share({ noteId }: { noteId: string }) {
  const toast = useToast();
  const shares = useAsync((signal) => api<{ shares: { userId: string; email: string; displayName: string; role: 'viewer' | 'editor' }[] }>(`/notes/${noteId}/shares`, { signal }), [noteId]);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'viewer' | 'editor'>('viewer');
  const [busy, setBusy] = useState(false);

  async function add(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api(`/notes/${noteId}/shares`, { method: 'PUT', body: { email, role } });
      setEmail('');
      shares.reload();
    } catch (err) { toast({ message: errMsg(err), tone: 'error' }); }
    finally { setBusy(false); }
  }

  return (
    <div className="stack">
      <form className="row gap-s wrap" onSubmit={add}>
        <input className="input grow" type="email" required placeholder="email@ejemplo.com" value={email} onChange={(e) => setEmail(e.target.value)} aria-label="Email de la persona" />
        <select className="select" value={role} onChange={(e) => setRole(e.target.value as 'viewer' | 'editor')} aria-label="Permiso">
          <option value="viewer">Puede leer</option>
          <option value="editor">Puede editar</option>
        </select>
        <button className="btn primary" disabled={busy}>Compartir</button>
      </form>
      <p className="tiny muted">Las notas compartidas no se usan en la búsqueda ni en el asistente de la otra persona.</p>
      {shares.data && (shares.data.shares.length === 0 ? <p className="muted small">Solo tú tienes acceso.</p> : (
        <ul className="share-list">
          {shares.data.shares.map((s) => (
            <li key={s.userId}>
              <span className="avatar sm" aria-hidden="true">{s.displayName[0]?.toUpperCase()}</span>
              <span className="grow"><strong>{s.displayName}</strong> <small className="muted">{s.email}</small></span>
              <span className="badge">{s.role === 'viewer' ? 'Lectura' : 'Edición'}</span>
              <button className="icon-btn xs" aria-label={`Quitar acceso a ${s.email}`} onClick={async () => {
                if (!confirmAction(`¿Quitar el acceso a ${s.email}?`)) return;
                await api(`/notes/${noteId}/shares/${s.userId}`, { method: 'DELETE' }).catch((e) => toast({ message: errMsg(e), tone: 'error' }));
                shares.reload();
              }}><Icon name="x" size={14} /></button>
            </li>
          ))}
        </ul>
      ))}
    </div>
  );
}
