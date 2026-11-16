# SecondBrain — Diseño (fase 0)

Este documento se escribió **antes** del código. Las secciones de API y limitaciones finales están en `API.md`, `SECURITY.md` y `LIMITATIONS.md`.

## 1. Análisis de requisitos

| Requisito | Interpretación concreta |
|---|---|
| Notas, documentos y tareas | Una única entidad `notes` con `type ∈ {note, document, task}`. Las tareas añaden `status` y `due_date`. Los documentos son notas cuyo contenido procede de un fichero (PDF/MD/TXT). |
| Etiquetas, categorías, relaciones | Etiquetas N:M (`tags`), una categoría libre por nota, relaciones explícitas nota→nota (`note_links`) creadas con `[[Título]]` o manualmente. |
| Búsqueda semántica | Embeddings locales (384 dim) por fragmento, guardados en `pgvector`. |
| Asistente con IA sobre la base del usuario | RAG: recuperación por similitud + Claude con *citations* nativas sobre los fragmentos recuperados. |
| Resúmenes y conexiones | Resumen por LLM (si hay clave) o extractivo (sin clave). Conexiones = notas semánticamente cercanas **sin** enlace ni etiqueta en común. |
| Visualización de relaciones | Grafo de fuerzas (notas, conceptos, personas). |

## 2. Ambigüedades y decisiones

1. **¿Multiusuario o personal?** SaaS multiusuario; cada usuario tiene su base aislada. Se puede **compartir** una nota con otro usuario (lector/editor). Búsqueda, RAG, grafo y estadísticas usan **solo notas propias** — así una nota compartida nunca alimenta el asistente de otro usuario sin que lo vea.
2. **¿Qué es un "concepto" y una "persona"?** Conceptos = etiquetas (`#etiqueta` en el texto o asignadas). Personas = menciones `@Nombre` o `@[Nombre Apellido]`. Extracción determinista: reproducible, testeable y sin coste. (Extracción por LLM: ver limitaciones.)
3. **Proveedor de embeddings.** Modelo local `paraphrase-multilingual-MiniLM-L12-v2` (ONNX vía transformers.js). Funciona sin clave, sin enviar contenido a terceros y en español. Medido en este equipo: "¿qué come mi gato?" vs nota sobre su gato = 0,56; vs IVA = −0,02.
4. **Proveedor de LLM.** Claude (`claude-opus-5-5`, configurable con `LLM_MODEL`). Sin `ANTHROPIC_API_KEY` el chat responde 503 explícito; nada se simula.
5. **"Reconocer cuándo no tiene información".** Doble barrera: (a) si ningún fragmento supera `RAG_MIN_SCORE` (0,30) se responde "no hay información suficiente" **sin** llamar al LLM; (b) el prompt de sistema exige decirlo si los fragmentos no responden la pregunta.
6. **Citas.** Se usan las *citations* nativas de la API (bloques `document` con `citations.enabled`), no un formato `[1]` parseado a mano: la cita apunta a un fragmento real y se mapea a la nota.
7. **Versionado.** Cada sesión de edición guarda un estado en `note_versions` (los autoguardados seguidos del mismo autor se agrupan; importaciones y restauraciones nunca se sobrescriben). *Revisado durante la implementación:* la primera versión guardaba "el estado anterior a la edición" y el E2E demostró que una nota nueva solo tenía como versión su marcador vacío. Concurrencia optimista: el cliente envía `version`; si no coincide → 409 (evita pisar ediciones de otra pestaña o de un editor compartido).
8. **Papelera.** Borrado lógico (`deleted_at`); restaurar o purgar; purga automática a los 30 días.
9. **Admin.** Rol `admin` gestiona usuarios (listar, desactivar, cambiar rol) pero **no** puede leer contenido ajeno. El rol solo se asigna por script (`npm run make-admin`) o por otro admin.
10. **Base de datos.** PostgreSQL + pgvector en producción (Docker). En desarrollo y tests, **PGlite** (Postgres real compilado a WASM, mismo SQL, mismo pgvector) para arrancar sin instalar nada.

## 3. Arquitectura

```
Navegador (React SPA, Vite)
   │  cookie de sesión httpOnly + cabecera X-CSRF-Token
   ▼
Fastify (Node 24, TypeScript sin compilar: type stripping nativo)
   ├─ auth.ts        sesiones, CSRF, scrypt, guardas
   ├─ notes.ts       CRUD, versiones, papelera, etiquetas, enlaces, compartir
   ├─ processing.ts  parseo (#, @, [[ ]]), fragmentado, cola de embeddings, PDF
   ├─ search.ts      búsqueda híbrida (tsvector + pgvector) con filtros
   ├─ assistant.ts   RAG, conversaciones, resúmenes (Claude)
   ├─ insights.ts    grafo, conexiones, estadísticas
   ├─ io.ts          importación/exportación
   └─ admin.ts       gestión de usuarios
   ▼
db.ts → pg Pool (DATABASE_URL)  |  PGlite (sin DATABASE_URL)
```

Justificación:
- **Node + TypeScript en un único paquete**: un lenguaje en front y back, tipos compartidos, Node 24 ejecuta `.ts` sin paso de build en el servidor.
- **Fastify**: validación, logs estructurados (pino) y `inject()` para tests de integración sin red.
- **Zod**: validación de entrada en cada frontera.
- **SQL a mano con parámetros** (sin ORM): las consultas de búsqueda híbrida y pgvector son SQL específico; un ORM añadiría capa sin quitar SQL.
- **React + Vite**: SPA con estados de carga/vacío/error; React escapa por defecto (XSS).
- **Procesamiento de embeddings en cola en proceso**: la escritura de una nota no espera al modelo. Al arrancar se reencolan las notas pendientes, así un reinicio no pierde trabajo.

## 4. Esquema de base de datos

Ver `server/migrations/001_init.sql` (fuente de verdad). Resumen:

- `users(id, email UNIQUE lower, password_hash, display_name, role, disabled, created_at)`
- `sessions(token_hash PK, user_id, csrf_token, expires_at, created_at, last_seen_at)` — se guarda el **hash** del token.
- `notes(id, owner_id, type, title, content, summary, category, status, due_date, version, embedding vector(384), embedding_status, source, created/updated/deleted_at, tsv GENERATED)`
- `note_versions(note_id, version, title, content, edited_by, reason, created_at)` UNIQUE(note_id, version) — estados guardados; una ráfaga de autoguardados actualiza su propia entrada (migración 002)
- `tags(id, owner_id, name)` + `note_tags(note_id, tag_id)`
- `entities(id, owner_id, kind person|concept, name)` + `note_entities`
- `note_links(source_id, target_id, kind manual|wikilink)`
- `chunks(id, note_id, owner_id, idx, content, embedding vector(384))` — búsqueda exacta por usuario (el índice HNSW inicial se retiró en la migración 003: ver SECURITY.md, hallazgo 2)
- `note_files(note_id, owner_id, filename, mime, size, sha256, data bytea)` — fichero original de los documentos importados (migración 004)
- `note_shares(note_id, user_id, role viewer|editor)`
- `conversations(id, owner_id, title)` + `messages(id, conversation_id, role, content, citations jsonb)`

Todas las tablas hijas tienen `ON DELETE CASCADE` hacia `users`/`notes`; `owner_id` está denormalizado en `chunks` para que la recuperación filtre por usuario en la misma consulta del índice vectorial.

## 5. Estructura de carpetas

```
server/            API (Fastify) + migrations/
web/               SPA (React) — index.html, src/
tests/unit         lógica pura
tests/integration  API real contra PGlite en memoria
tests/e2e          Playwright contra el servidor real
scripts/           make-admin, descarga del modelo
docs/              diseño, API, seguridad, limitaciones
Dockerfile, docker-compose.yml
```

## 6. Contratos de API (resumen; detalle en API.md)

Todas bajo `/api`, JSON, errores `{ error: { code, message } }`. Mutaciones exigen `X-CSRF-Token`.

- Auth: `POST /auth/register|login|logout`, `GET /auth/me`, `POST /auth/password`, `DELETE /auth/account`
- Notas: `GET/POST /notes`, `GET/PATCH/DELETE /notes/:id`, `GET /notes/:id/versions`, `GET /notes/:id/versions/:v`, `POST /notes/:id/versions/:v/restore`, `GET /notes/:id/related`, `POST/DELETE /notes/:id/links`, `GET/PUT/DELETE /notes/:id/shares`, `POST /notes/:id/summarize`, `GET /notes/:id/export.md`
- Papelera: `GET /trash`, `POST /trash/:id/restore`, `DELETE /trash/:id`, `DELETE /trash`
- Etiquetas: `GET /tags`
- Búsqueda: `GET /search?q&mode&alpha&recency&type&tags&category&from&to&limit`
- Asistente: `GET/POST /conversations`, `GET/DELETE /conversations/:id`, `POST /conversations/:id/messages` (SSE)
- Insights: `GET /graph`, `GET /insights/connections`, `GET /stats`
- E/S: `GET /export`, `POST /import` (multipart: .json/.md/.txt/.pdf)
- Admin: `GET /admin/users`, `PATCH /admin/users/:id`
- `GET /health`

## 7. Fases

1. Base: config, BD + migraciones, auth/sesiones/CSRF, notas, versiones, papelera, etiquetas → tests de integración.
2. Procesamiento: parseo de entidades/enlaces, fragmentado, embeddings, PDF → tests unitarios.
3. Búsqueda híbrida, relacionadas, grafo, conexiones, estadísticas, import/export → tests.
4. Asistente RAG + resúmenes → tests con cliente LLM inyectado en la frontera.
5. Frontend completo.
6. Tests de seguridad y E2E.
7. Docker, documentación, auditoría.
