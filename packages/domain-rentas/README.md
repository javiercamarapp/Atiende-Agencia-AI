# @atiende/domain-rentas

Fase 1 de la migración del vertical `rentas` (renta vacacional / property management)
desde `rentas/packages/domain` — ver el diseño Fase 1 aprobado (commit de esta rama)
para el mapeo completo tabla-por-tabla y la justificación de cada decisión.

## Qué se portó tal cual (guardias de negocio reales, no debilitadas)

- **Anti-doble-reserva de calendario** (`aplicacion/reservas.ts`): el mismo mecanismo
  `SAVEPOINT` + `ROLLBACK TO SAVEPOINT` + `pg_advisory_xact_lock` que evita que dos
  transacciones concurrentes sobre la misma unidad terminen en deadlock (`40P01`) en vez
  de una violación limpia del `EXCLUDE` (`23P01`). Una reserva de canal **nunca** se
  cancela unilateralmente (REQ-000): si conflictúa, se inserta igual como
  `conflicto_pendiente` para revisión humana.
- **`EXCLUDE USING gist`** sobre `rentas.ocupacion` — literal, sin relajar ninguna
  condición (`capa='reserva' AND estado<>'cancelado' AND bloqueante`).
- **Finanzas-1** (`finanzas/movimiento.ts`): si el canal ya entrega el monto neto de su
  comisión, esa comisión **nunca** se vuelve a restar sobre el bruto original.
- **Aritmética monetaria en centavos** (`finanzas/redondeo.ts`) — nunca flotante, mismo
  redondeo half-up determinista sobre `BigInt` que el origen.
- **`linea_impuesto.revision_fiscal`** siempre `true` — Atiende nunca calcula un
  impuesto definitivo (constraint de esquema, no solo de aplicación).

## Qué se rediseñó (ver diseño Fase 1 §1, tabla de correcciones)

- Sin `zod` ni `@js-temporal/polyfill` (precedente ya sentado por `domain-hoteles`):
  `fechas.ts` se reimplementa con `Date.UTC` puro — los 3 flujos elegidos solo
  necesitan aritmética de fechas de calendario, nunca conversión de zona horaria de
  pared (eso solo lo usa iCal sync, Fase 2).
- `errors.ts` es nuevo (vocabulario tipado propio del paquete, mismo patrón que
  `domain-hoteles::QuoteError`) — el port original usaba `throw new Error(string)`
  genérico; aquí la ruta HTTP necesita distinguir el código para mapear el status.
- Los inserts a `outbox_evento` del origen (que alimentan sync de canal/notificaciones,
  ambos Fase 2) se omiten — no hay ningún consumidor en esta fase y la tabla no forma
  parte del esquema mapeado (§2.3 del diseño no la incluye).

## Bloqueos de propietario/mantenimiento/buffer (Fase 4)

`crearBloqueo` (motor puro portado desde Fase 1, ver diseño Fase 1 §6) ya se expone por
HTTP: `POST/GET /rentas/:propertyId/unidades/:unidadId/bloqueos` y
`POST .../bloqueos/:ocupacionId/cancelar` (`apps/api/src/routes/verticals/rentas/bloqueos.ts`).
Comportamiento heredado del motor, no decidido en la capa HTTP: un bloqueo NUNCA
rechaza la creación de una reserva de canal que se solape (ni viceversa) — el EXCLUDE
de Postgres solo protege `capa='reserva'`; cualquier solape entre capas se registra como
`rentas.conflicto_calendario` (`capa_cruzada`) para revisión humana, nunca como rechazo
automático.

## Limpieza/mantenimiento (Fase 8) — tareas, checklist, inventario, incidencias

Port de `rentas/packages/domain/src/limpieza/*` (Lote 5 del origen, BACKLOG E08,
H-049 a H-055, REQ-111..120). Cierra el gap identificado por auditoría: `BUFFER_LIMPIEZA`
existía en `Razon` desde la Fase 1 como valor de enum sin que ningún módulo lo
produjera — `src/limpieza/*` es ese módulo. Ver `src/limpieza/README` (comentario de
cabecera de `src/limpieza/aplicacion/tareas.ts`) para el detalle completo; resumen:

- **Dominio puro** (`buffer.ts`/`checklist.ts`/`sla.ts`/`inventario.ts`/`incidencias.ts`):
  port ~literal, reutilizando `RangoFechas`/`FechaLocal` de `../tipos.ts` en vez de
  redefinirlos.
- **Configuración operativa por property** (buffer de limpieza en noches + SLA por
  tipo de tarea en horas): 3 columnas nuevas sobre `rentas.property_config`
  (migración 010) — nunca una tabla `configuracion_operativa_propiedad` propia, a
  diferencia del origen (aquí ya existía una fila de configuración por property desde
  la Fase 1).
- **Sin `outbox_evento`** (mismo motivo que el resto de este paquete, ver arriba): el
  origen consumía `outbox_evento` para crear la tarea de limpieza automáticamente al
  checkout; aquí `procesarCheckoutsPendientes` reemplaza ese consumidor por un poll
  idempotente directo sobre `rentas.ocupacion` (reservas confirmadas cuyo checkout ya
  llegó y sin tarea de limpieza vinculada) — mismo patrón que `ical-sync-cron.ts`
  (cron interno, guardado por `x-atiende-internal-secret`).
- **Fuera de fase** (documentado, no fingido como completo): plantilla de checklist
  editable por property (H-051, REQ-114 — hoy solo la plantilla por defecto de
  `checklist.ts`), reabastecimiento manual de inventario (solo consumo vía
  `completarTarea`), subida real de fotos (solo `dev-local`, mismo criterio que el
  resto del monorepo), canal real de notificación de tarea (`notificacion_tarea.canales`
  queda vacío — sin dispatcher propio para este lote), endpoint de escritura de la
  configuración operativa por property (defaults de `CONFIGURACION_OPERATIVA_DEFECTO`
  vía `rentas.property_config`).
