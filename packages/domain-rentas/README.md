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
