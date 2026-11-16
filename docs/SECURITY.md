# Informe de seguridad

Alcance: la API (`server/`), el frontend (`web/`) y su despliegue (`Dockerfile`, `docker-compose.yml`).
Cada control lleva la prueba automatizada que lo demuestra (`tests/integration/security.test.ts` = **S**, `tests/integration/core.test.ts` = **C**, `tests/unit/logic.test.ts` = **U**, `tests/e2e/app.spec.ts` = **E**). Todas pasan en la última ejecución (55 unit/integración, también por el driver `pg`, + 5 E2E).

## Activos y actores

- **Activos:** contenido de las notas (puede ser muy sensible), credenciales, sesiones, clave de la API de IA, disponibilidad del servicio y del presupuesto de IA.
- **Actores:** visitante anónimo; usuario autenticado malicioso (intenta leer/editar lo ajeno o escalar); destinatario de una nota compartida; sitio web malicioso visitado por un usuario con sesión (CSRF); contenido malicioso dentro de una nota o un documento importado (XSS, inyección de prompt).

## Amenazas y controles

| Amenaza | Control | Prueba |
|---|---|---|
| **SQL injection** | Todas las consultas usan parámetros (`$1…`). Lo único interpolado en SQL son fragmentos fijos elegidos de listas cerradas (`SORTS`, filtros). Los identificadores se validan con Zod (`uuid`, `enum`) antes de llegar a la BD. | S: *treats injection payloads…* (4 cargas × 6 rutas, la tabla sigue intacta y no se filtra contenido), *rejects identifiers…* |
| **XSS almacenado** | React escapa todo el texto. El Markdown pasa por `marked` + **DOMPurify** (sin `script`, `style`, `iframe`, `form`, atributos `on*`, `style`, URLs `javascript:`). Enlaces externos con `rel="noopener noreferrer nofollow"`. Fragmentos de búsqueda resaltados sin `innerHTML`. **CSP** estricta: `script-src 'self'`, `object-src 'none'`, `frame-ancestors 'none'`, `img-src 'self' data:`. | E: *markdown is sanitized* (img onerror, script, enlace javascript:, no se ejecuta nada); S: *stores HTML as inert text and serves strict security headers* |
| **CSRF** | Cookie `SameSite=Strict` + token sincronizador por sesión en `X-CSRF-Token` (comparación en tiempo constante) + rechazo de `Origin` ajeno en toda petición mutadora, **incluido el login** (login CSRF). | S: *rejects state-changing requests without the session CSRF token* (sin token, token falso, token de otro usuario), *rejects cross-origin posts, including login* |
| **Escalada de privilegios** | El rol nunca se lee del cliente: Zod descarta campos desconocidos en el registro y `admin.ts` usa `.strict()`. Endpoints admin con `requireAdmin`. Un admin no puede cambiarse a sí mismo (siempre queda al menos uno). Un lector no puede escribir, borrar, restaurar ni compartir; un editor no puede borrar ni gestionar el compartido. | S: *ignores a role sent at registration*, *lets an admin manage users but not read their notes…*, *lets a viewer read but not write…*, *lets an editor edit but not delete…* |
| **Fuga entre usuarios (IDOR)** | Un único punto de acceso (`loadNote`) decide propietario / compartido / nada; lo ajeno responde **404** (no 403) para no confirmar que existe. Búsqueda, RAG, grafo, estadísticas, facetas y exportación filtran por `owner_id` en la propia consulta. Las notas compartidas **no** alimentan la búsqueda ni el asistente del destinatario, y no revelan los títulos de otras notas enlazadas del propietario. Una nota en la papelera deja de ser visible para los destinatarios. | S: *returns 404 for every operation on another user's note* (13 operaciones), *never surfaces another user's content in search, graph, stats, export or the assistant* (incluye comprobar los documentos que recibe el LLM), *keeps conversations private*, *hides link titles from share recipients*, *hides a shared note from recipients once it is in the trash* |
| **Robo / fijación de sesión** | Token de 256 bits; en BD solo su **SHA-256**. Cookie `httpOnly`, `SameSite=Strict`, `Secure` en producción. Token nuevo en cada login (se descarta el que trajera el navegador). Cambiar la contraseña revoca todas las sesiones. Desactivar un usuario o cambiar su rol cierra sus sesiones. Sesiones caducadas se purgan a diario. | S: *sets a hardened cookie and stores only a hash*, *issues a new token at login… (no fixation)*, *revokes all other sessions on password change*, *disabling kills sessions* |
| **Credenciales** | `scrypt` (N=2¹⁴, r=8, p=1, sal aleatoria de 16 B) de la librería estándar; comparación en tiempo constante. Login con email inexistente verifica contra un hash señuelo para igualar tiempos. Mensaje de error único para email o contraseña. Mínimo 10 caracteres. | U: *hashes with a random salt and verifies*; C: *returns the session user and rejects a wrong password* |
| **Fuerza bruta / abuso** | `@fastify/rate-limit`: 300/min general, 10/min en auth, 20/min en IA, 20/min en importación (por IP). | S: *throttles repeated login attempts* (401,401,401,429,429) |
| **Validación de entrada / DoS por tamaño** | Zod en cada cuerpo, query y parámetro. Cuerpo JSON ≤ 1 MB, contenido ≤ 200 000 caracteres, ficheros ≤ 10 MB y ≤ 20 por petición, extensiones permitidas + firma `%PDF-` para PDF, consultas ≤ 500 caracteres, etiquetas con alfabeto restringido. | S: *rejects oversized, malformed and mistyped input* (8 casos, incl. 413) |
| **Protección de endpoints** | Todo `/api/*` salvo registro, login, logout y health exige sesión (`requireUser`). | S: *rejects requests without a session* (7 rutas) |
| **Fuga de información en errores** | Manejador global: 4xx con mensaje controlado; 5xx con mensaje genérico y detalle solo en el log. Rutas inexistentes → 404 JSON (los ficheros que no existen ya no devuelven el `index.html`). | S: *does not leak internals in errors* |
| **Secretos** | Solo por variables de entorno; `.env` en `.gitignore`; `.env.example` sin valores reales; la clave de IA nunca llega al cliente (solo se expone `llm: true/false`). Los logs redactan `cookie`, `x-csrf-token`, `authorization` y `set-cookie`. Docker exige `POSTGRES_PASSWORD` explícita (falla si falta) y el contenedor corre como usuario `node`. | Revisión de código (no automatizado; ver limitaciones) |
| **Inyección de prompt vía notas** | Los fragmentos van como bloques `document` (datos) y el prompt de sistema ordena ignorar instrucciones dentro de ellos. Las citas que devuelva el modelo solo se aceptan si apuntan a un documento enviado. | U: *drops citations that point outside the retrieved documents*. La resistencia del modelo en sí **no** está probada (no hay clave en este entorno) |
| **Coste/abuso del LLM** | Límite 20/min por IP; no se llama al modelo si no hay fragmentos relevantes; si el navegador se desconecta se aborta la llamada en curso. | C: *admits it does not know instead of calling the model* |
| **Clickjacking / MIME sniffing** | `frame-ancestors 'none'`, `X-Frame-Options`, `X-Content-Type-Options: nosniff` (helmet). | S: cabeceras comprobadas |

## Hallazgos de la auditoría propia (ya corregidos)

1. **Fuga de títulos a destinatarios de notas compartidas** (`linksOut/linksIn` incluían notas privadas del propietario). Corregido + prueba.
2. **RAG incorrecto en multiusuario**: el índice HNSW global se filtra por usuario *después* de la búsqueda aproximada, de modo que con muchos usuarios los fragmentos relevantes de uno podían quedar fuera. Migración `003` elimina ese índice; la recuperación es exacta por usuario.
3. **Comprobación de origen** usaba `X-Forwarded-Host` aunque no hubiera proxy de confianza. Ahora usa `req.host`, que solo lo respeta con `TRUST_PROXY=true`.
4. Notas con indexado fallido nunca se reintentaban; sesiones caducadas nunca se borraban. Corregido.
5. Ficheros estáticos inexistentes devolvían `index.html` con 200 (página en blanco tras un despliegue). Corregido.

## Riesgos aceptados / pendientes

- **Enumeración de emails**: el registro responde 409 si el email existe, y compartir con un email inexistente responde 404 (esto último solo para usuarios autenticados y limitado por rate limit). Evitarlo requiere verificación por email (no implementada).
- **Rate limit por IP** en memoria del proceso: con varias réplicas hay que moverlo a Redis; detrás de un proxy sin `TRUST_PROXY=true` todos los usuarios comparten la IP del proxy.
- **Historial visible al compartir**: quien recibe una nota puede ver sus versiones anteriores, incluidas las previas a compartirla.
- **Parser de PDF** (pdf.js) procesa ficheros no confiables en el proceso del servidor; un PDF patológico puede consumir CPU. Mitigado por tamaño máximo y rate limit; aislarlo en un *worker* sería lo siguiente.
- **Sin 2FA, sin verificación de email, sin recuperación de contraseña** (requiere servicio de correo).
- **Sin cifrado en reposo propio**: se delega en el disco/volumen de PostgreSQL.
