# Cabeceras de seguridad y `/health`

Estado de esta pieza: cabeceras en la API (enforcing), cabeceras en la SPA
(`vercel.json`, CSP en **Report-Only**) y `/health` real.

## 1. Qué se envía y dónde

| Cabecera | API (`apps/api/src/cabeceras-seguridad.ts`) | SPA (`vercel.json::headers`) |
| --- | --- | --- |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` | igual |
| `X-Content-Type-Options` | `nosniff` | igual |
| `X-Frame-Options` | `DENY` | `DENY` |
| `Referrer-Policy` | `no-referrer` | `strict-origin-when-cross-origin` |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=(), payment=(), usb=()` | igual |
| `Cross-Origin-Opener-Policy` | `same-origin` | `same-origin` |
| CSP | `Content-Security-Policy` **enforcing**: `default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'` (la API solo responde JSON/redirecciones) | `Content-Security-Policy-Report-Only` (ver 2) |

Notas:

- `vercel.json` aplica `/(.*)`, así que Vercel también puede añadir las
  cabeceras de la SPA a las respuestas de la función (rewrites a `/api`). Los
  valores comunes coinciden; `Referrer-Policy` difiere a propósito (la API usa
  `no-referrer`, la SPA `strict-origin-when-cross-origin`) y, si ambas llegaran a la
  misma respuesta, el navegador aplica la política más restrictiva.
- HSTS va **sin `preload`** a propósito: entrar a la lista de preload del
  navegador es prácticamente irreversible y es una decisión de dominio.
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
connect-src 'self' https://*.supabase.co wss://*.supabase.co;
frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'
```

| Directiva | Motivo (código real) |
| --- | --- |
| `script-src 'self'` | `apps/web/index.html` solo carga `/src/main.tsx` (bundle de Vite); sin scripts inline ni `eval`. |
| `style-src ... 'unsafe-inline'` | Hay muchos atributos `style={{...}}` de React (p. ej. `shell/SeleccionarOrganizacion.tsx`). |
| `style-src` + `font-src` Google Fonts | `apps/web/src/pages/login.css` hace `@import` de `fonts.googleapis.com`, que sirve las fuentes desde `fonts.gstatic.com`. |
| `connect-src 'self'` | La SPA llama a la API con `VITE_API_BASE_URL` (mismo origen detrás de los rewrites de Vercel; la API no define CORS). |
| `connect-src` Supabase (`https://` y `wss://`) | `verticals/citas/lib/realtime-client.ts` usa `@supabase/supabase-js` (Realtime por WebSocket). Es opcional: sin `VITE_SUPABASE_URL` no se conecta. |
| `img-src ... https: data: blob:` | Las `<img>` del código apuntan a recursos propios (`/atiende-wordmark.svg`, `/images/...`); `https:`, `data:` y `blob:` se dejan abiertos de forma deliberada para imágenes de contenido y previsualizaciones que no se auditaron una por una (se puede cerrar al promover). |
| sin fuentes de Stripe | No se carga Stripe.js; el cobro redirige con `window.location.href` a una URL entregada por la API (las navegaciones no las restringe `connect-src`). |

Huecos conocidos de esta lista (por eso es Report-Only):

1. Si `VITE_API_BASE_URL` apunta a **otro origen** en algún entorno, hay que
   añadirlo a `connect-src`. En producción con rewrites no hace falta.
2. No existe un colector de reportes: no se definió `report-uri`/`report-to`
   (sería un endpoint nuevo). Los avisos se leen en la consola del navegador.
3. Si `VITE_SUPABASE_URL` usa un dominio propio (no `*.supabase.co`), añadirlo.

## 3. Probar en un preview de Vercel

1. Abre un PR: Vercel crea un preview con este `vercel.json`.
2. Comprueba cabeceras:
   ```bash
   curl -sI https://<preview>.vercel.app/ | grep -i -E "strict-transport|x-frame|x-content-type|referrer|permissions|cross-origin|content-security"
   curl -sI https://<preview>.vercel.app/health
   ```
   Deben verse HSTS/nosniff/X-Frame/Referrer/Permissions/COOP y
   `content-security-policy-report-only` (y NO `content-security-policy` en `/`).
3. Recorre en el navegador con la consola abierta (filtro "Content Security
   Policy"): login de cada vertical (incluido "Continuar con Google"), cambio de
   organización, Citas (Realtime), Facturación y cualquier pantalla con
   imágenes. Cada aviso `[Report Only] Refused to ...` es una fuente que falta.
4. `/health` detallado (con el secreto interno, nunca en un preview público sin
   proteger):
   ```bash
   curl -s -H "x-atiende-internal-secret: $INTERNAL_SECRET" https://<preview>.vercel.app/health
   ```

## 4. Promover la CSP a enforcing

1. Mantén Report-Only en producción una ventana representativa (≥ 1 semana con
   uso real de todas las verticales) y confirma que no hay avisos nuevos.
2. Ajusta la lista (sección 2) según los avisos; repite el preview.
3. En `vercel.json`, cambia la clave `Content-Security-Policy-Report-Only` por
   `Content-Security-Policy` (mismo valor). Conviene hacerlo en un PR aparte y
   primero verificarlo en un preview.
4. Actualiza `apps/api/tests/vercel-headers.spec.ts` (hoy exige que NO exista la
   forma enforcing).
5. Rollback inmediato: volver a `Content-Security-Policy-Report-Only` y redeploy.
6. Opcional posterior: quitar `'unsafe-inline'` de `style-src` (requiere migrar los
   `style={{}}` de React) y añadir un colector de reportes.

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

La tienda pública de pedidos en línea ya no existe: `vercel.json` redirige `/pedir/*` a `/` (301), no hay reescritura a la función ni excepción de `Permissions-Policy` (la geolocalización queda denegada en todo el sitio). El middleware `cabecerasSeguridadApi` sigue sin añadir la CSP restrictiva a respuestas `text/html`.
