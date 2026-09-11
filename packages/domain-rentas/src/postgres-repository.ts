// PostgresRentasRepository — adaptador de producción de `RentasRepository`, sobre el
// `TenantDbSession` genérico de `@atiende/core-tenancy` (mismo contrato que consume
// `core-auth/src/middleware.ts::dbSession`). Ejecuta las queries reales contra el
// esquema `rentas` de migrations/001-003 (RLS real vía `core.has_property_access`/
// funciones propias del schema `rentas`).
import type { TenantDbSession } from "@atiende/core-tenancy";
import type { RentasRepository } from "./repository.ts";
import type {
  CanalRecord,
  ConfiguracionComisionCanal,
  ContextoPricingUnidad,
  DescuentoDuracion,
  MovimientoFinancieroReserva,
  NewGuestMinimoInput,
  NewReservaFinancieroInput,
  OcupacionParaMovimiento,
  OcupacionResumen,
  ReglaCanal,
  ReglaMinStay,
  TemporadaTarifa,
  UnidadRecord,
} from "./types.ts";

interface UnidadRow {
  id: string;
  organization_id: string;
  property_id: string;
  duracion_minima_noches: number;
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

export class PostgresRentasRepository implements RentasRepository {
  constructor(private readonly db: TenantDbSession) {}

  async findUnidad(propertyId: string, unidadId: string): Promise<UnidadRecord | null> {
    const { rows } = await this.db.query<UnidadRow>(`select id, organization_id, property_id, duracion_minima_noches from rentas.unidad where id = $1 and property_id = $2;`, [
      unidadId,
      propertyId,
    ]);
    const row = rows[0];
    if (!row) return null;
    return { id: row.id, organizationId: row.organization_id, propertyId: row.property_id, duracionMinimaNoches: row.duracion_minima_noches };
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

    const base = await this.db.query<TarifaBaseRow>(
      `select precio_noche_centavos, moneda from rentas.tarifa_base
       where unidad_id = $1 and vigente_desde <= current_date
       order by vigente_desde desc limit 1;`,
      [unidadId],
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
}
