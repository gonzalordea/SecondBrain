# API REST

Base: `/api`. JSON salvo donde se indica. Autenticación por cookie de sesión `sb_session` (httpOnly, SameSite=Strict).

**Toda petición que no sea GET/HEAD/OPTIONS** con sesión debe llevar `X-CSRF-Token: <csrfToken>` (lo devuelven `register`, `login`, `password` y `me`). Además, si llega cabecera `Origin`, debe coincidir con el host.

Errores: `{ "error": { "code": string, "message": string, "issues"?: [{ "path", "message" }] } }`

| Código | Cuándo |
|---|---|
| 400 `validation` | Entrada no válida (Zod); `issues` indica el campo |
| 401 `unauthenticated` / `invalid_credentials` | Sin sesión / credenciales incorrectas |
| 403 `csrf` / `bad_origin` / `forbidden` / `disabled` | Token CSRF, origen, permiso insuficiente, cuenta desactivada |
| 404 `not_found` | No existe **o no es tuyo** (no se distingue, para no revelar ids) |
| 409 `version_conflict` / `email_taken` | Concurrencia optimista / email repetido |
| 413 | Cuerpo > 1 MB o fichero > 10 MB |
| 429 `rate_limited` | Límite de peticiones |
| 502/503 `llm_*` | Fallo o ausencia del proveedor de IA |

## Autenticación

| Método | Ruta | Cuerpo | Respuesta |
|---|---|---|---|
| POST | `/auth/register` | `{ email, password (10-200), displayName }` | 201 `{ user, csrfToken }` + cookie |
| POST | `/auth/login` | `{ email, password }` | `{ user, csrfToken }` + cookie nueva |
| POST | `/auth/logout` | — | `{ ok }` (borra la sesión en BD) |
| GET | `/auth/me` | — | `{ user, csrfToken }` |
| POST | `/auth/password` | `{ currentPassword, newPassword }` | `{ user, csrfToken }`; revoca todas las demás sesiones |
| DELETE | `/auth/account` | `{ password }` | `{ ok }`; borra la cuenta y todo su contenido |

`user = { id, email, displayName, role: 'user'|'admin', createdAt }`

## Notas

`Note = { id, type: 'note'|'document'|'task', title, content, summary, summaryMethod, category, status, dueDate, version, source, embeddingStatus, createdAt, updatedAt, deletedAt, access: 'owner'|'editor'|'viewer', owner: { displayName }, tags[], textTags[], people[], linksOut[{id,title}], linksIn[{id,title}], files[{id, filename, mime, size, createdAt}], aiPeople[], concepts[], enrichStatus: 'none'|'pending'|'done'|'failed' }`

`people` incluye las personas escritas con `@` y las que encontró la IA (`aiPeople` es ese subconjunto). `concepts` son temas detectados por la IA; no son etiquetas. `enrichStatus = 'pending'` significa que el resumen y las entidades se recalcularán solos cuando la edición se calme.

`textTags` son las etiquetas que vienen de `#hashtags` del texto (no se quitan desde la lista de etiquetas). `linksOut/linksIn` van vacíos para quien no es propietario.

| Método | Ruta | Parámetros / cuerpo | Notas |
|---|---|---|---|
| GET | `/notes` | `scope=mine|shared`, `type`, `status`, `tag`, `category`, `sort=updated|created|title|due`, `limit≤200`, `offset` | `{ items: NoteSummary[], total }` |
| POST | `/notes` | `{ title, type?, content?, category?, status?, dueDate?, tags? }` | 201 `Note`. Extrae `#etiquetas`, `@Persona`/`@[Nombre Apellido]`, `[[Título]]` |
| GET | `/notes/:id` | — | `Note` |
| PATCH | `/notes/:id` | `{ version (obligatorio), title?, content?, type?, category?, status?, dueDate?, tags? }` | 409 si `version` no es la actual. `tags` reemplaza las etiquetas manuales |
| DELETE | `/notes/:id` | — | A la papelera (solo propietario) |
| GET | `/notes/:id/versions` | — | `{ current, versions: [{ version, title, length, createdAt, editedBy }] }` |
| GET | `/notes/:id/versions/:v` | — | `{ version, title, content, createdAt }` |
| POST | `/notes/:id/versions/:v/restore` | — | `Note` (crea una versión nueva; no borra ninguna) |
| GET | `/notes/:id/related` | `limit≤30` | `{ ready, items: [{ id, title, type, similarity, linked, sharedTags }] }` (vacío si no eres propietario) |
| POST | `/notes/:id/links` | `{ targetId }` | Enlace manual (ambas notas tuyas) |
| DELETE | `/notes/:id/links/:targetId` | — | Quita un enlace manual |
| GET | `/notes/:id/shares` | — | Solo propietario |
| PUT | `/notes/:id/shares` | `{ email, role: 'viewer'|'editor' }` | Crea o cambia |
| DELETE | `/notes/:id/shares/:userId` | — | Propietario, o el propio destinatario |
| POST | `/notes/:id/summarize` | — | Analiza ya la nota (resumen + personas + conceptos con IA; solo resumen extractivo sin clave). `{ summary, method: 'llm'|'extractive' }` |
| GET | `/notes/:id/export.md` | — | `text/markdown` con *front matter* |
| GET | `/notes/:id/files/:fileId` | — | Descarga el fichero original de un documento importado (mismo permiso que leer la nota; `attachment`, CSP `sandbox`) |
| GET | `/facets` | — | `{ tags, categories, people }` con recuentos |

## Papelera

| Método | Ruta | |
|---|---|---|
| GET | `/trash` | `{ items }` |
| POST | `/trash/:id/restore` | `Note` |
| DELETE | `/trash/:id` | Borrado definitivo (solo si está en la papelera) |
| DELETE | `/trash` | Vacía la papelera `{ deleted }` |

## Búsqueda

`GET /search?q=…` — `q` (1-500), `mode=hybrid|semantic|keyword`, `alpha` 0-1 (peso semántico en híbrido, 0.6), `recency` 0-1 (peso de lo reciente, 0), `minSimilarity` (0.25), `type`, `tags` (CSV, todas), `category`, `from`, `to` (YYYY-MM-DD), `limit≤50`.

Respuesta: `{ items: [{ id, type, title, category, status, tags, updatedAt, snippet, scores: { score, semantic, keyword, recency } }], tookMs }`. En `snippet`, los términos encontrados van entre `\u0001` y `\u0002`.

`score = (1 − recency) · (alpha · semantic + (1 − alpha) · keyword) + recency · e^(−días/30)`

## Asistente

| Método | Ruta | |
|---|---|---|
| GET | `/conversations` | `{ items, llm: boolean }` |
| POST | `/conversations` | `{ title? }` → 201 |
| GET | `/conversations/:id` | `{ id, title, messages: [{ id, role, content, sources, grounded, createdAt }] }` |
| DELETE | `/conversations/:id` | |
| POST | `/conversations/:id/messages` | `{ content }` → **`text/event-stream`** |

Eventos SSE: `retrieval {chunks, notes}` → `delta {text}`* → `done {message}` o `error {code, message}`.
`message.sources = [{ n, noteId, title, quotes[] }]`; el texto lleva marcadores `[n]`. `grounded=false` cuando no se encontró información suficiente (en ese caso **no** se llama al modelo).

Sin `ANTHROPIC_API_KEY`: 503 `llm_unavailable` antes de abrir el stream.

## Conocimiento

| Método | Ruta | |
|---|---|---|
| GET | `/graph?similar=0|1&threshold=0.55` | `{ nodes: [{ id: 'n:'|'t:'|'p:'…, kind: note|concept|person, label, degree }], edges: [{ source, target, kind: tag|mention|link|similar, weight? }], truncated, totalNotes }` (máx. 500 notas) |
| GET | `/insights/connections?threshold=0.45&limit` | Pares de notas parecidas sin enlace ni etiqueta en común |
| GET | `/stats` | Totales, tareas (incl. vencidas), top etiquetas/personas, actividad 12 semanas, más conectadas, aisladas, estado del índice |

## Importación / exportación

| Método | Ruta | |
|---|---|---|
| GET | `/export` | JSON `{ format: 'secondbrain-export', version: 1, notes, links }` (adjunto) |
| POST | `/import` | `multipart/form-data`, campo(s) `file`: `.json` (exportación), `.md`, `.txt`, `.pdf`. Los `.md/.txt/.pdf` se guardan además como fichero original de la nota (el tipo MIME se deduce de la extensión, no del cliente). → `{ imported, notes, errors: [{ file, message }] }` |

## Administración (rol admin)

| Método | Ruta | |
|---|---|---|
| GET | `/admin/users` | Lista sin contenido de notas |
| PATCH | `/admin/users/:id` | `{ role?, disabled? }` (no sobre uno mismo). Cierra sus sesiones |

`GET /health` → `{ ok, llm }`.
