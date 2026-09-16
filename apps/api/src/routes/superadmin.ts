// Back office de plataforma — cruzado a las 6 verticales, distinto de
// `core.membership.platform_role` (ese es DENTRO de una sola organización).
// Alcance de ESTE pase: solo lectura (listar organizaciones + conteo de staff
// por organización) — ninguna acción de escritura (suspender/reactivar una
// organización, dar de alta otro superadmin) todavía; eso queda para una
// siguiente pasada cuando exista un caso de uso real que lo pida.
//
// Autorización real: `deps.coreRepo.isPlatformSuperadmin`/las funciones SQL
// que consume (`core.list_all_organizations_for_superadmin`/
// `core.count_staff_by_organization_for_superadmin`) YA verifican por dentro
// que el caller es superadmin — el chequeo de aquí (`requireSuperadmin`) es
// defensa en profundidad (responde 403 explícito en vez de simplemente "0
// resultados", mejor UX de error), nunca la única autoridad real.
import { Hono } from "hono";
import { authMiddleware } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { Errors } from "../errors.ts";
import type { AppDeps } from "../deps.ts";

export function superadminRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  app.use("/superadmin/*", authMiddleware(deps.env));
  app.use("/superadmin/*", async (c, next) => {
    if (!(await deps.coreRepo.isPlatformSuperadmin(c.get("userId")))) {
      throw Errors.forbidden("Este panel es exclusivo del back office de plataforma.");
    }
    await next();
  });

  app.get("/superadmin/organizations", async (c) => {
    const callerId = c.get("userId");
    const [organizations, staffCounts] = await Promise.all([
      deps.coreRepo.listAllOrganizationsForSuperadmin(callerId),
      deps.coreRepo.countStaffByOrganizationForSuperadmin(callerId),
    ]);
    return c.json({
      organizations: organizations.map((o) => ({ ...o, staffCount: staffCounts.get(o.id) ?? 0 })),
    });
  });

  return app;
}
