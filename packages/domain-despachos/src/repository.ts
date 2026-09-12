// Puerto de acceso a datos de domain-despachos — mismo patrón dual de adaptador que
// domain-hoteles/src/repository.ts y domain-restaurantes/src/repository.ts: un
// puerto TS explícito, con un adaptador real en memoria (tests determinísticos) y un
// adaptador real de Postgres (sobre TenantDbSession, contra migrations/001). Ninguna
// función de negocio de las rutas de apps/api toca SQL directamente.
import type {
  DeadlineEscalationRecord,
  FiscalDeadlineRecord,
  InvoiceRecord,
  InvoiceReviewRecord,
  InvoiceReviewStatus,
  NewFiscalDeadlineInput,
  NewInvoiceInput,
  NewInvoiceReviewInput,
} from "./types.ts";
import type { NivelEscalamiento } from "./vencimientos/engine.ts";
import type { MapeoMigracionCuenta, NewMapeoMigracionInput } from "./migracion-catalogo/types.ts";
import type { NewPeriodoCierreInput } from "./cierre-mensual/repository-types.ts";
import type { ClosePeriod, CloseTask } from "./cierre-mensual/types.ts";

export interface DespachosRepository {
  // ---- CFDI (flujo 1) ----
  /** Lanza `InvoiceAlreadyExistsError` si ya existe un invoice con el mismo
   * (organizationId, folioFiscal) — el folio fiscal (UUID del timbre SAT) es la
   * llave natural de idempotencia de la ingesta: un mismo CFDI reenviado nunca se
   * duplica, sin necesitar un header Idempotency-Key aparte (a diferencia de
   * hoteles/folios, donde "cargo nuevo" no tiene una llave natural propia). */
  insertInvoice(input: NewInvoiceInput): Promise<InvoiceRecord>;
  findInvoice(propertyId: string, invoiceId: string): Promise<InvoiceRecord | null>;
  findInvoiceByFolioFiscal(organizationId: string, folioFiscal: string): Promise<InvoiceRecord | null>;
  /** `filter.periodo` (Fase 2, aditivo — ver diseño declaraciones §3, `repository.ts`):
   * "YYYY-MM", filtra a los invoices cuyo `diot.proveedoresReportables` contenga al
   * menos un registro para ese período — es el filtro que habilita
   * `GET /despachos/:propertyId/diot/:periodo` (Fase 3+: agregar DIOT sin releer CFDI
   * crudos, aplanando `proveedoresReportables` de cada invoice y llamando
   * `agregarDiot()`). No requiere migración de esquema nueva: se resuelve contra el
   * jsonb `diot` ya persistido en `invoice` (migrations/001). */
  listInvoices(propertyId: string, filter?: { readonly requiresHumanReview?: boolean; readonly periodo?: string }): Promise<readonly InvoiceRecord[]>;

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
}

export type { InvoiceRecord, InvoiceReviewRecord, FiscalDeadlineRecord, DeadlineEscalationRecord } from "./types.ts";
export type { MapeoMigracionCuenta, NewMapeoMigracionInput } from "./migracion-catalogo/types.ts";
