import { useState } from 'react';
import { api } from '../api.ts';
import { fmtNum } from '../text.tsx';
import { Empty, errMsg, ErrorState, Icon, Skeleton, Spinner, useAsync, useToast } from '../ui.tsx';

interface Stats {
  totals: { notes: number; note: number; document: number; task: number; words: number; trash: number; versions: number; conversations: number; links: number; chunks: number };
  tasks: { todo: number; doing: number; done: number; overdue: number };
  topTags: { name: string; count: number }[];
  topPeople: { name: string; count: number }[];
  activity: { week: string; created: number; updated: number }[];
  mostConnected: { id: string; title: string; degree: number }[];
  orphans: number;
  indexing: { ready: number; pending: number; failed: number };
}

export function InsightsView() {
  const stats = useAsync((signal) => api<Stats>('/stats', { signal }), []);
  const s = stats.data;
  return (
    <div className="page insights">
      <header className="page-head">
        <div><span className="eyebrow">Inteligencia</span><h1>Panorama</h1></div>
        <p>Qué sabes, cómo crece y qué está desconectado.</p>
      </header>
      {stats.error ? <ErrorState error={stats.error} retry={stats.reload} /> : !s ? <Skeleton lines={10} /> : s.totals.notes === 0 ? (
        <Empty title="Sin datos todavía" action={<a className="btn primary" href="#/notes/new">Crear la primera nota</a>}>En cuanto escribas o importes notas verás aquí su evolución.</Empty>
      ) : (
        <>
        <section className="ledger" aria-label="Totales">
          <Hero value={s.totals.notes} label="elementos" detail={`${s.totals.note} notas · ${s.totals.document} doc. · ${s.totals.task} tareas`} />
          <Hero value={s.totals.words} label="palabras" detail={`${fmtNum(s.totals.chunks)} fragmentos indexados`} />
          <Hero value={s.totals.links} label="enlaces" detail={`${s.orphans} ${s.orphans === 1 ? 'nota aislada' : 'notas aisladas'}`} />
          <Hero value={s.totals.versions} label="versiones" detail={`${s.totals.trash} en la papelera`} />
        </section>
        <div className="bento">

          <section className="tile span-2">
            <h2>Notas creadas por semana</h2>
            <ActivityChart data={s.activity} />
          </section>

          <section className="tile">
            <h2>Tareas</h2>
            {s.totals.task === 0 ? <p className="muted small">No hay tareas.</p> : (
              <>
                <TaskBar t={s.tasks} />
                {s.tasks.overdue > 0 && <p className="overdue-note"><Icon name="alert" size={15} /> {s.tasks.overdue} {s.tasks.overdue === 1 ? 'vencida' : 'vencidas'} · <a href="#/notes?type=task">revisar</a></p>}
              </>
            )}
          </section>

          <section className="tile">
            <h2>Etiquetas más usadas</h2>
            {s.topTags.length === 0 ? <p className="muted small">Aún no usas etiquetas.</p> : <Bars rows={s.topTags} href={(n) => `#/notes?tag=${encodeURIComponent(n)}`} prefix="#" />}
          </section>

          <section className="tile">
            <h2>Personas mencionadas</h2>
            {s.topPeople.length === 0 ? <p className="muted small">Menciona a alguien con <code>@Nombre</code>.</p> : <Bars rows={s.topPeople} href={(n) => `#/search?q=${encodeURIComponent(n)}`} prefix="@" />}
          </section>

          <section className="tile">
            <h2>Más conectadas</h2>
            {s.mostConnected.length === 0 ? <p className="muted small">Enlaza notas con <code>[[Título]]</code>.</p> : (
              <ol className="ranked">{s.mostConnected.map((n) => <li key={n.id}><span><a href={`#/notes/${n.id}`}>{n.title}</a><span className="count">{n.degree}</span></span></li>)}</ol>
            )}
          </section>

          <section className="tile span-12"><Connections /></section>

          <section className="tile">
            <h2>Índice semántico</h2>
            <p className="big-number">{Math.round((s.indexing.ready / Math.max(1, s.totals.notes)) * 100)}<small>%</small></p>
            <p className="muted small">{s.indexing.ready} indexadas{s.indexing.pending ? ` · ${s.indexing.pending} en cola` : ''}{s.indexing.failed ? ` · ${s.indexing.failed} con error` : ''}</p>
          </section>
        </div>
        </>
      )}
    </div>
  );
}

const Hero = ({ value, label, detail }: { value: number; label: string; detail: string }) => (
  <div className="hero-n"><strong>{fmtNum(value)}</strong><span>{label}</span><small>{detail}</small></div>
);

function ActivityChart({ data }: { data: Stats['activity'] }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...data.map((d) => d.created));
  const H = 140, bw = 100 / data.length;
  const fmt = (w: string) => new Date(w + 'T00:00').toLocaleDateString('es', { day: 'numeric', month: 'short' });
  return (
    <figure className="activity">
      <div className="activity-plot">
        <svg viewBox={`0 0 100 ${H}`} preserveAspectRatio="none" aria-hidden="true">
          {[0.5, 1].map((f) => <line key={f} x1="0" x2="100" y1={H - f * (H - 6)} y2={H - f * (H - 6)} className="grid" />)}
          {data.map((d, i) => {
            const h = (d.created / max) * (H - 6);
            return <rect key={d.week} x={i * bw + bw * 0.18} width={bw * 0.64} y={H - Math.max(h, d.created ? 2 : 0)} height={Math.max(h, d.created ? 2 : 0)} rx={0.8} className={`bar ${hover === i ? 'on' : ''}`} />;
          })}
        </svg>
        <div className="activity-hits">
          {data.map((d, i) => (
            <button key={d.week} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(i)} onBlur={() => setHover(null)}
              aria-label={`Semana del ${fmt(d.week)}: ${d.created} creadas, ${d.updated} editadas`} />
          ))}
        </div>
        {hover !== null && (
          <div className="chart-tip" style={{ left: `${(hover + 0.5) * bw}%` }}>
            <strong>Semana del {fmt(data[hover].week)}</strong>
            <span>{data[hover].created} creadas · {data[hover].updated} editadas</span>
          </div>
        )}
        <span className="axis-max tiny muted">{max}</span>
      </div>
      <figcaption className="row between tiny muted"><span>{fmt(data[0].week)}</span><span>esta semana</span></figcaption>
      <details className="tiny">
        <summary>Ver datos</summary>
        <table className="table compact"><thead><tr><th>Semana</th><th>Creadas</th><th>Editadas</th></tr></thead>
          <tbody>{data.map((d) => <tr key={d.week}><td>{fmt(d.week)}</td><td>{d.created}</td><td>{d.updated}</td></tr>)}</tbody></table>
      </details>
    </figure>
  );
}

function Bars({ rows, href, prefix }: { rows: { name: string; count: number }[]; href: (n: string) => string; prefix: string }) {
  const max = Math.max(...rows.map((r) => r.count));
  return (
    <ul className="hbars">
      {rows.map((r) => (
        <li key={r.name}>
          <a href={href(r.name)}><span className="hbar-label">{prefix}{r.name}</span><span className="hbar-value">{r.count}</span></a>
          <span className="hbar" aria-hidden="true"><span style={{ width: `${(r.count / max) * 100}%` }} /></span>
        </li>
      ))}
    </ul>
  );
}

function TaskBar({ t }: { t: Stats['tasks'] }) {
  const total = t.todo + t.doing + t.done || 1;
  const rows = [['todo', 'Por hacer', t.todo], ['doing', 'En curso', t.doing], ['done', 'Hechas', t.done]] as const;
  return (
    <>
      <div className="stackbar" role="img" aria-label={rows.map(([, l, v]) => `${l}: ${v}`).join(', ')}>
        {rows.map(([k, , v]) => v > 0 && <span key={k} className={`seg s-${k}`} style={{ width: `${(v / total) * 100}%` }} />)}
      </div>
      <ul className="legend-list">
        {rows.map(([k, l, v]) => <li key={k}><span className={`swatch s-${k}`} aria-hidden="true" />{l} <strong>{v}</strong></li>)}
      </ul>
    </>
  );
}

function Connections() {
  const toast = useToast();
  const res = useAsync((signal) => api<{ items: { a: { id: string; title: string; type: string }; b: { id: string; title: string; type: string }; similarity: number }[] }>('/insights/connections?limit=6', { signal }), []);
  const [done, setDone] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  return (
    <>
      <h2>Conexiones ocultas</h2>
      <p className="muted small">Notas que hablan de lo mismo pero no están enlazadas ni comparten etiquetas.</p>
      {res.error ? <p className="muted small">{errMsg(res.error)}</p> : !res.data ? <Skeleton lines={3} /> : res.data.items.length === 0 ? (
        <p className="muted small">No hay conexiones ocultas por ahora. Cuantas más notas, más aparecerán.</p>
      ) : (
        <ul className="connections">
          {res.data.items.map((p) => {
            const key = `${p.a.id}:${p.b.id}`;
            return (
              <li key={key}>
                <a href={`#/notes/${p.a.id}`}>{p.a.title}</a>
                <span className="conn-mid"><span className="meter"><span style={{ width: `${p.similarity * 100}%` }} /></span><small>{Math.round(p.similarity * 100)}%</small></span>
                <a href={`#/notes/${p.b.id}`}>{p.b.title}</a>
                {done.has(key) ? <span className="badge ok"><Icon name="check" size={13} /> Enlazadas</span> : (
                  <button className="btn sm" disabled={busy === key} onClick={async () => {
                    setBusy(key);
                    try { await api(`/notes/${p.a.id}/links`, { method: 'POST', body: { targetId: p.b.id } }); setDone((s) => new Set(s).add(key)); }
                    catch (e) { toast({ message: errMsg(e), tone: 'error' }); }
                    finally { setBusy(null); }
                  }}>{busy === key ? <Spinner /> : <Icon name="link" size={14} />} Enlazar</button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

