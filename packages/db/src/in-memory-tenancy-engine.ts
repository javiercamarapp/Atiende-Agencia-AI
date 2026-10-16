// InMemoryTenancyEngine — implementación real (no un mock) de
// `@atiende/core-tenancy::TenancyEngine`/`TenantDbSession`, de alcance DELIBERADAMENTE
// angosto: packages/db todavía no tiene un motor de conexión real (PGlite/
// embedded-postgres/Postgres gestionado — ver README.md, "Aún no portado"), así que
// ninguna ruta autenticada de staff (`authMiddleware` + `dbSession` +
// `requirePropertyMembership`, ver @atiende/core-auth/src/middleware.ts) podía
// probarse de punta a punta hasta ahora. Esto es lo mínimo que las Fase 1 que SÍ
// requieren rutas de staff autenticado (domain-hoteles: folios/pedidos-fnb/quotes)
// necesitan para funcionar en tests/dev sin Postgres real.
//
// Alcance angosto A PROPÓSITO: `query()` solo reconoce la ÚNICA forma de consulta SQL
// que `requirePropertyMembership()` emite (join `core.membership`/`core.property`
// resolviendo membership de un usuario sobre una property concreta) — no es un motor
// SQL de propósito general. Cualquier lectura/escritura de negocio de un
// domain-<vertical> sigue pasando por su propio `HotelesRepository`/
// `RestaurantesRepository` (nunca por este engine) — ver diseño Fase 1 hoteles §3.2.
// Un motor real de propósito general (que sí pueda correr las migraciones SQL de
// packages/domain-*/migrations/ contra Postgres real) sigue siendo trabajo pendiente
// de infraestructura de packages/db, no de esta vertical.
import type { PlatformRole, TenancyEngine, TenantDbSession } from "@atiende/core-tenancy";

export interface SeedTenancyProperty {
  readonly id: string;
  readonly organizationId: string;
}

export interface SeedTenancyMembership {
  readonly userId: string;
  readonly organizationId: string;
  /** null = acceso a TODAS las properties de la organización. */
  readonly propertyIds: readonly string[] | null;
  readonly platformRole: PlatformRole;
  readonly verticalRole: string;
}

interface MembershipQueryRow {
  organization_id: string;
  platform_role: PlatformRole;
  vertical_role: string;
}

function isMembershipPropertyJoinQuery(sql: string): boolean {
  const normalized = sql.toLowerCase();
  return normalized.includes("from core.membership") && normalized.includes("join core.property");
}

export class InMemoryTenancyEngine implements TenancyEngine {
  private readonly properties = new Map<string, SeedTenancyProperty>();
  private readonly memberships: SeedTenancyMembership[] = [];
  /** SA-L-46: lista de supresion de plataforma (core.supresion_contacto), solo `tipo:hash` (como la real). */
  private readonly suprimidos = new Set<string>();
  private readonly plantillasAprobadas = new Set<string>();

  seedProperty(property: SeedTenancyProperty): void {
    this.properties.set(property.id, property);
  }

  /** PL-31: declara una plantilla aprobada de una organizacion (solo pruebas). */
  seedPlantillaAprobada(organizationId: string, nombre: string): void {
    this.plantillasAprobadas.add(`${organizationId}:${nombre}`);
  }

  seedMembership(membership: SeedTenancyMembership): void {
    this.memberships.push(membership);
  }

  async withAppSession<T>(claims: { userId: string | null }, fn: (session: TenantDbSession) => Promise<T>): Promise<T> {
    const session: TenantDbSession = {
      query: async <R>(sql: string, params: unknown[] = []) => {
        if (isMembershipPropertyJoinQuery(sql)) {
          const propertyId = params[0] as string | undefined;
          if (!propertyId) return { rows: [] };
          const property = this.properties.get(propertyId);
          if (!property || claims.userId == null) return { rows: [] };
          const rows: MembershipQueryRow[] = this.memberships
            .filter(
              (m) =>
                m.userId === claims.userId &&
                m.organizationId === property.organizationId &&
                (m.propertyIds === null || m.propertyIds.includes(propertyId)),
            )
            .map((m) => ({ organization_id: m.organizationId, platform_role: m.platformRole, vertical_role: m.verticalRole }));
          return { rows: rows as unknown as R[] };
        }
        // SA-L-46: core.esta_suprimido / core.registrar_supresion (migracion 0043), modelo minimo en memoria.
        if (sql.includes("core.esta_suprimido")) {
          const [tipo, hash] = params as [string, string];
          return { rows: [{ suprimido: this.suprimidos.has(`${tipo}:${hash}`) }] as unknown as R[] };
        }
        if (sql.includes("core.registrar_supresion")) {
          const [tipo, hash] = params as [string, string];
          const nueva = !this.suprimidos.has(`${tipo}:${hash}`);
          this.suprimidos.add(`${tipo}:${hash}`);
          return { rows: [{ nueva }] as unknown as R[] };
        }
        // PL-32: core.reactivar_supresion_baja (migracion 0050), modelo minimo: el modelo en memoria no distingue motivos.
        if (sql.includes("core.reactivar_supresion_baja")) {
          const [tipo, hash] = params as [string, string];
          return { rows: [{ quitada: this.suprimidos.delete(`${tipo}:${hash}`) }] as unknown as R[] };
        }
        // PL-31: core.whatsapp_plantilla_aprobada (migracion 0050), catalogo minimo en memoria (`seedPlantillaAprobada`).
        if (sql.includes("core.whatsapp_plantilla_aprobada")) {
          const [organizationId, nombre] = params as [string, string];
          return { rows: [{ aprobada: this.plantillasAprobadas.has(`${organizationId}:${nombre}`) }] as unknown as R[] };
        }
        // H-20: las funciones de la bandeja de conversaciones (migracion 043) no existen en este motor de alcance angosto: se comporta como una
        // base SIN la 043 (SQLSTATE 42883, funcion inexistente), el camino que el codigo ya degrada. Asi el webhook de hoteles armado con este motor
        // sigue respondiendo como antes; las pruebas de la bandeja inyectan `InMemoryConversacionesRepository`.
        if (sql.includes("hoteles.conversacion")) {
          const err = new Error(`function ${sql.match(/hoteles\.conversacion\w*/)?.[0] ?? "hoteles.conversacion_"}() does not exist`) as Error & { code: string };
          err.code = "42883";
          throw err;
        }
        // QA R2 automatizacion-06: el tick de restaurantes cuenta como error de la corrida un barrido de avisos que LANZA. Este motor no tiene la
        // migracion 043 (candidatos de avisos operativos, core.emit_notification): se comporta como una base sin migrar (42883 => `disponible: false`, sin error), igual que arriba.
        if (sql.includes("restaurantes.avisos_operativos_candidatos") || sql.includes("core.emit_notification")) {
          const err = new Error("function restaurantes.avisos_operativos_candidatos() does not exist") as Error & { code: string };
          err.code = "42883";
          throw err;
        }
        throw new Error(
          `InMemoryTenancyEngine: consulta SQL no soportada (alcance angosto a propósito, ver comentario de archivo): ${sql}`,
        );
      },
      exec: async (sql: string) => {
        const normalized = sql.trim().toLowerCase();
        // Fix hallazgo auditoría a2 (CRÍTICO, "el drenado inline de correo aborta
        // la transacción de negocio en sesión de staff") — los 6 triggers inline
        // (apps/api/.../email-dispatch.ts::triggerXEmailDispatchInline) ahora
        // envuelven `dispatchPendingEmailJobs` en SAVEPOINT/RELEASE SAVEPOINT/
        // ROLLBACK TO SAVEPOINT sobre el MISMO `db: TenantDbSession` de
        // `c.get("db")` — este motor, usado por casi todos los fixtures de
        // apps/api/tests (hoteles/citas/despachos/licitaciones/restaurantes, ver
        // domain-rentas/src/in-memory-tenancy-engine.ts para el motor propio de
        // rentas, que ya soportaba esto), es ahora el primer caller real de
        // `exec()` en ese camino y necesita reconocerlas -- mismo criterio (no-op
        // seguro: este motor no modela transacciones/abortos reales, ver
        // comentario de cabecera del archivo) que
        // InMemoryRentasTenancyEngine::exec().
        if (normalized.startsWith("savepoint") || normalized.startsWith("release savepoint") || normalized.startsWith("rollback to savepoint")) {
          return;
        }
        throw new Error(`InMemoryTenancyEngine: exec() no soportado más allá de SAVEPOINT/RELEASE SAVEPOINT/ROLLBACK TO SAVEPOINT: ${sql}`);
      },
    };
    return fn(session);
  }
}
