import { useState, type FormEvent } from 'react';
import { api, ApiError, type User } from '../api.ts';
import { Spinner } from '../ui.tsx';

export function AuthView({ onAuth }: { onAuth: (u: User, csrf: string) => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true); setError(''); setFieldErrors({});
    try {
      const body = mode === 'login'
        ? { email: f.get('email'), password: f.get('password') }
        : { email: f.get('email'), password: f.get('password'), displayName: f.get('displayName') };
      const r = await api(`/auth/${mode}`, { method: 'POST', body });
      onAuth(r.user, r.csrfToken);
    } catch (err) {
      if (err instanceof ApiError && err.issues) setFieldErrors(Object.fromEntries(err.issues.map((i) => [i.path, i.message])));
      setError(err instanceof ApiError ? err.message : 'No se pudo conectar');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth">
      <section className="auth-art" aria-hidden="true">
        <svg viewBox="0 0 400 400" className="constellation">
          {[[80, 90, 150, 160], [150, 160, 260, 120], [150, 160, 210, 270], [260, 120, 320, 220], [210, 270, 320, 220], [210, 270, 110, 310]].map(([a, b, c, d], i) => (
            <line key={i} x1={a} y1={b} x2={c} y2={d} />
          ))}
          {[[80, 90, 7], [150, 160, 12], [260, 120, 9], [210, 270, 14], [320, 220, 8], [110, 310, 6]].map(([x, y, r], i) => (
            <circle key={i} cx={x} cy={y} r={r} style={{ animationDelay: `${i * 0.4}s` }} />
          ))}
        </svg>
        <blockquote>
          Todo lo que lees, piensas y decides, <em>conectado</em>.
        </blockquote>
      </section>
      <section className="auth-panel">
        <h1 className="wordmark big">Second<em>Brain</em></h1>
        <p className="muted">{mode === 'login' ? 'Bienvenido de nuevo.' : 'Crea tu espacio de conocimiento.'}</p>
        <div className="segmented" role="tablist" aria-label="Acceso">
          <button role="tab" aria-selected={mode === 'login'} onClick={() => setMode('login')}>Entrar</button>
          <button role="tab" aria-selected={mode === 'register'} onClick={() => setMode('register')}>Crear cuenta</button>
        </div>
        <form onSubmit={submit} className="stack" noValidate={false}>
          {mode === 'register' && (
            <label className="field">
              <span>Nombre</span>
              <input name="displayName" required maxLength={80} autoComplete="name" aria-invalid={!!fieldErrors.displayName} />
            </label>
          )}
          <label className="field">
            <span>Email</span>
            <input name="email" type="email" required autoComplete="email" aria-invalid={!!fieldErrors.email} />
            {fieldErrors.email && <small className="field-error">{fieldErrors.email}</small>}
          </label>
          <label className="field">
            <span>Contraseña</span>
            <input name="password" type="password" required minLength={mode === 'register' ? 10 : 1} maxLength={200}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'} aria-invalid={!!fieldErrors.password}
              aria-describedby={mode === 'register' ? 'pw-hint' : undefined} />
            {mode === 'register' && <small id="pw-hint" className="muted">Mínimo 10 caracteres. Una frase larga es más segura que símbolos raros.</small>}
            {fieldErrors.password && <small className="field-error">{fieldErrors.password}</small>}
          </label>
          {error && <p className="form-error" role="alert">{error}</p>}
          <button className="btn primary block lg" disabled={busy}>
            {busy ? <Spinner /> : mode === 'login' ? 'Entrar' : 'Crear cuenta'}
          </button>
        </form>
      </section>
    </div>
  );
}
