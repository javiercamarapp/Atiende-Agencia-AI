// Puerto de acceso a datos de domain-despachos — mismo patrón dual de adaptador que
// domain-hoteles/src/repository.ts y domain-restaurantes/src/repository.ts: un
// puerto TS explícito, con un adaptador real en memoria (tests determinísticos) y un
// adaptador real de Postgres (sobre TenantDbSession, contra migrations/001). Ninguna
// función de negocio de las rutas de apps/api toca SQL directamente.
import type {
  CollectionEventRecord,
  DeadlineEscalationRecord,
  DespachosAuditLogPage,
  DespachosPropertyConfigRecord,
  FiscalDeadlineRecord,
  InvoiceRecord,
  InvoiceReviewRecord,
  InvoiceReviewStatus,
  NewCollectionEventInput,
  NewFiscalDeadlineInput,
  NewInvoiceInput,
  NewInvoiceReviewInput,
  NewReceivableInput,
  NewSystemCollectionEventInput,
  ReceivableRecord,
  ReceivableReminderRow,
} from "./types.ts";
import type { NivelEscalamiento } from "./vencimientos/engine.ts";
import type { MapeoMigracionCuenta, NewMapeoMigracionInput } from "./migracion-catalogo/types.ts";
import type { NewPeriodoCierreInput } from "./cierre-mensual/repository-types.ts";
import type { ClosePeriod, CloseTask } from "./cierre-mensual/types.ts";

/** Página de `listInvoicesPage` -- mismo criterio de forma que
 * `CitasRepository::CustomerPage` (@atiende/domain-citas): `total` es el conteo
 * completo del filtro (no solo `items.length`), `nextOffset` es `null` cuando ya no
 * queda página siguiente. */
export interface InvoicePage {
  readonly items: readonly InvoiceRecord[];
  readonly total: number;
  readonly nextOffset: number | null;
}

export interface DespachosRepository {
  // ---- Fase 9 (paridad de UI del panel web): resolución de organización/property
  // desde el slug de la organización — mismo rol EXACTO que
  // `LicitacionesRepository.findOrganizationBySlug`/`listPropertiesForOrganization`
  // (ver domain-licitaciones/src/repository.ts): el panel de staff solo conoce el
  // slug de la organización tras el login (auth-client.ts nunca trae un
  // organizationId/propertyId), pero TODAS las rutas de staff de despachos
  // (cierre-mensual/cfdi/etc.) exigen `requirePropertyMembership("propertyId")`. Sin
  // esto, apps/web/src/verticals/despachos no tenía ningún camino real para resolver
  // ese propertyId — era el primer eslabón faltante antes que cualquier pantalla
  // nueva de esta fase (ver GET /v1/despachos/:orgSlug/admin/branches, admin.ts). */
  findOrganizationBySlug(slug: string): Promise<{ id: string; name: string; slug: string; isActive: boolean } | null>;
  /** Resuelve el nombre real de la organización por id -- necesario para el correo
   * de escalamiento de vencimientos (`vencimientos/email-notifications.ts`), que solo
   * conoce el `organizationId` del `FiscalDeadlineRecord`, nunca su slug. Mismo rol
   * EXACTO que `CitasRepository.findOrganizationById`. */
  findOrganizationById(organizationId: string): Promise<{ readonly id: string; readonly name: string } | null>;
  /** Despacho opera como property singleton por organización (mismo criterio que
   * licitaciones/citas §2.1), pero el panel igual lee la lista completa — nunca
   * asumir cardinalidad en el cliente. */
  listPropertiesForOrganization(organizationId: string): Promise<readonly { propertyId: string; name: string }[]>;

  // ---- CFDI (flujo 1) ----
  /** Lanza `InvoiceAlreadyExistsError` si ya existe un invoice con el mismo
   * (organizationId, folioFiscal) — el folio fiscal (UUID del timbre SAT) es la
   * llave natural de idempotencia de la ingesta: un mismo CFDI reenviado nunca se
   * duplica, sin necesitar un header Idempotency-Key aparte (a diferencia de
   * hoteles/folios, donde "cargo nuevo" no tiene una llave natural propia). */
  insertInvoice(input: NewInvoiceInput): Promise<InvoiceRecord>;
  findInvoice(propertyId: string, invoiceId: string): Promise<InvoiceRecord | null>;
  /** Batch de `findInvoice` -- hallazgo de auditoría (rubro 10, "performance y
   * escalabilidad", severidad MEDIA: "cobranza de despachos con 1+2N queries
   * serializadas"). Una sola consulta agregada (`WHERE id = ANY($1)`) para TODOS los
   * invoices de una lista de cuentas por cobrar, en vez de un `findInvoice` por
   * cuenta dentro de un `Promise.all` -- ver apps/api/.../cobranza.ts, que ya NO
   * llama a `findInvoice` uno por uno en sus rutas de listado. Orden no garantizado;
   * el llamador indexa por `id`. */
  findInvoicesByIds(propertyId: string, invoiceIds: readonly string[]): Promise<readonly InvoiceRecord[]>;
  findInvoiceByFolioFiscal(organizationId: string, folioFiscal: string): Promise<InvoiceRecord | null>;
  /** `filter.periodo` (Fase 2, aditivo; corregido en migración 006): "YYYY-MM",
   * filtra a los invoices cuya `fecha` real de emisión (columna `despachos.
   * invoice.fecha`, migración 006) caiga en ese período — es el filtro que habilita
   * `GET /despachos/:propertyId/diot/:periodo` (agregar DIOT sin releer CFDI crudos,
   * aplanando `proveedoresReportables` de cada invoice y llamando `agregarDiot()`) y
   * los endpoints de devolución de IVA por período. Antes de la migración 006 se
   * resolvía contra el jsonb `diot.proveedoresReportables`, que solo existe para un
   * CFDI tipo 'I' con subtotal>0 — cualquier otro tipo (E/T/P/N), o un 'I' con
   * subtotal=0, desaparecía del período sin importar su fecha real. Ahora se
   * resuelve directo contra `fecha`, así que incluye TODOS los tipos de CFDI de la
   * property que caigan en el período — el llamador decide si además filtra por
   * `diot.reportable` (como hace la agregación DIOT real, que solo reporta
   * proveedores tipo 'I'). */
  listInvoices(propertyId: string, filter?: { readonly requiresHumanReview?: boolean; readonly periodo?: string }): Promise<readonly InvoiceRecord[]>;
  /** Versión PAGINADA de `listInvoices`, para `GET /despachos/:propertyId/cfdi` (el
   * listado que un humano navega en el panel) -- hallazgo de auditoría (rubro 10,
   * "performance y escalabilidad", severidad BAJA: "listados sin paginación en 4
   * verticales"). `listInvoices` (arriba) se queda EXACTAMENTE como está y sigue
   * siendo la única usada por agregaciones fiscales que necesitan el conjunto
   * COMPLETO de un período (declaraciones/DIOT/devolución de IVA/conciliación) --
   * paginar esa función truncaría un cálculo fiscal real. Orden `created_at desc`
   * (más reciente primero), mismo criterio que `listInvoices`. */
  listInvoicesPage(propertyId: string, opts: { readonly limit: number; readonly offset: number; readonly requiresHumanReview?: boolean }): Promise<InvoicePage>;

  // ---- Cola de revisión humana (flujo 2) ----
  createReview(input: NewInvoiceReviewInput): Promise<InvoiceReviewRecord>;
  listPendingReviews(propertyId: string): Promise<readonly InvoiceReviewRecord[]>;
  findReview(propertyId: string, reviewId: string): Promise<InvoiceReviewRecord | null>;
  /** Lanza `InvoiceReviewAlreadyResolvedError` si `status` ya no es "pendiente". */
  resolveReview(propertyId: string, reviewId: string, resolvedBy: string, status: InvoiceReviewStatus, decisionNote: string | null): Promise<InvoiceReviewRecord>;

  // ---- Vencimientos fiscales (flujo 3) ----
  createDeadline(input: NewFiscalDeadlineInput): Promise<FiscalDeadlineRecord>;
  listDeadlines(propertyId: string, filter?: { readonly estado?: string }): Promise<readonly FiscalDeadlineRecord[]>;
  findDeadline(propertyId: string, deadlineId: string): Promise<FiscalDeadlineRecord | null>;
  markDeadlineCompleted(deadlineId: string, comprobanteUrl: string | null, fechaPresentacion: string): Promise<FiscalDeadlineRecord | null>;
  updateDeadlineEstado(deadlineId: string, estado: FiscalDeadlineRecord["estado"]): Promise<void>;
  insertEscalation(deadlineId: string, level: NivelEscalamiento, sentAt: string, notes: string): Promise<DeadlineEscalationRecord>;
  listEscalations(deadlineId: string): Promise<readonly DeadlineEscalationRecord[]>;

  // ---- Migración de catálogo contable (Fase 5) ----
  /** Crea un mapeo recién clasificado (`clasificarCuentaOrigen`) — `estado` viene
   * ya decidido por el clasificador ("aprobado" solo si `tipoMatch==="exacto"",
   * ADR-3; "pendiente" en cualquier otro caso). */
  insertMapeoMigracion(input: NewMapeoMigracionInput & { readonly tipoMatch: MapeoMigracionCuenta["tipoMatch"]; readonly score: number; readonly estado: MapeoMigracionCuenta["estado"] }): Promise<MapeoMigracionCuenta>;
  findMapeoMigracion(propertyId: string, mapeoId: string): Promise<MapeoMigracionCuenta | null>;
  listMapeosMigracion(propertyId: string, filter?: { readonly estado?: MapeoMigracionCuenta["estado"] }): Promise<readonly MapeoMigracionCuenta[]>;
  /** Reemplaza el mapeo completo — usado tras `aprobarMapeo`/`rechazarMapeo`/
   * `editarMapeo` (funciones puras de `migrador.ts`) para persistir el resultado. */
  updateMapeoMigracion(mapeo: MapeoMigracionCuenta): Promise<MapeoMigracionCuenta>;

  // ---- Cierre mensual (Fase 6) ----
  /** Crea el período + las tareas resueltas de la plantilla en una sola
   * operación (igual que `open_period` del origen, que también arma las
   * tareas atómicamente al abrir). El llamador (ruta HTTP) es responsable de
   * llamar `verificarPeriodoNoDuplicado` con `listPeriodosCierre` ANTES de
   * llamar esto — el repositorio no re-valida el duplicado (la unique
   * constraint de la migración es la última línea de defensa real). */
  insertPeriodoCierre(input: NewPeriodoCierreInput): Promise<{ readonly periodo: ClosePeriod; readonly tareas: readonly CloseTask[] }>;
  findPeriodoCierre(propertyId: string, periodoId: string): Promise<ClosePeriod | null>;
  /** Único período con ese (property, año, mes) — usado por el chequeo de
   * bloqueo de edición (ver `cfdi.ts`) para resolver el período de una fecha
   * dada sin tener que listar todos los períodos de la property. */
  findPeriodoCierrePorAnioMes(propertyId: string, anio: number, mes: number): Promise<ClosePeriod | null>;
  listPeriodosCierre(propertyId: string): Promise<readonly ClosePeriod[]>;
  listTareasCierre(periodoId: string): Promise<readonly CloseTask[]>;
  updatePeriodoCierre(periodo: ClosePeriod): Promise<ClosePeriod>;
  /** Reemplaza el arreglo completo de tareas del período — los motores de
   * `engine.ts` (`completarTarea`/`autoCheckTareas`) devuelven la lista
   * COMPLETA recalculada, no un diff. */
  replaceTareasCierre(periodoId: string, tareas: readonly CloseTask[]): Promise<readonly CloseTask[]>;

  // ---- Cobranza (Fase 10, REQ de paridad "agente de cobranza") ----
  /** Arranca el reloj de cobranza de un invoice tipo 'I' ya ingerido.
   * Lanza `ReceivableAlreadyExistsError` si ese invoice ya tiene una cuenta
   * por cobrar registrada — mismo criterio de idempotencia que
   * `insertInvoice`/`InvoiceAlreadyExistsError`. */
  registerReceivable(input: NewReceivableInput): Promise<ReceivableRecord>;
  findReceivable(propertyId: string, receivableId: string): Promise<ReceivableRecord | null>;
  findReceivableByInvoice(propertyId: string, invoiceId: string): Promise<ReceivableRecord | null>;
  /** `filter.pendiente=true` -> solo cuentas sin `pagadoEn` — la cartera
   * vigente que alimenta `analizarCarteraCobranza`/aging/recordatorios (ver
   * `cobranza/engine.ts`). Sin filtro, devuelve toda la cartera (incluida la
   * ya pagada) para reportes históricos. */
  listReceivables(propertyId: string, filter?: { readonly pendiente?: boolean }): Promise<readonly ReceivableRecord[]>;
  /** Lanza `ReceivableAlreadyPaidError` si `pagadoEn` ya estaba fijado — una
   * cuenta por cobrar se marca pagada una sola vez (mismo criterio de
   * "transición de un solo sentido" que `InvoiceReviewAlreadyResolvedError`). */
  markReceivablePaid(propertyId: string, receivableId: string, paidAtIso: string, montoPagado: number | null): Promise<ReceivableRecord>;
  /** Registra un recordatorio generado (o una respuesta del deudor, etapa
   * 'respuesta') para auditoría — el CONTENIDO del recordatorio lo genera
   * `construirRecordatorioCobranza` (puro, sin DB); esto solo deja el
   * rastro que después alimenta `scoreCobrabilidadCartera` como historial. */
  insertCollectionEvent(input: NewCollectionEventInput): Promise<CollectionEventRecord>;
  listCollectionEvents(propertyId: string, receivableId: string): Promise<readonly CollectionEventRecord[]>;
  /** Batch de `listCollectionEvents` -- mismo hallazgo de auditoría que
   * `findInvoicesByIds` de arriba. Una sola consulta agregada (`WHERE receivable_id =
   * ANY($1)`) para el historial de TODAS las cuentas de una lista, en vez de un
   * `listCollectionEvents` por cuenta. El llamador agrupa por `receivableId`. */
  listCollectionEventsForReceivables(propertyId: string, receivableIds: readonly string[]): Promise<readonly CollectionEventRecord[]>;

  // ---- Flujos de sistema (cron `cobranza-reminders`, `withAppSession({ userId:
  // null })`) -- hallazgo de auditoría (severidad ALTA, "flujos de sistema
  // bloqueados en escritura"): `listReceivables`/`findInvoice`/`insertCollectionEvent`
  // de arriba son código COMPARTIDO con el staff autenticado (panel de cartera +
  // `POST .../recordatorio`, ver `apps/api/src/routes/verticals/despachos/
  // cobranza.ts`) -- sustituirlos habría roto ese camino. Los 2 métodos de abajo son
  // EXCLUSIVOS del barrido de sistema (`apps/worker/src/jobs/despachos/cobranza-
  // reminders.ts`, ver migración 009 para el detalle completo). ----
  /** Cartera pendiente de UNA property + folio fiscal/total del invoice asociado, en
   * una sola consulta (evita el `findInvoice` por fila que exigía el camino de
   * staff) -- mismo criterio de `filter.pendiente=true` de `listReceivables`. */
  systemListPendingReceivablesForReminders(propertyId: string): Promise<readonly ReceivableReminderRow[]>;
  /** Registra el evento de recordatorio de cobranza de forma idempotente
   * (best-effort, ver header de la migración 009) para UN (receivable, etapa,
   * `eventDate`) -- `null` si ya se había registrado esa combinación (dedupe, no
   * error). Nunca usado para `etapa: 'respuesta'` (esa sigue siendo
   * `insertCollectionEvent`, camino de staff). */
  systemRecordCollectionEvent(input: NewSystemCollectionEventInput): Promise<CollectionEventRecord | null>;

  // ---- Infraestructura de correo (hallazgo de auditoría, severidad ALTA: "despachos
  // no tiene ninguna infraestructura de correo, mientras citas/rentas/licitaciones sí
  // la tienen") — mismo patrón EXACTO que `LicitacionesRepository` (leído primero
  // como plantilla): `messaging_outbox` organization-scoped, acotado a channel='email'
  // (migración 005), + resolución del "responsable" de la organización para avisos
  // internos (escalamiento de vencimientos fiscales). ----

  /** Organizaciones `despachos` activas — insumo del barrido transversal de cobranza
   * (`@atiende/worker::runCobranzaReminderSweep`), mismo rol que
   * `LicitacionesRepository.listActiveOrganizations`. */
  listActiveOrganizations(): Promise<readonly { id: string }[]>;
  /** Staff `owner`/`admin` de la organización — a quién se le manda el correo de
   * escalamiento de un vencimiento fiscal (aviso INTERNO al despacho, nunca al
   * contribuyente/cliente final). Ver `despachos.organization_notification_recipients`
   * (migración 005). */
  listOrganizationNotificationRecipients(organizationId: string): Promise<readonly OrganizationNotificationRecipient[]>;
  /** Encola (`channel='email'`) el envío real -- mismo rol que
   * `CitasRepository.enqueueMessagingOutbox`/`LicitacionesRepository.enqueueMessagingOutbox`.
   * `channel` se deja como parámetro (en vez de fijarlo en la firma) por SIMETRÍA con
   * el resto del monorepo -- este vertical hoy solo implementa 'email' (ver migración
   * 005, sin `despachos.whatsapp_config`); pasar cualquier otro valor lanza. */
  enqueueMessagingOutbox(organizationId: string, channel: "email", eventType: string, dedupeKey: string, payload: unknown): Promise<void>;
  /** Reclama hasta `limit` jobs `channel='email'` pendientes/fallidos -- ver
   * `despachos.claim_email_outbox_batch` (migración 005). */
  claimEmailOutboxBatch(limit: number): Promise<readonly EmailOutboxJobRow[]>;
  completeEmailOutboxJob(id: string, status: "sent" | "failed" | "dead", error: string | null): Promise<void>;

  /** Auditoría a3, hallazgo confirmado #5/#2 -- aísla un best-effort (hoy solo
   * `vencimientos/email-notifications.ts::tryEnqueueEscalationEmail`) con un
   * SAVEPOINT propio dentro de la MISMA transacción que ya persistió la escritura de
   * negocio real (`vencimientos.ts::escalar` hace `insertEscalation` +
   * `updateDeadlineEstado` ANTES de llamar a este best-effort, misma sesión de
   * staff). Sin este SAVEPOINT, un error real de Postgres dentro del correo (deadlock,
   * timeout, `42501` si `auth.uid()` no es miembro) deja la transacción COMPLETA
   * abortada (25P02) -- el escalamiento ya "persistido" se pierde de todas formas, y
   * el `commit;` que sigue en `managed-postgres-engine.ts` lo detecta y lanza
   * `AbortedTransactionCommitError` (desde PR #158 esto es un 500 honesto, NUNCA un
   * rollback silencioso con 2xx). Mismo patrón/mismo helper
   * (`runWithSavepointFallback` de `@atiende/db`, `isRecoverable: () => true`,
   * `fallback` que relanza) que `HotelesRepository.runWithRowSavepoint`/
   * `RestaurantesRepository.runWithRowSavepoint`/`PostgresCitasRepository.
   * runWithRowSavepoint` -- ver su comentario de cabecera para el diseño completo.
   * No-op en `InMemoryDespachosRepository` (sin transacción real que aislar). */
  runWithRowSavepoint<T>(fn: () => Promise<T>): Promise<T>;

  // ---- FASE 3 (producto) -- zona horaria por negocio (migración 012): config
  // real por property, ver el comentario de cabecera de la migración para el
  // porqué de una tabla nueva en vez de una columna en `tenant_profile`. ----
  /** `null` si la property nunca configuró una fila todavía (nunca 404 -- el
   * caller resuelve el default de plataforma vía
   * `resolverZonaHorariaNegocio(config?.zonaHoraria)`). Compat con la base sin
   * migrar: el adaptador de Postgres degrada a `null` en 42P01/42883/42703
   * (mismo criterio que el resto del repo, ver REGLA DURA de compatibilidad). */
  findPropertyConfig(propertyId: string): Promise<DespachosPropertyConfigRecord | null>;
  /** Upsert real (insert ... on conflict do update) -- una property puede no
   * tener fila todavía la primera vez que su owner configura la zona horaria.
   * `zonaHoraria: null` borra la configuración explícita (vuelve al default de
   * plataforma). Lanza `DespachosConfigUnavailableError` (./errors.ts) si la base
   * todavía no tiene la migración 012 aplicada -- la ruta HTTP lo traduce a un 503
   * honesto, nunca un 500 crudo ni un upsert silenciosamente perdido. */
  upsertPropertyConfigZonaHoraria(propertyId: string, organizationId: string, zonaHoraria: string | null): Promise<DespachosPropertyConfigRecord>;

  // ---- Bitácora de auditoría (f2-orden-total-bitacoras) ----
  /** Lectura PAGINADA de `despachos.audit_log` (008_despachos_audit_log.sql), más
   * reciente primero -- orden TOTAL desde el día uno (`created_at desc, seq desc`,
   * migración 011): sin este desempate, `now()` (created_at) es CONSTANTE dentro de
   * una transacción, así que dos entradas de auditoría escritas en la MISMA
   * transacción de request podrían quedar en orden no determinista y paginar de
   * forma inestable (mismo hallazgo que `packages/domain-rentas/migrations/
   * 022_rentas_audit_log_orden_determinista.sql`, PR #173, aplicado aquí ANTES de
   * que exista ningún consumidor real -- ver el comentario de cabecera de la
   * migración 011). Hoy sin caller HTTP (mismo criterio que la propia 008: "ninguna
   * ruta la expone todavía"); queda lista para un futuro panel de auditoría. */
  listAuditLogPage(organizationId: string, opts: { readonly limit: number; readonly offset: number }): Promise<DespachosAuditLogPage>;
}

/** Staff `owner`/`admin` real de una organización — el "responsable" al que se le
 * manda un correo de aviso interno (ver `listOrganizationNotificationRecipients`).
 * Mismo shape que `OrganizationNotificationRecipient` de domain-licitaciones. */
export interface OrganizationNotificationRecipient {
  readonly email: string;
  readonly fullName: string;
}

/** Fila de `despachos.messaging_outbox` reclamada para despacho real (ver
 * `email-dispatch.ts` y `despachos.claim_email_outbox_batch`, migración 005). Mismo
 * shape que `EmailOutboxJobRow` de domain-citas/domain-licitaciones. */
export interface EmailOutboxJobRow {
  readonly id: string;
  readonly organizationId: string;
  readonly attempts: number;
  readonly payload: Record<string, unknown>;
}

export type { InvoiceRecord, InvoiceReviewRecord, FiscalDeadlineRecord, DeadlineEscalationRecord, ReceivableRecord, CollectionEventRecord, DespachosPropertyConfigRecord } from "./types.ts";
export type { MapeoMigracionCuenta, NewMapeoMigracionInput } from "./migracion-catalogo/types.ts";
