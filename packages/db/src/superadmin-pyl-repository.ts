// Repositorio de la infraestructura compartida del P&L por vertical y cliente (SA-29) -- puerto
// contra las funciones `security definer` de packages/db/migrations/0032_superadmin_pyl_infra.sql.
// Las cifras de ingreso y costo del P&L NO pasan por aqui: salen de `CfoRepository` (0030).
//
// Ambos metodos son caller-bound (`withAppSession({ userId: callerId })`): esta clase no elige la
// sesion, recibe el `TenantDbSession` ya abierto.
//
// COMPATIBILIDAD CON LA BASE SIN MIGRAR: cada metodo corre bajo `runWithSavepointFallback`. Un
// SQLSTATE 42883/42P01/42703 (migracion 0032 sin aplicar) revierte SOLO el savepoint -- la
// transaccion de la sesion sigue viva para lo que el handler haga despues (el P&L lee el CFO en
// la misma transaccion) -- y devuelve `availability: "not_migrated"`; nunca un 500 ni un exito
// simulado. Los errores de negocio de SQL (42501, 22023...) se tipan como `SuperadminSeguridadError`.
import type { TenantDbSession } from "@atiende/core-tenancy";
import { isMigrationPendingError } from "./sql-errors.ts";
import { runWithSavepointFallback } from "./savepoint-fallback.ts";
import { SuperadminSeguridadError } from "./superadmin-seguridad-repository.ts";
import type { CostosAvailability } from "./superadmin-costos-planes-repository.ts";

export interface InfraCostRow {
  /** `YYYY-MM-01`. */
  readonly mes: string;
  readonly concepto: string;
  /** Centavos MXN enteros. */
  readonly montoMxnCentavos: number;
  readonly nota: string | null;
}

export interface PylRepository {
  /** CALLER. Conceptos de infra capturados entre dos meses (inclusive). */
  listInfraCosts(callerId: string, desde: string, hasta: string): Promise<{ availability: CostosAvailability; costs: readonly InfraCostRow[] }>;
  /** CALLER (superadmin). Captura o corrige un concepto del mes. */
  setInfraCost(callerId: string, mes: string, concepto: string, montoMxnCentavos: number, nota: string | null): Promise<{ availability: CostosAvailability }>;
}

let warned = false;
function warnOnce(): void {
  if (warned) return;
  warned = true;
  console.warn(
    "superadmin-pyl-repository: las funciones/tablas de 0032_superadmin_pyl_infra.sql no existen todavia " +
      "(SQLSTATE 42883/42P01/42703) -- degradando a 'sin infra capturada' (nunca 500, nunca exito simulado). Aplica la migracion " +
      "(o su espejo en supabase/migrations/) para capturar la infraestructura compartida del P&L.",
  );
}

function pgCode(err: unknown): string | undefined {
  return err && typeof err === "object" && "code" in err ? ((err as { code?: unknown }).code as string | undefined) : undefined;
}

function toTypedError(err: unknown): SuperadminSeguridadError | null {
  const message = err instanceof Error ? err.message : String(err);
  switch (pgCode(err)) {
    case "42501":
      return new SuperadminSeguridadError(message, "forbidden");
    case "22023":
    case "23514":
    case "22P02":
      return new SuperadminSeguridadError(message, "invalid");
    default:
      return null;
  }
}

async function guarded<TOk, TMissing>(db: TenantDbSession, run: () => Promise<TOk>, onMissing: () => TMissing): Promise<TOk | TMissing> {
  try {
    return await runWithSavepointFallback<TOk | TMissing>({
      session: db,
      primary: run,
      isRecoverable: (err) => isMigrationPendingError(err),
      fallback: async () => {
        warnOnce();
        return onMissing();
      },
    });
  } catch (err) {
    throw toTypedError(err) ?? err;
  }
}

const MES_RE = /^\d{4}-\d{2}-\d{2}$/u;

export class PostgresPylRepository implements PylRepository {
  constructor(private readonly db: TenantDbSession) {}

  listInfraCosts(callerId: string, desde: string, hasta: string) {
    return guarded(
      this.db,
      async () => {
        // `mes::text`: el driver `pg` devuelve `date` como Date a medianoche local (corre el dia segun la zona).
        const { rows } = await this.db.query<{ mes: string; concepto: string; monto_mxn_centavos: string | number; nota: string | null }>(
          `select mes::text as mes, concepto, monto_mxn_centavos, nota from core.list_infra_costs_for_superadmin($1, $2::date, $3::date);`,
          [callerId, desde, hasta],
        );
        return {
          availability: "available" as const,
          costs: rows.map((r): InfraCostRow => ({ mes: r.mes, concepto: r.concepto, montoMxnCentavos: Number(r.monto_mxn_centavos), nota: r.nota })),
        };
      },
      () => ({ availability: "not_migrated" as const, costs: [] as readonly InfraCostRow[] }),
    );
  }

  setInfraCost(callerId: string, mes: string, concepto: string, montoMxnCentavos: number, nota: string | null) {
    return guarded(
      this.db,
      async () => {
        await this.db.query(`select core.superadmin_set_infra_cost($1, $2::date, $3, $4::bigint, $5);`, [callerId, mes, concepto, montoMxnCentavos, nota]);
        return { availability: "available" as const };
      },
      () => ({ availability: "not_migrated" as const }),
    );
  }
}

/** Adaptador en memoria para los tests de rutas (misma semantica de acceso y validacion que el SQL). */
export class InMemoryPylRepository implements PylRepository {
  private readonly superadmins = new Set<string>();
  private readonly costs = new Map<string, InfraCostRow>();
  constructor(
    private readonly opciones: { readonly migrado?: boolean; readonly now?: () => number } = {},
  ) {}

  seedSuperadmin(userId: string): void {
    this.superadmins.add(userId);
  }
  seedCost(row: InfraCostRow): void {
    this.costs.set(`${row.mes}|${row.concepto.trim().toLowerCase()}`, row);
  }

  private get migrado(): boolean {
    return this.opciones.migrado ?? true;
  }

  async listInfraCosts(callerId: string, desde: string, hasta: string) {
    if (!this.migrado) return { availability: "not_migrated" as const, costs: [] as readonly InfraCostRow[] };
    if (!this.superadmins.has(callerId)) return { availability: "available" as const, costs: [] as readonly InfraCostRow[] };
    const costs = [...this.costs.values()]
      .filter((c) => c.mes.slice(0, 7) >= desde.slice(0, 7) && c.mes.slice(0, 7) <= hasta.slice(0, 7))
      .sort((a, b) => a.mes.localeCompare(b.mes) || a.concepto.toLowerCase().localeCompare(b.concepto.toLowerCase()));
    return { availability: "available" as const, costs };
  }

  async setInfraCost(callerId: string, mes: string, concepto: string, montoMxnCentavos: number, nota: string | null) {
    if (!this.migrado) return { availability: "not_migrated" as const };
    if (!this.superadmins.has(callerId)) throw new SuperadminSeguridadError("caller binding invalido o no es superadmin", "forbidden");
    if (!MES_RE.test(mes)) throw new SuperadminSeguridadError("mes invalido", "invalid");
    const mesPrimero = `${mes.slice(0, 7)}-01`;
    const hoy = new Date(this.opciones.now ? this.opciones.now() : Date.now()).toISOString().slice(0, 7);
    if (mesPrimero.slice(0, 7) > hoy) throw new SuperadminSeguridadError("el mes no puede ser futuro", "invalid");
    const c = concepto.trim();
    if (c.length < 2 || c.length > 80) throw new SuperadminSeguridadError("concepto obligatorio (2-80 caracteres)", "invalid");
    if (!Number.isInteger(montoMxnCentavos) || montoMxnCentavos < 0 || montoMxnCentavos > 100_000_000_000) throw new SuperadminSeguridadError("monto fuera de rango", "invalid");
    const n = nota === null ? null : nota.trim() === "" ? null : nota.trim();
    if (n !== null && n.length > 300) throw new SuperadminSeguridadError("nota de maximo 300 caracteres", "invalid");
    this.seedCost({ mes: mesPrimero, concepto: c, montoMxnCentavos, nota: n });
    return { availability: "available" as const };
  }
}
