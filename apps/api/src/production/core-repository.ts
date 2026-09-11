// ProductionCoreRepository — adaptador real de `CoreRepository` para producción,
// consumido por deps.ts al construir el handler de Vercel (ver ../vercel.ts).
//
// `PostgresCoreRepository` (@atiende/db) exige un `TenantDbSession` ya abierto en su
// constructor — no abre sesión por sí sola. El patrón documentado en
// `postgres-core-repository.ts` es "se abre siempre vía
// `TenancyEngine.withAppSession({ userId: null }, ...)` (sesión de sistema, sin
// `auth.uid()`) porque login ocurre ANTES de que exista una sesión autenticada" — este
// wrapper es exactamente eso: abre una transacción de sistema nueva en CADA llamada
// (nunca reutiliza una conexión entre requests, correcto para el `pg.Pool` de
// `ManagedPostgresEngine`) y delega en un `PostgresCoreRepository` construido sobre esa
// sesión efímera.
import type { CoreRepository, MembershipRow, StaffUserRow } from "@atiende/db";
import { PostgresCoreRepository } from "@atiende/db";
import type { TenancyEngine } from "@atiende/core-tenancy";

export class ProductionCoreRepository implements CoreRepository {
  constructor(private readonly engine: TenancyEngine) {}

  findStaffByEmail(email: string): Promise<StaffUserRow | null> {
    return this.engine.withAppSession({ userId: null }, (session) =>
      new PostgresCoreRepository(session).findStaffByEmail(email),
    );
  }

  findStaffById(id: string): Promise<StaffUserRow | null> {
    return this.engine.withAppSession({ userId: null }, (session) =>
      new PostgresCoreRepository(session).findStaffById(id),
    );
  }

  findMembershipsByUserId(userId: string): Promise<readonly MembershipRow[]> {
    return this.engine.withAppSession({ userId: null }, (session) =>
      new PostgresCoreRepository(session).findMembershipsByUserId(userId),
    );
  }
}
