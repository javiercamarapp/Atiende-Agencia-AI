# Vertical: despachos (worker)

Primer job real de este vertical (hallazgo de auditoría, severidad ALTA:
"ningún job en `apps/worker/src/jobs` para despachos, a diferencia de
citas/hoteles/licitaciones/rentas/restaurantes").

- `cobranza-reminders.ts` — `runCobranzaReminderSweep`: barrido transversal
  (todas las organizaciones activas, todas sus properties) que decide qué
  cuenta por cobrar tiene HOY un recordatorio de cobranza pendiente
  (`etapaRecordatorioCobranzaHoy`, motor puro de
  `packages/domain-despachos/src/cobranza/engine.ts`) y encola el correo real
  (`@atiende/domain-despachos::tryEnqueueCollectionReminderEmail`) cuando la
  cuenta tiene un contacto de correo capturado. Expuesto por
  `POST /internal/despachos/cobranza-reminders` (ver
  `apps/api/src/routes/verticals/despachos/notifications.ts`).

El escalamiento de vencimientos fiscales (`POST .../vencimientos/:id/escalar`)
NO tiene un job de barrido propio — es una acción puntual disparada por un
usuario del panel (ver
`apps/api/src/routes/verticals/despachos/vencimientos.ts`), no algo que un
scheduler deba re-evaluar periódicamente; su correo se encola inline en esa
misma ruta (`packages/domain-despachos/src/vencimientos/email-notifications.ts`).
