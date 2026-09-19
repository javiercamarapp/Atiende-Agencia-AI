// Tipos de registro (fila ya mapeada a camelCase) que RentasRepository
// devuelve/recibe — ninguna función de negocio de las rutas de apps/api toca una
// fila cruda de SQL directamente, mismo criterio que domain-hoteles/domain-restaurantes.
import type { Capa, EstadoOcupacion, Razon, RangoFechas } from "./tipos.ts";
import type { ConfiguracionComisionCanal, LineaGastoEntrada, LineaImpuestoEntrada, MovimientoFinancieroReserva } from "./finanzas/tipos.ts";
import type { LineaOwnerStatement, TotalesOwnerStatement } from "./finanzas/statement.ts";
import type { LineaConciliada, ResumenConciliacion } from "./finanzas/conciliacion.ts";
import type { DescuentoDuracion, ReglaMinStay, TemporadaTarifa } from "./pricing/tipos.ts";
import type { ChecklistItemTarea, EstadoIncidencia, EstadoTareaOperativa, ItemInventarioUnidad, PrioridadTareaOperativa, SeveridadIncidencia, TipoTareaOperativa } from "./limpieza/tipos.ts";

export interface UnidadRecord {
  readonly id: string;
  readonly propertyId: string;
  readonly organizationId: string;
  readonly duracionMinimaNoches: number;
  /** `rentas.unidad.owner_id` -- `null` si la unidad no tiene propietario asignado
   *  todavía. Solo lo necesita el owner statement (Fase 2, Flujo 5); opcional para no
   *  romper los seeds de Fase 1 que no lo pasan. */
  readonly ownerId?: string | null;
  /** `rentas.unidad.name` -- opcional para no romper los seeds de fases anteriores
   *  que no lo pasan (`findUnidad` nunca lo necesitó hasta Fase 9). Solo lo necesita
   *  el correo transaccional al huésped (Fase 9, `findOcupacionParaCorreo`), que cae a
   *  un texto genérico si falta -- ver reserva-email-notifications.ts. */
  readonly name?: string;
}

// ─────────────────────────────────────────────────────────────────────────
// Fase 12 -- descubrimiento de organización/property para el panel web de staff
// (apps/web/src/verticals/rentas): el login (`POST /auth/login`) nunca trae un
// propertyId, solo `{id, slug, nombre, vertical, rol}` -- mismo problema y misma
// solución que ya resolvió hoteles (`GET /v1/hoteles/:orgSlug/admin/propiedades`,
// ver domain-hoteles/src/types.ts::HotelOrganizationSummary/PropertySummary,
// comentario de cabecera de esa ruta) y antes restaurantes
// (`GET /v1/restaurantes/:orgSlug/admin/branches`). `RentasOrganizationSummary`/
// `RentasPropertySummary` son un espejo de solo-lectura de
// `core.organization`/`core.property` (vertical 'rentas') -- este dominio no posee
// esas filas (viven en `core`), solo las expone para que la ruta de descubrimiento
// no tenga que hablar SQL de `core` directamente.
// ─────────────────────────────────────────────────────────────────────────
export interface RentasOrganizationSummary {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
}

export interface RentasPropertySummary {
  readonly propertyId: string;
  readonly name: string;
}

export interface CanalRecord {
  readonly id: string;
  readonly codigo: string;
}

export interface NewGuestMinimoInput {
  readonly organizationId: string;
  readonly propertyId: string;
  readonly nombre: string | null;
  readonly contacto: string | null;
}

/** Resumen mínimo de una ocupación para las verificaciones de defensa en profundidad
 * que hace la ruta ANTES de invocar `modificarFechasReserva`/`cancelarOcupacion`
 * (nunca tocar una reserva de canal — regla heredada del origen, se porta literal). */
export interface OcupacionResumen {
  readonly id: string;
  readonly unidadId: string;
  readonly capa: "reserva" | "bloqueo";
  readonly estado: EstadoOcupacion;
  readonly canalOrigenId: string | null;
}

export interface OcupacionParaMovimiento {
  readonly id: string;
  readonly capa: "reserva" | "bloqueo";
  readonly canalId: string | null;
}

/** Fila de listado para `GET .../bloqueos` -- Fase 4, expone `crearBloqueo` (motor
 * puro ya existente desde Fase 1, nunca alcanzable por HTTP hasta ahora). Solo cubre
 * `capa='bloqueo'` (BLOQUEO_PROPIETARIO/MANTENIMIENTO/BUFFER_LIMPIEZA) -- nunca
 * mezcla reservas de canal aquí, mismo criterio que `OcupacionResumen`. */
export interface BloqueoRecord {
  readonly id: string;
  readonly unidadId: string;
  readonly rango: RangoFechas;
  readonly razon: Extract<Razon, "BLOQUEO_PROPIETARIO" | "MANTENIMIENTO" | "BUFFER_LIMPIEZA">;
  readonly estado: EstadoOcupacion;
}

/** Fila de listado para `GET .../ocupaciones` -- Fase 13 (calendario visual del panel
 *  de staff). A diferencia de `BloqueoRecord` (solo `capa='bloqueo'`, Fase 4) esta
 *  vista es la UNIFICADA que el calendario necesita: TODA ocupación de la unidad
 *  (reserva de canal Y bloqueo, activa Y cancelada), con lo mínimo para pintarla sin
 *  una segunda ronda de queries -- `canalCodigo` para distinguir "Airbnb"/"manual" en
 *  una reserva, `huespedNombre`/`huespedContacto` cuando la reserva tiene un huésped
 *  mínimo adjunto (ver `attachGuestToOcupacion`). Nunca expone más que esto -- ningún
 *  dato financiero ni de pricing vive aquí, mismo criterio de acotamiento que
 *  `OcupacionResumen`. */
export interface OcupacionCalendarioItem {
  readonly id: string;
  readonly unidadId: string;
  readonly capa: Capa;
  readonly rango: RangoFechas;
  readonly razon: Razon;
  readonly estado: EstadoOcupacion;
  readonly canalCodigo: string | null;
  readonly huespedNombre: string | null;
  readonly huespedContacto: string | null;
  readonly createdAt: string;
}

export interface NewReservaFinancieroInput {
  readonly organizationId: string;
  readonly propertyId: string;
  readonly ocupacionId: string;
  readonly moneda: string;
  readonly montoBrutoCentavos: number;
  readonly yaNetoDeComision: boolean;
  readonly comisionCanalBasisPoints: number;
  readonly comisionCanalFuente: string;
  readonly comisionCanalCentavos: number;
  readonly comisionGestorBasisPoints: number;
  readonly comisionGestorBase: "bruto" | "neto_de_canal";
  readonly comisionGestorCentavos: number;
  readonly montoRecibidoCentavos: number;
  readonly gastos: readonly LineaGastoEntrada[];
  readonly gastosCentavos: number;
  readonly impuestos: readonly LineaImpuestoEntrada[];
  readonly impuestosCentavos: number;
  readonly netoCentavos: number;
  readonly createdBy: string;
}

export type { ConfiguracionComisionCanal, MovimientoFinancieroReserva };
export type { ContextoPricingUnidad, DescuentoDuracion, ReglaCanal, ReglaMinStay, ResultadoCotizacion, TemporadaTarifa } from "./pricing/tipos.ts";

// ---------------------------------------------------------------------------
// Pricing CRUD (Fase 2, Flujo 4) -- ver migrations/004_pricing_escritura_rls.sql.
// ---------------------------------------------------------------------------

export interface NewTarifaBaseInput {
  readonly organizationId: string;
  readonly propertyId: string;
  readonly unidadId: string;
  readonly precioNocheCentavos: number;
  readonly moneda: string;
  readonly vigenteDesde: string;
  readonly createdBy: string;
}

export interface TemporadaRecord extends TemporadaTarifa {
  readonly id: string;
}

export interface NewTemporadaInput {
  readonly organizationId: string;
  readonly propertyId: string;
  readonly unidadId: string;
  readonly nombre: string;
  readonly rango: RangoFechas;
  readonly precioNocheCentavos: number;
  readonly moneda: string;
  readonly createdBy: string;
}

export interface DescuentoDuracionRecord extends DescuentoDuracion {
  readonly id: string;
}

export interface NewDescuentoDuracionInput {
  readonly organizationId: string;
  readonly propertyId: string;
  readonly unidadId: string;
  readonly nochesMinimas: number;
  readonly porcentajeDescuentoBasisPoints: number;
  readonly fuente: string;
  // Sin `createdBy`: `rentas.tarifa_descuento_duracion` (migrations/002) no tiene
  // columna `creado_por` -- a diferencia de tarifa_base/tarifa_temporada.
}

export interface ReglaMinStayRecord extends ReglaMinStay {
  readonly id: string;
}

export interface NewReglaMinStayInput {
  readonly organizationId: string;
  readonly propertyId: string;
  readonly unidadId: string;
  readonly rango: RangoFechas;
  readonly diaSemanaCheckIn: number | null;
  readonly nochesMinimas: number;
  // Sin `createdBy`: `rentas.tarifa_min_stay` (migrations/002) no tiene columna
  // `creado_por`.
}

export interface NewReglaCanalPricingInput {
  readonly organizationId: string;
  readonly propertyId: string;
  readonly unidadId: string;
  readonly canalId: string;
  readonly markupBasisPoints: number;
  readonly activo: boolean;
  // Sin `createdBy`: `rentas.tarifa_regla_canal` (migrations/002) no tiene columna
  // `creado_por`.
}

// ---------------------------------------------------------------------------
// Owner statement (Fase 2, Flujo 5) -- ver
// migrations/005_finanzas_statement_payout_schema.sql.
// ---------------------------------------------------------------------------

export interface OwnerRecord {
  readonly id: string;
  readonly name: string;
}

export interface UltimaVersionOwnerStatement {
  readonly id: string;
  readonly version: number;
  readonly hashContenido: string;
}

export interface NewOwnerStatementInput {
  readonly organizationId: string;
  readonly propertyId: string;
  readonly ownerId: string;
  readonly periodo: RangoFechas;
  readonly version: number;
  readonly moneda: string;
  readonly totales: TotalesOwnerStatement;
  readonly lineas: readonly LineaOwnerStatement[];
  readonly hashContenido: string;
  readonly motivoVersion: string | null;
  readonly generadoPor: string;
}

export interface OwnerStatementSummary {
  readonly id: string;
  readonly ownerId: string;
  readonly propertyId: string;
  readonly periodo: RangoFechas;
  readonly version: number;
  readonly moneda: string;
  readonly netoCentavos: number;
  readonly generadoEn: string;
}

export interface OwnerStatementDetalle extends OwnerStatementSummary {
  readonly totales: TotalesOwnerStatement;
  readonly lineas: readonly LineaOwnerStatement[];
  readonly motivoVersion: string | null;
}

export type { ReservaParaStatement } from "./finanzas/statement.ts";

// ---------------------------------------------------------------------------
// Payout / conciliación (Fase 2, Flujo 6, alcance recortado -- ver diseño §1.4/§5).
// ---------------------------------------------------------------------------

export type { CandidataConciliacion, LineaConciliada } from "./finanzas/conciliacion.ts";

export interface NewPayoutInput {
  readonly organizationId: string;
  readonly propertyId: string;
  readonly canalId: string;
  readonly moneda: string;
  readonly montoTotalCentavos: number;
  readonly fechaPayout: string;
  readonly referenciaExterna: string | null;
  readonly createdBy: string;
  readonly lineas: readonly LineaConciliada[];
}

export interface PayoutDetalle {
  readonly id: string;
  readonly propertyId: string;
  readonly canalCodigo: string;
  readonly moneda: string;
  readonly montoTotalCentavos: number;
  readonly fechaPayout: string;
  readonly referenciaExterna: string | null;
  readonly resumen: ResumenConciliacion;
  readonly lineas: readonly LineaConciliada[];
}

// ---------------------------------------------------------------------------
// Correo transaccional al huésped (Fase 9) -- ver
// migrations/011_rentas_email_outbox.sql, ../reserva-email-notifications.ts,
// ../email-dispatch.ts, ../checkin-reminders.ts.
// ---------------------------------------------------------------------------

/** Todo lo que `enqueueReservaEmailCore` necesita para armar el correo real
 *  (to/subject/html) a partir de solo un `ocupacionId` -- mismo principio que
 *  `domain-citas::CitaCorreo`/`findAppointmentForOrganization`: el caller nunca arma
 *  este objeto a mano. `capa`/`estado` se exponen para que el caller pueda negarse a
 *  encolar un correo sobre una fila que no sea una reserva directa 'confirmado'
 *  (nunca un bloqueo, nunca una `provisional`/`conflicto_pendiente` -- una estancia
 *  que todavía no es real no amerita confirmársela al huésped). */
export interface OcupacionParaCorreo {
  readonly ocupacionId: string;
  readonly propertyId: string;
  readonly organizationId: string;
  readonly capa: "reserva" | "bloqueo";
  readonly estado: EstadoOcupacion;
  readonly rango: RangoFechas;
  /** `rentas.unidad.name` -- nunca `null`: `findOcupacionParaCorreo` cae a un texto
   *  genérico ("tu alojamiento") si la unidad no tiene nombre configurado, nunca deja
   *  el correo sin este dato. */
  readonly unidadNombre: string;
  /** `core.organization.name` del tenant dueño de la property -- mismo rol que
   *  `organization.name` en `domain-citas::CitaCorreo.tenantNombre`. */
  readonly tenantNombre: string;
  readonly huespedNombre: string | null;
  /** `rentas.guest_minimo.contacto` tal cual -- campo libre (puede ser teléfono o
   *  correo, ver migrations/001). `enqueueReservaEmailCore` decide si es un correo
   *  válido; este repositorio nunca filtra ni valida el formato. */
  readonly huespedContacto: string | null;
}

export type MessagingOutboxChannel = "whatsapp" | "email";

/** Fila reclamada por `rentas.claim_email_outbox_batch` -- mismo shape que
 *  `domain-citas::EmailOutboxJobRow`, con `propertyId` de más porque
 *  `rentas.messaging_outbox` particiona por property (igual que
 *  `hoteles.messaging_outbox`), no por organización. */
export interface EmailOutboxJobRow {
  readonly id: string;
  readonly propertyId: string;
  readonly organizationId: string;
  readonly attempts: number;
  readonly payload: Record<string, unknown>;
}

/** Candidata a recordatorio de check-in -- fila mínima que devuelve
 *  `listReservasProximasACheckIn`, suficiente para que el cron resuelva el resto vía
 *  `findOcupacionParaCorreo`, mismo principio de "autosuficiente a partir de un id"
 *  que `domain-citas::ReminderCandidateRow`. */
export interface ReservaProximaCheckIn {
  readonly ocupacionId: string;
  readonly organizationId: string;
}

// ---------------------------------------------------------------------------
// Fase 17 -- panel operativo del rol `limpieza` (tareas/checklist/inventario/
// incidencias, ver apps/api/.../rentas/limpieza.ts): cierra el hallazgo de auditoría
// ALTA "el rol limpieza sigue sin ninguna vista funcional" -- el motor transaccional
// completo (asignarTarea/completarChecklistItem/completarTarea/registrarIncidencia,
// ver ../limpieza/aplicacion/tareas.ts) ya existía desde Fase 8 sin que ningún HTTP
// route lo expusiera (ver el comentario "Fuera de fase" que tenía README.md hasta
// esta fase). Estos son los tipos de LECTURA que necesita ese panel -- las
// escrituras siguen pasando por las funciones de aplicación directo (mismo patrón
// que bloqueos.ts/reservas.ts: la ruta le pasa el `TenantDbSession` DIRECTO, nunca
// envuelto en este repository).
// ---------------------------------------------------------------------------

/** Fila de listado/detalle de `rentas.tarea_operativa`, con el nombre de la unidad ya
 *  resuelto (evita una segunda ronda de queries en la UI -- mismo criterio que
 *  `OcupacionCalendarioItem`). */
export interface TareaOperativaRecord {
  readonly id: string;
  readonly propertyId: string;
  readonly unidadId: string;
  readonly unidadNombre: string;
  readonly tipo: TipoTareaOperativa;
  readonly estado: EstadoTareaOperativa;
  readonly prioridad: PrioridadTareaOperativa;
  readonly asignadoA: string | null;
  readonly esProveedorExterno: boolean;
  readonly programadaPara: string;
  readonly slaVenceEn: string | null;
  readonly completadaEn: string | null;
  readonly creadoEn: string;
}

/** Filtro de `listTareas` -- `asignadoA: null` (literal) pide SOLO tareas sin
 *  asignar, `asignadoA` ausente no filtra por asignación (para un futuro panel de
 *  admin_gestora que vea todo). La vista "mis tareas de hoy" del rol `limpieza`
 *  siempre pasa `asignadoA: <su propio userId>`. */
export interface TareaListFiltro {
  readonly asignadoA?: string | null;
  readonly estados?: readonly EstadoTareaOperativa[];
}

export interface TareaOperativaDetalle extends TareaOperativaRecord {
  readonly checklist: readonly ChecklistItemTarea[];
}

export type ItemInventarioRecord = ItemInventarioUnidad;

export interface IncidenciaMantenimientoRecord {
  readonly id: string;
  readonly propertyId: string;
  readonly unidadId: string;
  readonly tareaOrigenId: string | null;
  readonly severidad: SeveridadIncidencia;
  readonly titulo: string;
  readonly descripcion: string | null;
  readonly estado: EstadoIncidencia;
  readonly propuestaBloqueoRango: RangoFechas | null;
  readonly reportadoPor: string | null;
  readonly creadoEn: string;
}

// ---------------------------------------------------------------------------
// Bitácora de auditoría del staff (r5) -- ver
// migrations/021_rentas_audit_log.sql. `membership` está reservado en el catálogo
// aunque hoy ningún caller real lo usa (rentas todavía no tiene ruta de gestión de
// membership/rol de staff -- ver comentario de cabecera de esa migración).
// ---------------------------------------------------------------------------
export type RentasAuditEntityType = "pricing" | "reserva" | "payout" | "owner_statement" | "membership" | "canal";

export interface RegistrarAuditoriaInput {
  readonly organizationId: string;
  /** Usado SOLO por `InMemoryRentasRepository` (sin `auth.uid()`) para poblar
   *  `actorUserId` en sus fixtures de prueba. `PostgresRentasRepository` lo IGNORA
   *  por completo al armar la llamada SQL -- `rentas.record_audit_log` (security
   *  definer) captura el actor real vía `auth.uid()` dentro de la función, nunca
   *  confía en un parámetro de este lado (ver comentario de cabecera de
   *  postgres-repository.ts y de migrations/021_rentas_audit_log.sql). */
  readonly actorUserId: string;
  readonly action: string;
  readonly entityType: RentasAuditEntityType;
  readonly entityId: string | null;
  readonly campo?: string | null;
  readonly antes?: string | null;
  readonly despues?: string | null;
}

export interface RentasAuditLogRow {
  readonly id: string;
  readonly actorUserId: string;
  readonly action: string;
  readonly entityType: string;
  readonly entityId: string | null;
  readonly campo: string | null;
  readonly antes: string | null;
  readonly despues: string | null;
  readonly createdAtMs: number;
}

export interface RentasAuditLogFiltro {
  readonly entityType?: RentasAuditEntityType | null;
  /** `YYYY-MM-DD`, inclusive. */
  readonly desde?: string | null;
  /** `YYYY-MM-DD`, inclusive. */
  readonly hasta?: string | null;
}

export interface RentasAuditLogPaginacion {
  readonly limit?: number;
  readonly offset?: number;
}

export interface RentasAuditLogPagina {
  /** `false` cuando `rentas.audit_log`/`rentas.record_audit_log` todavía no existen
   *  en esta base (SQLSTATE 42883/42P01/42703, ver postgres-repository.ts) -- la
   *  pantalla debe mostrar "no disponible aún", nunca confundirlo con una bitácora
   *  real pero vacía (`disponible: true, items: []`). */
  readonly disponible: boolean;
  readonly items: readonly RentasAuditLogRow[];
  readonly total: number;
  readonly nextOffset: number | null;
}
