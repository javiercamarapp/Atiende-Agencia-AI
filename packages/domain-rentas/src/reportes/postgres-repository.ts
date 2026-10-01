// Rn-03 -- lectura real del reporte de ocupación e ingresos sobre el TenantDbSession del
// request (RLS real: core.has_property_access + rentas.can_read_finanzas para el dinero).
//
// Compatibilidad con la base sin migrar: solo lee tablas de 001/003. Aun así, si
// `rentas.reserva_financiero` no existe o no es legible (42P01/42703/42501 en una base
// parcial), la consulta de respaldo trae solo noches. Esa degradación corre bajo
// SAVEPOINT (runWithSavepointFallback): la sesión es UNA transacción por request y un
// error de Postgres la dejaría abortada (25P02) para la consulta de respaldo.
import { ZONA_HORARIA_NEGOCIO_DEFAULT, type TenantDbSession } from "@atiende/core-tenancy";
import { isMigrationPendingError, runWithSavepointFallback } from "@atiende/db";
import type { RangoFechas } from "../tipos.ts";
import { CANAL_SIN_CODIGO } from "./calculo.ts";
import type { ContextoPropiedadReporte, DatosReporte, FiltrosReporte, RentasReportesRepository } from "./repository.ts";
import type { FinancieroReservaReporte, ReservaParaReporte } from "./tipos.ts";

interface FilaReserva {
  id: string;
  unidad_id: string;
  canal: string | null;
  inicio: string;
  fin: string;
  creada_en: string;
  moneda: string | null;
  bruto: string | null;
  comision_canal: string | null;
  comision_gestor: string | null;
  gastos: string | null;
  impuestos: string | null;
  neto: string | null;
}

function aFinanciero(f: FilaReserva): FinancieroReservaReporte | null {
  if (f.moneda === null) return null;
  return {
    moneda: f.moneda,
    brutoCentavos: Number(f.bruto),
    comisionCanalCentavos: Number(f.comision_canal),
    comisionGestorCentavos: Number(f.comision_gestor),
    gastosCentavos: Number(f.gastos),
    impuestosCentavos: Number(f.impuestos),
    netoCentavos: Number(f.neto),
  };
}

function esDegradable(err: unknown): boolean {
  return isMigrationPendingError(err) || (typeof err === "object" && err !== null && (err as { code?: unknown }).code === "42501");
}

export class PostgresRentasReportesRepository implements RentasReportesRepository {
  constructor(private readonly db: TenantDbSession) {}

  async leerContextoPropiedad(propertyId: string): Promise<ContextoPropiedadReporte> {
    const config = await this.db.query<{ zona_horaria: string; moneda: string }>(`select zona_horaria, moneda from rentas.property_config where property_id = $1;`, [propertyId]);
    return { moneda: (config.rows[0]?.moneda ?? "MXN").trim(), zonaHoraria: config.rows[0]?.zona_horaria ?? ZONA_HORARIA_NEGOCIO_DEFAULT };
  }

  async cargarDatosReporte(propertyId: string, periodo: RangoFechas, filtros: FiltrosReporte): Promise<DatosReporte> {
    const { moneda, zonaHoraria } = await this.leerContextoPropiedad(propertyId);

    const unidadesSql = await this.db.query<{ id: string; name: string; owner_id: string | null; owner_name: string | null }>(
      `select u.id, u.name, u.owner_id, o.name as owner_name
       from rentas.unidad u left join rentas.owner o on o.id = u.owner_id
       where u.property_id = $1 and ($2::uuid is null or u.id = $2::uuid) and ($3::uuid is null or u.owner_id = $3::uuid)
       order by u.name, u.id;`,
      [propertyId, filtros.unidadId ?? null, filtros.ownerId ?? null],
    );
    const unidades = unidadesSql.rows.map((u) => ({ id: u.id, nombre: u.name, ownerId: u.owner_id, ownerNombre: u.owner_name }));

    const parametros = [propertyId, periodo.inicio, periodo.fin, filtros.unidadId ?? null, filtros.ownerId ?? null, filtros.canal ?? null];
    const filtroBase = `where o.property_id = $1 and o.capa = 'reserva' and o.estado = 'confirmado'
         and o.rango && daterange($2::date, $3::date, '[)')
         and ($4::uuid is null or o.unidad_id = $4::uuid)
         and ($5::uuid is null or u.owner_id = $5::uuid)
         and ($6::text is null or coalesce(c.codigo, '${CANAL_SIN_CODIGO}') = $6::text)
       order by lower(o.rango), o.created_at, o.id`;
    const columnasBase = `o.id, o.unidad_id, coalesce(c.codigo, '${CANAL_SIN_CODIGO}') as canal,
         to_char(lower(o.rango), 'YYYY-MM-DD') as inicio, to_char(upper(o.rango), 'YYYY-MM-DD') as fin, o.created_at::text as creada_en`;
    const desde = `from rentas.ocupacion o
       join rentas.unidad u on u.id = o.unidad_id
       left join rentas.canal c on c.id = o.canal_origen_id`;

    const conFinanciero = async () =>
      (
        await this.db.query<FilaReserva>(
          `select ${columnasBase},
             rf.moneda::text as moneda, rf.monto_bruto_centavos::text as bruto, rf.comision_canal_centavos::text as comision_canal,
             rf.comision_gestor_centavos::text as comision_gestor, rf.gastos_centavos::text as gastos,
             rf.impuestos_centavos::text as impuestos, rf.neto_centavos::text as neto
           ${desde}
           left join rentas.reserva_financiero rf on rf.ocupacion_id = o.id
           ${filtroBase};`,
          parametros,
        )
      ).rows;
    const sinFinanciero = async () =>
      (
        await this.db.query<FilaReserva>(
          `select ${columnasBase}, null::text as moneda, null::text as bruto, null::text as comision_canal, null::text as comision_gestor,
             null::text as gastos, null::text as impuestos, null::text as neto
           ${desde} ${filtroBase};`,
          parametros,
        )
      ).rows;

    let financieroDisponible = true;
    const filas = await runWithSavepointFallback<FilaReserva[]>({
      session: this.db,
      savepointName: "sp_reporte_rentas_financiero",
      primary: conFinanciero,
      isRecoverable: esDegradable,
      fallback: async () => {
        financieroDisponible = false;
        return sinFinanciero();
      },
    });

    const reservas: ReservaParaReporte[] = filas.map((f) => ({
      ocupacionId: f.id,
      unidadId: f.unidad_id,
      canal: f.canal ?? CANAL_SIN_CODIGO,
      inicio: f.inicio,
      fin: f.fin,
      creadaEn: f.creada_en,
      financiero: aFinanciero(f),
    }));
    return { moneda, zonaHoraria, unidades, reservas, financieroDisponible };
  }
}
