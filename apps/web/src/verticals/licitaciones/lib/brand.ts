// Hallazgo de auditoría (severidad de observabilidad/branding: "Logo real
// ausente del panel"): el panel de licitaciones nunca mostraba ningún logo,
// pese a que la marca "atiende" ya tiene un asset SVG real en producción —
// los 6 correos transaccionales del monorepo lo embeben (ver
// `@atiende/domain-licitaciones::emails/layout.ts::LOGO_DATA_URI`, mismo
// wordmark en `domain-citas`/`domain-hoteles`/`domain-restaurantes`/
// `domain-rentas`/`domain-despachos`). Este archivo es el MISMO byte-a-byte,
// duplicado aquí a propósito (apps/web no depende de los paquetes de
// dominio, mismo criterio ya documentado en otros `lib/*-client.ts` de este
// vertical) para que el panel deje de ser el único lugar del producto sin
// ningún logo real.
export const ATIENDE_LOGO_DATA_URI =
  "data:image/svg+xml;base64,PHN2ZyB2aWV3Qm94PSIwIDAgMjIwIDQwIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPgogIDxnPgogICAgPHJlY3QgeD0iMCIgeT0iMTAiIHdpZHRoPSIxMyIgaGVpZ2h0PSI0IiByeD0iMiIgZmlsbD0iIzdERDNGQyIgLz4KICAgIDxyZWN0IHg9IjQiIHk9IjE4IiB3aWR0aD0iMTMiIGhlaWdodD0iNCIgcng9IjIiIGZpbGw9IiM3REQzRkMiIC8+CiAgICA8cmVjdCB4PSIwIiB5PSIyNiIgd2lkdGg9IjEzIiBoZWlnaHQ9IjQiIHJ4PSIyIiBmaWxsPSIjN0REM0ZDIiAvPgogICAgPGNpcmNsZSBjeD0iMjYiIGN5PSIxMiIgcj0iNSIgZmlsbD0iIzM4QkRGOCIgLz4KICAgIDxwYXRoCiAgICAgIGQ9Ik0xNCAzOCBMMjAgMjYgUTIyIDIyIDI3IDIyIEwzMSAyMiBRMzQgMjIgMzYgMTkgTDM4IDE2IgogICAgICBzdHJva2U9IiMxRDRFRDgiCiAgICAgIHN0cm9rZS13aWR0aD0iNyIKICAgICAgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIgogICAgICBzdHJva2UtbGluZWpvaW49InJvdW5kIgogICAgICBmaWxsPSJub25lIgogICAgLz4KICA8L2c+CiAgPHRleHQgeD0iNTIiIHk9IjMwIiBmb250LWZhbWlseT0iQXJpYWwsIEhlbHZldGljYSwgc2Fucy1zZXJpZiIgZm9udC1zaXplPSIyNiIgZm9udC13ZWlnaHQ9IjcwMCIgZmlsbD0iIzFENEVEOCIgbGV0dGVyLXNwYWNpbmc9Ii0wLjUiPmF0aWVuZGU8L3RleHQ+Cjwvc3ZnPgo=";

/** Título de pestaña del navegador para TODO el panel de licitaciones (login
 * + shell autenticado) — hallazgo de auditoría: `apps/web/index.html` trae un
 * `<title>` ESTÁTICO ("Atiende — Restaurantes") compartido por las 6
 * verticales de esta SPA; ninguna lo sobreescribía en runtime, así que
 * cualquier pestaña de licitaciones se quedaba mostrando "Restaurantes" en
 * la barra del navegador. `document.title` en runtime es la corrección
 * estándar de una SPA de una sola página HTML — se aplica desde
 * `Login.tsx`/`LicitacionesShell.tsx` (los dos únicos puntos de montaje de
 * este vertical en `App.tsx`), así que cubre el 100% de las pantallas de
 * licitaciones sin tocar `index.html` ni las demás verticales.
 */
export const LICITACIONES_TAB_TITLE = "Atiende — Licitaciones";
