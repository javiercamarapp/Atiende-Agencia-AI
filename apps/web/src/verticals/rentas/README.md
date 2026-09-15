# Vertical: rentas (web)

Fase 1 (ver diseño Fase 1 rentas §5): solo `lib/auth-client.ts` + `pages/Login.tsx` —
email+password contra el JWT propio de `@atiende/core-auth`, mismo patrón ya construido
por hoteles/restaurantes-fase1. El dashboard visual completo (calendario, cotizador,
panel de finanzas) quedaba fuera de alcance de esa fase, igual que en las dos
verticales ya migradas. (Panel de finanzas: ver Fase 16 más abajo.)

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
visual siguen fuera de alcance (ver Fases 14 y 16 más abajo).

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
historial persistente. El panel de finanzas visual sigue fuera de alcance (ver Fase
16 más abajo).

Fase 15: `pages/Aprobaciones.tsx` + `lib/mensajeria-client.ts` — cierra el hallazgo de
auditoría ALTA "Mensajería con aprobación humana obligatoria: la cola de aprobación no
tiene botón de aprobar". `mensajeria-conversaciones.ts` y `mensajeria-borradores.ts`
(GET/POST generar borrador, POST aprobar, POST rechazar, POST intento-automatico) ya
estaban montados y probados desde la Fase 7 (H-059), pero ningún cliente web los
consumía: el principio de diseño "un agente redacta y no sale hasta que alguien lo
aprueba" vivía solo en el backend — en la práctica nadie podía aprobar ni rechazar
nada desde el producto.

- **Bandeja real, no un log**: el backend nunca expuso un GET "borradores pendientes
  de toda la property" (`RentasMensajeriaRepository.listBorradores` exige
  `conversacionId`, ver `packages/domain-rentas/src/mensajeria/repository.ts`). La
  página arma la bandeja en el cliente recorriendo `GET .../unidades` →
  `GET .../unidades/:id/conversaciones` → `GET .../conversaciones/:id/borradores`
  (`fetchBandejaAprobacion`), y ordena primero las conversaciones con al menos un
  borrador `pendiente_aprobacion`. Aceptable para el volumen real de una property de
  rentas (pocas unidades, pocas conversaciones activas); no escala a cientos de
  unidades sin un endpoint agregador nuevo — fuera de alcance de esta fase.
- **Aprobar/Rechazar** están gateados en el CLIENTE por
  `MENSAJERIA_ESCRITURA_ROLES = ["admin_gestora", "operador:acceso_total",
  "operador:calendario_mensajeria"]` (mismo valor real de
  `packages/domain-rentas/src/roles.ts`), mismo patrón que `PRICING_ESCRITURA_ROLES`
  en Precios.tsx — el servidor SIEMPRE re-valida con `assertVerticalRole`, este gate
  es solo UX.
- **No se expone ningún botón para `POST .../intento-automatico`**: ese endpoint es
  el punto de prueba de auditoría de "un proceso automático nunca puede enviar sin
  aprobación humana" (siempre lanza un error tipado), no una acción que un operador
  deba disparar desde el producto.
- **Nota honesta, deliberadamente NO corregida en esta fase** (documentada también
  como aviso fijo en la propia página): aprobar un borrador dispara
  `SimuladorCanalMensajeria` (`packages/domain-rentas/src/mensajeria/canalMensajeria.ts`),
  no un adaptador real de WhatsApp/Airbnb/Vrbo — no existe todavía ningún adaptador
  real de canal conectado para rentas. El borrador queda marcado `enviado` en la base
  de datos y en este panel, pero el huésped real no recibe ningún mensaje. Conectar un
  canal real es un hallazgo aparte, fuera de alcance de este hallazgo (que era,
  específicamente, la ausencia de UI para la cola de aprobación humana).
- **Fase 15.1 (cierra el hallazgo anterior)**: `lib/mensajeria-conversaciones-client.ts`
  agrega el cliente que faltaba para crear una conversación (`POST .../conversaciones`),
  registrar un mensaje ENTRANTE del huésped (`POST .../conversaciones/:id/mensajes`) y
  pedirle al agente que redacte un borrador (`POST .../conversaciones/:id/borradores`).
  El bloque `SimuladorMensajeEntrante` en `pages/Aprobaciones.tsx` encadena las 3
  llamadas en una sola acción de staff (elige/crea conversación → registra el mensaje
  → pide el borrador), gateado por el mismo `MENSAJERIA_ESCRITURA_ROLES` que ya usan
  aprobar/rechazar. Sigue siendo, honestamente, un registro **manual**: el mensaje se
  manda con `origen: "manual"` porque no existe ningún adaptador real de WhatsApp/
  Airbnb/Vrbo conectado — mismo aviso, mismo criterio que ya tenía esta página para
  `SimuladorCanalMensajeria` al aprobar (ver arriba). Antes de esta fase, la bandeja
  de aprobación SOLO se poblaba generando borradores por API directa (tests, script);
  ahora un operador puede sembrarla de punta a punta desde el producto.

Fase 16: `pages/Finanzas.tsx` + `lib/finanzas-client.ts` — cierra el hallazgo de
auditoría ALTA "Finanzas (movimientos, owner statements, payouts/conciliación) sin UI
para admin_gestora ni contador". `finanzas.ts` (POST/GET
`.../reservas/:ocupacionId/movimiento`), `finanzas-statements.ts` (POST/GET
`.../owners/:ownerId/statements`, GET `.../statements/:id`) y `finanzas-payouts.ts`
(POST `.../payouts`, GET `.../payouts/:id`) ya estaban montados y probados desde las
Fases 1 y 2 del backend, pero ningún cliente web los consumía: `contador`
(`FINANZAS_LECTURA_ROLES`) no tenía una sola pantalla que ver.

- **Lectura vs. escritura**: toda la página se gatea primero por
  `FINANZAS_LECTURA_ROLES = ["admin_gestora", "contador"]` (si el rol de la
  organización no está en esa lista, se muestra un aviso y ninguna de las 3
  secciones se monta); dentro de eso, registrar movimiento / generar statement /
  importar payout se gatean además por `FINANZAS_ESCRITURA_ROLES = ["admin_gestora"]`
  — mismo criterio y mismos valores reales de `packages/domain-rentas/src/roles.ts`
  que ya usa `PRICING_ESCRITURA_ROLES` en Precios.tsx. El servidor SIEMPRE re-valida
  con `assertVerticalRole`; este gate es solo UX.
- **Movimiento por reserva**: la reserva se elige con el mismo selector unidad →
  ocupaciones que ya construyó Calendario.tsx (`fetchUnidades`/`fetchOcupaciones`,
  filtrando `capa === "reserva"`) en vez de pedir un `ocupacionId` a ciegas.
- **Límite real, no un stub disfrazado** (documentado también en el header de
  `finanzas-client.ts`): ningún endpoint de rentas expone un GET que liste los
  propietarios de una property, ni uno que liste los payouts ya importados
  (confirmado leyendo completos `finanzas-statements.ts`/`finanzas-payouts.ts`/
  `repository.ts` — el único método de resolución de owner es
  `findOwnerConUnidadesEnProperty(propertyId, ownerId)`, que YA exige conocer el
  `ownerId`). La página pide `ownerId`/`payoutId` como texto libre — mismo criterio
  que la ausencia de GET de configuración de pricing ya documentada en la Fase 14.
  Al importar un payout, su id recién creado se precarga automáticamente en el campo
  de consulta (dato real devuelto por el propio POST, nunca inventado). Agregar esos
  catálogos es trabajo de backend fuera del alcance de este hallazgo.

Fase 17: `pages/MisTareas.tsx` — panel operativo real del rol `limpieza` (tareas/
checklist/inventario/incidencias, motor de `packages/domain-rentas/src/limpieza/*`
desde la Fase 8). Ver el comentario de cabecera de `RentasShell.tsx` para el detalle
completo; no documentado aquí en su momento.

Fase 18: `lib/property-selection.ts` + selector real en `RentasShell.tsx` +
`pages/Dashboard.tsx` clicable — cierra el hallazgo de auditoría "en rentas, una
empresa gestora con varias propiedades solo puede operar la primera". Hasta esta
fase `RentasShell.tsx` fijaba `propertyId = properties[0]` para siempre ("hasta que
haya un selector visual real"), igual que `HotelesShell.tsx` — pero a diferencia de
hoteles (donde ese atajo se justifica porque la mayoría de sus organizaciones operan
un solo hotel), en rentas el caso multi-propiedad es **el caso base del vertical**
(una gestora que administra propiedades de más de un anfitrión), así que el atajo
dejaba inoperable el caso más común, no una excepción.

- **Selector real**: dropdown en el header del nav de `RentasShell.tsx` cuando la
  organización tiene 2+ properties (con 1 sola sigue mostrando solo su nombre, mismo
  criterio visual que `HotelesShell.tsx`). `propertyId`/`setPropertyId` viajan en
  `RentasShellContext` para que cualquier página hija pueda leer y cambiar la
  property activa.
- **Segundo punto de entrada**: `pages/Dashboard.tsx` ya listaba las properties de
  la organización pero no eran clicables — ahora cada una es un botón real que llama
  al mismo `setPropertyId` del contexto (no un selector paralelo).
- **Persistencia (`lib/property-selection.ts`)**: cada ruta de `App.tsx`
  (`/rentas/:orgSlug/calendario`, `/rentas/:orgSlug/finanzas`, etc.) monta una
  instancia NUEVA de `<RentasShell>` — no hay un layout persistente entre rutas de
  React Router en este panel. Sin persistir la selección fuera del `useState` del
  Shell, cambiar de página (Calendario → Finanzas) resetearía silenciosamente la
  property activa a la primera, el mismo bug que este hallazgo pide cerrar. Se
  persiste en `localStorage` bajo `atiende.rentas.selectedProperty.<orgSlug>`,
  best-effort (nunca lanza si el storage falla al leer/escribir — modo privado,
  cuota excedida, storage bloqueado — la selección sigue viva en memoria durante la
  sesión del tab, solo no sobrevive un refresh).
- **Ninguna página operativa necesitó cambios funcionales**: `Calendario.tsx`,
  `Precios.tsx`, `Aprobaciones.tsx`, `Finanzas.tsx` y `MisTareas.tsx` ya
  desestructuraban `propertyId` de `RentasShellContext` (nunca asumían
  `properties[0]` directamente) y ya lo listaban en el arreglo de dependencias de
  sus `useEffect` de carga — en cuanto el Shell les pasa un `propertyId` distinto,
  vuelven a pedir datos automáticamente sin ningún cambio de código en esas 5
  páginas.
