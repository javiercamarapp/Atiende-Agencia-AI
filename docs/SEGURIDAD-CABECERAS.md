# Cabeceras de seguridad y `/health`

Estado de esta pieza: cabeceras en la API (enforcing), cabeceras en la SPA
(`vercel.json`, CSP **enforcing** desde el PR «CSP en modo enforce», con reportes a
`/v1/csp-report`) y `/health` real.

## 1. Qué se envía y dónde

| Cabecera | API (`apps/api/src/cabeceras-seguridad.ts`) | SPA (`vercel.json::headers`) |
| --- | --- | --- |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` | igual |
| `X-Content-Type-Options` | `nosniff` | igual |
| `X-Frame-Options` | `DENY` | `DENY` |
| `Referrer-Policy` | `no-referrer` | `strict-origin-when-cross-origin` |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=(), payment=(), usb=()` | `camera=(), microphone=(self), geolocation=(), payment=(), usb=()` (ver nota) |
| `Cross-Origin-Opener-Policy` | `same-origin` | `same-origin` |
| CSP | `Content-Security-Policy` **enforcing**: `default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'` (la API solo responde JSON/redirecciones) | `Content-Security-Policy` **enforcing** + `Reporting-Endpoints` (ver 2) |

Notas:

- `vercel.json` aplica `/(.*)`, así que Vercel también puede añadir las
  cabeceras de la SPA a las respuestas de la función (rewrites a `/api`). Los
  valores comunes coinciden; `Referrer-Policy` difiere a propósito (la API usa
  `no-referrer`, la SPA `strict-origin-when-cross-origin`) y, si ambas llegaran a la
  misma respuesta, el navegador aplica la política más restrictiva.
- HSTS va **sin `preload`** a propósito: entrar a la lista de preload del
  navegador es prácticamente irreversible y es una decisión de dominio.
- `Permissions-Policy` de la SPA lleva `microphone=(self)` en la regla GLOBAL (`vercel.json`), porque la «llamada de prueba» de voz del panel usa `getUserMedia` + AudioWorklet y con `microphone=()` el navegador la bloquea sin preguntar. Es global y no por ruta porque la cabecera se fija una sola vez al cargar el documento y la SPA navega con React Router sin recargar: quien entra por la portada `/` y llega al panel conservaría la política del primer documento. Solo `self` (nunca `*`): no concede nada a terceros, `apps/web` no usa `<iframe>`, `X-Frame-Options: DENY` impide que un iframe ajeno herede el permiso y el navegador sigue pidiendo permiso al usuario. Cámara, geolocalización, pagos y USB siguen denegados. la API JSON (`cabeceras-seguridad.ts`) también conserva `microphone=()`.
- `Permissions-Policy` no bloquea `clipboard-write`: el panel copia enlaces y
  XML con `navigator.clipboard.writeText`.
- `COOP: same-origin` es seguro hoy porque el login con Google es una
  redirección completa (`window.location.href`), no un popup.

## 2. CSP de la SPA: de dónde sale cada fuente

```
default-src 'self';
script-src 'self';
style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;
font-src 'self' https://fonts.gstatic.com data:;
img-src 'self' data: blob: https:;
connect-src 'self' https://*.supabase.co wss://*.supabase.co wss://generativelanguage.googleapis.com;
frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self';
report-uri /v1/csp-report; report-to csp
```

Más `Reporting-Endpoints: csp="/v1/csp-report"` (Chromium usa `report-to`; Firefox y Safari, `report-uri`).

| Directiva | Motivo (código real) |
| --- | --- |
| `script-src 'self'` | `apps/web/index.html` solo carga `/theme-boot.js` y `/src/main.tsx` (bundle de Vite); sin scripts inline ni `eval` (revisado en los 482 chunks de producción del 7-nov). El AudioWorklet de la llamada de prueba de voz se sirve como archivo (`public/voz/captura-pcm-worklet.js`), no desde `blob:`. |
| `style-src ... 'unsafe-inline'` | Hay muchos atributos `style={{...}}` de React (p. ej. `shell/SeleccionarOrganizacion.tsx`). |
| `style-src` + `font-src` Google Fonts | `apps/web/src/pages/login.css` hace `@import` de `fonts.googleapis.com`, que sirve las fuentes desde `fonts.gstatic.com`. |
| `connect-src 'self'` | La SPA llama a la API con `VITE_API_BASE_URL` (mismo origen detrás de los rewrites de Vercel; la API no define CORS). |
| `connect-src wss://generativelanguage.googleapis.com` | Vista previa de voz (Gemini Live): el navegador abre el WebSocket con el token efímero que emite la API (`packages/voice-core/src/gemini-live-provider.ts`, `apps/api/src/demo-agents/gemini.ts`). Deepgram y ElevenLabs solo se usan del lado del servidor (voice-worker); OpenRouter y los demás LLM, por el gateway de la API. |
| `connect-src` Supabase (`https://` y `wss://`) | `verticals/citas/lib/realtime-client.ts` usa `@supabase/supabase-js` (Realtime por WebSocket). Es opcional: sin `VITE_SUPABASE_URL` no se conecta. |
| `img-src ... https: data: blob:` | Las `<img>` del código apuntan a recursos propios (`/atiende-wordmark.svg`, `/images/...`); `https:`, `data:` y `blob:` se dejan abiertos de forma deliberada para imágenes de contenido y previsualizaciones que no se auditaron una por una (se puede cerrar al promover). |
| sin fuentes de Stripe | No se carga Stripe.js; el cobro redirige con `window.location.href` a una URL entregada por la API (las navegaciones no las restringe `connect-src`). |

Huecos conocidos de esta lista:

1. Si `VITE_API_BASE_URL` apunta a **otro origen** en algún entorno, hay que
   añadirlo a `connect-src`. En producción es `""` (mismo origen, rewrites).
2. Si `VITE_SUPABASE_URL` usa un dominio propio (no `*.supabase.co`), añadirlo.
3. Si se activa Sentry en el navegador (`VITE_SENTRY_DSN`), añadir el host de ingesta
   de Sentry a `connect-src`.

**Reportes**: `POST /v1/csp-report` (`apps/api/src/routes/csp-report.ts`) registra una
línea `csp_violacion` por violación: directiva, origen del recurso bloqueado, ruta del
documento (sin query) y disposición; nunca el cuerpo crudo ni `script-sample`. Tope de
16 KB, 10 reportes por petición y 30 peticiones por minuto por IP (`csp:report`). Se
leen en los logs de la función de Vercel filtrando `csp_violacion`.

## 3. Probar en un preview de Vercel

1. Abre un PR: Vercel crea un preview con este `vercel.json`.
2. Comprueba cabeceras:
   ```bash
   curl -sI https://<preview>.vercel.app/ | grep -i -E "strict-transport|x-frame|x-content-type|referrer|permissions|cross-origin|content-security"
   curl -sI https://<preview>.vercel.app/health
   ```
   Deben verse HSTS/nosniff/X-Frame/Referrer/Permissions/COOP y
   `content-security-policy` (enforcing) y `reporting-endpoints`.
3. Recorre en el navegador con la consola abierta (filtro "Content Security
   Policy"): login de cada vertical (incluido "Continuar con Google"), cambio de
   organización, Citas (Realtime), Facturación y cualquier pantalla con
   imágenes. Cada aviso `Refused to ...` es una fuente que falta (y queda en los logs `csp_violacion`).
4. `/health` detallado (con el secreto interno, nunca en un preview público sin
   proteger):
   ```bash
   curl -s -H "x-atiende-internal-secret: $INTERNAL_SECRET" https://<preview>.vercel.app/health
   ```

## 4. CSP enforcing: verificación y rollback

1. La CSP estuvo en Report-Only desde su alta. El 7-nov el tráfico real era casi nulo
   (0 pedidos, 1 usuario con membresía), así que no hubo reportes que leer: la lista se
   revisó contra el código y contra el bundle de producción (sección 2).
2. Tras fusionar, recorrer en producción con la consola abierta: login (incluido
   Google), cada vertical, superadmin, la llamada de prueba de voz, mapas de pedidos y
   los menús PDF (`/menu-pdf/*`). Revisar los logs `csp_violacion` las primeras 48 h.
3. **Rollback inmediato**: en `vercel.json` volver la clave a
   `Content-Security-Policy-Report-Only` (mismo valor) y redesplegar; el colector sigue
   recibiendo reportes. `apps/api/tests/vercel-headers.spec.ts` fija la forma actual.
4. Opcional posterior: quitar `'unsafe-inline'` de `style-src` (requiere migrar los
   `style={{}}` de React).

## 5. `/health`

- **Público** (sin credenciales): `{ "ok": true, "status": "ok" }` con HTTP 200, o
  `{ "ok": false, "status": "degradado" }` con HTTP **503** si la BD no responde
  a `select 1` en 2 s. Sin versión, sin mensajes de error. El resultado se
  reutiliza 5 s por instancia para que un endpoint anónimo no genere una consulta
  por request.
- **Detalle**: mismo endpoint con `x-atiende-internal-secret` o
  `Authorization: Bearer <INTERNAL_SECRET>` (el mismo secreto de `/internal/*`).
  Agrega `version` (commit corto y entorno de Vercel), `db.latenciaMs`, `crons` y
  `rateLimiter.modo` (`distribuido` si Upstash está configurado; solo
  configuración, sin llamada de red). Un secreto incorrecto recibe la respuesta
  pública (no es un oráculo).
- **Crons**: hoy `crons.estado = "sin_medir"`. Las lecturas de
  `core.cron_heartbeat` existentes (`core.list_cron_heartbeats_for_superadmin`)
  exigen un superadmin real, y no hay lectura de sistema; agregarla requiere una
  migración (fuera del alcance de este PR). `evaluarCrons` ya reutiliza
  `juzgarLatido` y solo falta inyectar el lector (`healthRoutes(deps, { leerLatidos })`).
- Base sin migrar: la única consulta es `select 1`; no depende de ninguna tabla.

## Tienda en línea eliminada (`/pedir/*`)

La tienda pública de pedidos en línea ya no existe: `vercel.json` redirige `/pedir/*` a `/` (`permanent: true`, Vercel responde 308), no hay reescritura a la función ni excepción de `Permissions-Policy` (la geolocalización queda denegada en todo el sitio). El middleware `cabecerasSeguridadApi` sigue sin añadir la CSP restrictiva a respuestas `text/html`.
