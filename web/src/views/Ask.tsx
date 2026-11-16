import { Fragment, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { api, streamEvents, type ChatMessage, type Source } from '../api.ts';
import { renderMarkdown, timeAgo } from '../text.tsx';
import { confirmAction, Empty, errMsg, ErrorState, Icon, navigate, Skeleton, Spinner, useAsync, useToast } from '../ui.tsx';

interface Conv { id: string; title: string; updatedAt: string }

export function AskView({ conversationId }: { conversationId?: string }) {
  const toast = useToast();
  const convs = useAsync((signal) => api<{ items: Conv[]; llm: boolean }>('/conversations', { signal }), []);

  async function newConversation() {
    try {
      const c = await api<Conv>('/conversations', { method: 'POST' });
      convs.setData((d) => d && { ...d, items: [c, ...d.items] });
      navigate(`#/ask/${c.id}`);
    } catch (e) { toast({ message: errMsg(e), tone: 'error' }); }
  }

  return (
    <div className={`ask-layout ${conversationId ? 'has-open' : ''}`}>
      <aside className="conv-pane" aria-label="Conversaciones">
        <header className="pane-head">
          <h1>Preguntar</h1>
          <button className="icon-btn accent" onClick={newConversation} aria-label="Nueva conversación"><Icon name="plus" /></button>
        </header>
        {convs.data && !convs.data.llm && <p className="banner info small" style={{ margin: '0 12px 8px' }}><Icon name="alert" size={15} /> Asistente desactivado: falta ANTHROPIC_API_KEY en el servidor.</p>}
        {convs.error ? <ErrorState error={convs.error} retry={convs.reload} /> : !convs.data ? <div className="pad"><Skeleton /></div> : (
          <ul className="conv-list">
            {convs.data.items.map((c) => (
              <li key={c.id} className="conv-row">
                <a href={`#/ask/${c.id}`} aria-current={c.id === conversationId ? 'page' : undefined}>
                  <span className="ellipsis">{c.title}</span><small>{timeAgo(c.updatedAt)}</small>
                </a>
                <button className="icon-btn xs" aria-label={`Borrar conversación ${c.title}`} onClick={async () => {
                  if (!confirmAction('¿Borrar esta conversación?')) return;
                  await api(`/conversations/${c.id}`, { method: 'DELETE' });
                  convs.setData((d) => d && { ...d, items: d.items.filter((x) => x.id !== c.id) });
                  if (c.id === conversationId) navigate('#/ask');
                }}><Icon name="trash" size={14} /></button>
              </li>
            ))}
            {convs.data.items.length === 0 && <li className="muted small pad">Sin conversaciones aún.</li>}
          </ul>
        )}
      </aside>
      <section className="chat-pane">
        {convs.data && !convs.data.llm ? (
          <Empty title="El asistente no está configurado">
            Define <code>ANTHROPIC_API_KEY</code> en el servidor para activar las respuestas con IA. La búsqueda semántica, el grafo y los resúmenes extractivos funcionan sin ella.
          </Empty>
        ) : conversationId ? (
          <Chat key={conversationId} id={conversationId} onActivity={(title) => convs.setData((d) => d && {
            ...d, items: d.items.map((c) => (c.id === conversationId ? { ...c, title, updatedAt: new Date().toISOString() } : c)),
          })} />
        ) : (
          <Empty title="Pregunta a tu segundo cerebro" action={<button className="btn primary" onClick={newConversation}><Icon name="plus" size={16} /> Nueva conversación</button>}>
            Responde solo con lo que hay en tus notas, cita de dónde lo saca y te dice cuándo no lo sabe.
          </Empty>
        )}
      </section>
    </div>
  );
}

function Chat({ id, onActivity }: { id: string; onActivity: (title: string) => void }) {
  const conv = useAsync((signal) => api<{ title: string; messages: ChatMessage[] }>(`/conversations/${id}`, { signal }), [id]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState<{ text: string; phase: string } | null>(null);
  const [error, setError] = useState('');
  const end = useRef<HTMLDivElement>(null);
  const abort = useRef<AbortController>(undefined);

  useEffect(() => { if (conv.data) setMessages(conv.data.messages); }, [conv.data]);
  useEffect(() => end.current?.scrollIntoView({ block: 'end', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }), [messages, streaming?.text]);
  useEffect(() => () => abort.current?.abort(), []);

  async function send(e?: FormEvent) {
    e?.preventDefault();
    const content = input.trim();
    if (!content || streaming) return;
    setInput(''); setError('');
    const optimistic: ChatMessage = { id: `tmp-${Date.now()}`, role: 'user', content, sources: [], grounded: true, createdAt: new Date().toISOString() };
    setMessages((m) => [...m, optimistic]);
    setStreaming({ text: '', phase: 'Buscando en tus notas…' });
    abort.current = new AbortController();
    try {
      await streamEvents(`/conversations/${id}/messages`, { content }, (event, data) => {
        if (event === 'retrieval') setStreaming((s) => s && { ...s, phase: data.chunks ? `Leyendo ${data.notes} ${data.notes === 1 ? 'nota' : 'notas'}…` : 'Sin fragmentos relevantes' });
        if (event === 'delta') setStreaming((s) => s && { ...s, text: s.text + data.text });
        if (event === 'done') {
          setMessages((m) => [...m, data.message]);
          if (messages.length === 0) onActivity(content.slice(0, 80));
        }
        if (event === 'error') setError(data.message);
      }, abort.current.signal);
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        setError(errMsg(err));
        setMessages((m) => m.filter((x) => x.id !== optimistic.id));
        setInput(content);
      }
    } finally {
      setStreaming(null);
    }
  }

  if (conv.error) return <ErrorState error={conv.error} retry={conv.reload} />;
  if (!conv.data) return <div className="pad"><Skeleton lines={5} /></div>;

  return (
    <div className="chat">
      <header className="chat-head">
        <a className="icon-btn back" href="#/ask" aria-label="Volver"><Icon name="back" /></a>
        <h2 className="ellipsis">{conv.data.title}</h2>
      </header>
      <div className="chat-scroll" aria-live="polite">
        {messages.length === 0 && !streaming && (
          <div className="suggestions">
            {['¿Qué tengo pendiente esta semana?', 'Resume lo que sé sobre…', '¿Qué decidí en la última reunión?'].map((s) => (
              <button key={s} className="suggestion" onClick={() => setInput(s)}>{s}</button>
            ))}
          </div>
        )}
        {messages.map((m) => <Message key={m.id} m={m} />)}
        {streaming && (
          <div className="msg assistant streaming">
            <div className="msg-avatar" aria-hidden="true"><Icon name="sparkle" size={16} /></div>
            <div className="msg-body">
              {streaming.text ? <div className="prose">{streaming.text}<span className="caret" aria-hidden="true" /></div>
                : <p className="muted phase"><Spinner /> {streaming.phase}</p>}
            </div>
          </div>
        )}
        {error && <div className="banner error" role="alert"><Icon name="alert" /> {error}</div>}
        <div ref={end} />
      </div>
      <form className="composer" onSubmit={send}>
        <label className="sr-only" htmlFor="ask-input">Tu pregunta</label>
        <textarea id="ask-input" value={input} onChange={(e) => setInput(e.target.value)} rows={1} maxLength={4000}
          placeholder="Pregunta algo sobre tus notas…"
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} />
        {streaming
          ? <button type="button" className="btn" onClick={() => abort.current?.abort()}>Detener</button>
          : <button className="btn primary icon-only" disabled={!input.trim()} aria-label="Enviar"><Icon name="send" /></button>}
      </form>
    </div>
  );
}

function Message({ m }: { m: ChatMessage }) {
  const [openSource, setOpenSource] = useState<number | null>(null);
  if (m.role === 'user') return <div className="msg user"><div className="msg-body"><p>{m.content}</p></div></div>;
  return (
    <div className={`msg assistant ${m.grounded ? '' : 'ungrounded'}`}>
      <div className="msg-avatar" aria-hidden="true"><Icon name={m.grounded ? 'sparkle' : 'alert'} size={16} /></div>
      <div className="msg-body">
        {!m.grounded && <p className="tiny ungrounded-label">Sin información suficiente en tus notas</p>}
        <div className="prose">{withCitations(m.content, m.sources, setOpenSource)}</div>
        {m.sources.length > 0 && (
          <div className="sources">
            <h3>Fuentes</h3>
            <ol>
              {m.sources.map((s) => (
                <li key={s.n} className={openSource === s.n ? 'open' : ''}>
                  <button className="source-head" onClick={() => setOpenSource(openSource === s.n ? null : s.n)} aria-expanded={openSource === s.n}>
                    <span className="cite-num">{s.n}</span> {s.title}
                  </button>
                  <a href={`#/notes/${s.noteId}`} className="tiny">Abrir nota</a>
                  {openSource === s.n && s.quotes.map((q, i) => <blockquote key={i}>{q}</blockquote>)}
                </li>
              ))}
            </ol>
          </div>
        )}
      </div>
    </div>
  );
}

/** Render markdown paragraphs, turning [n] markers into buttons that reveal the cited passage. */
function withCitations(text: string, sources: Source[], open: (n: number) => void): ReactNode {
  const valid = new Set(sources.map((s) => s.n));
  const parts = text.split(/(\[\d+\])/);
  if (parts.length === 1) return <div dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />;
  // Keep the text plain around citations (markdown inside a sentence fragment would break); React escapes it.
  return (
    <p className="cited">
      {parts.map((p, i) => {
        const n = /^\[(\d+)\]$/.exec(p)?.[1];
        if (n && valid.has(+n)) return <button key={i} className="cite" onClick={() => open(+n)} aria-label={`Ver fuente ${n}`}>{n}</button>;
        return <Fragment key={i}>{p}</Fragment>;
      })}
    </p>
  );
}
