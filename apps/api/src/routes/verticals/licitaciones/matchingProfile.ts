// Fase 3 pieza 2 — licitacionesMatchingProfileRoutes: `GET`/`PUT
// base/matching-profile` (ver diseño Fase 3 §5). Tabla propia
// (`licitaciones.matching_profile`), autocontenida -- domain-licitaciones
// nunca portó `CompanyCapability`/`getCapabilities()` con datos reales (sigue
// siendo un stub `[]`, ver company-data.ts), así que este perfil no depende
// de esa feature inexistente.
import { Hono } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { WRITE_ROLES } from "@atiende/domain-licitaciones";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";

interface MatchingProfilePutBody {
  readonly keywords?: unknown;
  readonly excludedKeywords?: unknown;
  readonly classifierCodes?: unknown;
  readonly entities?: unknown;
  readonly states?: unknown;
  readonly budgetMin?: unknown;
  readonly budgetMax?: unknown;
}

function parseStringArray(raw: unknown, field: string): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || !raw.every((s) => typeof s === "string" && s.length > 0)) throw Errors.validation(`${field}: se esperaba un arreglo de strings no vacíos.`);
  return raw;
}

function parseOptionalNumber(raw: unknown, field: string): number | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "number" || !Number.isFinite(raw)) throw Errors.validation(`${field}: se esperaba un número.`);
  return raw;
}

const EMPTY_PROFILE = { keywords: [], excludedKeywords: [], classifierCodes: [], entities: [], states: [], budgetMin: null, budgetMax: null, updatedBy: null, updatedAt: null } as const;

export function licitacionesMatchingProfileRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  const base = "/licitaciones/:propertyId/matching-profile";

  app.use(base, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  app.get(base, async (c) => {
    const repo = deps.licitacionesRepo(c.get("db"));
    const organizationId = c.get("organizationId");
    const profile = await repo.findMatchingProfile(organizationId);
    // Ningún perfil configurado todavía -- se responde el "vacío" explícito
    // (nunca 404: la ausencia de configuración es un estado válido y
    // esperado el día 1 de una organización, ver diseño §5) para que el
    // cliente pueda distinguir "sin configurar" de un error de red.
    return c.json(profile ?? { organizationId, ...EMPTY_PROFILE });
  });

  app.put(base, async (c) => {
    const repo = deps.licitacionesRepo(c.get("db"));
    assertVerticalRole(c, WRITE_ROLES);
    const organizationId = c.get("organizationId");
    const actorId = c.get("userId");
    const raw = await readJsonCapped<MatchingProfilePutBody>(c.req.raw, 32 * 1024);

    const keywords = parseStringArray(raw.keywords, "keywords");
    const excludedKeywords = parseStringArray(raw.excludedKeywords, "excludedKeywords");
    const classifierCodes = parseStringArray(raw.classifierCodes, "classifierCodes");
    const entities = parseStringArray(raw.entities, "entities");
    const states = parseStringArray(raw.states, "states");
    const budgetMin = parseOptionalNumber(raw.budgetMin, "budgetMin");
    const budgetMax = parseOptionalNumber(raw.budgetMax, "budgetMax");
    if (budgetMin !== null && budgetMax !== null && budgetMin > budgetMax) throw Errors.validation("budgetMin no puede ser mayor que budgetMax.");

    const profile = await repo.upsertMatchingProfile(organizationId, { keywords, excludedKeywords, classifierCodes, entities, states, budgetMin, budgetMax, actorId });
    return c.json(profile, 200);
  });

  return app;
}
