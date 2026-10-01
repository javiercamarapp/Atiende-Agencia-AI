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

## efos-69b-ingestion.ts (D-04, lista 69-B del SAT)

`runEfos69bIngestion(withRepo, source, periodo)` parsea una edicion del CSV publico "Listado
completo 69-B" y la persiste via `repo.ingestarListaEfos` (funcion SQL `despachos.efos_ingestar_periodo`,
solo sesion de sistema, idempotente por periodo y SHA-256). Falla ENTERA si el archivo es invalido.

- **Sin llamadas al SAT**: la fuente es un adaptador (`Efos69bSource`). Hoy: subida manual por
  `POST /internal/despachos/efos-69b/ingestar?periodo=YYYY-MM` (secreto interno, cuerpo = CSV, tope 4 MB
  por el limite de cuerpo de las funciones de Vercel) y `FixtureEfos69bSource` (pruebas).
- **No hay cron** en `vercel.json` a proposito: una descarga automatica del archivo oficial es un adaptador
  futuro. Una edicion completa puede superar 4 MB; en ese caso se ingiere con un adaptador fuera de la
  funcion HTTP.
- Requiere la migracion 014. Sin ella la ruta responde 503 y la validacion de CFDI muestra la lista como
  "no disponible" (nunca como "emisor limpio").
