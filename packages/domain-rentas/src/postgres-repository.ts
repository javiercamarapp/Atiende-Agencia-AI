// PostgresRentasRepository — adaptador de producción de `RentasRepository`, sobre el
// `TenantDbSession` genérico de `@atiende/core-tenancy` (mismo contrato que consume
// `core-auth/src/middleware.ts::dbSession`). Ejecuta las queries reales contra el
// esquema `rentas` de migrations/001-003 (RLS real vía `core.has_property_access`/
// funciones propias del schema `rentas`).
import type { TenantDbSession } from "@atiende/core-tenancy";
import { hoyFechaNegocio } from "@atiende/core-tenancy";
import { isMigrationPendingError, runWithSavepointFallback } from "@atiende/db";
import type { OcupacionCalendarioPage, RentasRepository } from "./repository.ts";
import type { LineaOwnerStatement, TotalesOwnerStatement, TipoLineaOwnerStatement } from "./finanzas/statement.ts";
import type { CandidataConciliacion, EstadoConciliacion, LineaConciliada } from "./finanzas/conciliacion.ts";
import type { RangoFechas } from "./tipos.ts";
import type {
  BloqueoRecord,
  CanalRecord,
  ConfiguracionComisionCanal,
  ContextoPricingUnidad,
  DescuentoDuracion,
  DescuentoDuracionRecord,
  EmailOutboxJobRow,
  IncidenciaMantenimientoRecord,
  ItemInventarioRecord,
  MessagingOutboxChannel,
  MovimientoFinancieroReserva,
  NewDescuentoDuracionInput,
  NewGuestMinimoInput,
  NewOwnerStatementInput,
  NewPayoutInput,
  NewReglaCanalPricingInput,
  NewReglaMinStayInput,
  NewReservaFinancieroInput,
  NewTarifaBaseInput,
  NewTemporadaInput,
  OcupacionCalendarioItem,
  OcupacionParaCorreo,
  OcupacionParaMovimiento,
  OcupacionResumen,
  OwnerRecord,
  OwnerStatementDetalle,
  OwnerStatementSummary,
  PayoutDetalle,
  RegistrarAuditoriaInput,
  ReglaCanal,
  ReglaMinStay,
  ReglaMinStayRecord,
  RentasAuditLogFiltro,
  RentasAuditLogPagina,
  RentasAuditLogPaginacion,
  RentasAuditLogRow,
  RentasOrganizationSummary,
  RentasPropertySummary,
  ReservaParaStatement,
  ReservaProximaCheckIn,
  TareaListFiltro,
  TareaOperativaDetalle,
  TareaOperativaRecord,
  TemporadaRecord,
  TemporadaTarifa,
  UltimaVersionOwnerStatement,
  UnidadRecord,
} from "./types.ts";
import type { ChecklistItemTarea, EstadoIncidencia, EstadoTareaOperativa, PrioridadTareaOperativa, SeveridadIncidencia, TipoTareaOperativa } from "./limpieza/tipos.ts";

interface UnidadRow {
  id: string;
  organization_id: string;
  property_id: string;
  duracion_minima_noches: number;
  owner_id: string | null;
}

interface TarifaBaseRow {
  precio_noche_centavos: string;
  moneda: string;
}

interface TarifaTemporadaRow {
  nombre: string;
  fecha_inicio: string;
  fecha_fin: string;
  precio_noche_centavos: string;
}

interface TarifaDescuentoRow {
  noches_minimas: number;
  porcentaje_descuento_basis_points: number;
  fuente: string;
}

interface TarifaMinStayRow {
  fecha_inicio: string;
  fecha_fin: string;
  dia_semana_checkin: number | null;
  noches_minimas: number;
}

interface ReglaCanalRow {
  markup_basis_points: number;
  activo: boolean;
}

interface ReglaComisionCanalRow {
  ya_neto_de_comision: boolean;
  comision_basis_points: number;
  fuente: string;
}

interface ReservaFinancieroRow {
  ocupacion_id: string;
  moneda: string;
  monto_bruto_centavos: string;
  monto_recibido_centavos: string;
  comision_canal_centavos: string;
  comision_canal_fuente: string;
  comision_gestor_centavos: string;
  gastos_centavos: string;
  impuestos_centavos: string;
  neto_centavos: string;
}

function mapReservaFinanciero(row: ReservaFinancieroRow): MovimientoFinancieroReserva {
  return {
    ocupacionUnidadId: row.ocupacion_id,
    moneda: row.moneda,
    ingresoBrutoCentavos: Number(row.monto_bruto_centavos),
    montoRecibidoCentavos: Number(row.monto_recibido_centavos),
    comisionCanalCentavos: Number(row.comision_canal_centavos),
    comisionCanalFuente: row.comision_canal_fuente,
    comisionGestorCentavos: Number(row.comision_gestor_centavos),
    gastosCentavos: Number(row.gastos_centavos),
    impuestosCentavos: Number(row.impuestos_centavos),
    netoCentavos: Number(row.neto_centavos),
  };
}

// ---------------------------------------------------------------------------
// r5 -- bitácora de auditoría del staff (ver migrations/021_rentas_audit_log.sql).
//
// COMPATIBILIDAD CON LA BASE SIN MIGRAR (regla dura de la fase, ver AGENTS.md):
// mergear a main despliega este código al instante, pero la base Supabase real va
// migraciones atrás y nadie las aplica al mergear -- `rentas.record_audit_log`/
// `rentas.audit_log` no existen todavía en ese estado, y Postgres real lanza
// SQLSTATE 42883 (`undefined_function`)/42P01 (`undefined_table`)/42703
// (`undefined_column`) en ese caso.
//
// f3-rentas-bitacora-y-guards -- ENDURECIDO (hallazgo de la revisión de #179,
// "guard 42883 a secas"): la comparación local `code === "42883"` de aquí
// TRATABA CUALQUIER 42883 como "migración pendiente" -- pero Postgres reutiliza
// ese mismo SQLSTATE para "operator does not exist: uuid = text" (un BUG REAL de
// tipos en la consulta, nunca una migración sin aplicar), ver el comentario de
// cabecera de `packages/db/src/sql-errors.ts` para la demostración completa
// contra Postgres real. Un guard que confunda ambos casos ENMASCARA un bug de
// tipos como si fuera "vacío honesto". Se reemplaza por
// `isMigrationPendingError` (@atiende/db) -- la versión endurecida y compartida
// que YA usa `packages/domain-citas/src/postgres-repository.ts` para el mismo
// propósito exacto (bitácora de auditoría de citas) -- con
// `expectedFunctionName = "rentas.record_audit_log"` en el único punto donde el
// error puede venir de una llamada a función (`registrarAuditoria`, abajo); la
// lectura (`listAuditoria`) nunca llama a ninguna función (solo hace `select`
// directo contra la tabla), así que ahí se usa sin nombre esperado -- mismo
// criterio que el propio `isMigrationPendingError` documenta (42P01/42703 no
// tienen la ambigüedad de mensaje que 42883 sí tiene).
// ---------------------------------------------------------------------------
const RENTAS_AUDIT_LOG_SAVEPOINT = "sp_rentas_audit_log_write";
const RENTAS_AUDIT_LOG_READ_SAVEPOINT = "sp_rentas_audit_log_read";
// r6 -- ver migrations/022_rentas_audit_log_orden_determinista.sql. Savepoint
// propio (anidado dentro de RENTAS_AUDIT_LOG_READ_SAVEPOINT) para el caso
// intermedio "021 aplicada, 022 no": `seq` no existe todavía y `order by ...,
// seq desc` lanza 42703 -- se degrada al `order by created_at desc` de antes de
// 022 sin tumbar el resto de la lectura (la tabla/función SÍ existen, no es el
// caso "no disponible" de RENTAS_AUDIT_LOG_READ_SAVEPOINT).
const RENTAS_AUDIT_LOG_READ_ORDER_SAVEPOINT = "sp_rentas_audit_log_read_order";

// r6 -- ver migrations/022_rentas_audit_log_orden_determinista.sql. Específico a
// 42703 (`undefined_column`) -- exactamente el SQLSTATE que `order by ..., seq
// desc` lanza contra una base con 021 aplicada pero 022 no (`seq` no existe
// todavía). Deliberadamente SOLO ese código (mismo criterio que
// `markAppointmentGoogleSyncInvalid` en domain-citas -- un SQLSTATE específico,
// nunca un catch-all): un error real distinto (sintaxis, conexión caída) debe
// seguir propagándose tal cual, `runWithSavepointFallback` nunca lo enmascara.
function esErrorColumnaSeqNoExiste(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === "42703";
}

let auditLogAdvertidoEscritura = false;
function advertirAuditLogEscrituraNoDisponible(err: unknown): void {
  if (auditLogAdvertidoEscritura) return;
  auditLogAdvertidoEscritura = true;
  console.warn(
    "PostgresRentasRepository.registrarAuditoria: rentas.record_audit_log no existe todavía en esta base " +
      "(SQLSTATE 42883/42P01/42703) -- la acción de negocio YA se completó y no se revierte, esta fila de " +
      "bitácora se omitió. Aplica packages/domain-rentas/migrations/021_rentas_audit_log.sql (o su espejo en " +
      "supabase/migrations/) para habilitarla.",
    err,
  );
}

let auditLogAdvertidoLectura = false;
function advertirAuditLogLecturaNoDisponible(err: unknown): void {
  if (auditLogAdvertidoLectura) return;
  auditLogAdvertidoLectura = true;
  console.warn(
    "PostgresRentasRepository.listAuditoria: rentas.audit_log no existe todavía en esta base (SQLSTATE " +
      "42883/42P01/42703) -- devolviendo disponible:false (nunca una lista vacía real, ver RentasAuditLogPagina). " +
      "Aplica packages/domain-rentas/migrations/021_rentas_audit_log.sql (o su espejo en supabase/migrations/).",
    err,
  );
}

let auditLogAdvertidoOrdenSeq = false;
function advertirAuditLogOrdenSeqNoDisponible(err: unknown): void {
  if (auditLogAdvertidoOrdenSeq) return;
  auditLogAdvertidoOrdenSeq = true;
  console.warn(
    "PostgresRentasRepository.listAuditoria: rentas.audit_log.seq no existe todavía en esta base (SQLSTATE " +
      "42703) -- la bitácora SÍ está disponible, pero degradada al orden 'created_at desc' de antes de la " +
      "migración 022 (empates de timestamp dentro de una misma transacción pueden quedar en orden no " +
      "determinista hasta que se aplique). Aplica packages/domain-rentas/migrations/022_rentas_audit_log_orden_" +
      "determinista.sql (o su espejo en supabase/migrations/) para el orden total estable.",
    err,
  );
}

interface RentasAuditLogRowSql {
  id: string;
  actor_user_id: string;
  action: string;
  entity_type: string;
  entity_id: string | null;
  campo: string | null;
  antes: string | null;
  despues: string | null;
  created_at: string;
}

function mapRentasAuditLogRow(row: RentasAuditLogRowSql): RentasAuditLogRow {
  return {
    id: row.id,
    actorUserId: row.actor_user_id,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    campo: row.campo,
    antes: row.antes,
    despues: row.despues,
    createdAtMs: new Date(row.created_at).getTime(),
  };
}

export class PostgresRentasRepository implements RentasRepository {
  constructor(private readonly db: TenantDbSession) {}

  async findUnidad(propertyId: string, unidadId: string): Promise<UnidadRecord | null> {
    const { rows } = await this.db.query<UnidadRow>(`select id, organization_id, property_id, duracion_minima_noches, owner_id from rentas.unidad where id = $1 and property_id = $2;`, [
      unidadId,
      propertyId,
    ]);
    const row = rows[0];
    if (!row) return null;
    return { id: row.id, organizationId: row.organization_id, propertyId: row.property_id, duracionMinimaNoches: row.duracion_minima_noches, ownerId: row.owner_id };
  }

  async findCanalPorCodigo(codigo: string): Promise<CanalRecord | null> {
    const { rows } = await this.db.query<{ id: string; codigo: string }>(`select id, codigo from rentas.canal where codigo = $1;`, [codigo]);
    return rows[0] ?? null;
  }

  async findOcupacion(propertyId: string, unidadId: string, ocupacionId: string): Promise<OcupacionResumen | null> {
    const { rows } = await this.db.query<{ id: string; unidad_id: string; capa: "reserva" | "bloqueo"; estado: OcupacionResumen["estado"]; canal_origen_id: string | null }>(
      `select id, unidad_id, capa, estado, canal_origen_id from rentas.ocupacion where id = $1 and unidad_id = $2 and property_id = $3;`,
      [ocupacionId, unidadId, propertyId],
    );
    const row = rows[0];
    if (!row) return null;
    return { id: row.id, unidadId: row.unidad_id, capa: row.capa, estado: row.estado, canalOrigenId: row.canal_origen_id };
  }

  async listBloqueos(propertyId: string, unidadId: string): Promise<readonly BloqueoRecord[]> {
    const { rows } = await this.db.query<{ id: string; unidad_id: string; inicio: string; fin: string; razon: BloqueoRecord["razon"]; estado: BloqueoRecord["estado"] }>(
      `select id, unidad_id, lower(rango)::text as inicio, upper(rango)::text as fin, razon, estado
       from rentas.ocupacion
       where property_id = $1 and unidad_id = $2 and capa = 'bloqueo'
       order by lower(rango);`,
      [propertyId, unidadId],
    );
    return rows.map((row) => ({ id: row.id, unidadId: row.unidad_id, rango: { inicio: row.inicio, fin: row.fin }, razon: row.razon, estado: row.estado }));
  }

  /** Fase 13 -- selector de unidad del calendario visual del panel de staff. */
  async listUnidades(propertyId: string): Promise<readonly UnidadRecord[]> {
    // `rentas.unidad.name` es `not null` en el esquema (migrations/001) -- nunca
    // `null` en una fila real, a diferencia de `owner_id`.
    const { rows } = await this.db.query<UnidadRow & { name: string }>(
      `select id, organization_id, property_id, duracion_minima_noches, owner_id, name from rentas.unidad where property_id = $1 order by name;`,
      [propertyId],
    );
    return rows.map((row) => ({
      id: row.id,
      organizationId: row.organization_id,
      propertyId: row.property_id,
      duracionMinimaNoches: row.duracion_minima_noches,
      ownerId: row.owner_id,
      name: row.name,
    }));
  }

  /** Fase 13 -- `GET .../ocupaciones`: TODA ocupación de la unidad (capa='reserva' Y
   *  capa='bloqueo', activa Y cancelada), ordenadas por fecha de inicio -- el listado
   *  unificado que le faltaba al calendario visual (a diferencia de `listBloqueos`
   *  arriba, acotado a `capa='bloqueo'`). */
  async listOcupaciones(propertyId: string, unidadId: string): Promise<readonly OcupacionCalendarioItem[]> {
    const { rows } = await this.db.query<{
      id: string;
      unidad_id: string;
      inicio: string;
      fin: string;
      capa: "reserva" | "bloqueo";
      razon: OcupacionCalendarioItem["razon"];
      estado: OcupacionCalendarioItem["estado"];
      canal_codigo: string | null;
      huesped_nombre: string | null;
      huesped_contacto: string | null;
      created_at: string;
    }>(
      `select o.id, o.unidad_id, lower(o.rango)::text as inicio, upper(o.rango)::text as fin, o.capa, o.razon, o.estado,
              c.codigo as canal_codigo, g.nombre as huesped_nombre, g.contacto as huesped_contacto, o.created_at::text as created_at
       from rentas.ocupacion o
       left join rentas.canal c on c.id = o.canal_origen_id
       left join rentas.guest_minimo g on g.id = o.huesped_minimo_id
       where o.property_id = $1 and o.unidad_id = $2
       order by lower(o.rango);`,
      [propertyId, unidadId],
    );
    return rows.map((row) => ({
      id: row.id,
      unidadId: row.unidad_id,
      capa: row.capa,
      rango: { inicio: row.inicio, fin: row.fin },
      razon: row.razon,
      estado: row.estado,
      canalCodigo: row.canal_codigo,
      huespedNombre: row.huesped_nombre,
      huespedContacto: row.huesped_contacto,
      createdAt: row.created_at,
    }));
  }

  async listOcupacionesPage(propertyId: string, unidadId: string, opts: { readonly limit: number; readonly offset: number }): Promise<OcupacionCalendarioPage> {
    const { rows } = await this.db.query<{
      id: string;
      unidad_id: string;
      inicio: string;
      fin: string;
      capa: "reserva" | "bloqueo";
      razon: OcupacionCalendarioItem["razon"];
      estado: OcupacionCalendarioItem["estado"];
      canal_codigo: string | null;
      huesped_nombre: string | null;
      huesped_contacto: string | null;
      created_at: string;
      total: string;
    }>(
      `select o.id, o.unidad_id, lower(o.rango)::text as inicio, upper(o.rango)::text as fin, o.capa, o.razon, o.estado,
              c.codigo as canal_codigo, g.nombre as huesped_nombre, g.contacto as huesped_contacto, o.created_at::text as created_at,
              count(*) over ()::text as total
       from rentas.ocupacion o
       left join rentas.canal c on c.id = o.canal_origen_id
       left join rentas.guest_minimo g on g.id = o.huesped_minimo_id
       where o.property_id = $1 and o.unidad_id = $2
       order by lower(o.rango)
       limit $3 offset $4;`,
      [propertyId, unidadId, opts.limit, opts.offset],
    );
    const items = rows.map((row) => ({
      id: row.id,
      unidadId: row.unidad_id,
      capa: row.capa,
      rango: { inicio: row.inicio, fin: row.fin },
      razon: row.razon,
      estado: row.estado,
      canalCodigo: row.canal_codigo,
      huespedNombre: row.huesped_nombre,
      huespedContacto: row.huesped_contacto,
      createdAt: row.created_at,
    }));
    const total = rows[0] ? Number(rows[0].total) : 0;
    const nextOffset = opts.offset + items.length < total ? opts.offset + items.length : null;
    return { items, total, nextOffset };
  }

  async insertGuestMinimo(input: NewGuestMinimoInput): Promise<{ id: string }> {
    const { rows } = await this.db.query<{ id: string }>(`insert into rentas.guest_minimo (organization_id, property_id, nombre, contacto) values ($1, $2, $3, $4) returning id;`, [
      input.organizationId,
      input.propertyId,
      input.nombre,
      input.contacto,
    ]);
    return { id: rows[0]!.id };
  }

  async attachGuestToOcupacion(ocupacionId: string, guestMinimoId: string): Promise<void> {
    await this.db.query(`update rentas.ocupacion set huesped_minimo_id = $2, updated_at = now() where id = $1;`, [ocupacionId, guestMinimoId]);
  }

  async loadPricingContext(propertyId: string, unidadId: string): Promise<ContextoPricingUnidad | null> {
    const unidad = await this.db.query<{ id: string }>(`select id from rentas.unidad where id = $1 and property_id = $2;`, [unidadId, propertyId]);
    if (unidad.rows.length === 0) return null;

    // Bug real (mismo hallazgo que `apps/api/.../rentas/pricing-config.ts::hoyIso`,
    // ver su comentario de cabecera): `current_date` corre en la sesión de Postgres,
    // que en Vercel es UTC -- entre las 18:00 y las 23:59 CDMX el día UTC ya es
    // MAÑANA, así que una tarifa nueva con `vigenteDesde` = mañana (CDMX) aparecía
    // vigente HOY un día antes de tiempo, y una tarifa que dejó de aplicar hoy (CDMX)
    // seguía compitiendo un día de más. Resuelto UNA vez en TS con
    // `@atiende/core-tenancy::hoyFechaNegocio()` y pasado como parámetro -- el SQL ya
    // no llama `current_date`. `RentasRepository` no expone hoy ninguna zona horaria
    // real por property (ver el mismo gap ya documentado en pricing-config.ts, r6
    // punto 6) -- usa el default de plataforma (`America/Mexico_City`).
    const hoy = hoyFechaNegocio();
    const base = await this.db.query<TarifaBaseRow>(
      `select precio_noche_centavos, moneda from rentas.tarifa_base
       where unidad_id = $1 and vigente_desde <= $2::date
       order by vigente_desde desc limit 1;`,
      [unidadId, hoy],
    );
    if (base.rows.length === 0) return null;

    const [temporadas, descuentos, minStay] = await Promise.all([
      this.db.query<TarifaTemporadaRow>(`select nombre, fecha_inicio::text as fecha_inicio, fecha_fin::text as fecha_fin, precio_noche_centavos from rentas.tarifa_temporada where unidad_id = $1;`, [
        unidadId,
      ]),
      this.db.query<TarifaDescuentoRow>(`select noches_minimas, porcentaje_descuento_basis_points, fuente from rentas.tarifa_descuento_duracion where unidad_id = $1;`, [unidadId]),
      this.db.query<TarifaMinStayRow>(
        `select fecha_inicio::text as fecha_inicio, fecha_fin::text as fecha_fin, dia_semana_checkin, noches_minimas from rentas.tarifa_min_stay where unidad_id = $1;`,
        [unidadId],
      ),
    ]);

    const temporadasMapeadas: TemporadaTarifa[] = temporadas.rows.map((t) => ({
      nombre: t.nombre,
      rango: { inicio: t.fecha_inicio, fin: t.fecha_fin },
      precioNocheCentavos: Number(t.precio_noche_centavos),
    }));
    const descuentosMapeados: DescuentoDuracion[] = descuentos.rows.map((d) => ({
      nochesMinimas: d.noches_minimas,
      porcentajeDescuentoBasisPoints: d.porcentaje_descuento_basis_points,
      fuente: d.fuente,
    }));
    const minStayMapeadas: ReglaMinStay[] = minStay.rows.map((m) => ({
      rango: { inicio: m.fecha_inicio, fin: m.fecha_fin },
      diaSemanaCheckIn: m.dia_semana_checkin,
      nochesMinimas: m.noches_minimas,
    }));

    return {
      unidadId,
      moneda: base.rows[0]!.moneda,
      precioBaseNocheCentavos: Number(base.rows[0]!.precio_noche_centavos),
      temporadas: temporadasMapeadas,
      descuentosDuracion: descuentosMapeados,
      reglasMinStay: minStayMapeadas,
    };
  }

  async loadReglaCanalPricing(unidadId: string, canalCodigo: string): Promise<ReglaCanal | null> {
    const { rows } = await this.db.query<ReglaCanalRow>(
      `select trc.markup_basis_points, trc.activo
       from rentas.tarifa_regla_canal trc
       join rentas.canal c on c.id = trc.canal_id
       where trc.unidad_id = $1 and c.codigo = $2;`,
      [unidadId, canalCodigo],
    );
    const row = rows[0];
    if (!row) return null;
    return { canalCodigo, markupBasisPoints: row.markup_basis_points, activo: row.activo };
  }

  async findOcupacionParaMovimiento(propertyId: string, ocupacionId: string): Promise<OcupacionParaMovimiento | null> {
    const { rows } = await this.db.query<{ id: string; capa: "reserva" | "bloqueo"; canal_origen_id: string | null }>(
      `select id, capa, canal_origen_id from rentas.ocupacion where id = $1 and property_id = $2;`,
      [ocupacionId, propertyId],
    );
    const row = rows[0];
    if (!row) return null;
    return { id: row.id, capa: row.capa, canalId: row.canal_origen_id };
  }

  async findReglaComisionCanal(propertyId: string, canalId: string | null): Promise<ConfiguracionComisionCanal> {
    // Mismo orden de búsqueda que `buscarReglaComisionCanal` del origen: primero una
    // regla específica de esta property, luego la regla global del tenant
    // (property_id IS NULL) — `nulls last` prioriza la fila específica cuando ambas
    // existen.
    const { rows } = await this.db.query<ReglaComisionCanalRow>(
      `select ya_neto_de_comision, comision_basis_points, fuente
       from rentas.regla_comision_canal
       where canal_id is not distinct from $2
         and organization_id = (select organization_id from core.property where id = $1)
         and (property_id = $1 or property_id is null)
       order by property_id nulls last, vigente_desde desc
       limit 1;`,
      [propertyId, canalId],
    );
    const row = rows[0];
    if (!row) {
      throw new Error(`No hay rentas.regla_comision_canal configurada para canalId="${canalId}" (ni específica de la property ni global del tenant).`);
    }
    return { yaNetoDeComision: row.ya_neto_de_comision, comisionBasisPoints: row.comision_basis_points, fuente: row.fuente };
  }

  async insertReservaFinanciero(input: NewReservaFinancieroInput): Promise<{ id: string; createdAt: string }> {
    const { rows } = await this.db.query<{ id: string; created_at: string }>(
      `insert into rentas.reserva_financiero
         (organization_id, property_id, ocupacion_id, moneda, monto_bruto_centavos, ya_neto_de_comision,
          comision_canal_basis_points, comision_canal_fuente, comision_canal_centavos,
          comision_gestor_basis_points, comision_gestor_base, comision_gestor_centavos,
          monto_recibido_centavos, gastos_centavos, impuestos_centavos, neto_centavos, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
       returning id, created_at::text as created_at;`,
      [
        input.organizationId,
        input.propertyId,
        input.ocupacionId,
        input.moneda,
        input.montoBrutoCentavos,
        input.yaNetoDeComision,
        input.comisionCanalBasisPoints,
        input.comisionCanalFuente,
        input.comisionCanalCentavos,
        input.comisionGestorBasisPoints,
        input.comisionGestorBase,
        input.comisionGestorCentavos,
        input.montoRecibidoCentavos,
        input.gastosCentavos,
        input.impuestosCentavos,
        input.netoCentavos,
        input.createdBy,
      ],
    );
    const reservaFinancieroId = rows[0]!.id;

    for (const gasto of input.gastos) {
      await this.db.query(`insert into rentas.linea_gasto (reserva_financiero_id, tipo, descripcion, monto_centavos, creado_por) values ($1, $2, $3, $4, $5);`, [
        reservaFinancieroId,
        gasto.tipo,
        gasto.descripcion ?? null,
        gasto.montoCentavos,
        input.createdBy,
      ]);
    }
    // `revision_fiscal` nunca se pasa como parámetro: el DEFAULT true del esquema
    // (con CHECK (revision_fiscal = true)) es la única fuente — Atiende nunca calcula
    // un impuesto definitivo, ni siquiera por accidente de un valor pasado por error.
    for (const impuesto of input.impuestos) {
      await this.db.query(`insert into rentas.linea_impuesto (reserva_financiero_id, tipo, monto_centavos, creado_por) values ($1, $2, $3, $4);`, [
        reservaFinancieroId,
        impuesto.tipo,
        impuesto.montoCentavos,
        input.createdBy,
      ]);
    }

    return { id: reservaFinancieroId, createdAt: rows[0]!.created_at };
  }

  async findReservaFinanciero(propertyId: string, ocupacionId: string): Promise<MovimientoFinancieroReserva | null> {
    const { rows } = await this.db.query<ReservaFinancieroRow>(
      `select ocupacion_id, moneda, monto_bruto_centavos, monto_recibido_centavos, comision_canal_centavos, comision_canal_fuente,
              comision_gestor_centavos, gastos_centavos, impuestos_centavos, neto_centavos
       from rentas.reserva_financiero where ocupacion_id = $1 and property_id = $2;`,
      [ocupacionId, propertyId],
    );
    const row = rows[0];
    return row ? mapReservaFinanciero(row) : null;
  }

  // ---- Pricing CRUD (flujo 4, Fase 2) ----

  async findMonedaExistentePricing(unidadId: string, excluirVigenteDesde?: string): Promise<string | null> {
    const base = await this.db.query<{ moneda: string }>(`select moneda from rentas.tarifa_base where unidad_id = $1 and ($2::date is null or vigente_desde <> $2::date) limit 1;`, [
      unidadId,
      excluirVigenteDesde ?? null,
    ]);
    if (base.rows[0]) return base.rows[0].moneda;
    const temporada = await this.db.query<{ moneda: string }>(`select moneda from rentas.tarifa_temporada where unidad_id = $1 limit 1;`, [unidadId]);
    return temporada.rows[0]?.moneda ?? null;
  }

  async upsertTarifaBase(input: NewTarifaBaseInput): Promise<{ id: string }> {
    const { rows } = await this.db.query<{ id: string }>(
      `insert into rentas.tarifa_base (organization_id, property_id, unidad_id, precio_noche_centavos, moneda, vigente_desde, creado_por)
       values ($1,$2,$3,$4,$5,$6,$7)
       on conflict (unidad_id, vigente_desde) do update set precio_noche_centavos = excluded.precio_noche_centavos, moneda = excluded.moneda
       returning id;`,
      [input.organizationId, input.propertyId, input.unidadId, input.precioNocheCentavos, input.moneda, input.vigenteDesde, input.createdBy],
    );
    return { id: rows[0]!.id };
  }

  async listTemporadas(unidadId: string): Promise<TemporadaRecord[]> {
    const { rows } = await this.db.query<{ id: string; nombre: string; fecha_inicio: string; fecha_fin: string; precio_noche_centavos: string }>(
      `select id, nombre, fecha_inicio::text as fecha_inicio, fecha_fin::text as fecha_fin, precio_noche_centavos from rentas.tarifa_temporada where unidad_id = $1 order by fecha_inicio;`,
      [unidadId],
    );
    return rows.map((r) => ({ id: r.id, nombre: r.nombre, rango: { inicio: r.fecha_inicio, fin: r.fecha_fin }, precioNocheCentavos: Number(r.precio_noche_centavos) }));
  }

  async insertTemporada(input: NewTemporadaInput): Promise<{ id: string }> {
    const { rows } = await this.db.query<{ id: string }>(
      `insert into rentas.tarifa_temporada (organization_id, property_id, unidad_id, nombre, fecha_inicio, fecha_fin, precio_noche_centavos, moneda, creado_por)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id;`,
      [input.organizationId, input.propertyId, input.unidadId, input.nombre, input.rango.inicio, input.rango.fin, input.precioNocheCentavos, input.moneda, input.createdBy],
    );
    return { id: rows[0]!.id };
  }

  async listDescuentosDuracion(unidadId: string): Promise<DescuentoDuracionRecord[]> {
    const { rows } = await this.db.query<{ id: string; noches_minimas: number; porcentaje_descuento_basis_points: number; fuente: string }>(
      `select id, noches_minimas, porcentaje_descuento_basis_points, fuente from rentas.tarifa_descuento_duracion where unidad_id = $1 order by noches_minimas;`,
      [unidadId],
    );
    return rows.map((r) => ({ id: r.id, nochesMinimas: r.noches_minimas, porcentajeDescuentoBasisPoints: r.porcentaje_descuento_basis_points, fuente: r.fuente }));
  }

  async upsertDescuentoDuracion(input: NewDescuentoDuracionInput): Promise<{ id: string }> {
    const { rows } = await this.db.query<{ id: string }>(
      `insert into rentas.tarifa_descuento_duracion (organization_id, property_id, unidad_id, noches_minimas, porcentaje_descuento_basis_points, fuente)
       values ($1,$2,$3,$4,$5,$6)
       on conflict (unidad_id, noches_minimas) do update set porcentaje_descuento_basis_points = excluded.porcentaje_descuento_basis_points, fuente = excluded.fuente
       returning id;`,
      [input.organizationId, input.propertyId, input.unidadId, input.nochesMinimas, input.porcentajeDescuentoBasisPoints, input.fuente],
    );
    return { id: rows[0]!.id };
  }

  async listReglasMinStay(unidadId: string): Promise<ReglaMinStayRecord[]> {
    const { rows } = await this.db.query<{ id: string; fecha_inicio: string; fecha_fin: string; dia_semana_checkin: number | null; noches_minimas: number }>(
      `select id, fecha_inicio::text as fecha_inicio, fecha_fin::text as fecha_fin, dia_semana_checkin, noches_minimas from rentas.tarifa_min_stay where unidad_id = $1 order by fecha_inicio;`,
      [unidadId],
    );
    return rows.map((r) => ({ id: r.id, rango: { inicio: r.fecha_inicio, fin: r.fecha_fin }, diaSemanaCheckIn: r.dia_semana_checkin, nochesMinimas: r.noches_minimas }));
  }

  async insertReglaMinStay(input: NewReglaMinStayInput): Promise<{ id: string }> {
    const { rows } = await this.db.query<{ id: string }>(
      `insert into rentas.tarifa_min_stay (organization_id, property_id, unidad_id, fecha_inicio, fecha_fin, dia_semana_checkin, noches_minimas)
       values ($1,$2,$3,$4,$5,$6,$7) returning id;`,
      [input.organizationId, input.propertyId, input.unidadId, input.rango.inicio, input.rango.fin, input.diaSemanaCheckIn, input.nochesMinimas],
    );
    return { id: rows[0]!.id };
  }

  async upsertReglaCanalPricing(input: NewReglaCanalPricingInput): Promise<{ id: string }> {
    const { rows } = await this.db.query<{ id: string }>(
      `insert into rentas.tarifa_regla_canal (organization_id, property_id, unidad_id, canal_id, markup_basis_points, activo)
       values ($1,$2,$3,$4,$5,$6)
       on conflict (unidad_id, canal_id) do update set markup_basis_points = excluded.markup_basis_points, activo = excluded.activo
       returning id;`,
      [input.organizationId, input.propertyId, input.unidadId, input.canalId, input.markupBasisPoints, input.activo],
    );
    return { id: rows[0]!.id };
  }

  // ---- Owner statement (flujo 5, Fase 2) ----

  async findOwnerConUnidadesEnProperty(propertyId: string, ownerId: string): Promise<OwnerRecord | null> {
    const { rows } = await this.db.query<{ id: string; name: string }>(
      `select o.id, o.name from rentas.owner o
       where o.id = $2 and exists (select 1 from rentas.unidad u where u.property_id = $1 and u.owner_id = o.id)
       limit 1;`,
      [propertyId, ownerId],
    );
    return rows[0] ?? null;
  }

  async findMovimientosPeriodoParaOwner(propertyId: string, ownerId: string, periodo: RangoFechas): Promise<ReservaParaStatement[]> {
    const { rows } = await this.db.query<{
      ocupacion_id: string;
      moneda: string;
      monto_bruto_centavos: string;
      comision_canal_centavos: string;
      comision_gestor_centavos: string;
      gastos_centavos: string;
      impuestos_centavos: string;
      neto_centavos: string;
    }>(
      `select rf.ocupacion_id, rf.moneda, rf.monto_bruto_centavos, rf.comision_canal_centavos, rf.comision_gestor_centavos, rf.gastos_centavos, rf.impuestos_centavos, rf.neto_centavos
       from rentas.reserva_financiero rf
       join rentas.ocupacion o on o.id = rf.ocupacion_id
       join rentas.unidad u on u.id = o.unidad_id
       where o.property_id = $1 and u.owner_id = $2 and o.estado <> 'cancelado'
         and upper(o.rango) >= $3::date and upper(o.rango) < $4::date;`,
      [propertyId, ownerId, periodo.inicio, periodo.fin],
    );
    return rows.map((r) => ({
      ocupacionId: r.ocupacion_id,
      moneda: r.moneda,
      ingresoBrutoCentavos: Number(r.monto_bruto_centavos),
      comisionCanalCentavos: Number(r.comision_canal_centavos),
      comisionGestorCentavos: Number(r.comision_gestor_centavos),
      gastosCentavos: Number(r.gastos_centavos),
      impuestosCentavos: Number(r.impuestos_centavos),
      netoCentavos: Number(r.neto_centavos),
    }));
  }

  async findUltimaVersionOwnerStatement(propertyId: string, ownerId: string, periodo: RangoFechas): Promise<UltimaVersionOwnerStatement | null> {
    const { rows } = await this.db.query<{ id: string; version: number; hash_contenido: string }>(
      `select id, version, hash_contenido from rentas.owner_statement
       where owner_id = $1 and property_id = $2 and periodo_inicio = $3::date and periodo_fin = $4::date
       order by version desc limit 1;`,
      [ownerId, propertyId, periodo.inicio, periodo.fin],
    );
    const row = rows[0];
    return row ? { id: row.id, version: row.version, hashContenido: row.hash_contenido } : null;
  }

  async insertOwnerStatement(input: NewOwnerStatementInput): Promise<{ id: string; generadoEn: string }> {
    const { rows } = await this.db.query<{ id: string; generado_en: string }>(
      `insert into rentas.owner_statement
         (organization_id, owner_id, property_id, periodo_inicio, periodo_fin, version, moneda,
          ingresos_brutos_centavos, comision_canal_centavos, comision_gestor_centavos, gastos_centavos, impuestos_centavos, neto_centavos,
          hash_contenido, motivo_version, generado_por)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       returning id, generado_en::text as generado_en;`,
      [
        input.organizationId,
        input.ownerId,
        input.propertyId,
        input.periodo.inicio,
        input.periodo.fin,
        input.version,
        input.moneda,
        input.totales.ingresosBrutosCentavos,
        input.totales.comisionCanalCentavos,
        input.totales.comisionGestorCentavos,
        input.totales.gastosCentavos,
        input.totales.impuestosCentavos,
        input.totales.netoCentavos,
        input.hashContenido,
        input.motivoVersion,
        input.generadoPor,
      ],
    );
    const statementId = rows[0]!.id;

    for (const linea of input.lineas) {
      await this.db.query(`insert into rentas.owner_statement_linea (statement_id, ocupacion_id, tipo, descripcion, monto_centavos, moneda) values ($1,$2,$3,$4,$5,$6);`, [
        statementId,
        linea.ocupacionId,
        linea.tipo,
        linea.descripcion,
        linea.montoCentavos,
        input.moneda,
      ]);
    }

    return { id: statementId, generadoEn: rows[0]!.generado_en };
  }

  async listOwnerStatements(propertyId: string, ownerId: string): Promise<OwnerStatementSummary[]> {
    const { rows } = await this.db.query<{
      id: string;
      owner_id: string;
      property_id: string;
      periodo_inicio: string;
      periodo_fin: string;
      version: number;
      moneda: string;
      neto_centavos: string;
      generado_en: string;
    }>(
      `select distinct on (periodo_inicio, periodo_fin) id, owner_id, property_id, periodo_inicio::text as periodo_inicio, periodo_fin::text as periodo_fin,
              version, moneda, neto_centavos, generado_en::text as generado_en
       from rentas.owner_statement
       where property_id = $1 and owner_id = $2
       order by periodo_inicio desc, periodo_fin desc, version desc;`,
      [propertyId, ownerId],
    );
    return rows.map((r) => ({
      id: r.id,
      ownerId: r.owner_id,
      propertyId: r.property_id,
      periodo: { inicio: r.periodo_inicio, fin: r.periodo_fin },
      version: r.version,
      moneda: r.moneda,
      netoCentavos: Number(r.neto_centavos),
      generadoEn: r.generado_en,
    }));
  }

  async findOwnerStatementDetalle(propertyId: string, statementId: string): Promise<OwnerStatementDetalle | null> {
    const { rows } = await this.db.query<{
      id: string;
      owner_id: string;
      property_id: string;
      periodo_inicio: string;
      periodo_fin: string;
      version: number;
      moneda: string;
      ingresos_brutos_centavos: string;
      comision_canal_centavos: string;
      comision_gestor_centavos: string;
      gastos_centavos: string;
      impuestos_centavos: string;
      neto_centavos: string;
      motivo_version: string | null;
      generado_en: string;
    }>(
      `select id, owner_id, property_id, periodo_inicio::text as periodo_inicio, periodo_fin::text as periodo_fin, version, moneda,
              ingresos_brutos_centavos, comision_canal_centavos, comision_gestor_centavos, gastos_centavos, impuestos_centavos, neto_centavos,
              motivo_version, generado_en::text as generado_en
       from rentas.owner_statement where id = $1 and property_id = $2;`,
      [statementId, propertyId],
    );
    const s = rows[0];
    if (!s) return null;

    const lineasResult = await this.db.query<{ ocupacion_id: string | null; tipo: TipoLineaOwnerStatement; descripcion: string; monto_centavos: string }>(
      `select ocupacion_id, tipo, descripcion, monto_centavos from rentas.owner_statement_linea where statement_id = $1 order by tipo, ocupacion_id;`,
      [statementId],
    );

    const totales: TotalesOwnerStatement = {
      ingresosBrutosCentavos: Number(s.ingresos_brutos_centavos),
      comisionCanalCentavos: Number(s.comision_canal_centavos),
      comisionGestorCentavos: Number(s.comision_gestor_centavos),
      gastosCentavos: Number(s.gastos_centavos),
      impuestosCentavos: Number(s.impuestos_centavos),
      netoCentavos: Number(s.neto_centavos),
    };
    const lineas: LineaOwnerStatement[] = lineasResult.rows.map((l) => ({ ocupacionId: l.ocupacion_id ?? "", tipo: l.tipo, descripcion: l.descripcion, montoCentavos: Number(l.monto_centavos) }));

    return {
      id: s.id,
      ownerId: s.owner_id,
      propertyId: s.property_id,
      periodo: { inicio: s.periodo_inicio, fin: s.periodo_fin },
      version: s.version,
      moneda: s.moneda,
      netoCentavos: totales.netoCentavos,
      generadoEn: s.generado_en,
      totales,
      lineas,
      motivoVersion: s.motivo_version,
    };
  }

  // ---- Payout / conciliación (flujo 6, Fase 2, alcance recortado) ----

  async findCandidatasConciliacion(propertyId: string, canalId: string): Promise<CandidataConciliacion[]> {
    const { rows } = await this.db.query<{ ocupacion_id: string; external_id: string | null; monto_esperado_centavos: string }>(
      `select o.id as ocupacion_id, o.external_id, rf.monto_recibido_centavos as monto_esperado_centavos
       from rentas.ocupacion o
       join rentas.reserva_financiero rf on rf.ocupacion_id = o.id
       where o.property_id = $1 and o.canal_origen_id = $2;`,
      [propertyId, canalId],
    );
    return rows.map((r) => ({ ocupacionId: r.ocupacion_id, externalId: r.external_id, montoEsperadoCentavos: Number(r.monto_esperado_centavos) }));
  }

  async insertPayout(input: NewPayoutInput): Promise<{ id: string; creadoEn: string }> {
    const { rows } = await this.db.query<{ id: string; creado_en: string }>(
      `insert into rentas.payout_canal (organization_id, property_id, canal_id, referencia_externa, moneda, monto_total_centavos, fecha_payout, creado_por)
       values ($1,$2,$3,$4,$5,$6,$7,$8) returning id, creado_en::text as creado_en;`,
      [input.organizationId, input.propertyId, input.canalId, input.referenciaExterna, input.moneda, input.montoTotalCentavos, input.fechaPayout, input.createdBy],
    );
    const payoutId = rows[0]!.id;

    for (const linea of input.lineas) {
      await this.db.query(
        `insert into rentas.payout_linea (payout_id, ocupacion_id, referencia_externa_reserva, monto_centavos, monto_esperado_centavos, estado_conciliacion) values ($1,$2,$3,$4,$5,$6);`,
        [payoutId, linea.ocupacionId, linea.referenciaExternaReserva, linea.montoCentavos, linea.montoEsperadoCentavos, linea.estado],
      );
    }

    return { id: payoutId, creadoEn: rows[0]!.creado_en };
  }

  async findPayoutDetalle(propertyId: string, payoutId: string): Promise<PayoutDetalle | null> {
    const { rows } = await this.db.query<{
      id: string;
      property_id: string;
      canal_codigo: string;
      moneda: string;
      monto_total_centavos: string;
      fecha_payout: string;
      referencia_externa: string | null;
    }>(
      `select pc.id, pc.property_id, c.codigo as canal_codigo, pc.moneda, pc.monto_total_centavos, pc.fecha_payout::text as fecha_payout, pc.referencia_externa
       from rentas.payout_canal pc join rentas.canal c on c.id = pc.canal_id
       where pc.id = $1 and pc.property_id = $2;`,
      [payoutId, propertyId],
    );
    const p = rows[0];
    if (!p) return null;

    const lineasResult = await this.db.query<{ ocupacion_id: string | null; referencia_externa_reserva: string | null; monto_centavos: string; monto_esperado_centavos: string | null; estado_conciliacion: EstadoConciliacion }>(
      `select ocupacion_id, referencia_externa_reserva, monto_centavos, monto_esperado_centavos, estado_conciliacion from rentas.payout_linea where payout_id = $1;`,
      [payoutId],
    );
    const lineas: LineaConciliada[] = lineasResult.rows.map((l) => ({
      ocupacionId: l.ocupacion_id,
      referenciaExternaReserva: l.referencia_externa_reserva,
      montoCentavos: Number(l.monto_centavos),
      montoEsperadoCentavos: l.monto_esperado_centavos === null ? null : Number(l.monto_esperado_centavos),
      estado: l.estado_conciliacion,
    }));

    return {
      id: p.id,
      propertyId: p.property_id,
      canalCodigo: p.canal_codigo,
      moneda: p.moneda,
      montoTotalCentavos: Number(p.monto_total_centavos),
      fechaPayout: p.fecha_payout,
      referenciaExterna: p.referencia_externa,
      resumen: {
        conciliadas: lineas.filter((l) => l.estado === "conciliado").length,
        pendientes: lineas.filter((l) => l.estado === "pendiente").length,
        discrepancias: lineas.filter((l) => l.estado === "discrepancia").length,
      },
      lineas,
    };
  }

  // ---------------------------------------------------------------------------
  // Correo transaccional al huésped (Fase 9) -- ver
  // migrations/011_rentas_email_outbox.sql.
  // ---------------------------------------------------------------------------

  async findOcupacionParaCorreo(organizationId: string, ocupacionId: string): Promise<OcupacionParaCorreo | null> {
    const { rows } = await this.db.query<{
      ocupacion_id: string;
      property_id: string;
      organization_id: string;
      capa: "reserva" | "bloqueo";
      estado: OcupacionParaCorreo["estado"];
      inicio: string;
      fin: string;
      unidad_nombre: string;
      tenant_nombre: string;
      huesped_nombre: string | null;
      huesped_contacto: string | null;
    }>(
      `select o.id as ocupacion_id, o.property_id, o.organization_id, o.capa, o.estado,
              lower(o.rango)::text as inicio, upper(o.rango)::text as fin,
              coalesce(u.name, 'tu alojamiento') as unidad_nombre,
              org.name as tenant_nombre,
              g.nombre as huesped_nombre, g.contacto as huesped_contacto
       from rentas.ocupacion o
       join rentas.unidad u on u.id = o.unidad_id
       join core.organization org on org.id = o.organization_id
       left join rentas.guest_minimo g on g.id = o.huesped_minimo_id
       where o.id = $2 and o.organization_id = $1;`,
      [organizationId, ocupacionId],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      ocupacionId: row.ocupacion_id,
      propertyId: row.property_id,
      organizationId: row.organization_id,
      capa: row.capa,
      estado: row.estado,
      rango: { inicio: row.inicio, fin: row.fin },
      unidadNombre: row.unidad_nombre,
      tenantNombre: row.tenant_nombre,
      huespedNombre: row.huesped_nombre,
      huespedContacto: row.huesped_contacto,
    };
  }

  async listReservasProximasACheckIn(desdeFecha: string, hastaFecha: string): Promise<readonly ReservaProximaCheckIn[]> {
    const { rows } = await this.db.query<{ id: string; organization_id: string }>(
      `select id, organization_id from rentas.ocupacion
       where capa = 'reserva' and estado = 'confirmado'
         and recordatorio_checkin_enviado_en is null
         and lower(rango) >= $1 and lower(rango) <= $2
       order by lower(rango) asc;`,
      [desdeFecha, hastaFecha],
    );
    return rows.map((r) => ({ ocupacionId: r.id, organizationId: r.organization_id }));
  }

  async marcarRecordatorioCheckInEnviado(ocupacionId: string, enviadoEnIso: string): Promise<void> {
    await this.db.query(`update rentas.ocupacion set recordatorio_checkin_enviado_en = $2 where id = $1;`, [ocupacionId, enviadoEnIso]);
  }

  async enqueueMessagingOutbox(propertyId: string, organizationId: string, channel: MessagingOutboxChannel, eventType: string, dedupeKey: string, payload: unknown): Promise<void> {
    await this.db.query(`select rentas.enqueue_messaging_outbox($1, $2, $3, $4, $5, $6::jsonb);`, [propertyId, organizationId, channel, eventType, dedupeKey, JSON.stringify(payload)]);
  }

  async claimEmailOutboxBatch(limit: number): Promise<readonly EmailOutboxJobRow[]> {
    const { rows } = await this.db.query<{ id: string; property_id: string; organization_id: string; attempts: number; payload: Record<string, unknown> }>(
      `select id, property_id, organization_id, attempts, payload from rentas.claim_email_outbox_batch($1);`,
      [limit],
    );
    return rows.map((r) => ({ id: r.id, propertyId: r.property_id, organizationId: r.organization_id, attempts: r.attempts, payload: r.payload ?? {} }));
  }

  async completeEmailOutboxJob(id: string, status: "sent" | "failed" | "dead", error: string | null): Promise<void> {
    await this.db.query(`select rentas.complete_email_outbox_job($1, $2, $3);`, [id, status, error]);
  }

  // ---- RentasRepository: Fase 12 — descubrimiento de organización/property ----

  async findOrganizationBySlug(slug: string): Promise<RentasOrganizationSummary | null> {
    const { rows } = await this.db.query<{ id: string; slug: string; name: string }>(
      `select id, slug, name from core.organization where slug = $1 and vertical = 'rentas';`,
      [slug],
    );
    return rows[0] ?? null;
  }

  async listPropertiesForOrganization(organizationId: string): Promise<readonly RentasPropertySummary[]> {
    const { rows } = await this.db.query<{ property_id: string; name: string }>(
      `select id as property_id, name
       from core.property
       where organization_id = $1 and status = 'active'
       order by name asc;`,
      [organizationId],
    );
    return rows.map((row) => ({ propertyId: row.property_id, name: row.name }));
  }

  // ---- RentasRepository: Fase 17 -- panel operativo del rol `limpieza` (lecturas de
  // tarea_operativa/checklist_item_tarea/item_inventario/incidencia_mantenimiento,
  // ver migrations/010_rentas_limpieza_schema.sql). Las escrituras siguen pasando por
  // ../limpieza/aplicacion/tareas.ts (ver comentario de cabecera del archivo). ----

  async listTareas(propertyId: string, filtro: TareaListFiltro = {}): Promise<readonly TareaOperativaRecord[]> {
    // `asignado_a is not distinct from $2` deja pasar tanto "= $2" (staffId concreto)
    // como "IS NULL" (sin asignar, cuando $2 es null) con un solo operador -- mismo
    // patrón que `findReglaComisionCanal` (canal_id is not distinct from $2) arriba.
    // `$2::boolean` decide si el filtro de asignación aplica en absoluto -- distingue
    // "sin filtro" (arg ausente) de "filtra por NULL" (arg = null literal).
    const { rows } = await this.db.query<{
      id: string;
      property_id: string;
      unidad_id: string;
      unidad_nombre: string;
      tipo: TipoTareaOperativa;
      estado: EstadoTareaOperativa;
      prioridad: PrioridadTareaOperativa;
      asignado_a: string | null;
      es_proveedor_externo: boolean;
      programada_para: string;
      sla_vence_en: string | null;
      completada_en: string | null;
      creado_en: string;
    }>(
      `select t.id, t.property_id, t.unidad_id, coalesce(u.name, t.unidad_id::text) as unidad_nombre,
              t.tipo, t.estado, t.prioridad, t.asignado_a, t.es_proveedor_externo,
              t.programada_para::text as programada_para, t.sla_vence_en::text as sla_vence_en,
              t.completada_en::text as completada_en, t.creado_en::text as creado_en
       from rentas.tarea_operativa t
       join rentas.unidad u on u.id = t.unidad_id
       where t.property_id = $1
         and ($2::boolean is not true or t.asignado_a is not distinct from $3)
         and ($4::text[] is null or t.estado = any($4::text[]))
       order by t.programada_para asc, t.creado_en asc;`,
      [propertyId, filtro.asignadoA !== undefined, filtro.asignadoA ?? null, filtro.estados ? [...filtro.estados] : null],
    );
    return rows.map((r) => ({
      id: r.id,
      propertyId: r.property_id,
      unidadId: r.unidad_id,
      unidadNombre: r.unidad_nombre,
      tipo: r.tipo,
      estado: r.estado,
      prioridad: r.prioridad,
      asignadoA: r.asignado_a,
      esProveedorExterno: r.es_proveedor_externo,
      programadaPara: r.programada_para,
      slaVenceEn: r.sla_vence_en,
      completadaEn: r.completada_en,
      creadoEn: r.creado_en,
    }));
  }

  async findTareaDetalle(propertyId: string, tareaId: string): Promise<TareaOperativaDetalle | null> {
    const { rows } = await this.db.query<{
      id: string;
      property_id: string;
      unidad_id: string;
      unidad_nombre: string;
      tipo: TipoTareaOperativa;
      estado: EstadoTareaOperativa;
      prioridad: PrioridadTareaOperativa;
      asignado_a: string | null;
      es_proveedor_externo: boolean;
      programada_para: string;
      sla_vence_en: string | null;
      completada_en: string | null;
      creado_en: string;
    }>(
      `select t.id, t.property_id, t.unidad_id, coalesce(u.name, t.unidad_id::text) as unidad_nombre,
              t.tipo, t.estado, t.prioridad, t.asignado_a, t.es_proveedor_externo,
              t.programada_para::text as programada_para, t.sla_vence_en::text as sla_vence_en,
              t.completada_en::text as completada_en, t.creado_en::text as creado_en
       from rentas.tarea_operativa t
       join rentas.unidad u on u.id = t.unidad_id
       where t.id = $1 and t.property_id = $2;`,
      [tareaId, propertyId],
    );
    const row = rows[0];
    if (!row) return null;

    const checklist = await this.db.query<{ id: string; tarea_id: string; descripcion: string; orden: number; completado: boolean; completado_en: string | null; completado_por: string | null }>(
      `select id, tarea_id, descripcion, orden, completado, completado_en::text as completado_en, completado_por
       from rentas.checklist_item_tarea where tarea_id = $1 order by orden asc;`,
      [tareaId],
    );

    return {
      id: row.id,
      propertyId: row.property_id,
      unidadId: row.unidad_id,
      unidadNombre: row.unidad_nombre,
      tipo: row.tipo,
      estado: row.estado,
      prioridad: row.prioridad,
      asignadoA: row.asignado_a,
      esProveedorExterno: row.es_proveedor_externo,
      programadaPara: row.programada_para,
      slaVenceEn: row.sla_vence_en,
      completadaEn: row.completada_en,
      creadoEn: row.creado_en,
      checklist: checklist.rows.map(
        (c): ChecklistItemTarea => ({
          id: c.id,
          tareaId: c.tarea_id,
          descripcion: c.descripcion,
          orden: c.orden,
          completado: c.completado,
          completadoEn: c.completado_en,
          completadoPor: c.completado_por,
        }),
      ),
    };
  }

  async findChecklistItem(propertyId: string, tareaId: string, itemId: string): Promise<{ id: string } | null> {
    const { rows } = await this.db.query<{ id: string }>(
      `select ci.id
       from rentas.checklist_item_tarea ci
       join rentas.tarea_operativa t on t.id = ci.tarea_id
       where ci.id = $1 and ci.tarea_id = $2 and t.property_id = $3;`,
      [itemId, tareaId, propertyId],
    );
    return rows[0] ?? null;
  }

  async listItemsInventario(propertyId: string, unidadId: string): Promise<readonly ItemInventarioRecord[]> {
    const { rows } = await this.db.query<{ id: string; unidad_id: string; nombre: string; categoria: ItemInventarioRecord["categoria"]; cantidad_actual: string; umbral_minimo: string; unidad_medida: string }>(
      `select id, unidad_id, nombre, categoria, cantidad_actual, umbral_minimo, unidad_medida
       from rentas.item_inventario where property_id = $1 and unidad_id = $2 order by nombre asc;`,
      [propertyId, unidadId],
    );
    return rows.map((r) => ({
      id: r.id,
      unidadId: r.unidad_id,
      nombre: r.nombre,
      categoria: r.categoria,
      cantidadActual: Number(r.cantidad_actual),
      umbralMinimo: Number(r.umbral_minimo),
      unidadMedida: r.unidad_medida,
    }));
  }

  async listIncidencias(propertyId: string, unidadId: string): Promise<readonly IncidenciaMantenimientoRecord[]> {
    const { rows } = await this.db.query<{
      id: string;
      property_id: string;
      unidad_id: string;
      tarea_origen_id: string | null;
      severidad: SeveridadIncidencia;
      titulo: string;
      descripcion: string | null;
      estado: EstadoIncidencia;
      propuesta_bloqueo_inicio: string | null;
      propuesta_bloqueo_fin: string | null;
      reportado_por: string | null;
      creado_en: string;
    }>(
      `select id, property_id, unidad_id, tarea_origen_id, severidad, titulo, descripcion, estado,
              propuesta_bloqueo_inicio::text as propuesta_bloqueo_inicio, propuesta_bloqueo_fin::text as propuesta_bloqueo_fin,
              reportado_por, creado_en::text as creado_en
       from rentas.incidencia_mantenimiento where property_id = $1 and unidad_id = $2 order by creado_en desc;`,
      [propertyId, unidadId],
    );
    return rows.map((r) => ({
      id: r.id,
      propertyId: r.property_id,
      unidadId: r.unidad_id,
      tareaOrigenId: r.tarea_origen_id,
      severidad: r.severidad,
      titulo: r.titulo,
      descripcion: r.descripcion,
      estado: r.estado,
      propuestaBloqueoRango: r.propuesta_bloqueo_inicio && r.propuesta_bloqueo_fin ? { inicio: r.propuesta_bloqueo_inicio, fin: r.propuesta_bloqueo_fin } : null,
      reportadoPor: r.reportado_por,
      creadoEn: r.creado_en,
    }));
  }

  // ---- r5 — bitácora de auditoría del staff ----

  /**
   * Registra una fila en `rentas.audit_log` llamando a `rentas.record_audit_log`
   * (security definer) DENTRO de la transacción compartida del request (nunca abre
   * su propia transacción) -- `input.actorUserId` se ignora deliberadamente al
   * armar esta llamada: el actor real lo captura la función vía `auth.uid()`, nunca
   * un parámetro (ver migrations/021_rentas_audit_log.sql).
   *
   * REGLA DURA DE COMPATIBILIDAD (ver AGENTS.md de esta fase): esta escritura NUNCA
   * debe romper ni revertir la acción de negocio que ya se hizo en la MISMA
   * transacción -- por eso corre bajo su propio SAVEPOINT y CUALQUIER error de este
   * bloque (no solo 42883/42P01/42703, aunque son los únicos esperados contra un
   * despliegue real) se traga aquí mismo, nunca se propaga al llamador. Sin el
   * SAVEPOINT, un error aquí dejaría la transacción del request ABORTADA (25P02) y
   * el `commit` final de `ManagedPostgresEngine.withAppSession` fallaría, revirtiendo
   * la escritura de negocio que ya había corrido -- exactamente lo que esta regla
   * prohíbe. Mismo patrón de SAVEPOINT que
   * `break-glass/postgres-data-repository.ts`, adaptado a "nunca lanzar" (esta
   * bitácora no tiene un "camino anterior" al que caer).
   */
  async registrarAuditoria(input: RegistrarAuditoriaInput): Promise<void> {
    try {
      await this.db.exec(`SAVEPOINT ${RENTAS_AUDIT_LOG_SAVEPOINT}`);
    } catch (err) {
      // Ni siquiera pudo abrirse el SAVEPOINT (sesión que no soporta SAVEPOINT,
      // p.ej. un doble de prueba angosto) -- se registra y se sale sin tocar nada
      // más, la acción de negocio sigue intacta.
      console.error("PostgresRentasRepository.registrarAuditoria: no se pudo abrir el SAVEPOINT -- se omite el registro de bitácora.", err);
      return;
    }
    try {
      await this.db.query(`select rentas.record_audit_log($1, $2, $3, $4, $5, $6, $7);`, [
        input.organizationId,
        input.action,
        input.entityType,
        input.entityId,
        input.campo ?? null,
        input.antes ?? null,
        input.despues ?? null,
      ]);
      await this.db.exec(`RELEASE SAVEPOINT ${RENTAS_AUDIT_LOG_SAVEPOINT}`);
    } catch (err) {
      try {
        await this.db.exec(`ROLLBACK TO SAVEPOINT ${RENTAS_AUDIT_LOG_SAVEPOINT}`);
        await this.db.exec(`RELEASE SAVEPOINT ${RENTAS_AUDIT_LOG_SAVEPOINT}`);
      } catch (recoveryErr) {
        console.error("PostgresRentasRepository.registrarAuditoria: fallo al recuperar el SAVEPOINT tras un error de bitácora.", recoveryErr);
      }
      if (isMigrationPendingError(err, "rentas.record_audit_log")) {
        advertirAuditLogEscrituraNoDisponible(err);
        return;
      }
      // Error inesperado (no de compatibilidad) -- se registra para diagnóstico pero
      // TAMPOCO se propaga: la regla dura de arriba no distingue "por qué" falló la
      // bitácora, solo que nunca puede tumbar ni revertir la acción de negocio ya
      // hecha.
      console.error("PostgresRentasRepository.registrarAuditoria: fallo inesperado al escribir en rentas.audit_log (la acción de negocio ya se completó y NO se revierte).", err);
    }
  }

  async listAuditoria(organizationId: string, filtro: RentasAuditLogFiltro, paginacion: RentasAuditLogPaginacion): Promise<RentasAuditLogPagina> {
    const limit = Math.min(200, Math.max(1, paginacion.limit ?? 50));
    const offset = Math.max(0, paginacion.offset ?? 0);

    const params: unknown[] = [organizationId];
    const condiciones = ["organization_id = $1"];
    if (filtro.entityType) {
      params.push(filtro.entityType);
      condiciones.push(`entity_type = $${params.length}`);
    }
    // No bloqueante #10 de revisión r5: `created_at >= $n::date` comparaba usando la
    // zona horaria de la SESIÓN de Postgres (UTC) -- el admin elige `desde`/`hasta`
    // en hora local de México, así que una acción de las 18:00 a las 23:59 hora de
    // México caía en el día SIGUIENTE del filtro (UTC ya cruzó medianoche). Se ancla
    // explícitamente a America/Mexico_City con offset fijo `-06:00` (México no tiene
    // horario de verano nacional desde 2022) -- mismo criterio EXACTO que
    // domain-licitaciones/src/dates.ts (`MEXICO_CITY_OFFSET`), replicado aquí en vez
    // de importado porque los paquetes de dominio no se importan entre sí.
    if (filtro.desde) {
      params.push(`${filtro.desde}T00:00:00-06:00`);
      condiciones.push(`created_at >= $${params.length}::timestamptz`);
    }
    if (filtro.hasta) {
      // Extremo inclusivo -- `hasta` es una fecha (sin hora), así que compara contra
      // el INICIO del día siguiente en vez de `<=` (que excluiría cualquier hora
      // después de medianoche del propio día `hasta`), ambos anclados a la misma
      // zona de arriba.
      params.push(`${filtro.hasta}T00:00:00-06:00`);
      condiciones.push(`created_at < ($${params.length}::timestamptz + interval '1 day')`);
    }
    const where = condiciones.join(" and ");

    // r6 -- refactor a `runWithSavepointFallback` (ver migrations/
    // 022_rentas_audit_log_orden_determinista.sql y el comentario de cabecera de
    // ese helper en packages/db/src/savepoint-fallback.ts) en vez del SAVEPOINT/
    // ROLLBACK TO SAVEPOINT/RELEASE manual que tenía este método antes -- mismo
    // comportamiento observable para el caso "tabla no existe" (021 sin aplicar,
    // ver `savepointName` fijo a RENTAS_AUDIT_LOG_READ_SAVEPOINT, que preserva las
    // aserciones exactas de packages/domain-rentas/tests/audit-log-savepoint.spec.ts),
    // MÁS el caso nuevo anidado de abajo (021 aplicada, 022 no).
    return runWithSavepointFallback<RentasAuditLogPagina>({
      session: this.db,
      savepointName: RENTAS_AUDIT_LOG_READ_SAVEPOINT,
      primary: async () => {
        const totalResult = await this.db.query<{ total: string }>(`select count(*)::text as total from rentas.audit_log where ${where};`, params);
        const total = Number(totalResult.rows[0]?.total ?? 0);

        const limitOffsetParams = [...params, limit, offset];
        const selectConOrden = (orderBy: string) =>
          this.db.query<RentasAuditLogRowSql>(
            `select id, actor_user_id, action, entity_type, entity_id, campo, antes, despues, created_at::text as created_at
             from rentas.audit_log where ${where} order by ${orderBy} limit $${limitOffsetParams.length - 1} offset $${limitOffsetParams.length};`,
            limitOffsetParams,
          );

        // Anidado DENTRO del SAVEPOINT de arriba (los SAVEPOINT de Postgres
        // anidan sin problema, ver comentario de cabecera de
        // `runWithSavepointFallback`): la tabla/función YA se demostraron
        // disponibles (el `count(*)` de arriba tuvo éxito) -- este segundo nivel
        // decide SOLO si `seq` (022) ya existe, nunca si la bitácora en general
        // está disponible.
        const { rows } = await runWithSavepointFallback({
          session: this.db,
          savepointName: RENTAS_AUDIT_LOG_READ_ORDER_SAVEPOINT,
          primary: () => selectConOrden("created_at desc, seq desc"),
          isRecoverable: esErrorColumnaSeqNoExiste,
          fallback: (err) => {
            advertirAuditLogOrdenSeqNoDisponible(err);
            return selectConOrden("created_at desc");
          },
        });

        const items = rows.map(mapRentasAuditLogRow);
        return { disponible: true, items, total, nextOffset: offset + items.length < total ? offset + items.length : null };
      },
      // Sin `expectedFunctionName`: este bloque nunca llama a ninguna función,
      // solo hace `select`/`count(*)` directo contra `rentas.audit_log` -- 42883
      // no puede originarse aquí (ningún operando de tipo ambiguo), así que la
      // ambigüedad de mensaje que `expectedFunctionName` existe para resolver no
      // aplica en este camino (ver cabecera de esta sección).
      isRecoverable: isMigrationPendingError,
      fallback: (err) => {
        advertirAuditLogLecturaNoDisponible(err);
        return Promise.resolve({ disponible: false, items: [], total: 0, nextOffset: null });
      },
    });
  }
}
