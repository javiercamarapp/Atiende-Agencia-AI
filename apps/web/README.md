# apps/web

SPA Vite/React real, única para las 6 verticales — ya NO es una carpeta reservada.
Actualizado en el barrido de documentación de las rondas 13/14/16: este README
describía "Aún no construida: no hay `package.json` ni `vite.config.ts` todavía",
que dejó de ser cierto hace varias fases.

## Estructura real

- `src/App.tsx` — enrutador raíz (React Router 7): login, selector de
  organización/vertical y las rutas de cada vertical.
- `src/shell/` — login, selector de organización/vertical activa y layout común
  compartido por las 6 verticales: `AceptarInvitacion.tsx`,
  `SeleccionarOrganizacion.tsx`, `SinOrganizacion.tsx`, `SeleccionarVertical.tsx`
  (picker de vertical en "/") y `GoogleCallback.tsx` (puente compartido de
  retorno de OAuth de Google y de magic-link, canjea el código opaco de
  `POST /auth/exchange-code` antes de persistir sesión).
- `src/superadmin/` — back office de plataforma, fuera del árbol de las 6
  verticales: `SuperAdminShell.tsx` + `Dashboard.tsx`/`Prospectos.tsx`/
  `Paneles.tsx`/`GastoApi.tsx`/`BreakGlass.tsx`/`Integraciones.tsx`/
  `Facturacion.tsx`/`Salud.tsx` ("Salud operativa" — latidos de crons, salud
  de colas de mensajería, fuentes de licitaciones), ruteadas bajo
  `/superadmin/*`.
- `src/lib/` — cliente HTTP compartido contra `apps/api`, y el cliente de Supabase
  Realtime (usado hoy por el panel de Agenda de citas — ver
  `src/verticals/citas/lib/realtime-client.ts`).
- `src/verticals/{restaurantes,hoteles,citas,licitaciones,despachos,rentas}/` — el
  panel de administración propio de cada vertical (21 a 34 archivos `.tsx`/`.ts`
  por vertical a la fecha, licitaciones es el más grande: back-office,
  dashboards, formularios operativos).

`npm run build` corre `tsc --noEmit && vite build` — el build de producción
typechecka antes de empaquetar. `vercel.json` (raíz del repo) sirve este build
estático y reescribe `/auth/*`, `/v1/restaurantes/*`, `/hoteles/*`, etc. hacia la
función serverless de `apps/api` en el mismo dominio — ver `docs/DEPLOY.md`.
