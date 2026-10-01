// Adaptador Postgres de `DemoRepository`. REGLA DURA de compatibilidad con la base SIN migrar: la lectura corre dentro
// de la transaccion unica del request y la migracion 036 no se aplica sola al mergear. Un 42P01/42703/42883/42501
// sin SAVEPOINT dejaria la transaccion abortada (25P02) y el siguiente paso del request fallaria; con SAVEPOINT cae a
// "no es demo" (el widget responde "no disponible") y la sesion sigue viva.
import { runWithSavepointFallback } from "@atiende/db";
import type { TenantDbSession } from "@atiende/core-tenancy";
import type { DemoOrganizationInfo, DemoRepository } from "./types.ts";

function esBaseSinMigrar(err: unknown): boolean {
  const code = err && typeof err === "object" && "code" in err ? (err as { code?: unknown }).code : undefined;
  return code === "42P01" || code === "42703" || code === "42883" || code === "42501";
}

export class PostgresDemoRepository implements DemoRepository {
  constructor(private readonly db: TenantDbSession) {}

  async findDemoOrganization(organizationId: string): Promise<DemoOrganizationInfo | null> {
    return runWithSavepointFallback<DemoOrganizationInfo | null>({
      session: this.db,
      savepointName: "sp_restaurantes_demo_organization_read",
      primary: async () => {
        const { rows } = await this.db.query<{ organization_id: string; seed_version: string; activo: boolean }>(
          `select organization_id, seed_version, activo from restaurantes.demo_organization where organization_id = $1;`,
          [organizationId],
        );
        const row = rows[0];
        return row ? { organizationId: row.organization_id, seedVersion: row.seed_version, activo: row.activo === true } : null;
      },
      isRecoverable: esBaseSinMigrar,
      fallback: async () => null,
    });
  }
}
