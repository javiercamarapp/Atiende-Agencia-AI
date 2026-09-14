// Fase 7 -- CRUD de plantillas de mensajería (H-056). `rentas.plantilla_mensaje` es
// ORGANIZATION-scoped (nunca property-scoped: una plantilla de "confirmación" aplica
// a cualquier property del tenant, ver migrations/009_rentas_mensajeria_schema.sql) --
// la ruta sigue montada bajo `/rentas/:propertyId/...` (mismo criterio de URL que el
// resto del vertical) SOLO para reutilizar `requirePropertyMembership` y resolver la
// sesión/`organizationId` reales; el propertyId de la URL nunca filtra qué plantillas
// se listan/editan -- listar desde CUALQUIER property de la organización devuelve el
// mismo catálogo completo de plantillas.
//
// Separación de permisos (H-056, ver src/roles.ts):
//  - Crear/editar el CUERPO de una plantilla: MENSAJERIA_ESCRITURA_ROLES (mismo
//    criterio que generar/aprobar un borrador -- es contenido de conversación).
//  - Marcarla `aprobadaPorTenant: true` (la habilita para programación automática):
//    SOLO MENSAJERIA_PLANTILLA_APROBACION_ROLES (admin_gestora) -- un operador puede
//    proponer/editar el texto, nunca aprobarlo él mismo para el tenant.
import { Hono } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { CANALES_MENSAJERIA, EVENTOS_PLANTILLA, MENSAJERIA_ESCRITURA_ROLES, MENSAJERIA_PLANTILLA_APROBACION_ROLES } from "@atiende/domain-rentas";
import type { CanalMensajeriaCodigo, EventoPlantilla, IdiomaMensaje } from "@atiende/domain-rentas";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";

const IDIOMAS = ["es", "en"] as const;

function requireEvento(value: unknown): EventoPlantilla {
  if (typeof value !== "string" || !(EVENTOS_PLANTILLA as readonly string[]).includes(value)) {
    throw Errors.validation(`evento: se esperaba uno de ${EVENTOS_PLANTILLA.join(", ")}.`);
  }
  return value as EventoPlantilla;
}

function requireIdioma(value: unknown): IdiomaMensaje {
  if (typeof value !== "string" || !(IDIOMAS as readonly string[]).includes(value)) {
    throw Errors.validation(`idioma: se esperaba uno de ${IDIOMAS.join(", ")}.`);
  }
  return value as IdiomaMensaje;
}

function requireCanalOpcional(value: unknown): CanalMensajeriaCodigo | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !(CANALES_MENSAJERIA as readonly string[]).includes(value)) {
    throw Errors.validation(`canal: se esperaba null o uno de ${CANALES_MENSAJERIA.join(", ")}.`);
  }
  return value as CanalMensajeriaCodigo;
}

function requireCuerpo(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 4000) {
    throw Errors.validation("cuerpo: se esperaba un texto de 1-4000 caracteres.");
  }
  return value;
}

interface CrearPlantillaBody {
  readonly evento?: unknown;
  readonly idioma?: unknown;
  readonly canal?: unknown;
  readonly cuerpo?: unknown;
}

interface ActualizarPlantillaBody {
  readonly cuerpo?: unknown;
  readonly activa?: unknown;
  readonly aprobadaPorTenant?: unknown;
}

export function rentasMensajeriaPlantillasRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  const base = "/rentas/:propertyId/plantillas";
  app.use(base, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  app.use(`${base}/:id`, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  app.get(base, async (c) => {
    const organizationId = c.get("organizationId");
    const db = c.get("db");
    const plantillas = await deps.rentasMensajeriaRepo(db).listPlantillas(organizationId);
    return c.json({ plantillas }, 200);
  });

  app.post(base, async (c) => {
    assertVerticalRole(c, MENSAJERIA_ESCRITURA_ROLES);
    const organizationId = c.get("organizationId");
    const db = c.get("db");

    const raw = await readJsonCapped<CrearPlantillaBody>(c.req.raw, 4 * 1024);
    const evento = requireEvento(raw.evento);
    const idioma = requireIdioma(raw.idioma);
    const canal = requireCanalOpcional(raw.canal);
    const cuerpo = requireCuerpo(raw.cuerpo);

    // Default SIEMPRE false -- crear una plantilla nunca la deja lista para
    // programación automática (H-056); un PATCH aparte, con el rol correcto, la
    // aprueba.
    const plantilla = await deps.rentasMensajeriaRepo(db).insertPlantilla({ organizationId, evento, idioma, canal, cuerpo, aprobadaPorTenant: false, activa: true });
    return c.json(plantilla, 201);
  });

  app.patch(`${base}/:id`, async (c) => {
    const organizationId = c.get("organizationId");
    const id = c.req.param("id");
    const db = c.get("db");
    const mensajeriaRepo = deps.rentasMensajeriaRepo(db);

    const actual = await mensajeriaRepo.findPlantilla(organizationId, id);
    if (!actual) throw Errors.notFound("Plantilla no encontrada en esta organización.");

    const raw = await readJsonCapped<ActualizarPlantillaBody>(c.req.raw, 4 * 1024);
    const cambios: { id: string; organizationId: string; cuerpo?: string; activa?: boolean; aprobadaPorTenant?: boolean } = { id, organizationId };

    if (raw.cuerpo !== undefined || raw.activa !== undefined) {
      assertVerticalRole(c, MENSAJERIA_ESCRITURA_ROLES);
      if (raw.cuerpo !== undefined) cambios.cuerpo = requireCuerpo(raw.cuerpo);
      if (raw.activa !== undefined) {
        if (typeof raw.activa !== "boolean") throw Errors.validation("activa: se esperaba boolean.");
        cambios.activa = raw.activa;
      }
    }
    if (raw.aprobadaPorTenant !== undefined) {
      // Aprobar para el tenant es una decisión de negocio más estricta que editar el
      // cuerpo -- ver cabecera del archivo.
      assertVerticalRole(c, MENSAJERIA_PLANTILLA_APROBACION_ROLES);
      if (typeof raw.aprobadaPorTenant !== "boolean") throw Errors.validation("aprobadaPorTenant: se esperaba boolean.");
      cambios.aprobadaPorTenant = raw.aprobadaPorTenant;
    }

    const actualizada = await mensajeriaRepo.updatePlantilla(cambios);
    if (!actualizada) throw Errors.notFound("Plantilla no encontrada en esta organización.");
    return c.json(actualizada, 200);
  });

  return app;
}
