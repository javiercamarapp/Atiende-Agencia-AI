# Vertical: rentas (web)

Fase 1 (ver diseño Fase 1 rentas §5): solo `lib/auth-client.ts` + `pages/Login.tsx` —
email+password contra el JWT propio de `@atiende/core-auth`, mismo patrón ya construido
por hoteles/restaurantes-fase1. El dashboard visual completo (calendario, cotizador,
panel de finanzas) quedaba fuera de alcance de esa fase, igual que en las dos
verticales ya migradas.

Fase 12: `RentasShell.tsx` + `pages/Dashboard.tsx` + `lib/discovery-client.ts` — cierra
el hallazgo "login de rentas redirige a una ruta que no existía en la SPA (pantalla en
blanco)". La landing lista las properties reales de la organización y el rol del staff
logueado; el resto del dashboard operativo seguía fuera de alcance.

Fase 13: `pages/Calendario.tsx` + `lib/calendario-client.ts` — cierra el hallazgo de
auditoría "Calendario de reservas y bloqueos: backend completo sin UI". Consume el
listado unificado de ocupaciones (`GET .../unidades/:unidadId/ocupaciones`, nuevo en
esta fase) + crear/modificar/cancelar reservas y crear/cancelar bloqueos (ya existían
en el backend desde las Fases 1 y 4 sin ningún cliente web). Vista real (lista por
fecha, no un calendario visual con drag-and-drop). El cotizador y el panel de finanzas
visual siguen fuera de alcance.
