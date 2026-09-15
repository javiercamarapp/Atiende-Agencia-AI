# apps/web

SPA Vite/React real, única para las 6 verticales — ya NO es una carpeta reservada.
Actualizado en el barrido de documentación de las rondas 13/14/16: este README
describía "Aún no construida: no hay `package.json` ni `vite.config.ts` todavía",
que dejó de ser cierto hace varias fases.

## Estructura real

- `src/App.tsx` — enrutador raíz (React Router 7): login, selector de
  organización/vertical y las rutas de cada vertical.
- `src/shell/` — login, selector de organización/vertical activa y layout común
  compartido por las 6 verticales (`AceptarInvitacion.tsx`,
  `SeleccionarOrganizacion.tsx`, `SinOrganizacion.tsx`).
- `src/lib/` — cliente HTTP compartido contra `apps/api`, y el cliente de Supabase
  Realtime (usado hoy por el panel de Agenda de citas — ver
  `src/verticals/citas/lib/realtime-client.ts`).
- `src/verticals/{restaurantes,hoteles,citas,licitaciones,despachos,rentas}/` — el
  panel de administración propio de cada vertical (20 a 33 archivos `.tsx`/`.ts`
  por vertical: back-office, dashboards, formularios operativos).

`npm run build` corre `tsc --noEmit && vite build` — el build de producción
typechecka antes de empaquetar. `vercel.json` (raíz del repo) sirve este build
estático y reescribe `/auth/*`, `/v1/restaurantes/*`, `/hoteles/*`, etc. hacia la
función serverless de `apps/api` en el mismo dominio — ver `docs/DEPLOY.md`.
