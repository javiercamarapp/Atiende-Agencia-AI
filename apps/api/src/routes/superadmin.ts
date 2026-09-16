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
import { ProspectoNotFoundError } from "@atiende/db";
import type { ProspectoRow } from "@atiende/db";
import { Errors } from "../errors.ts";
import type { AppDeps } from "../deps.ts";

const VERTICALES_VALIDAS = new Set(["hoteles", "restaurantes", "rentas", "licitaciones", "citas", "despachos"]);
const ESTADOS_VALIDOS = new Set(["nuevo", "contactado", "demo", "propuesta", "negociacion", "ganado", "perdido", "descartado"]);

function serializeProspecto(p: ProspectoRow) {
  return {
    id: p.id,
    empresa: p.empresa,
    vertical: p.vertical,
    ciudad: p.ciudad,
    contactoNombre: p.contactoNombre,
    telefono: p.telefono,
    correo: p.correo,
    estado: p.estado,
    fuente: p.fuente,
    notas: p.notas,
    creadoPor: p.creadoPor,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

/** `string | null` desde JSON -- nunca `undefined` (el campo puede venir ausente,
 *  vacío, o con un valor real; los tres casos deben mapear a `null` limpio para
 *  las funciones SQL, que hacen `coalesce`/insertan `null`, nunca reciben
 *  `undefined`). */
function textoOpcional(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

interface CreateProspectoBody {
  readonly empresa?: unknown;
  readonly vertical?: unknown;
  readonly ciudad?: unknown;
  readonly contactoNombre?: unknown;
  readonly telefono?: unknown;
  readonly correo?: unknown;
  readonly fuente?: unknown;
  readonly notas?: unknown;
}

interface UpdateProspectoBody {
  readonly estado?: unknown;
  readonly notas?: unknown;
}

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

  // "Cerebro de ventas" (ver supabase/migrations/20240101000114_0012_superadmin_
  // prospectos.sql) -- las 3 funciones SQL ya validan `is_platform_superadmin`
  // por dentro; el middleware de arriba es defensa en profundidad (403 explícito
  // en vez de una lista vacía/silenciosa).
  app.get("/superadmin/prospectos", async (c) => {
    const prospectos = await deps.coreRepo.listProspectosForSuperadmin(c.get("userId"));
    return c.json({ prospectos: prospectos.map(serializeProspecto) });
  });

  app.post("/superadmin/prospectos", async (c) => {
    const raw = (await c.req.json().catch(() => ({}))) as CreateProspectoBody;
    if (typeof raw.empresa !== "string" || raw.empresa.trim().length === 0) throw Errors.validation("empresa requerida");
    if (typeof raw.vertical !== "string" || !VERTICALES_VALIDAS.has(raw.vertical)) throw Errors.validation("vertical inválida o ausente");

    const prospecto = await deps.coreRepo.createProspectoForSuperadmin(c.get("userId"), {
      empresa: raw.empresa.trim(),
      vertical: raw.vertical,
      ciudad: textoOpcional(raw.ciudad),
      contactoNombre: textoOpcional(raw.contactoNombre),
      telefono: textoOpcional(raw.telefono),
      correo: textoOpcional(raw.correo),
      fuente: textoOpcional(raw.fuente),
      notas: textoOpcional(raw.notas),
    });
    return c.json({ prospecto: serializeProspecto(prospecto) }, 201);
  });

  app.patch("/superadmin/prospectos/:id", async (c) => {
    const raw = (await c.req.json().catch(() => ({}))) as UpdateProspectoBody;
    const estado = typeof raw.estado === "string" ? raw.estado : null;
    if (estado !== null && !ESTADOS_VALIDOS.has(estado)) throw Errors.validation("estado inválido");
    const notas = textoOpcional(raw.notas);

    try {
      const prospecto = await deps.coreRepo.updateProspectoForSuperadmin(c.get("userId"), c.req.param("id"), estado, notas);
      return c.json({ prospecto: serializeProspecto(prospecto) });
    } catch (err) {
      if (err instanceof ProspectoNotFoundError) throw Errors.notFound(err.message);
      throw err;
    }
  });

  return app;
}
