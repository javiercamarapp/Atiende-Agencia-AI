// Repositorio de la bitacora de corridas (SA-L-07) y del panel de agentes (SA-L-08) -- puerto contra las funciones
// `security definer` de packages/db/migrations/0044_superadmin_corridas_y_panel_agentes.sql.
//
// SESIONES: la escritura (`registrarCorrida`) y la purga son SOLO-SISTEMA y el llamador abre una transaccion PROPIA
// por llamada (`engine.withAppSession({ userId: null }, ...)`), de modo que un fallo al escribir la bitacora nunca
// toca la transaccion de otra operacion. Las lecturas son caller-bound (`{ userId: callerId }`).
//
// BASE SIN MIGRAR: cada metodo corre bajo `runWithSavepointFallback`. Un SQLSTATE 42883/42P01/42703 (la 0044 aun no
// aplicada) deja `{ ok: false, razon: "no_migrado" }` (lecturas) o `"no_migrado"` (escritura) y la sesion viva;
// cualquier otro error SQL en una lectura queda `{ ok: false, razon: "error" }` y en la escritura se propaga para que
// el llamador lo registre. Nunca un 500 ni un valor inventado.
//
// Los timestamps salen como ISO (`Date.toISOString()`); los bigint de Postgres llegan como texto y se convierten.
import type { TenantDbSession } from "@atiende/core-tenancy";
import { isMigrationPendingError } from "./sql-errors.ts";
import { runWithSavepointFallback } from "./savepoint-fallback.ts";

export type FuenteAgentes<T> = { readonly ok: true; readonly data: T } | { readonly ok: false; readonly razon: "no_migrado" | "error" };

export type DisparoCorrida = "cron" | "whatsapp" | "voz" | "manual";
export type EstadoCorrida = "ok" | "parcial" | "fallo";
export type EstadoAgente = "vivo" | "pausado" | "disenado" | "retirado";

export interface RegistrarCorridaInput {
  /** Rol del gateway (`restaurantes:whatsapp_agent`) o ruta exacta del cron (`/internal/...`). */
  readonly agente: string;
  readonly vertical: string;
  readonly organizationId: string | null;
  readonly disparo: DisparoCorrida;
  readonly estado: EstadoCorrida;
  /** null = no medido. */
  readonly tareasHechas: number | null;
  readonly tareasTotal: number | null;
  /** micro-USD; null = no medido. */
  readonly costoMicroUsd: number | null;
  /** YA redactado (ver apps/api/src/agentes/corridas.ts); la base lo redacta de nuevo como defensa en profundidad. */
  readonly error: string | null;
  readonly iniciadoEn: Date;
  readonly terminadoEn: Date;
}

export interface AgentRunRow {
  readonly id: string;
  readonly agente: string;
  readonly vertical: string;
  readonly organizationId: string | null;
  readonly disparo: DisparoCorrida;
  readonly estado: EstadoCorrida;
  readonly tareasHechas: number | null;
  readonly tareasTotal: number | null;
  readonly costoMicroUsd: number | null;
  readonly error: string | null;
  readonly iniciadoEn: string;
  readonly terminadoEn: string;
  readonly duracionMs: number;
}

export interface FiltrosCorridas {
  readonly agente?: string | null;
  readonly vertical?: string | null;
  readonly estado?: EstadoCorrida | null;
  readonly desde?: Date | null;
  readonly hasta?: Date | null;
  readonly limite?: number;
}

export interface AgentPanelRow {
  readonly id: string;
  readonly nombre: string;
  readonly vertical: string;
  readonly canal: string;
  readonly disparador: string;
  readonly modeloRol: string;
  readonly presupuestoDiaMicroUsd: number | null;
  readonly estado: EstadoAgente;
  readonly ultimaCorridaEn: string | null;
  readonly ultimaCorridaEstado: EstadoCorrida | null;
  readonly corridas30d: number;
  readonly corridasOk30d: number;
  readonly llamadas30d: number;
  readonly costo30dMicroUsd: number;
}

export interface AgentRunRepository {
  /** SISTEMA. Una fila en core.agent_run. `"no_migrado"` = la 0044 aun no esta aplicada (no se escribio nada). */
  registrarCorrida(input: RegistrarCorridaInput): Promise<"registrada" | "no_migrado">;
  /** SISTEMA. `true` si el catalogo marca al agente 'vivo'; `null` = la 0044 aun no esta aplicada. */
  agenteVivo(agente: string): Promise<boolean | null>;
  /** SISTEMA. Borra por lotes lo anterior a la retencion; devuelve cuantas filas borro (null = no migrado). */
  purgarCorridas(lote: number): Promise<number | null>;
  /** CALLER. Bitacora filtrable (maximo 200 filas, mas recientes primero). */
  listarCorridas(callerId: string, filtros: FiltrosCorridas): Promise<FuenteAgentes<readonly AgentRunRow[]>>;
  /** CALLER. Una fila por agente del catalogo; `hoy` = `YYYY-MM-DD` (dia de Mexico). */
  panel(callerId: string, hoy: string): Promise<FuenteAgentes<readonly AgentPanelRow[]>>;
}

let warned = false;
function warnOnce(): void {
  if (warned) return;
  warned = true;
  console.warn(
    "superadmin-agentes-repository: las funciones de 0044_superadmin_corridas_y_panel_agentes.sql no existen todavia " +
      "(SQLSTATE 42883/42P01/42703) -- la bitacora de corridas y el panel degradan a 'no disponible aun' (nunca 500). " +
      "Aplica la migracion (o su espejo en supabase/migrations/) para habilitarlos.",
  );
}

function pgCode(err: unknown): string {
  return err && typeof err === "object" && "code" in err ? String((err as { code?: unknown }).code) : "desconocido";
}

const num = (v: string | number | null | undefined): number => Number(v ?? 0);
const numOrNull = (v: string | number | null | undefined): number | null => (v === null || v === undefined ? null : Number(v));
const iso = (v: Date | string): string => (v instanceof Date ? v.toISOString() : new Date(v).toISOString());
const isoOrNull = (v: Date | string | null | undefined): string | null => (v === null || v === undefined ? null : iso(v));

async function guarded<T>(db: TenantDbSession, fuente: string, run: () => Promise<T>): Promise<FuenteAgentes<T>> {
  return runWithSavepointFallback<FuenteAgentes<T>>({
    session: db,
    primary: async () => ({ ok: true as const, data: await run() }),
    isRecoverable: () => true,
    fallback: async (err) => {
      if (isMigrationPendingError(err)) {
        warnOnce();
        return { ok: false as const, razon: "no_migrado" as const };
      }
      console.error(`superadmin-agentes-repository: la fuente '${fuente}' fallo (SQLSTATE ${pgCode(err)}); ese campo queda no disponible.`);
      return { ok: false as const, razon: "error" as const };
    },
  });
}

interface RunSqlRow {
  id: string;
  agente: string;
  vertical: string;
  organization_id: string | null;
  disparo: DisparoCorrida;
  estado: EstadoCorrida;
  tareas_hechas: number | string | null;
  tareas_total: number | string | null;
  costo_micro_usd: number | string | null;
  error: string | null;
  iniciado_en: Date | string;
  terminado_en: Date | string;
  duracion_ms: number | string;
}

interface PanelSqlRow {
  id: string;
  nombre: string;
  vertical: string;
  canal: string;
  disparador: string;
  modelo_rol: string;
  presupuesto_dia_micro_usd: number | string | null;
  estado: EstadoAgente;
  ultima_corrida_en: Date | string | null;
  ultima_corrida_estado: EstadoCorrida | null;
  corridas_30d: number | string;
  corridas_ok_30d: number | string;
  llamadas_30d: number | string;
  costo_30d_micro_usd: number | string;
}

export class PostgresAgentRunRepository implements AgentRunRepository {
  constructor(private readonly db: TenantDbSession) {}

  async registrarCorrida(input: RegistrarCorridaInput): Promise<"registrada" | "no_migrado"> {
    return runWithSavepointFallback<"registrada" | "no_migrado">({
      session: this.db,
      primary: async () => {
        await this.db.query(`select core.record_agent_run($1, $2, $3::uuid, $4, $5, $6::int, $7::int, $8::bigint, $9, $10::timestamptz, $11::timestamptz);`, [
          input.agente,
          input.vertical,
          input.organizationId,
          input.disparo,
          input.estado,
          input.tareasHechas,
          input.tareasTotal,
          input.costoMicroUsd,
          input.error,
          input.iniciadoEn.toISOString(),
          input.terminadoEn.toISOString(),
        ]);
        return "registrada" as const;
      },
      isRecoverable: (err) => isMigrationPendingError(err),
      fallback: async () => {
        warnOnce();
        return "no_migrado" as const;
      },
    });
  }

  async agenteVivo(agente: string): Promise<boolean | null> {
    return runWithSavepointFallback<boolean | null>({
      session: this.db,
      primary: async () => {
        const { rows } = await this.db.query<{ vivo: boolean }>(`select core.system_agent_is_live($1) as vivo;`, [agente]);
        return rows[0]?.vivo === true;
      },
      isRecoverable: (err) => isMigrationPendingError(err),
      fallback: async () => null,
    });
  }

  async purgarCorridas(lote: number): Promise<number | null> {
    return runWithSavepointFallback<number | null>({
      session: this.db,
      primary: async () => {
        const { rows } = await this.db.query<{ borradas: number | string }>(`select core.system_purge_agent_runs($1::int) as borradas;`, [lote]);
        return num(rows[0]?.borradas);
      },
      isRecoverable: (err) => isMigrationPendingError(err),
      fallback: async () => null,
    });
  }

  listarCorridas(callerId: string, f: FiltrosCorridas) {
    return guarded(this.db, "corridas", async () => {
      const { rows } = await this.db.query<RunSqlRow>(
        `select id, agente, vertical, organization_id, disparo, estado, tareas_hechas, tareas_total, costo_micro_usd, error, iniciado_en, terminado_en, duracion_ms
           from core.list_agent_runs_for_superadmin($1::uuid, $2, $3, $4, $5::timestamptz, $6::timestamptz, $7::int);`,
        [callerId, f.agente ?? null, f.vertical ?? null, f.estado ?? null, f.desde ? f.desde.toISOString() : null, f.hasta ? f.hasta.toISOString() : null, f.limite ?? 50],
      );
      return rows.map(
        (r): AgentRunRow => ({
          id: r.id,
          agente: r.agente,
          vertical: r.vertical,
          organizationId: r.organization_id,
          disparo: r.disparo,
          estado: r.estado,
          tareasHechas: numOrNull(r.tareas_hechas),
          tareasTotal: numOrNull(r.tareas_total),
          costoMicroUsd: numOrNull(r.costo_micro_usd),
          error: r.error,
          iniciadoEn: iso(r.iniciado_en),
          terminadoEn: iso(r.terminado_en),
          duracionMs: num(r.duracion_ms),
        }),
      );
    });
  }

  panel(callerId: string, hoy: string) {
    return guarded(this.db, "panel_agentes", async () => {
      const { rows } = await this.db.query<PanelSqlRow>(
        `select id, nombre, vertical, canal, disparador, modelo_rol, presupuesto_dia_micro_usd, estado, ultima_corrida_en, ultima_corrida_estado,
                corridas_30d, corridas_ok_30d, llamadas_30d, costo_30d_micro_usd
           from core.get_agent_panel_for_superadmin($1::uuid, $2::date);`,
        [callerId, hoy],
      );
      return rows.map(
        (r): AgentPanelRow => ({
          id: r.id,
          nombre: r.nombre,
          vertical: r.vertical,
          canal: r.canal,
          disparador: r.disparador,
          modeloRol: r.modelo_rol,
          presupuestoDiaMicroUsd: numOrNull(r.presupuesto_dia_micro_usd),
          estado: r.estado,
          ultimaCorridaEn: isoOrNull(r.ultima_corrida_en),
          ultimaCorridaEstado: r.ultima_corrida_estado,
          corridas30d: num(r.corridas_30d),
          corridasOk30d: num(r.corridas_ok_30d),
          llamadas30d: num(r.llamadas_30d),
          costo30dMicroUsd: num(r.costo_30d_micro_usd),
        }),
      );
    });
  }
}

const NO_MIGRADO = { ok: false, razon: "no_migrado" } as const;

/**
 * Adaptador en memoria para los tests de rutas y de withHeartbeat. Sin sembrar, `panel` devuelve `no_migrado`
 * (la base sin migrar); `listarCorridas` devuelve las corridas registradas con `registrarCorrida` (o las sembradas).
 * Misma semantica de acceso que el SQL: un caller que no es superadmin recibe cero filas. `falloEscritura` permite
 * probar que una bitacora rota nunca tumba la corrida.
 */
export class InMemoryAgentRunRepository implements AgentRunRepository {
  private readonly superadmins = new Set<string>();
  private panelSembrado: FuenteAgentes<readonly AgentPanelRow[]> = NO_MIGRADO;
  private corridasSembradas: FuenteAgentes<readonly AgentRunRow[]> | null = null;
  readonly registradas: RegistrarCorridaInput[] = [];
  readonly llamadasPanel: string[] = [];
  readonly llamadasListar: FiltrosCorridas[] = [];
  /** Si se define, `registrarCorrida` lanza este error (simula una bitacora caida). */
  falloEscritura: Error | null = null;
  /** `true` simula la base sin migrar para la escritura. */
  sinMigrar = false;
  purgas = 0;

  seedSuperadmin(userId: string): void {
    this.superadmins.add(userId);
  }
  readonly vivos = new Set<string>();
  seedPanel(p: FuenteAgentes<readonly AgentPanelRow[]>): void {
    this.panelSembrado = p;
  }
  seedCorridas(c: FuenteAgentes<readonly AgentRunRow[]>): void {
    this.corridasSembradas = c;
  }

  async registrarCorrida(input: RegistrarCorridaInput): Promise<"registrada" | "no_migrado"> {
    if (this.falloEscritura) throw this.falloEscritura;
    if (this.sinMigrar) return "no_migrado";
    this.registradas.push(input);
    return "registrada";
  }

  async agenteVivo(agente: string): Promise<boolean | null> {
    if (this.sinMigrar) return null;
    return this.vivos.has(agente);
  }

  async purgarCorridas(_lote: number): Promise<number | null> {
    if (this.sinMigrar) return null;
    this.purgas += 1;
    return 0;
  }

  async listarCorridas(callerId: string, filtros: FiltrosCorridas): Promise<FuenteAgentes<readonly AgentRunRow[]>> {
    this.llamadasListar.push(filtros);
    if (this.sinMigrar) return NO_MIGRADO;
    if (!this.superadmins.has(callerId)) return { ok: true, data: [] };
    if (this.corridasSembradas) return this.corridasSembradas;
    const filas = this.registradas
      .filter((r) => (!filtros.agente || r.agente === filtros.agente) && (!filtros.vertical || r.vertical === filtros.vertical) && (!filtros.estado || r.estado === filtros.estado))
      .map(
        (r, i): AgentRunRow => ({
          id: `run-${i}`,
          agente: r.agente,
          vertical: r.vertical,
          organizationId: r.organizationId,
          disparo: r.disparo,
          estado: r.estado,
          tareasHechas: r.tareasHechas,
          tareasTotal: r.tareasTotal,
          costoMicroUsd: r.costoMicroUsd,
          error: r.error,
          iniciadoEn: r.iniciadoEn.toISOString(),
          terminadoEn: r.terminadoEn.toISOString(),
          duracionMs: r.terminadoEn.getTime() - r.iniciadoEn.getTime(),
        }),
      );
    return { ok: true, data: filas };
  }

  async panel(callerId: string, hoy: string): Promise<FuenteAgentes<readonly AgentPanelRow[]>> {
    this.llamadasPanel.push(hoy);
    if (!this.panelSembrado.ok) return this.panelSembrado;
    return this.superadmins.has(callerId) ? this.panelSembrado : { ok: true, data: [] };
  }
}
