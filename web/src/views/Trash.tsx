import { api, type NoteType } from '../api.ts';
import { fmtDate } from '../text.tsx';
import { confirmAction, Empty, errMsg, ErrorState, Icon, Skeleton, TYPE_LABEL, useAsync, useToast } from '../ui.tsx';

interface Item { id: string; type: NoteType; title: string; excerpt: string; deletedAt: string }

export function TrashView() {
  const toast = useToast();
  const trash = useAsync((signal) => api<{ items: Item[] }>('/trash', { signal }), []);
  const remove = (id: string) => trash.setData((d) => d && { items: d.items.filter((i) => i.id !== id) });

  async function act(fn: () => Promise<unknown>, ok: string, id?: string) {
    try { await fn(); if (id) remove(id); else trash.reload(); toast({ message: ok, tone: 'ok' }); }
    catch (e) { toast({ message: errMsg(e), tone: 'error' }); }
  }

  return (
    <div className="page">
      <header className="page-head">
        <div><span className="eyebrow">Se vacía sola a los 30 días</span><h1>Papelera</h1></div>
        {!!trash.data?.items.length && (
          <button className="btn danger" onClick={() => confirmAction(`¿Eliminar definitivamente ${trash.data!.items.length} elementos? No se puede deshacer.`)
            && act(() => api('/trash', { method: 'DELETE' }), 'Papelera vaciada')}>
            <Icon name="trash" size={16} /> Vaciar papelera
          </button>
        )}
      </header>
      {trash.error ? <ErrorState error={trash.error} retry={trash.reload} /> : !trash.data ? <Skeleton lines={5} /> : trash.data.items.length === 0 ? (
        <Empty title="La papelera está vacía">Lo que borres aparecerá aquí y podrás recuperarlo.</Empty>
      ) : (
        <ul className="trash-list">
          {trash.data.items.map((i) => (
            <li key={i.id}>
              <span className={`type-dot t-${i.type}`} aria-label={TYPE_LABEL[i.type]}><Icon name={i.type} size={14} /></span>
              <div className="grow">
                <strong>{i.title}</strong>
                <p className="muted small ellipsis">{i.excerpt || 'Vacía'}</p>
                <small className="mono muted">borrada {fmtDate(i.deletedAt)}</small>
              </div>
              <button className="btn sm" onClick={() => act(() => api(`/trash/${i.id}/restore`, { method: 'POST' }), 'Restaurada', i.id)}>Restaurar</button>
              <button className="icon-btn danger" aria-label={`Eliminar definitivamente ${i.title}`}
                onClick={() => confirmAction(`¿Eliminar «${i.title}» para siempre?`) && act(() => api(`/trash/${i.id}`, { method: 'DELETE' }), 'Eliminada', i.id)}>
                <Icon name="x" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
