import { useRef, useState, type DragEvent, type FormEvent } from 'react';
import { api, setCsrf } from '../api.ts';
import { useSession } from '../session.ts';
import { fmtDate } from '../text.tsx';
import { confirmAction, errMsg, ErrorState, Icon, Skeleton, Spinner, useAsync, useToast } from '../ui.tsx';

export function SettingsView() {
  const { user } = useSession();
  return (
    <div className="page settings">
      <header className="page-head"><h1>Ajustes</h1></header>
      <div className="settings-grid">
        <ImportExport />
        <section className="card">
          <h2>Cuenta</h2>
          <dl className="kv"><dt>Nombre</dt><dd>{user.displayName}</dd><dt>Email</dt><dd>{user.email}</dd><dt>Rol</dt><dd>{user.role === 'admin' ? 'Administrador' : 'Usuario'}</dd></dl>
          <PasswordForm />
        </section>
        {user.role === 'admin' && <Admin />}
        <DangerZone />
      </div>
    </div>
  );
}

function ImportExport() {
  const toast = useToast();
  const { refreshFacets } = useSession();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const [result, setResult] = useState<{ imported: number; notes: { id: string; title: string }[]; errors: { file: string; message: string }[] } | null>(null);

  async function upload(files: FileList | File[]) {
    const list = [...files];
    if (!list.length) return;
    const form = new FormData();
    for (const f of list) form.append('file', f, f.name);
    setBusy(true); setResult(null);
    try {
      setResult(await api('/import', { method: 'POST', body: form }));
      refreshFacets();
    } catch (e) { toast({ message: errMsg(e), tone: 'error' }); }
    finally { setBusy(false); if (input.current) input.current.value = ''; }
  }

  return (
    <section className="card span-2">
      <h2>Importar y exportar</h2>
      <div className={`dropzone ${over ? 'over' : ''}`}
        onDragOver={(e: DragEvent) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
        onDrop={(e: DragEvent) => { e.preventDefault(); setOver(false); upload(e.dataTransfer.files); }}>
        {busy ? <><Spinner /> <span>Procesando…</span></> : (
          <>
            <Icon name="upload" size={26} />
            <p><strong>Arrastra ficheros aquí</strong> o <button className="link-btn" onClick={() => input.current?.click()}>elígelos</button></p>
            <p className="tiny muted">PDF, Markdown o texto (se convierten en documentos) y copias .json de SecondBrain. Máx. 10 MB por fichero.</p>
          </>
        )}
        <input ref={input} type="file" multiple hidden accept=".pdf,.md,.markdown,.txt,.json" onChange={(e) => e.target.files && upload(e.target.files)} />
      </div>
      {result && (
        <div className="import-result" role="status">
          <p><Icon name="check" size={15} /> {result.imported} {result.imported === 1 ? 'elemento importado' : 'elementos importados'}.</p>
          {result.notes.length > 0 && <ul className="plain-list small">{result.notes.slice(0, 8).map((n) => <li key={n.id}><a href={`#/notes/${n.id}`}>{n.title}</a></li>)}</ul>}
          {result.errors.map((e) => <p key={e.file} className="form-error small">{e.file}: {e.message}</p>)}
        </div>
      )}
      <div className="row gap-s wrap">
        <a className="btn" href="/api/export" download><Icon name="download" size={16} /> Exportar todo (.json)</a>
        <span className="tiny muted">Incluye notas, etiquetas y enlaces. Se puede reimportar en otra cuenta.</span>
      </div>
    </section>
  );
}

function PasswordForm() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    setBusy(true);
    try {
      const r = await api('/auth/password', { method: 'POST', body: { currentPassword: f.get('current'), newPassword: f.get('next') } });
      setCsrf(r.csrfToken);
      form.reset();
      toast({ message: 'Contraseña cambiada. Se han cerrado las demás sesiones.', tone: 'ok' });
    } catch (err) { toast({ message: errMsg(err), tone: 'error' }); }
    finally { setBusy(false); }
  }
  return (
    <form className="stack" onSubmit={submit}>
      <h3>Cambiar contraseña</h3>
      <label className="field"><span>Actual</span><input className="input" name="current" type="password" required autoComplete="current-password" /></label>
      <label className="field"><span>Nueva</span><input className="input" name="next" type="password" required minLength={10} autoComplete="new-password" /></label>
      <button className="btn" disabled={busy}>{busy ? <Spinner /> : 'Guardar'}</button>
    </form>
  );
}

function Admin() {
  const toast = useToast();
  const { user } = useSession();
  const users = useAsync((signal) => api<{ items: { id: string; email: string; displayName: string; role: string; disabled: boolean; createdAt: string; notes: number; lastSeen: string | null }[] }>('/admin/users', { signal }), []);
  async function update(id: string, body: Record<string, unknown>) {
    try { await api(`/admin/users/${id}`, { method: 'PATCH', body }); users.reload(); }
    catch (e) { toast({ message: errMsg(e), tone: 'error' }); }
  }
  return (
    <section className="card span-2">
      <h2><Icon name="shield" size={17} /> Usuarios</h2>
      <p className="tiny muted">Los administradores gestionan cuentas; nunca ven el contenido de las notas.</p>
      {users.error ? <ErrorState error={users.error} retry={users.reload} /> : !users.data ? <Skeleton /> : (
        <div className="table-scroll">
          <table className="table">
            <thead><tr><th>Usuario</th><th>Notas</th><th>Alta</th><th>Rol</th><th>Estado</th></tr></thead>
            <tbody>
              {users.data.items.map((u) => (
                <tr key={u.id}>
                  <td><strong>{u.displayName}</strong><br /><small className="muted">{u.email}</small></td>
                  <td>{u.notes}</td>
                  <td className="small">{fmtDate(u.createdAt)}</td>
                  <td>
                    <select className="select sm" value={u.role} disabled={u.id === user.id} aria-label={`Rol de ${u.email}`} onChange={(e) => update(u.id, { role: e.target.value })}>
                      <option value="user">Usuario</option><option value="admin">Admin</option>
                    </select>
                  </td>
                  <td>
                    <button className={`btn sm ${u.disabled ? '' : 'ghost'}`} disabled={u.id === user.id} onClick={() => update(u.id, { disabled: !u.disabled })}>
                      {u.disabled ? 'Reactivar' : 'Desactivar'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function DangerZone() {
  const toast = useToast();
  const { setUser } = useSession();
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const pw = new FormData(e.currentTarget).get('password');
    if (!confirmAction('Se borrarán tu cuenta y todas tus notas para siempre. ¿Continuar?')) return;
    try { await api('/auth/account', { method: 'DELETE', body: { password: pw } }); setUser(null); }
    catch (err) { toast({ message: errMsg(err), tone: 'error' }); }
  }
  return (
    <section className="card danger-zone">
      <h2>Eliminar cuenta</h2>
      <p className="small muted">Borra tu cuenta y todo su contenido. Exporta antes si quieres conservarlo.</p>
      <form className="stack" onSubmit={submit}>
        <label className="field"><span>Confirma con tu contraseña</span><input className="input" name="password" type="password" required autoComplete="current-password" /></label>
        <button className="btn danger">Eliminar mi cuenta</button>
      </form>
    </section>
  );
}
