// Logo real de la marca "Atiende, agencia de AI" — mismo asset EXACTO (byte a byte)
// que `docs/brand/atiende-wordmark.svg` y que el SVG embebido en
// `packages/domain-{hoteles,citas,rentas,licitaciones,despachos}/src/emails/layout.ts`
// (ver el comentario de cabecera de ese archivo: "NUNCA reemplazar por otro logo ni
// otro color de marca").
//
// Hallazgo de auditoría (severidad MEDIA/BRANDING, "el logo real no aparece en
// ninguna pantalla del panel -- solo en los correos"): hasta este cambio el único
// lugar del monorepo donde un usuario real veía la marca era el correo
// transaccional; el panel de staff (esta SPA) no la mostraba en ningún header/shell.
//
// Se reexpone aquí como data URI (en vez de importar `docs/brand/atiende-wordmark.svg`
// por ruta relativa fuera de `apps/web/`) para no depender de que el dev-server de
// Vite tenga habilitado servir archivos fuera de su raíz (`server.fs.allow`, no
// configurado explícitamente en `apps/web/vite.config.ts`) — un data URI no
// necesita ninguna request adicional ni configuración de bundler, funciona igual en
// dev y en build. Compartido (no solo de hoteles) a propósito: cualquier otra
// vertical que agregue el logo a su propio Shell reusa esta misma constante en vez
// de duplicar el base64.
export const ATIENDE_LOGO_DATA_URI =
  "data:image/svg+xml;base64,PHN2ZyB2aWV3Qm94PSIwIDAgMjIwIDQwIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPgogIDxnPgogICAgPHJlY3QgeD0iMCIgeT0iMTAiIHdpZHRoPSIxMyIgaGVpZ2h0PSI0IiByeD0iMiIgZmlsbD0iIzdERDNGQyIgLz4KICAgIDxyZWN0IHg9IjQiIHk9IjE4IiB3aWR0aD0iMTMiIGhlaWdodD0iNCIgcng9IjIiIGZpbGw9IiM3REQzRkMiIC8+CiAgICA8cmVjdCB4PSIwIiB5PSIyNiIgd2lkdGg9IjEzIiBoZWlnaHQ9IjQiIHJ4PSIyIiBmaWxsPSIjN0REM0ZDIiAvPgogICAgPGNpcmNsZSBjeD0iMjYiIGN5PSIxMiIgcj0iNSIgZmlsbD0iIzM4QkRGOCIgLz4KICAgIDxwYXRoCiAgICAgIGQ9Ik0xNCAzOCBMMjAgMjYgUTIyIDIyIDI3IDIyIEwzMSAyMiBRMzQgMjIgMzYgMTkgTDM4IDE2IgogICAgICBzdHJva2U9IiMxRDRFRDgiCiAgICAgIHN0cm9rZS13aWR0aD0iNyIKICAgICAgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIgogICAgICBzdHJva2UtbGluZWpvaW49InJvdW5kIgogICAgICBmaWxsPSJub25lIgogICAgLz4KICA8L2c+CiAgPHRleHQgeD0iNTIiIHk9IjMwIiBmb250LWZhbWlseT0iQXJpYWwsIEhlbHZldGljYSwgc2Fucy1zZXJpZiIgZm9udC1zaXplPSIyNiIgZm9udC13ZWlnaHQ9IjcwMCIgZmlsbD0iIzFENEVEOCIgbGV0dGVyLXNwYWNpbmc9Ii0wLjUiPmF0aWVuZGU8L3RleHQ+Cjwvc3ZnPgo=";
