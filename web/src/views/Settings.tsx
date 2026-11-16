import { useRef, useState, type DragEvent, type FormEvent, type ReactNode } from 'react';
import { api, setCsrf, type Theme } from '../api.ts';
import { THEME_LABEL, THEME_ORDER, useSession } from '../session.ts';
import { fmtDate } from '../text.tsx';
import { confirmAction, errMsg, ErrorState, Icon, Skeleton, Spinner, useAsync, useToast } from '../ui.tsx';

/** Settings are a column of sections: what it is on the left, the controls on the right. */
function Section({ id, title, description, className = '', children }: { id: string; title: string; description?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <section className={`settings-section ${className}`} aria-labelledby={id}>
      <header><h2 id={id}>{title}</h2>{description && <p>{description}</p>}</header>
      <div>{children}</div>
    </section>
  );
}

export function SettingsView() {
  const { user } = useSession();
  return (
    <div className="page settings">
      <header className="page-head"><div><span className="eyebrow">Cuenta</span><h1>Ajustes</h1></div></header>
      <div className="settings-grid">
        <Appearance />
        <ImportExport />
        <Section id="s-account" title="Cuenta" description="Al cambiar la contraseña se cierran las demás sesiones abiertas.">
          <dl className="kv"><dt>Nombre</dt><dd>{user.displayName}</dd><dt>Email</dt><dd>{user.email}</dd><dt>Rol</dt><dd>{user.role === 'admin' ? 'Administrador' : 'Usuario'}</dd></dl>
          <PasswordForm />
        </Section>
        {user.role === 'admin' && <Admin />}
        <DangerZone />
      </div>
    </div>
  );
}

function Appearance() {
  const { theme, setTheme } = useSession();
  return (
    <Section id="s-appearance" title="Apariencia" description="Se guarda en tu cuenta y se aplica en cualquier navegador donde entres.">
      <div className="theme-options" role="radiogroup" aria-label="Tema">
        {THEME_ORDER.map((t: Theme) => (
          <button key={t} className="theme-option" role="radio" aria-checked={theme === t} onClick={() => setTheme(t)}>
            <span className={`preview ${t}`} aria-hidden="true">
              {t === 'system' ? (
                <><span className="p-side light"><i /><i /><i /></span><span className="p-main light"><i /><i /></span>
                  <span className="p-side dark"><i /><i /><i /></span><span className="p-main dark"><i /><i /></span></>
              ) : (
                <><span className="p-side"><i /><i /><i /><i /></span><span className="p-main"><i /><i /><i /></span></>
              )}
            </span>
            <span>{THEME_LABEL[t]}{t === 'system' && <span className="muted"> · automático</span>}</span>
          </button>
        ))}
      </div>
    </Section>
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
    <Section id="s-io" title="Importar y exportar"
      description="PDF, Markdown y texto se convierten en documentos (y se guarda el original). Las copias .json de SecondBrain se pueden reimportar en otra cuenta.">
      <div className={`dropzone ${over ? 'over' : ''}`}
        onDragOver={(e: DragEvent) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
        onDrop={(e: DragEvent) => { e.preventDefault(); setOver(false); upload(e.dataTransfer.files); }}>
        {busy ? <><Spinner /> <span>Procesando…</span></> : (
          <>
            <Icon name="upload" size={20} />
            <p><strong>Arrastra ficheros aquí</strong> o <button className="link-btn" onClick={() => input.current?.click()}>elígelos</button></p>
            <p className="tiny muted">.pdf · .md · .txt · .json — máx. 10 MB por fichero</p>
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
      <div className="row gap wrap">
        <a className="btn" href="/api/export" download><Icon name="download" size={15} /> Exportar todo (.json)</a>
        <span className="tiny muted">Notas, etiquetas y enlaces.</span>
      </div>
    </Section>
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
    <form className="stack settings-form" onSubmit={submit}>
      <h3>Cambiar contraseña</h3>
      <label className="field"><span>Actual</span><input className="input" name="current" type="password" required autoComplete="current-password" /></label>
      <label className="field"><span>Nueva (mínimo 10 caracteres)</span><input className="input" name="next" type="password" required minLength={10} autoComplete="new-password" /></label>
      <div><button className="btn" disabled={busy}>{busy ? <Spinner /> : 'Cambiar contraseña'}</button></div>
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
    <Section id="s-admin" title="Usuarios" description="Los administradores gestionan cuentas; nunca ven el contenido de las notas.">
      {users.error ? <ErrorState error={users.error} retry={users.reload} /> : !users.data ? <Skeleton /> : (
        <div className="table-scroll">
          <table className="table">
            <thead><tr><th>Usuario</th><th>Notas</th><th>Alta</th><th>Rol</th><th>Estado</th></tr></thead>
            <tbody>
              {users.data.items.map((u) => (
                <tr key={u.id}>
                  <td><strong>{u.displayName}</strong><br /><small className="muted">{u.email}</small></td>
                  <td className="mono">{u.notes}</td>
                  <td className="mono">{fmtDate(u.createdAt)}</td>
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
    </Section>
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
    <Section id="s-danger" title="Eliminar cuenta" className="danger-zone" description="Borra tu cuenta y todo su contenido para siempre. Exporta antes si quieres conservarlo.">
      <form className="stack settings-form" onSubmit={submit}>
        <label className="field"><span>Confirma con tu contraseña</span><input className="input" name="password" type="password" required autoComplete="current-password" /></label>
        <div><button className="btn danger">Eliminar mi cuenta</button></div>
      </form>
    </Section>
  );
}
