// Persistencia del WORKER DE TELEFONIA de voz (migracion 044): gasto del mes (tope mensual), modo de entrada de la llamada, costo por escalon en
// `core.usage_cost_event` (via `core.record_usage_cost_event`, solo sistema, idempotente por ref) y el KPI de llamadas en desborde / ventas
// recuperadas / latencia de voz a voz.
//
// REGLA DE COMPATIBILIDAD CON LA BASE SIN MIGRAR: mergear despliega el codigo al instante y la 044 (y la 0028 de core) no se aplican solas. La
// sesion es UNA transaccion por request: cada operacion corre en su propio SAVEPOINT (`runWithSavepointFallback`) y, ante tabla/columna/funcion
// inexistente (42P01, 42703, 42883), degrada a "no disponible aun" (`null` / `disponible: false`), nunca a un 500 ni a una transaccion abortada.
// Cualquier otro error (42501 por sesion de staff en una funcion de sistema, 22023 por un valor invalido) se repropaga: no se enmascara un fallo real.
import type { TenantDbSession } from "@atiende/core-tenancy";
import { isMigrationPendingError, runWithSavepointFallback } from "@atiende/db";
import type { EventoCostoUso } from "@atiende/voice-core";
import type { VozLectura } from "./types.ts";

export type ModoEntradaVoz = "desborde" | "total" | "prueba";
export const MODOS_ENTRADA_VOZ: readonly ModoEntradaVoz[] = ["desborde", "total", "prueba"];
export type FranjaVoz = "manana" | "tarde" | "noche";
export const FRANJAS_VOZ: readonly FranjaVoz[] = ["manana", "tarde", "noche"];

export interface ResultadoRegistroCosto {
  /** false = la base todavia no tiene `core.record_usage_cost_event` (migracion 0028 de core pendiente): nada se registro. */
  readonly disponible: boolean;
  /** Eventos nuevos (los repetidos por idempotencia no cuentan). */
  readonly registrados: number;
  readonly repetidos: number;
}

/** KPI de un dia local de la sucursal: lo que el worker registra (modo de entrada y latencia de voz a voz). */
export interface VozModoEntradaKpiDia {
  readonly fecha: string;
  /** Llamadas que llegaron por desvio del conmutador (el personal no las contesto). */
  readonly llamadasDesborde: number;
  /** De esas, las que terminaron en pedido (sin cancelados). */
  readonly pedidosDesborde: number;
  /** Suma de los totales de esos pedidos (MXN): ventas recuperadas, una cifra verificable, sin contrafactual. */
  readonly ventasRecuperadas: number;
  readonly llamadasConModo: number;
  readonly llamadasConLatencia: number;
  /** Latencia de voz a voz (fin de la voz del cliente -> primer audio del agente), ms. null = sin muestras ese dia. */
  readonly latenciaP50Ms: number | null;
  readonly latenciaP95Ms: number | null;
}

/** Objetivo de latencia de voz a voz: p95 por debajo de 1.5 s (brief VT / B-36). */
export const LATENCIA_VOZ_OBJETIVO_P95_MS = 1500;

export interface VozLlamadaRepository {
  /** Gasto de voz del mes calendario (zona de Merida) de la organizacion, en micro-USD. `null` = no disponible aun (base sin migrar). */
  gastoMesMicroUsd(organizationId: string, ahora: Date): Promise<number | null>;
  /** `true` = marcada; `false` = la conversacion no existe para esa organizacion (o es un preview); `null` = no disponible aun. */
  marcarModoEntrada(input: { organizationId: string; conversationId: string; modo: ModoEntradaVoz; franja: FranjaVoz }): Promise<boolean | null>;
  registrarCostoLlamada(eventos: readonly EventoCostoUso[]): Promise<ResultadoRegistroCosto>;
  /** Lectura del panel (owner/admin con alcance de la sucursal; lo exige la funcion SQL). */
  getModoEntradaKpi(organizationId: string, propertyId: string, desde: string, hasta: string): Promise<VozLectura<readonly VozModoEntradaKpiDia[]>>;
}

const toInt = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
const toIntOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

interface KpiRow {
  fecha: Date | string;
  llamadas_desborde: number;
  pedidos_desborde: number;
  ventas_recuperadas: string | number;
  llamadas_con_modo: number;
  llamadas_con_latencia: number;
  latencia_p50_ms: number | null;
  latencia_p95_ms: number | null;
}

const fechaIso = (v: Date | string): string => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));

export class PostgresVozLlamadaRepository implements VozLlamadaRepository {
  constructor(private readonly db: TenantDbSession) {}

  async gastoMesMicroUsd(organizationId: string, ahora: Date): Promise<number | null> {
    return runWithSavepointFallback<number | null>({
      session: this.db,
      savepointName: "sp_voz_gasto_mes",
      primary: async () => {
        const { rows } = await this.db.query<{ gasto: string | number | null }>(`select restaurantes.voz_gasto_mes_micro_usd($1::uuid, $2::timestamptz) as gasto;`, [organizationId, ahora.toISOString()]);
        const gasto = rows[0]?.gasto;
        return gasto === null || gasto === undefined ? null : Number(gasto);
      },
      isRecoverable: (err) => isMigrationPendingError(err),
      fallback: async () => null,
    });
  }

  async marcarModoEntrada(input: { organizationId: string; conversationId: string; modo: ModoEntradaVoz; franja: FranjaVoz }): Promise<boolean | null> {
    return runWithSavepointFallback<boolean | null>({
      session: this.db,
      savepointName: "sp_voz_modo_entrada",
      primary: async () => {
        const { rows } = await this.db.query<{ ok: boolean }>(`select restaurantes.voz_marcar_modo_entrada($1::uuid, $2::uuid, $3, $4) as ok;`, [input.organizationId, input.conversationId, input.modo, input.franja]);
        return rows[0]?.ok === true;
      },
      isRecoverable: (err) => isMigrationPendingError(err),
      fallback: async () => null,
    });
  }

  async registrarCostoLlamada(eventos: readonly EventoCostoUso[]): Promise<ResultadoRegistroCosto> {
    let registrados = 0;
    let repetidos = 0;
    for (const e of eventos) {
      const nuevo = await runWithSavepointFallback<boolean | null>({
        session: this.db,
        primary: async () => {
          const { rows } = await this.db.query<{ nuevo: boolean }>(
            `select core.record_usage_cost_event($1::uuid, $2::uuid, $3::timestamptz, $4, $5, $6, $7::numeric, $8::bigint, $9::boolean, $10, $11) as nuevo;`,
            [e.organizationId, e.propertyId, e.ocurridoEn, e.categoria, e.proveedor, e.unidad, e.cantidad, e.costoMicroUsd, e.costoEstimado, e.refTipo, e.refId],
          );
          return rows[0]?.nuevo === true;
        },
        isRecoverable: (err) => isMigrationPendingError(err),
        fallback: async () => null,
      });
      if (nuevo === null) return { disponible: false, registrados, repetidos };
      if (nuevo) registrados += 1;
      else repetidos += 1;
    }
    return { disponible: true, registrados, repetidos };
  }

  async getModoEntradaKpi(organizationId: string, propertyId: string, desde: string, hasta: string): Promise<VozLectura<readonly VozModoEntradaKpiDia[]>> {
    return runWithSavepointFallback<VozLectura<readonly VozModoEntradaKpiDia[]>>({
      session: this.db,
      savepointName: "sp_voz_modo_entrada_kpi",
      primary: async () => {
        const { rows } = await this.db.query<KpiRow>(`select * from restaurantes.voz_modo_entrada_kpi($1::uuid, $2::uuid, $3::date, $4::date);`, [organizationId, propertyId, desde, hasta]);
        return {
          disponible: true,
          valor: rows.map((r) => ({
            fecha: fechaIso(r.fecha),
            llamadasDesborde: toInt(r.llamadas_desborde),
            pedidosDesborde: toInt(r.pedidos_desborde),
            ventasRecuperadas: Number(r.ventas_recuperadas ?? 0),
            llamadasConModo: toInt(r.llamadas_con_modo),
            llamadasConLatencia: toInt(r.llamadas_con_latencia),
            latenciaP50Ms: toIntOrNull(r.latencia_p50_ms),
            latenciaP95Ms: toIntOrNull(r.latencia_p95_ms),
          })),
        };
      },
      isRecoverable: (err) => isMigrationPendingError(err),
      fallback: async () => ({ disponible: false, valor: [] }),
    });
  }
}

/** Doble en memoria (pruebas): misma idempotencia por `ref_tipo + ref_id`, gasto sumado de los eventos 'voz' y KPI configurable. */
export class InMemoryVozLlamadaRepository implements VozLlamadaRepository {
  readonly eventos: EventoCostoUso[] = [];
  readonly modos = new Map<string, { modo: ModoEntradaVoz; franja: FranjaVoz }>();
  /** Conversaciones conocidas por organizacion (para el cross-tenant de `marcarModoEntrada`). */
  readonly conversaciones = new Map<string, string>();
  kpi: readonly VozModoEntradaKpiDia[] = [];
  disponible = true;
  /** Gasto fijo (micro-USD) que ya trae el mes; se suma a los eventos registrados. */
  gastoPrevioMicroUsd = 0;

  async gastoMesMicroUsd(organizationId: string): Promise<number | null> {
    if (!this.disponible) return null;
    return this.gastoPrevioMicroUsd + this.eventos.filter((e) => e.organizationId === organizationId && e.categoria === "voz").reduce((s, e) => s + e.costoMicroUsd, 0);
  }

  async marcarModoEntrada(input: { organizationId: string; conversationId: string; modo: ModoEntradaVoz; franja: FranjaVoz }): Promise<boolean | null> {
    if (!this.disponible) return null;
    const dueno = this.conversaciones.get(input.conversationId);
    if (dueno !== undefined && dueno !== input.organizationId) return false;
    this.modos.set(input.conversationId, { modo: input.modo, franja: input.franja });
    return true;
  }

  async registrarCostoLlamada(eventos: readonly EventoCostoUso[]): Promise<ResultadoRegistroCosto> {
    if (!this.disponible) return { disponible: false, registrados: 0, repetidos: 0 };
    let registrados = 0;
    let repetidos = 0;
    for (const e of eventos) {
      if (this.eventos.some((x) => x.refTipo === e.refTipo && x.refId === e.refId)) repetidos += 1;
      else {
        this.eventos.push(e);
        registrados += 1;
      }
    }
    return { disponible: true, registrados, repetidos };
  }

  async getModoEntradaKpi(): Promise<VozLectura<readonly VozModoEntradaKpiDia[]>> {
    return this.disponible ? { disponible: true, valor: this.kpi } : { disponible: false, valor: [] };
  }
}
