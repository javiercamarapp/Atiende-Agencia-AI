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

Fase 14: `pages/Precios.tsx` + `lib/pricing-client.ts` — cierra el hallazgo de
auditoría "Cotizador y configuración de pricing (6 endpoints) sin UI":
`GET .../unidades/:unidadId/cotizacion` (R2, `cotizaciones.ts`) y los 5 POST de
`pricing-config.ts` (tarifa-base, temporadas, descuentos-duracion, min-stay,
reglas-canal) ya existían en el backend desde la Fase 2 sin ningún cliente web. El
cotizador queda disponible para cualquier staff con acceso a la property (igual que
el servidor); la configuración de pricing se muestra solo si `session.organizations`
resuelve el rol de esa organización a `admin_gestora` (`PRICING_ESCRITURA_ROLES` real
de `packages/domain-rentas/src/roles.ts`) — el servidor sigue re-validando con
`assertVerticalRole`, este gate es solo UX. Límite real documentado en ambos
archivos: `pricing-config.ts` nunca expuso un GET que liste la configuración ya
guardada, así que la página muestra "configurado en esta sesión" en vez de un
historial persistente. El panel de finanzas visual sigue fuera de alcance.
