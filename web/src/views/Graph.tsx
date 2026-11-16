import { useMemo, useRef, useState, type PointerEvent, type WheelEvent } from 'react';
import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type SimulationNodeDatum } from 'd3-force';
import { api } from '../api.ts';
import { Empty, ErrorState, Icon, navigate, Skeleton, useAsync } from '../ui.tsx';

type Kind = 'note' | 'concept' | 'person';
interface GNode extends SimulationNodeDatum { id: string; kind: Kind; label: string; type?: string; degree: number; isTag?: boolean }
interface GEdge { source: string; target: string; kind: 'tag' | 'concept' | 'mention' | 'link' | 'similar'; weight?: number }

const KIND_LABEL: Record<Kind, string> = { note: 'Notas', concept: 'Conceptos', person: 'Personas' };
const W = 1000, H = 700;

export function GraphView() {
  const [similar, setSimilar] = useState(true);
  const [threshold, setThreshold] = useState(0.55);
  const [kinds, setKinds] = useState<Record<Kind, boolean>>({ note: true, concept: true, person: true });
  const [asList, setAsList] = useState(false);
  const data = useAsync((signal) => api<{ nodes: GNode[]; edges: GEdge[]; truncated: boolean; totalNotes: number }>(
    `/graph?similar=${similar ? 1 : 0}&threshold=${threshold}`, { signal }), [similar, threshold]);

  const layout = useMemo(() => {
    if (!data.data) return null;
    const nodes = data.data.nodes.filter((n) => kinds[n.kind]).map((n) => ({ ...n }));
    const ids = new Set(nodes.map((n) => n.id));
    const edges = data.data.edges.filter((e) => ids.has(e.source) && ids.has(e.target)).map((e) => ({ ...e }));
    // ponytail: layout computed synchronously (no animation) — cheap up to the API's 500-note cap and calm for reduced-motion users.
    const sim = forceSimulation<GNode>(nodes)
      .force('link', forceLink<GNode, any>(edges).id((d) => d.id).distance((e: any) => (e.kind === 'similar' ? 120 : 70)).strength((e: any) => (e.kind === 'similar' ? 0.15 : 0.5)))
      .force('charge', forceManyBody().strength(-160))
      .force('center', forceCenter(W / 2, H / 2))
      .force('x', forceX(W / 2).strength(0.04))
      .force('y', forceY(H / 2).strength(0.06))
      .force('collide', forceCollide<GNode>().radius((d) => radius(d) + 6))
      .stop();
    for (let i = 0; i < 300; i++) sim.tick();
    const neighbours = new Map<string, Set<string>>();
    for (const e of edges as any[]) {
      const s = e.source.id, t = e.target.id;
      (neighbours.get(s) ?? neighbours.set(s, new Set()).get(s)!).add(t);
      (neighbours.get(t) ?? neighbours.set(t, new Set()).get(t)!).add(s);
    }
    // Fit the view to the laid-out nodes (with room for labels) so small graphs are not lost in the middle.
    const xs = nodes.map((n) => n.x!), ys = nodes.map((n) => n.y!);
    const pad = 60, minW = 360, minH = 260;
    let bx = Math.min(...xs) - pad, by = Math.min(...ys) - pad, bw = Math.max(...xs) - bx + pad, bh = Math.max(...ys) - by + pad;
    if (bw < minW) { bx -= (minW - bw) / 2; bw = minW; }
    if (bh < minH) { by -= (minH - bh) / 2; bh = minH; }
    const box = { x: bx, y: by, w: bw, h: bh };
    return { box, nodes, edges: edges as unknown as (Omit<GEdge, 'source' | 'target'> & { source: GNode; target: GNode })[], neighbours };
  }, [data.data, kinds]);

  return (
    <div className="page graph-page">
      <header className="page-head">
        <div>
          <span className="eyebrow">Inteligencia</span>
          <h1>Grafo de conocimiento</h1>
          <p className="muted small">
            {data.data ? `${data.data.nodes.filter((n) => n.kind === 'note').length} notas · ${data.data.edges.length} relaciones` : ' '}
            {data.data?.truncated && ` · mostrando las ${data.data.nodes.filter((n) => n.kind === 'note').length} más recientes de ${data.data.totalNotes}`}
          </p>
        </div>
        <div className="graph-controls">
          {(Object.keys(KIND_LABEL) as Kind[]).map((k) => (
            <label key={k} className="check">
              <input type="checkbox" checked={kinds[k]} onChange={(e) => setKinds({ ...kinds, [k]: e.target.checked })} />
              <Shape kind={k} r={6} legend /> {KIND_LABEL[k]}
            </label>
          ))}
          <label className="check">
            <input type="checkbox" checked={similar} onChange={(e) => setSimilar(e.target.checked)} />
            <svg width="22" height="10" aria-hidden="true"><line x1="0" y1="5" x2="22" y2="5" className="edge similar" /></svg> Similitud semántica
          </label>
          {similar && (
            <label className="check">
              <span className="small">umbral {Math.round(threshold * 100)}%</span>
              <input type="range" min={0.3} max={0.9} step={0.05} value={threshold} onChange={(e) => setThreshold(+e.target.value)} aria-label="Umbral de similitud" />
            </label>
          )}
          <button className="btn sm" onClick={() => setAsList(!asList)}>{asList ? 'Ver grafo' : 'Ver como lista'}</button>
        </div>
      </header>
      {data.error ? <ErrorState error={data.error} retry={data.reload} />
        : !layout ? <Skeleton lines={8} />
        : layout.nodes.length === 0 ? <Empty title="El grafo está vacío">Crea notas con <code>#etiquetas</code>, <code>@personas</code> o <code>[[enlaces]]</code> y aparecerán aquí conectadas.</Empty>
        : asList ? <GraphList nodes={layout.nodes} neighbours={layout.neighbours} />
        : <Canvas layout={layout} />}
    </div>
  );
}

const radius = (n: GNode) => (n.kind === 'note' ? 5 : 4) + Math.min(10, Math.sqrt(n.degree) * 2.2);

function Shape({ kind, r, legend, ...rest }: { kind: Kind; r: number; legend?: boolean; [k: string]: any }) {
  const cls = `node k-${kind}`;
  const el = kind === 'note' ? <circle r={r} className={cls} {...rest} />
    : kind === 'concept' ? <rect x={-r} y={-r} width={r * 2} height={r * 2} transform="rotate(45)" className={cls} {...rest} />
    : <rect x={-r * 0.9} y={-r * 0.9} width={r * 1.8} height={r * 1.8} rx={2} className={cls} {...rest} />;
  return legend ? <svg width={r * 2 + 6} height={r * 2 + 6} viewBox={`${-r - 3} ${-r - 3} ${r * 2 + 6} ${r * 2 + 6}`} aria-hidden="true">{el}</svg> : el;
}

function Canvas({ layout }: { layout: { box: { x: number; y: number; w: number; h: number }; nodes: GNode[]; edges: any[]; neighbours: Map<string, Set<string>> } }) {
  const { box } = layout;
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const [hover, setHover] = useState<GNode | null>(null);
  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);
  const svg = useRef<SVGSVGElement>(null);
  const near = hover ? layout.neighbours.get(hover.id) ?? new Set<string>() : null;
  const lit = (id: string) => !near || id === hover!.id || near.has(id);

  const onWheel = (e: WheelEvent) => {
    const rect = svg.current!.getBoundingClientRect();
    // preserveAspectRatio=meet: one scale for both axes, content centred.
    const s = Math.min(rect.width / box.w, rect.height / box.h);
    const px = box.x + (e.clientX - rect.left - (rect.width - box.w * s) / 2) / s, py = box.y + (e.clientY - rect.top - (rect.height - box.h * s) / 2) / s;
    const k = Math.min(4, Math.max(0.4, view.k * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
    setView({ k, x: px - ((px - view.x) * k) / view.k, y: py - ((py - view.y) * k) / view.k });
  };
  const onDown = (e: PointerEvent) => { if (e.target === svg.current) { drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y }; svg.current!.setPointerCapture(e.pointerId); } };
  const onMove = (e: PointerEvent) => {
    if (!drag.current) return;
    const r = svg.current!.getBoundingClientRect();
    const scale = 1 / Math.min(r.width / box.w, r.height / box.h);
    setView((v) => ({ ...v, x: drag.current!.vx + (e.clientX - drag.current!.x) * scale, y: drag.current!.vy + (e.clientY - drag.current!.y) * scale }));
  };
  const open = (n: GNode) => {
    if (n.kind === 'note') navigate(`#/notes/${n.id.slice(2)}`);
    // AI-found concepts are not tags, so they open a search instead of a tag filter.
    else if (n.kind === 'concept' && n.isTag) navigate(`#/notes?tag=${encodeURIComponent(n.label)}`);
    else navigate(`#/search?q=${encodeURIComponent(n.label)}`);
  };

  return (
    <div className="graph-wrap">
      <svg ref={svg} viewBox={`${box.x} ${box.y} ${box.w} ${box.h}`} className="graph" role="img" aria-label="Grafo de notas, conceptos y personas. Usa «Ver como lista» para una versión accesible."
        onWheel={onWheel} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={() => { drag.current = null; }}>
        <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
          {layout.edges.map((e, i) => (
            <line key={i} x1={e.source.x} y1={e.source.y} x2={e.target.x} y2={e.target.y}
              className={`edge ${e.kind} ${near && !(lit(e.source.id) && lit(e.target.id) && (e.source.id === hover!.id || e.target.id === hover!.id)) ? 'dim' : ''}`}
              style={e.kind === 'similar' ? { strokeOpacity: 0.25 + (e.weight ?? 0.5) * 0.6 } : undefined} />
          ))}
          {layout.nodes.map((n) => {
            const r = radius(n);
            const showLabel = hover?.id === n.id || (near?.has(n.id)) || n.degree >= 4 || view.k > 1.6;
            return (
              <g key={n.id} transform={`translate(${n.x},${n.y})`} className={`gnode ${lit(n.id) ? '' : 'dim'}`}
                tabIndex={0} role="button" aria-label={`${n.label} (${n.kind === 'note' ? 'nota' : n.kind === 'concept' ? 'concepto' : 'persona'}, ${n.degree} conexiones)`}
                onMouseEnter={() => setHover(n)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(n)} onBlur={() => setHover(null)}
                onClick={() => open(n)} onKeyDown={(e) => e.key === 'Enter' && open(n)}>
                <circle r={r + 8} className="hit" />
                <Shape kind={n.kind} r={r} />
                {showLabel && <text y={r + 13} textAnchor="middle" className="glabel">{n.kind === 'concept' ? (n.isTag ? '#' : '') : n.kind === 'person' ? '@' : ''}{n.label.length > 32 ? `${n.label.slice(0, 30)}…` : n.label}</text>}
              </g>
            );
          })}
        </g>
      </svg>
      <div className="graph-hint tiny muted"><Icon name="search" size={13} /> Rueda para ampliar · arrastra el fondo para moverte · clic para abrir</div>
      <button className="btn sm graph-reset" onClick={() => setView({ x: 0, y: 0, k: 1 })}>Centrar</button>
    </div>
  );
}

function GraphList({ nodes, neighbours }: { nodes: GNode[]; neighbours: Map<string, Set<string>> }) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return (
    <table className="table">
      <caption className="sr-only">Nodos del grafo y sus conexiones</caption>
      <thead><tr><th>Nodo</th><th>Tipo</th><th>Conexiones</th></tr></thead>
      <tbody>
        {[...nodes].sort((a, b) => b.degree - a.degree).map((n) => (
          <tr key={n.id}>
            <td>{n.kind === 'note' ? <a href={`#/notes/${n.id.slice(2)}`}>{n.label}</a> : `${n.kind === 'concept' ? (n.isTag ? '#' : '') : '@'}${n.label}`}</td>
            <td>{n.kind === 'note' ? 'Nota' : n.kind === 'concept' ? 'Concepto' : 'Persona'}</td>
            <td className="small">{[...(neighbours.get(n.id) ?? [])].map((id) => byId.get(id)?.label).filter(Boolean).slice(0, 8).join(' · ')}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
