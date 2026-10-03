// Repositorio de las fichas de agente y de Model Ops de la consola de superadmin (SA-L-09, SA-L-10) -- puerto contra las
// funciones `security definer` de packages/db/migrations/0049_superadmin_fichas_agente.sql.
//
// Mismo contrato que `superadmin-consola-repository.ts`:
//   * todos los metodos son caller-bound (`withAppSession({ userId: callerId })`); la clase recibe el `TenantDbSession` ya abierto
//     (una sola transaccion por request);
//   * CADA FUENTE FALLA POR SEPARADO: cada metodo corre bajo `runWithSavepointFallback`. Cualquier error SQL revierte SOLO su
//     savepoint y devuelve `{ ok: false, razon }`: `no_migrado` (SQLSTATE 42883/42P01/42703: 0049 sin aplicar) o `error` (cualquier
//     otro; solo se registra el SQLSTATE, nunca el mensaje). Nunca un 500 ni un valor simulado;
//   * los `date` se piden como texto (`::text`): el driver `pg` convierte `date` a Date a medianoche local y correria el dia.
import type { TenantDbSession } from "@atiende/core-tenancy";
import { isMigrationPendingError } from "./sql-errors.ts";
import { runWithSavepointFallback } from "./savepoint-fallback.ts";
import type { FuenteConsola } from "./superadmin-consola-repository.ts";

export interface FichaDocumentosExtraidosRow {
  /** Documentos de bases distintos con al menos un requisito extraido por el LLM (no invalidado). `null` + `razon` = sin fuente. */
  readonly documentos: number | null;
  readonly requisitos: number | null;
  readonly licitaciones: number | null;
  readonly razon: "fuente_no_migrada" | null;
}
export interface FichaConciliadosRow {
  readonly movimientosConciliados: number | null;
  readonly porMotor: number | null;
  readonly porLlmAprobado: number | null;
  readonly porManual: number | null;
  readonly sugerenciasPendientes: number | null;
  readonly sugerenciasTotal: number | null;
  readonly razon: "fuente_no_migrada" | null;
}
export interface FichaVozVerticalRow {
  readonly vertical: string;
  readonly minutosVoz: number;
  readonly costoMicroUsd: number;
  readonly eventos: number;
}
export interface FichaActividadDiariaRow {
  /** `YYYY-MM-DD`. Solo dias CON consumo. */
  readonly dia: string;
  readonly vertical: string;
  readonly role: string;
  readonly llamadas: number;
  readonly costoMicroUsd: number;
  readonly fallbacks: number;
}
export interface FichaModeloRolRow {
  readonly vertical: string;
  readonly role: string;
  readonly providerId: string;
  readonly model: string;
  readonly lane: string;
  readonly llamadas: number;
  readonly fallbacks: number;
  readonly costoMicroUsd: number;
  readonly tokensIn: number;
  readonly tokensOut: number;
}

export interface FichasAgenteRepository {
  /** CALLER. Documentos y requisitos extraidos por el LLM (licitaciones). */
  documentosExtraidos(callerId: string): Promise<FuenteConsola<FichaDocumentosExtraidosRow>>;
  /** CALLER. Movimientos conciliados vigentes por origen y sugerencias del nivel 4 (despachos). */
  conciliados(callerId: string): Promise<FuenteConsola<FichaConciliadosRow>>;
  /** CALLER. Minutos y costo de voz por vertical (solo verticales con eventos de voz). */
  vozPorVertical(callerId: string): Promise<FuenteConsola<readonly FichaVozVerticalRow[]>>;
  /** CALLER. Serie diaria por vertical y rol; `desde`/`hasta` = `YYYY-MM-DD` inclusivos, maximo 400 dias. */
  actividadDiaria(callerId: string, desde: string, hasta: string): Promise<FuenteConsola<readonly FichaActividadDiariaRow[]>>;
  /** CALLER. Llamadas, fallbacks, costo y tokens por vertical, rol, proveedor, modelo y carril del rango. */
  modelosPorRol(callerId: string, desde: string, hasta: string): Promise<FuenteConsola<readonly FichaModeloRolRow[]>>;
}

let warned = false;
function warnOnce(): void {
  if (warned) return;
  warned = true;
  console.warn(
    "superadmin-fichas-agente-repository: las funciones de 0049_superadmin_fichas_agente.sql no existen todavia " +
      "(SQLSTATE 42883/42P01/42703) -- degradando a 'no disponible aun' por fuente (nunca 500, nunca exito simulado). Aplica la migracion " +
      "(o su espejo en supabase/migrations/) para habilitar las fichas de agente y Model Ops de la consola.",
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
      console.error(`superadmin-fichas-agente-repository: la fuente '${fuente}' fallo (SQLSTATE ${pgCode(err)}); ese campo queda en null.`);
      return { ok: false as const, razon: "error" as const };
    },
  });
}

const num = (v: string | number | null | undefined): number => Number(v ?? 0);
const numOrNull = (v: string | number | null | undefined): number | null => (v === null || v === undefined ? null : Number(v));
const sinFilas = (fn: string): Error => Object.assign(new Error(`${fn} devolvio cero filas`), { code: "sin_filas" });

export class PostgresFichasAgenteRepository implements FichasAgenteRepository {
  constructor(private readonly db: TenantDbSession) {}

  documentosExtraidos(callerId: string) {
    return guarded(this.db, "documentos_extraidos", async () => {
      const { rows } = await this.db.query<{ documentos: string | number | null; requisitos: string | number | null; licitaciones: string | number | null; razon: FichaDocumentosExtraidosRow["razon"] }>(
        `select documentos, requisitos, licitaciones, razon from core.get_fichas_documentos_extraidos_for_superadmin($1);`,
        [callerId],
      );
      const r = rows[0];
      // Cero filas = el SQL no reconocio al caller como superadmin: no es "0 documentos", es una lectura fallida.
      if (!r) throw sinFilas("get_fichas_documentos_extraidos_for_superadmin");
      return { documentos: numOrNull(r.documentos), requisitos: numOrNull(r.requisitos), licitaciones: numOrNull(r.licitaciones), razon: r.razon };
    });
  }

  conciliados(callerId: string) {
    return guarded(this.db, "conciliados", async () => {
      const { rows } = await this.db.query<{
        movimientos_conciliados: string | number | null;
        por_motor: string | number | null;
        por_llm_aprobado: string | number | null;
        por_manual: string | number | null;
        sugerencias_pendientes: string | number | null;
        sugerencias_total: string | number | null;
        razon: FichaConciliadosRow["razon"];
      }>(
        `select movimientos_conciliados, por_motor, por_llm_aprobado, por_manual, sugerencias_pendientes, sugerencias_total, razon
           from core.get_fichas_conciliados_for_superadmin($1);`,
        [callerId],
      );
      const r = rows[0];
      if (!r) throw sinFilas("get_fichas_conciliados_for_superadmin");
      return {
        movimientosConciliados: numOrNull(r.movimientos_conciliados),
        porMotor: numOrNull(r.por_motor),
        porLlmAprobado: numOrNull(r.por_llm_aprobado),
        porManual: numOrNull(r.por_manual),
        sugerenciasPendientes: numOrNull(r.sugerencias_pendientes),
        sugerenciasTotal: numOrNull(r.sugerencias_total),
        razon: r.razon,
      };
    });
  }

  vozPorVertical(callerId: string) {
    return guarded(this.db, "voz_por_vertical", async () => {
      const { rows } = await this.db.query<{ vertical: string; minutos_voz: string | number; costo_micro_usd: string | number; eventos: string | number }>(
        `select vertical, minutos_voz, costo_micro_usd, eventos from core.get_fichas_voz_por_vertical_for_superadmin($1);`,
        [callerId],
      );
      return rows.map((r) => ({ vertical: r.vertical, minutosVoz: num(r.minutos_voz), costoMicroUsd: num(r.costo_micro_usd), eventos: num(r.eventos) }));
    });
  }

  actividadDiaria(callerId: string, desde: string, hasta: string) {
    return guarded(this.db, "actividad_diaria", async () => {
      const { rows } = await this.db.query<{ dia: string; vertical: string; role: string; llamadas: string | number; costo_micro_usd: string | number; fallbacks: string | number }>(
        `select dia::text as dia, vertical, role, llamadas, costo_micro_usd, fallbacks from core.get_fichas_actividad_diaria_for_superadmin($1, $2::date, $3::date);`,
        [callerId, desde, hasta],
      );
      return rows.map((r) => ({ dia: r.dia, vertical: r.vertical, role: r.role, llamadas: num(r.llamadas), costoMicroUsd: num(r.costo_micro_usd), fallbacks: num(r.fallbacks) }));
    });
  }

  modelosPorRol(callerId: string, desde: string, hasta: string) {
    return guarded(this.db, "modelos_por_rol", async () => {
      const { rows } = await this.db.query<{
        vertical: string;
        role: string;
        provider_id: string;
        model: string;
        lane: string;
        llamadas: string | number;
        fallbacks: string | number;
        costo_micro_usd: string | number;
        tokens_in: string | number;
        tokens_out: string | number;
      }>(
        `select vertical, role, provider_id, model, lane, llamadas, fallbacks, costo_micro_usd, tokens_in, tokens_out
           from core.get_fichas_modelos_por_rol_for_superadmin($1, $2::date, $3::date);`,
        [callerId, desde, hasta],
      );
      return rows.map((r) => ({
        vertical: r.vertical,
        role: r.role,
        providerId: r.provider_id,
        model: r.model,
        lane: r.lane,
        llamadas: num(r.llamadas),
        fallbacks: num(r.fallbacks),
        costoMicroUsd: num(r.costo_micro_usd),
        tokensIn: num(r.tokens_in),
        tokensOut: num(r.tokens_out),
      }));
    });
  }
}

type SeedFuente = {
  documentosExtraidos: FuenteConsola<FichaDocumentosExtraidosRow>;
  conciliados: FuenteConsola<FichaConciliadosRow>;
  vozPorVertical: FuenteConsola<readonly FichaVozVerticalRow[]>;
  actividadDiaria: FuenteConsola<readonly FichaActividadDiariaRow[]>;
  modelosPorRol: FuenteConsola<readonly FichaModeloRolRow[]>;
};

const NO_MIGRADO = { ok: false, razon: "no_migrado" } as const;

/**
 * Adaptador en memoria para los tests de rutas. Cada fuente se siembra por separado (`seed`); sin sembrar, devuelve `no_migrado`
 * (la base sin migrar). Misma semantica de acceso que el SQL: un caller que no es superadmin recibe resultados vacios en las listas
 * (`ok: true` con cero filas) y `error` en las fuentes de una sola fila (cero filas). `llamadas` registra los rangos pedidos.
 */
export class InMemoryFichasAgenteRepository implements FichasAgenteRepository {
  private readonly superadmins = new Set<string>();
  private fuentes: SeedFuente = {
    documentosExtraidos: NO_MIGRADO,
    conciliados: NO_MIGRADO,
    vozPorVertical: NO_MIGRADO,
    actividadDiaria: NO_MIGRADO,
    modelosPorRol: NO_MIGRADO,
  };
  readonly llamadas = {
    actividadDiaria: [] as Array<{ desde: string; hasta: string }>,
    modelosPorRol: [] as Array<{ desde: string; hasta: string }>,
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

  async documentosExtraidos(callerId: string) {
    return this.unica(callerId, this.fuentes.documentosExtraidos);
  }
  async conciliados(callerId: string) {
    return this.unica(callerId, this.fuentes.conciliados);
  }
  async vozPorVertical(callerId: string) {
    return this.lectura(callerId, this.fuentes.vozPorVertical);
  }
  async actividadDiaria(callerId: string, desde: string, hasta: string) {
    this.llamadas.actividadDiaria.push({ desde, hasta });
    return this.lectura(callerId, this.fuentes.actividadDiaria);
  }
  async modelosPorRol(callerId: string, desde: string, hasta: string) {
    this.llamadas.modelosPorRol.push({ desde, hasta });
    return this.lectura(callerId, this.fuentes.modelosPorRol);
  }
}
