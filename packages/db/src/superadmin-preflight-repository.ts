// Repositorio de los hechos de datos del "Listo para produccion" de una organizacion (go-live G-05/G-16) -- puerto contra
// `core.get_org_preflight_restaurantes_for_superadmin` de packages/db/migrations/0057_superadmin_preflight_organizacion.sql.
//
// SOLO LECTURA y caller-bound (`withAppSession({ userId: callerId })`): esta clase no elige la sesion, recibe el `TenantDbSession` ya abierto.
//
// COMPATIBILIDAD CON LA BASE SIN MIGRAR: la lectura corre bajo `runWithSavepointFallback`; contra una base sin la 0057 (SQLSTATE
// 42883/42P01/42703) devuelve `{ ok: false, razon: "no_migrado" }` y la transaccion sigue utilizable (nunca 500). Cualquier otro error SQL
// (incluido el 42501 de un llamador que no es superadmin) devuelve `{ ok: false, razon: "error" }` y solo se registra su SQLSTATE.
import type { TenantDbSession } from "@atiende/core-tenancy";
import { isMigrationPendingError } from "./sql-errors.ts";
import { runWithSavepointFallback } from "./savepoint-fallback.ts";
import type { FuenteConsola } from "./superadmin-consola-repository.ts";

export type PreflightVoz = "habilitada" | "deshabilitada" | "sin_configurar";

export interface PreflightSucursalHechos {
  readonly id: string;
  readonly nombre: string;
  readonly activa: boolean;
  readonly conCoordenadas: boolean;
  readonly productosDisponibles: number;
  /** jsonb crudo de `restaurantes.branch_policy.horario` (null = sin politica); lo interpreta `leerHorarioPersistido`. */
  readonly horario: unknown;
  readonly conPedidoMinimoDomicilio: boolean;
  readonly zonasDeEntrega: number;
  readonly conWhatsappPropio: boolean;
  readonly voz: PreflightVoz;
}

export interface PreflightRestaurantesHechos {
  /** Cada bloque en `null` = no se pudo medir en este despliegue (tabla o columna ausente); nunca un cero inventado. */
  readonly sucursales: readonly PreflightSucursalHechos[] | null;
  readonly whatsappGeneral: boolean | null;
  readonly agente: { readonly configurada: boolean; readonly conNombre: boolean } | null;
  readonly hayPedidos: boolean | null;
  readonly privacidad: {
    readonly configurada: boolean;
    readonly conResponsable: boolean;
    readonly conAviso: boolean;
    readonly version: string | null;
    readonly avisosPublicados: number;
  } | null;
}

export interface OrgPreflightHechos {
  readonly vertical: string;
  /** `null` = la vertical de la organizacion no es restaurantes. */
  readonly restaurantes: PreflightRestaurantesHechos | null;
}

export interface OrgPreflightRepository {
  /** CALLER (superadmin). `data = null` = la organizacion no existe. */
  hechos(callerId: string, organizationId: string): Promise<FuenteConsola<OrgPreflightHechos | null>>;
}

let warned = false;
function pgCode(err: unknown): string {
  return err && typeof err === "object" && "code" in err ? String((err as { code?: unknown }).code) : "desconocido";
}

export class PostgresOrgPreflightRepository implements OrgPreflightRepository {
  constructor(private readonly db: TenantDbSession) {}

  hechos(callerId: string, organizationId: string): Promise<FuenteConsola<OrgPreflightHechos | null>> {
    return runWithSavepointFallback<FuenteConsola<OrgPreflightHechos | null>>({
      session: this.db,
      savepointName: "sp_superadmin_preflight_hechos",
      primary: async () => {
        const { rows } = await this.db.query<{ hechos: OrgPreflightHechos | null }>(
          `select core.get_org_preflight_restaurantes_for_superadmin($1, $2::uuid) as hechos;`,
          [callerId, organizationId],
        );
        return { ok: true as const, data: rows[0]?.hechos ?? null };
      },
      isRecoverable: () => true,
      fallback: async (err) => {
        if (isMigrationPendingError(err)) {
          if (!warned) {
            warned = true;
            console.warn(
              "superadmin-preflight-repository: core.get_org_preflight_restaurantes_for_superadmin no existe todavia (SQLSTATE 42883/42P01/42703) -- " +
                "las verificaciones de datos quedan 'no disponible aun' (nunca 500). Aplica la migracion 0057_superadmin_preflight_organizacion " +
                "(o su espejo en supabase/migrations/).",
            );
          }
          return { ok: false as const, razon: "no_migrado" as const };
        }
        console.error(`superadmin-preflight-repository: la lectura de hechos fallo (SQLSTATE ${pgCode(err)}).`);
        return { ok: false as const, razon: "error" as const };
      },
    });
  }
}

/** Adaptador en memoria para los tests de rutas: un llamador que no es superadmin recibe `error` (como el 42501 real). */
export class InMemoryOrgPreflightRepository implements OrgPreflightRepository {
  private readonly superadmins = new Set<string>();
  private readonly organizaciones = new Map<string, OrgPreflightHechos>();
  private fuente: { readonly ok: false; readonly razon: "no_migrado" | "error" } | null = null;
  readonly llamadas: Array<{ callerId: string; organizationId: string }> = [];

  seedSuperadmin(userId: string): void {
    this.superadmins.add(userId);
  }
  seedOrganizacion(organizationId: string, hechos: OrgPreflightHechos): void {
    this.organizaciones.set(organizationId, hechos);
  }
  /** Simula la base sin migrar (`no_migrado`) o un fallo de la lectura (`error`). */
  fallar(razon: "no_migrado" | "error" | null): void {
    this.fuente = razon === null ? null : { ok: false, razon };
  }

  async hechos(callerId: string, organizationId: string): Promise<FuenteConsola<OrgPreflightHechos | null>> {
    this.llamadas.push({ callerId, organizationId });
    if (this.fuente) return this.fuente;
    if (!this.superadmins.has(callerId)) return { ok: false, razon: "error" };
    return { ok: true, data: this.organizaciones.get(organizationId) ?? null };
  }
}
