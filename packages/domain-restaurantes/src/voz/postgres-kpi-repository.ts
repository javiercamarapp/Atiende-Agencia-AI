// Adaptador Postgres de `VozKpiRepository` (migracion 035). REGLA DURA de compatibilidad con la base SIN migrar:
// mergear despliega el codigo al instante y la 035 no se aplica sola. Toda consulta corre dentro de la transaccion
// UNICA del request (`withAppSession`): un error de Postgres la deja abortada (25P02) y el COMMIT seria un ROLLBACK,
// por eso TODA operacion usa `runWithSavepointFallback` antes de degradar: lecturas -> `disponible: false`,
// escrituras -> `VozNoDisponibleError` (503).
import { runWithSavepointFallback } from "@atiende/db";
import type { TenantDbSession } from "@atiende/core-tenancy";
import type { VozKpiRepository } from "./kpi-repository.ts";
import { VOZ_UMBRALES_POR_DEFECTO } from "./kpi.ts";
import type { VozAlerta, VozAlertaTipo, VozEventoEntrada, VozKpiDia, VozUmbrales, VozUmbralesEntrada } from "./kpi.ts";
import { VozNoDisponibleError, VozRechazadaError } from "./types.ts";
import type { VozLectura } from "./types.ts";

function code(err: unknown): string | undefined {
  return err && typeof err === "object" && "code" in err ? ((err as { code?: unknown }).code as string | undefined) : undefined;
}

/** Objeto de la migracion 035 inexistente: tabla, columna o funcion. */
function esBaseSinMigrar(err: unknown): boolean {
  const c = code(err);
  return c === "42P01" || c === "42703" || c === "42883";
}

function esErrorEscrituraConocido(err: unknown): boolean {
  return esBaseSinMigrar(err) || code(err) === "42501";
}

function aErrorDeEscritura(err: unknown): never {
  if (esBaseSinMigrar(err)) {
    advertirNoDisponible(err);
    throw new VozNoDisponibleError();
  }
  throw new VozRechazadaError();
}

let advertido = false;
function advertirNoDisponible(err: unknown): void {
  if (advertido) return;
  advertido = true;
  console.warn(
    "PostgresVozKpiRepository: las tablas/funciones de KPI de voz todavía no existen en esta base (SQLSTATE 42P01/42703/42883) -- " +
      "aplica packages/domain-restaurantes/migrations/035_voz_kpi_alertas_costo.sql (o su espejo en supabase/migrations/).",
    err,
  );
}

const num = (v: string | number | null): number => (v === null ? 0 : Number(v));
const numNull = (v: string | number | null): number | null => (v === null ? null : Number(v));

interface KpiRow {
  fecha: string;
  zona_horaria: string;
  llamadas: number;
  llamadas_cerradas: number;
  duracion_total_s: string | number;
  pedidos_voz: number;
  escaladas: number;
  abandonadas: number;
  errores_proveedor: number;
  errores_elevenlabs: number;
  errores_twilio: number;
  errores_otros: number;
  tool_calls: number;
  tool_p95_ms: number | null;
  costo_voz_micro_usd: string | number;
  costo_telefonia_micro_usd: string | number;
  costo_total_centavos_mxn: string | number | null;
  costo_llm_org_micro_usd: string | number | null;
  costo_llm_org_centavos_mxn: string | number | null;
}

function mapKpi(r: KpiRow): VozKpiDia {
  return {
    fecha: r.fecha,
    zonaHoraria: r.zona_horaria,
    llamadas: num(r.llamadas),
    llamadasCerradas: num(r.llamadas_cerradas),
    duracionTotalS: num(r.duracion_total_s),
    pedidosVoz: num(r.pedidos_voz),
    escaladas: num(r.escaladas),
    abandonadas: num(r.abandonadas),
    erroresProveedor: num(r.errores_proveedor),
    erroresElevenlabs: num(r.errores_elevenlabs),
    erroresTwilio: num(r.errores_twilio),
    erroresOtros: num(r.errores_otros),
    toolCalls: num(r.tool_calls),
    toolP95Ms: numNull(r.tool_p95_ms),
    costoVozMicroUsd: num(r.costo_voz_micro_usd),
    costoTelefoniaMicroUsd: num(r.costo_telefonia_micro_usd),
    costoTotalCentavosMxn: numNull(r.costo_total_centavos_mxn),
    costoLlmOrgMicroUsd: numNull(r.costo_llm_org_micro_usd),
    costoLlmOrgCentavosMxn: numNull(r.costo_llm_org_centavos_mxn),
  };
}

interface UmbralRow {
  umbral_costo_dia_centavos_mxn: string | number | null;
  umbral_tasa_error_pct: number | null;
  min_llamadas_tasa_error: number;
}

function mapUmbrales(r: UmbralRow): VozUmbrales {
  return {
    configurado: true,
    umbralCostoDiaCentavosMxn: numNull(r.umbral_costo_dia_centavos_mxn),
    umbralTasaErrorPct: r.umbral_tasa_error_pct === null ? null : Number(r.umbral_tasa_error_pct),
    minLlamadasTasaError: Number(r.min_llamadas_tasa_error),
  };
}

interface AlertaRow {
  fecha: string;
  tipo: string;
  valor: string | number;
  umbral: string | number;
  nueva: boolean | null;
}

function mapAlerta(r: AlertaRow): VozAlerta {
  return { fecha: r.fecha, tipo: r.tipo as VozAlertaTipo, valor: Number(r.valor), umbral: Number(r.umbral), nueva: r.nueva === true };
}

export class PostgresVozKpiRepository implements VozKpiRepository {
  constructor(private readonly db: TenantDbSession) {}

  async getKpisDiarios(organizationId: string, propertyId: string, desde: string, hasta: string): Promise<VozLectura<readonly VozKpiDia[]>> {
    return runWithSavepointFallback<VozLectura<readonly VozKpiDia[]>>({
      session: this.db,
      savepointName: "sp_voz_kpi_diarios_read",
      primary: async () => {
        const { rows } = await this.db.query<KpiRow>(
          `select to_char(fecha, 'YYYY-MM-DD') as fecha, zona_horaria, llamadas, llamadas_cerradas, duracion_total_s, pedidos_voz, escaladas,
                  abandonadas, errores_proveedor, errores_elevenlabs, errores_twilio, errores_otros, tool_calls, tool_p95_ms,
                  costo_voz_micro_usd, costo_telefonia_micro_usd, costo_total_centavos_mxn, costo_llm_org_micro_usd, costo_llm_org_centavos_mxn
             from restaurantes.voz_kpis_diarios($1, $2, $3::date, $4::date)
            order by fecha;`,
          [organizationId, propertyId, desde, hasta],
        );
        return { disponible: true, valor: rows.map(mapKpi) };
      },
      isRecoverable: esBaseSinMigrar,
      fallback: async (err) => {
        advertirNoDisponible(err);
        return { disponible: false, valor: [] };
      },
    });
  }

  async getUmbrales(propertyId: string): Promise<VozLectura<VozUmbrales>> {
    return runWithSavepointFallback<VozLectura<VozUmbrales>>({
      session: this.db,
      savepointName: "sp_voz_umbrales_read",
      primary: async () => {
        const { rows } = await this.db.query<UmbralRow>(
          `select umbral_costo_dia_centavos_mxn, umbral_tasa_error_pct, min_llamadas_tasa_error from restaurantes.voice_alert_config where property_id = $1;`,
          [propertyId],
        );
        return { disponible: true, valor: rows[0] ? mapUmbrales(rows[0]) : VOZ_UMBRALES_POR_DEFECTO };
      },
      isRecoverable: esBaseSinMigrar,
      fallback: async (err) => {
        advertirNoDisponible(err);
        return { disponible: false, valor: VOZ_UMBRALES_POR_DEFECTO };
      },
    });
  }

  async upsertUmbrales(organizationId: string, propertyId: string, actorUserId: string, entrada: VozUmbralesEntrada): Promise<VozUmbrales> {
    return runWithSavepointFallback<VozUmbrales>({
      session: this.db,
      savepointName: "sp_voz_umbrales_write",
      primary: async () => {
        const { rows } = await this.db.query<UmbralRow>(
          `insert into restaurantes.voice_alert_config (property_id, organization_id, umbral_costo_dia_centavos_mxn, umbral_tasa_error_pct, min_llamadas_tasa_error, updated_by, updated_at)
           values ($1, $2, $3, $4, $5, $6, now())
           on conflict (property_id) do update set
             umbral_costo_dia_centavos_mxn = excluded.umbral_costo_dia_centavos_mxn,
             umbral_tasa_error_pct = excluded.umbral_tasa_error_pct,
             min_llamadas_tasa_error = excluded.min_llamadas_tasa_error,
             updated_by = excluded.updated_by,
             updated_at = excluded.updated_at
           returning umbral_costo_dia_centavos_mxn, umbral_tasa_error_pct, min_llamadas_tasa_error;`,
          [propertyId, organizationId, entrada.umbralCostoDiaCentavosMxn, entrada.umbralTasaErrorPct, entrada.minLlamadasTasaError, actorUserId],
        );
        return mapUmbrales(rows[0]!);
      },
      isRecoverable: esErrorEscrituraConocido,
      fallback: aErrorDeEscritura,
    });
  }

  async evaluarAlertas(organizationId: string, propertyId: string): Promise<VozLectura<readonly VozAlerta[]>> {
    return runWithSavepointFallback<VozLectura<readonly VozAlerta[]>>({
      session: this.db,
      savepointName: "sp_voz_alertas_evaluar",
      primary: async () => {
        const { rows } = await this.db.query<AlertaRow>(
          `select to_char(fecha, 'YYYY-MM-DD') as fecha, tipo, valor, umbral, nueva from restaurantes.voz_evaluar_alertas($1, $2);`,
          [organizationId, propertyId],
        );
        return { disponible: true, valor: rows.map(mapAlerta) };
      },
      isRecoverable: esBaseSinMigrar,
      fallback: async (err) => {
        advertirNoDisponible(err);
        return { disponible: false, valor: [] };
      },
    });
  }

  async listAlertas(organizationId: string, propertyId: string, limite: number): Promise<VozLectura<readonly VozAlerta[]>> {
    return runWithSavepointFallback<VozLectura<readonly VozAlerta[]>>({
      session: this.db,
      savepointName: "sp_voz_alertas_read",
      primary: async () => {
        const { rows } = await this.db.query<AlertaRow>(
          `select to_char(fecha, 'YYYY-MM-DD') as fecha, tipo, valor, umbral, false as nueva
             from restaurantes.voice_alert
            where organization_id = $1 and property_id = $2
            order by fecha desc, created_at desc
            limit $3;`,
          [organizationId, propertyId, limite],
        );
        return { disponible: true, valor: rows.map(mapAlerta) };
      },
      isRecoverable: esBaseSinMigrar,
      fallback: async (err) => {
        advertirNoDisponible(err);
        return { disponible: false, valor: [] };
      },
    });
  }

  async registrarEvento(input: VozEventoEntrada): Promise<void> {
    await runWithSavepointFallback<void>({
      session: this.db,
      savepointName: "sp_voz_evento_write",
      primary: async () => {
        await this.db.query(
          `select restaurantes.voz_registrar_evento($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz);`,
          [input.organizationId, input.propertyId, input.conversationId, input.tipo, input.proveedor, input.herramienta, input.latenciaMs, input.codigo, input.ocurridoAt],
        );
      },
      isRecoverable: esErrorEscrituraConocido,
      fallback: aErrorDeEscritura,
    });
  }
}
