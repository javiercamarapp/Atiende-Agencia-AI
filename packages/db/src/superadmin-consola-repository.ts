// Repositorio de los agregados de la consola de superadmin (SA-L-05 resumen, SA-L-06 actividad de agentes) --
// puerto contra las funciones `security definer` de
// packages/db/migrations/0042_superadmin_consola_resumen.sql.
//
// SESIONES: todos los metodos son caller-bound (`withAppSession({ userId: callerId })`); esta clase no elige la
// sesion, recibe el `TenantDbSession` ya abierto (una sola transaccion por request).
//
// CADA FUENTE FALLA POR SEPARADO: cada metodo corre bajo `runWithSavepointFallback`. Cualquier error SQL revierte
// SOLO su savepoint (la transaccion sigue viva para las demas fuentes) y devuelve `{ ok: false, razon }`:
//   * `no_migrado` -- SQLSTATE 42883/42P01/42703 (0042 sin aplicar en este despliegue);
//   * `error`      -- cualquier otro error SQL (se registra solo su SQLSTATE, nunca el mensaje).
// Nunca un 500 ni un valor simulado: el llamador deja ese campo en null con su razon.
//
// Los `date`/`timestamptz` se piden como texto (`::text`): el driver `pg` convierte `date` a Date a medianoche
// local y correria el dia segun la zona horaria del proceso.
import type { TenantDbSession } from "@atiende/core-tenancy";
import { isMigrationPendingError } from "./sql-errors.ts";
import { runWithSavepointFallback } from "./savepoint-fallback.ts";

export type FuenteConsola<T> = { readonly ok: true; readonly data: T } | { readonly ok: false; readonly razon: "no_migrado" | "error" };

export interface ConsolaOrganizacionRow {
  readonly vertical: string;
  readonly total: number;
  readonly demo: number;
  readonly activas: number;
}
export interface ConsolaCostoDiarioRow {
  /** `YYYY-MM-DD`. */
  readonly dia: string;
  readonly llmMicroUsd: number;
  readonly eventosMicroUsd: number;
  readonly tokens: number;
}
export interface ConsolaCostoHistoricoRow {
  /** `llm` o una categoria de `core.usage_cost_event` (voz, whatsapp, telefonia, sms, email, storage). */
  readonly fuente: string;
  readonly costoMicroUsd: number;
  readonly tokensIn: number | null;
  readonly tokensOut: number | null;
  readonly eventos: number;
  readonly minutosVoz: number | null;
}
export interface ConsolaOperacionRow {
  readonly vertical: string;
  /** `null` = total historico de la vertical; `YYYY-MM-DD` = operaciones creadas ese dia (dia de Mexico). */
  readonly dia: string | null;
  /** `null` + `razon` = la vertical NO tiene fuente (o su migracion no esta aplicada). */
  readonly cantidad: number | null;
  readonly razon: "fuente_no_migrada" | "sin_fuente" | null;
}
export interface ConsolaAlcanceRow {
  readonly sucursalesActivas: number;
  readonly staffConMembresia: number;
  readonly superadmins: number;
  readonly usuariosConAcceso: number;
}
export interface ConsolaConversacionesWaRow {
  readonly vertical: string;
  readonly total: number | null;
  readonly razon: "fuente_no_migrada" | "sin_whatsapp" | null;
}
export interface ConsolaResueltasSinHumanoRow {
  readonly total: number | null;
  readonly resueltasSinHumano: number | null;
  readonly razon: "fuente_no_migrada" | null;
}
export interface ConsolaAgenteActividadRow {
  readonly vertical: string;
  readonly role: string;
  readonly llamadasHist: number;
  readonly costoHistMicroUsd: number;
  readonly fallbackHist: number;
  readonly llamadas30d: number;
  readonly costo30dMicroUsd: number;
  readonly fallback30d: number;
}

export interface ConsolaRepository {
  /** CALLER. Organizaciones por vertical y cuantas son demo. */
  organizaciones(callerId: string): Promise<FuenteConsola<readonly ConsolaOrganizacionRow[]>>;
  /** CALLER. Serie diaria (inclusive) de gasto de IA y tokens; `desde`/`hasta` = `YYYY-MM-DD`. */
  costoDiario(callerId: string, desde: string, hasta: string): Promise<FuenteConsola<readonly ConsolaCostoDiarioRow[]>>;
  /** CALLER. Gasto de IA, tokens y minutos de voz historicos, una fila por fuente. */
  costoHistorico(callerId: string): Promise<FuenteConsola<readonly ConsolaCostoHistoricoRow[]>>;
  /** CALLER. Operaciones atendidas por vertical (total historico y una fila por dia del rango). */
  operaciones(callerId: string, desde: string, hasta: string): Promise<FuenteConsola<readonly ConsolaOperacionRow[]>>;
  /** CALLER. Sucursales activas y usuarios con acceso. */
  alcance(callerId: string): Promise<FuenteConsola<ConsolaAlcanceRow>>;
  /** CALLER. Conversaciones de WhatsApp por vertical (solo conteo). */
  conversacionesWa(callerId: string): Promise<FuenteConsola<readonly ConsolaConversacionesWaRow[]>>;
  /** CALLER. "X de N" del rango `[desde, hasta)` (instantes ISO), medido solo en restaurantes. */
  resueltasSinHumano(callerId: string, desdeIso: string, hastaIso: string): Promise<FuenteConsola<ConsolaResueltasSinHumanoRow>>;
  /** CALLER. Llamadas, costo y fallbacks por vertical y rol; `hoy` = `YYYY-MM-DD` (dia de Mexico). */
  agentesActividad(callerId: string, hoy: string): Promise<FuenteConsola<readonly ConsolaAgenteActividadRow[]>>;
}

let warned = false;
function warnOnce(): void {
  if (warned) return;
  warned = true;
  console.warn(
    "superadmin-consola-repository: las funciones de 0042_superadmin_consola_resumen.sql no existen todavia " +
      "(SQLSTATE 42883/42P01/42703) -- degradando a 'no disponible aun' por fuente (nunca 500, nunca exito simulado). Aplica la migracion " +
      "(o su espejo en supabase/migrations/) para habilitar el resumen y la actividad de agentes de la consola.",
  );
}

function pgCode(err: unknown): string {
  return err && typeof err === "object" && "code" in err ? String((err as { code?: unknown }).code) : "desconocido";
}

/** Una fuente = un SAVEPOINT: cualquier error SQL la deja en `{ ok: false }` y la transaccion sigue viva. */
async function guarded<T>(db: TenantDbSession, fuente: string, run: () => Promise<T>): Promise<FuenteConsola<T>> {
  return runWithSavepointFallback<FuenteConsola<T>>({
    session: db,
    primary: async () => ({ ok: true as const, data: await run() }),
    isRecoverable: () => true,
    fallback: async (err) => {
      if (isMigrationPendingError(err)) {
        warnOnce();
        return { ok: false as const, razon: "no_migrado" as const };
      }
      console.error(`superadmin-consola-repository: la fuente '${fuente}' fallo (SQLSTATE ${pgCode(err)}); ese campo queda en null.`);
      return { ok: false as const, razon: "error" as const };
    },
  });
}

const num = (v: string | number | null | undefined): number => Number(v ?? 0);
const numOrNull = (v: string | number | null | undefined): number | null => (v === null || v === undefined ? null : Number(v));

export class PostgresConsolaRepository implements ConsolaRepository {
  constructor(private readonly db: TenantDbSession) {}

  organizaciones(callerId: string) {
    return guarded(this.db, "organizaciones", async () => {
      const { rows } = await this.db.query<{ vertical: string; total: string | number; demo: string | number; activas: string | number }>(
        `select vertical, total, demo, activas from core.get_consola_organizaciones_for_superadmin($1);`,
        [callerId],
      );
      return rows.map((r) => ({ vertical: r.vertical, total: num(r.total), demo: num(r.demo), activas: num(r.activas) }));
    });
  }

  costoDiario(callerId: string, desde: string, hasta: string) {
    return guarded(this.db, "costo_diario", async () => {
      const { rows } = await this.db.query<{ dia: string; llm_micro_usd: string | number; eventos_micro_usd: string | number; tokens: string | number }>(
        `select dia::text as dia, llm_micro_usd, eventos_micro_usd, tokens from core.get_consola_costo_diario_for_superadmin($1, $2::date, $3::date);`,
        [callerId, desde, hasta],
      );
      return rows.map((r) => ({ dia: r.dia, llmMicroUsd: num(r.llm_micro_usd), eventosMicroUsd: num(r.eventos_micro_usd), tokens: num(r.tokens) }));
    });
  }

  costoHistorico(callerId: string) {
    return guarded(this.db, "costo_historico", async () => {
      const { rows } = await this.db.query<{
        fuente: string;
        costo_micro_usd: string | number;
        tokens_in: string | number | null;
        tokens_out: string | number | null;
        eventos: string | number;
        minutos_voz: string | number | null;
      }>(`select fuente, costo_micro_usd, tokens_in, tokens_out, eventos, minutos_voz from core.get_consola_costo_historico_for_superadmin($1);`, [callerId]);
      return rows.map((r) => ({
        fuente: r.fuente,
        costoMicroUsd: num(r.costo_micro_usd),
        tokensIn: numOrNull(r.tokens_in),
        tokensOut: numOrNull(r.tokens_out),
        eventos: num(r.eventos),
        minutosVoz: numOrNull(r.minutos_voz),
      }));
    });
  }

  operaciones(callerId: string, desde: string, hasta: string) {
    return guarded(this.db, "operaciones", async () => {
      const { rows } = await this.db.query<{ vertical: string; dia: string | null; cantidad: string | number | null; razon: ConsolaOperacionRow["razon"] }>(
        `select vertical, dia::text as dia, cantidad, razon from core.get_consola_operaciones_for_superadmin($1, $2::date, $3::date);`,
        [callerId, desde, hasta],
      );
      return rows.map((r) => ({ vertical: r.vertical, dia: r.dia, cantidad: numOrNull(r.cantidad), razon: r.razon }));
    });
  }

  alcance(callerId: string) {
    return guarded(this.db, "alcance", async () => {
      const { rows } = await this.db.query<{
        sucursales_activas: string | number;
        staff_con_membresia: string | number;
        superadmins: string | number;
        usuarios_con_acceso: string | number;
      }>(`select sucursales_activas, staff_con_membresia, superadmins, usuarios_con_acceso from core.get_consola_alcance_for_superadmin($1);`, [callerId]);
      const r = rows[0];
      // Cero filas = el SQL no reconocio al caller como superadmin: no es "0 usuarios", es una lectura fallida.
      if (!r) throw Object.assign(new Error("get_consola_alcance_for_superadmin devolvio cero filas"), { code: "sin_filas" });
      return {
        sucursalesActivas: num(r.sucursales_activas),
        staffConMembresia: num(r.staff_con_membresia),
        superadmins: num(r.superadmins),
        usuariosConAcceso: num(r.usuarios_con_acceso),
      };
    });
  }

  conversacionesWa(callerId: string) {
    return guarded(this.db, "conversaciones_wa", async () => {
      const { rows } = await this.db.query<{ vertical: string; total: string | number | null; razon: ConsolaConversacionesWaRow["razon"] }>(
        `select vertical, total, razon from core.get_consola_conversaciones_wa_for_superadmin($1);`,
        [callerId],
      );
      return rows.map((r) => ({ vertical: r.vertical, total: numOrNull(r.total), razon: r.razon }));
    });
  }

  resueltasSinHumano(callerId: string, desdeIso: string, hastaIso: string) {
    return guarded(this.db, "resueltas_sin_humano", async () => {
      const { rows } = await this.db.query<{ total: string | number | null; resueltas_sin_humano: string | number | null; razon: ConsolaResueltasSinHumanoRow["razon"] }>(
        `select total, resueltas_sin_humano, razon from core.get_consola_resueltas_sin_humano_for_superadmin($1, $2::timestamptz, $3::timestamptz);`,
        [callerId, desdeIso, hastaIso],
      );
      const r = rows[0];
      if (!r) throw Object.assign(new Error("get_consola_resueltas_sin_humano_for_superadmin devolvio cero filas"), { code: "sin_filas" });
      return { total: numOrNull(r.total), resueltasSinHumano: numOrNull(r.resueltas_sin_humano), razon: r.razon };
    });
  }

  agentesActividad(callerId: string, hoy: string) {
    return guarded(this.db, "agentes_actividad", async () => {
      const { rows } = await this.db.query<{
        vertical: string;
        role: string;
        llamadas_hist: string | number;
        costo_hist_micro_usd: string | number;
        fallback_hist: string | number;
        llamadas_30d: string | number;
        costo_30d_micro_usd: string | number;
        fallback_30d: string | number;
      }>(
        `select vertical, role, llamadas_hist, costo_hist_micro_usd, fallback_hist, llamadas_30d, costo_30d_micro_usd, fallback_30d
           from core.get_consola_agentes_actividad_for_superadmin($1, $2::date);`,
        [callerId, hoy],
      );
      return rows.map((r) => ({
        vertical: r.vertical,
        role: r.role,
        llamadasHist: num(r.llamadas_hist),
        costoHistMicroUsd: num(r.costo_hist_micro_usd),
        fallbackHist: num(r.fallback_hist),
        llamadas30d: num(r.llamadas_30d),
        costo30dMicroUsd: num(r.costo_30d_micro_usd),
        fallback30d: num(r.fallback_30d),
      }));
    });
  }
}

type SeedFuente = {
  organizaciones: FuenteConsola<readonly ConsolaOrganizacionRow[]>;
  costoDiario: FuenteConsola<readonly ConsolaCostoDiarioRow[]>;
  costoHistorico: FuenteConsola<readonly ConsolaCostoHistoricoRow[]>;
  operaciones: FuenteConsola<readonly ConsolaOperacionRow[]>;
  alcance: FuenteConsola<ConsolaAlcanceRow>;
  conversacionesWa: FuenteConsola<readonly ConsolaConversacionesWaRow[]>;
  resueltasSinHumano: FuenteConsola<ConsolaResueltasSinHumanoRow>;
  agentesActividad: FuenteConsola<readonly ConsolaAgenteActividadRow[]>;
};

const NO_MIGRADO = { ok: false, razon: "no_migrado" } as const;

/**
 * Adaptador en memoria para los tests de rutas. Cada fuente se siembra por separado (`seed`); sin sembrar, devuelve
 * `no_migrado` (la base sin migrar). Misma semantica de acceso que el SQL: un caller que no es superadmin recibe
 * resultados vacios (`ok: true` con cero filas) y `alcance`/`resueltasSinHumano` quedan `error` (cero filas).
 * `llamadas` registra los rangos pedidos para que un test pueda verificar el calculo de "hoy" y de la ventana.
 */
export class InMemoryConsolaRepository implements ConsolaRepository {
  private readonly superadmins = new Set<string>();
  private fuentes: SeedFuente = {
    organizaciones: NO_MIGRADO,
    costoDiario: NO_MIGRADO,
    costoHistorico: NO_MIGRADO,
    operaciones: NO_MIGRADO,
    alcance: NO_MIGRADO,
    conversacionesWa: NO_MIGRADO,
    resueltasSinHumano: NO_MIGRADO,
    agentesActividad: NO_MIGRADO,
  };
  readonly llamadas = {
    costoDiario: [] as Array<{ desde: string; hasta: string }>,
    operaciones: [] as Array<{ desde: string; hasta: string }>,
    resueltasSinHumano: [] as Array<{ desdeIso: string; hastaIso: string }>,
    agentesActividad: [] as string[],
  };

  seedSuperadmin(userId: string): void {
    this.superadmins.add(userId);
  }
  seed(parche: Partial<SeedFuente>): void {
    this.fuentes = { ...this.fuentes, ...parche };
  }

  private lectura<T extends readonly unknown[]>(callerId: string, f: FuenteConsola<T>): FuenteConsola<T> {
    if (!f.ok) return f;
    return this.superadmins.has(callerId) ? f : { ok: true, data: [] as unknown as T };
  }
  private unica<T>(callerId: string, f: FuenteConsola<T>): FuenteConsola<T> {
    if (!f.ok) return f;
    return this.superadmins.has(callerId) ? f : { ok: false, razon: "error" };
  }

  async organizaciones(callerId: string) {
    return this.lectura(callerId, this.fuentes.organizaciones);
  }
  async costoDiario(callerId: string, desde: string, hasta: string) {
    this.llamadas.costoDiario.push({ desde, hasta });
    return this.lectura(callerId, this.fuentes.costoDiario);
  }
  async costoHistorico(callerId: string) {
    return this.lectura(callerId, this.fuentes.costoHistorico);
  }
  async operaciones(callerId: string, desde: string, hasta: string) {
    this.llamadas.operaciones.push({ desde, hasta });
    return this.lectura(callerId, this.fuentes.operaciones);
  }
  async alcance(callerId: string) {
    return this.unica(callerId, this.fuentes.alcance);
  }
  async conversacionesWa(callerId: string) {
    return this.lectura(callerId, this.fuentes.conversacionesWa);
  }
  async resueltasSinHumano(callerId: string, desdeIso: string, hastaIso: string) {
    this.llamadas.resueltasSinHumano.push({ desdeIso, hastaIso });
    return this.unica(callerId, this.fuentes.resueltasSinHumano);
  }
  async agentesActividad(callerId: string, hoy: string) {
    this.llamadas.agentesActividad.push(hoy);
    return this.lectura(callerId, this.fuentes.agentesActividad);
  }
}
