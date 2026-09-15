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

## Calendario visual del panel de staff (Fase 13)

Cierra el gap identificado por auditoría: reservas.ts (Fase 1) y bloqueos.ts (Fase 4)
ya exponían crear/modificar/cancelar reservas y crear/listar/liberar bloqueos, pero
`apps/web` no tenía ningún cliente que los consumiera y, más grave, no existía ningún
`GET` que devolviera, para una unidad, TODAS sus ocupaciones (reserva de canal Y
bloqueo) en una sola vista — el listado mínimo para poder pintar un calendario.

- `RentasRepository.listOcupaciones(propertyId, unidadId)` (nuevo) — vista UNIFICADA
  de `rentas.ocupacion` (ambas capas, activa y cancelada, con `canalCodigo`/
  `huespedNombre`/`huespedContacto` ya resueltos), a diferencia de `listBloqueos`
  (Fase 4, acotado a `capa='bloqueo'`). Expuesta como
  `GET /rentas/:propertyId/unidades/:unidadId/ocupaciones`.
- `RentasRepository.listUnidades(propertyId)` (nuevo) — plumbing mínimo que también
  faltaba: hasta esta fase no había forma de que el panel web enumerara las unidades
  de una property antes de poder pedir nada más específico (mismo criterio que
  `listPropertiesForOrganization`, Fase 12). Expuesta como
  `GET /rentas/:propertyId/unidades`.
- `CALENDARIO_LECTURA_ROLES` (roles.ts, nuevo) — ambas rutas son de solo lectura, así
  que se abren también a `operador:solo_calendario` (mismo criterio de "lectura más
  permisiva que escritura" que ya declaraba `SYNC_CALENDARIO_LECTURA_ROLES`).
  Deliberadamente NO aplicado a `GET .../bloqueos` (Fase 4, sigue con
  `ESCRITURA_CALENDARIO_ROLES`) — ampliar esa ruta existente es un cambio de
  comportamiento fuera del alcance de este hallazgo.
- `apps/web/src/verticals/rentas/pages/Calendario.tsx` (nuevo) — vista real (lista por
  fecha, no un calendario visual con drag-and-drop) donde el staff ve y gestiona
  reservas/bloqueos reales de una unidad: crear reserva, crear bloqueo, modificar
  fechas de una reserva directa, cancelar/liberar.

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

## Correo transaccional al huésped (Fase 9)

Cierra el gap identificado por auditoría: el repo original enviaba automáticamente 2
correos reales al huésped (confirmación al crear la reserva, recordatorio 24-48h
antes del check-in) — `apps/api/.../rentas/reservas.ts` documentaba explícitamente
ese envío como diferido ("no hay motor de correo migrado a atiende-fusion todavía"),
aunque `domain-citas` ya había traído el motor real (Resend, `messaging_outbox`
`channel='email'`) en su propia Fase 6 §3. Esta fase lo porta a `rentas`:

- **`rentas.messaging_outbox`** (migrations/011) — MISMO shape de fila que
  `hoteles.messaging_outbox` (particiona por `property_id`, no por `organization_id`)
  + `claim_email_outbox_batch`/`complete_email_outbox_job` acotados a `channel='email'`
  (mismo patrón que `citas.claim_email_outbox_batch`).
- **`src/emails/reserva-templates.ts`** (+ `layout.ts`, DUPLICADO deliberado del
  layout de `domain-citas` — mismo criterio de aislamiento por paquete que el resto
  del monorepo) — `correoReservaConfirmada`/`correoReservaRecordatorioCheckIn`.
  Deliberadamente DISTINTAS de `src/mensajeria/plantillas.ts` (H-056, Fase 7): estos
  dos correos son **transaccionales/deterministas** (una plantilla fija con los datos
  reales de la reserva), **nunca pasan por `colaAprobacion.ts`** — a diferencia del
  borrador de mensajería de canal (Airbnb/Vrbo/Booking, con o sin IA), que SIEMPRE
  exige aprobación humana antes de salir.
- **`src/reserva-email-notifications.ts`** — `enqueueReservaEmailCore`/
  `tryEnqueueReservaEmail`, autosuficientes a partir de solo un `ocupacionId` (mismo
  principio que `domain-citas::appointment-email-notifications.ts`). Solo encola para
  una reserva DIRECTA `capa='reserva' AND estado='confirmado'` con un `contacto` de
  huésped que calce un patrón de correo real — nunca para un bloqueo, nunca para una
  `provisional`/`conflicto_pendiente`, nunca si el único dato de contacto es un
  teléfono.
- **`src/email-dispatch.ts`** — envío real fail-closed vía Resend (`fetch` nativo),
  mismo criterio que `domain-citas::email-dispatch.ts`: sin `RESEND_API_KEY`
  configurada, siempre lanza; un job JAMÁS se marca `'sent'` sin que Resend en verdad
  lo haya aceptado.
- **`src/checkin-reminders.ts`** — `runRecordatorioCheckInCore`, el cron de
  recordatorio: como `rentas.ocupacion.rango` es una fecha de calendario (`YYYY-MM-DD`,
  nunca un timestamp con hora — ver `fechas.ts`, README Fase 1 §1-#8), la ventana
  "24-48h antes" se expresa como `[hoy+1, hoy+2]` en días de calendario, calculada con
  el mismo `Date.UTC` puro del resto del paquete. `rentas.ocupacion.
  recordatorio_checkin_enviado_en` (belt-and-suspenders sobre el dedupe_key real del
  outbox, mismo criterio que `citas.appointments.reminder_24h_sent_at`) se marca SOLO
  tras encolar con éxito — una reserva sin correo real del huésped se deja sin marcar
  a propósito, para que una corrida futura la reintente si el dato cambia.
- **Rutas HTTP**: `POST /rentas/:propertyId/unidades/:unidadId/reservas` llama
  `tryEnqueueReservaEmail(..., "reserva.creada", ...)` tras crear la reserva
  (best-effort real: nunca convierte en error una reserva que ya se creó con éxito).
  `POST /internal/rentas/email-dispatch` (drena el outbox) y
  `POST /internal/rentas/checkin-recordatorio` (corre el cron) — mismo patrón/guard
  `x-atiende-internal-secret` que `ical-sync-cron.ts`; quién los dispara y cada
  cuánto es una decisión de infraestructura pendiente (mismo criterio que el resto de
  crons internos de este monorepo, ninguno tiene entrada en `vercel.json` todavía).

## Onboarding self-serve del tenant (Fase 11)

Cierra el gap identificado por auditoría: el repo original permite que un cliente
nuevo (dueño de propiedades) se dé de alta a sí mismo como tenant desde el producto —
organización + primera propiedad + admin + configuración inicial de rentas, un solo
submit, sin intervención manual del equipo de Atiende (`onboarding_registrar_empresa`,
`SECURITY DEFINER`, `rentas-standalone/packages/db/src/migrations/
0121_onboarding_funciones.ts`). En atiende-fusion esto está **parcialmente
construido, honestamente bloqueado en la porción que no es de este paquete**:

- **`src/onboarding/captura.ts`** (`validarCapturaOnboardingRentas`) — validación y
  normalización REAL de la captura completa (organización + primera propiedad + admin
  + configuración inicial), sin ninguna dependencia de infraestructura: nombre no
  vacío, `tipoOrganizacion` dentro del enum, zona horaria validada contra
  `Intl.supportedValuesOf("timeZone")` (D-013 del origen, mismo criterio que
  `rentas-standalone/packages/domain/src/fechas.ts::validarZonaHorariaIana`), moneda
  ISO 4217, correo/contraseña del admin, slug derivado del nombre
  (`slugificarNombreOrganizacion`).
- **`src/onboarding/repository.ts`** + **`postgres-repository.ts`** — el puerto
  `RentasOnboardingRepository` y su adaptador Postgres REAL (SQL correcto contra el
  esquema ya migrado, resolución de colisión de slug con sufijo incremental, manejo de
  correo de admin duplicado) — no es un stub ni un mock, es el código que correrá el
  día que exista una sesión de privilegio para escribirlo.
- **Bloqueado, por diseño, y documentado en detalle en `src/onboarding/repository.ts`**:
  `core.organization`/`core.property`/`core.staff_user`/`core.membership` NUNCA
  otorgan `insert`/`update`/`delete` a `authenticated`, solo a `service_role`
  (`packages/db/migrations/0001_core_schema.sql`), y este monorepo no aprovisiona
  `service_role` como conexión de aplicación (mismo gap ya documentado para 3 métodos
  de `rentasOwnerPortalRepo`, aquí es el puerto ENTERO). La solución real ya tiene
  precedente en este mismo monorepo — `core.accept_staff_invite`
  (`packages/db/migrations/0002_staff_invite_schema.sql`, función `security definer`)
  resuelve exactamente este tipo de problema sin necesitar `service_role` — y
  `core.staff_user.created_via` ya reserva el valor `'registro_autoservicio'` desde la
  migración 0001 sin que ningún método lo produjera hasta esta fase. Escribir esa
  función (`core.register_tenant_onboarding`, o el nombre que se decida) es trabajo de
  PLATAFORMA (esquema `core`, compartido por las 6 verticales), fuera del alcance de
  este paquete de dominio.
- **`InMemoryRentasOnboardingRepository`** — adaptador en memoria REAL (no un mock),
  usado hoy por `apps/api/tests/rentas-onboarding.spec.ts` para ejercitar
  `POST /rentas/onboarding/registro` de punta a punta; en producción,
  `production/deps.ts` conecta el puerto completo a `notProductionReady` (ver
  `apps/api/src/production/rentas-onboarding-repository.ts`) hasta que la función
  `security definer` exista.
- **Deliberadamente fuera de esta fase** (no fingido como completo): envío/consumo del
  token de verificación de correo (el resultado ya declara
  `requiereVerificacionCorreo: true` y `email_verified_at: null`, coherente con el
  chequeo que ya hace `POST /auth/login` sobre `created_via='registro_autoservicio'`,
  pero no hay infraestructura de envío de correo de verificación de STAFF en este
  monorepo — `src/emails/*` de la Fase 9 es correo transaccional al HUÉSPED, un
  concepto distinto), plan/facturación en la captura (`core.organization` no tiene
  columna de plan a propósito, ver comentario de `Organization` en
  `@atiende/core-tenancy::types.ts`: "Campos de plan/facturación deliberadamente
  AUSENTES — ver packages/billing"), y cualquier rate limiting sobre la ruta pública
  (mismo criterio que `POST /auth/login`, que tampoco lo tiene hoy en este monorepo).
