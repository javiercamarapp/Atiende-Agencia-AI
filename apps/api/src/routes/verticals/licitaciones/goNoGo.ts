// Fase 3 pieza 3 — licitacionesGoNoGoRoutes: `GET`/`POST
// base/tenders/:tenderId/go-no-go` (ver diseño Fase 3 §7). El `MatchResult`
// que sustenta la decisión SIEMPRE se recalcula aquí, en vivo, contra el
// perfil de matching y la convocatoria vigentes -- nunca se acepta un score
// que el cliente proponga (mismo principio que el hash de insumos en
// cierre.ts: nada de lo que decide "go"/"no_go" viene del request).
import { Hono } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { GO_NO_GO_ROLES, GoNoGoRejectedError, MatchingEngine, buildMatchInputsSnapshot, computeMatchInputsHash, toOrganizationMatchingProfile } from "@atiende/domain-licitaciones";
import type { LicitacionesRole } from "@atiende/domain-licitaciones";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";

interface GoNoGoCreateBody {
  readonly decision?: unknown;
  readonly reasons?: unknown;
}

/** Traduce `GoNoGoRejectedError.reasonCode` a un código HTTP -- rol insuficiente es un 403 explícito (el actor está identificado, pero esta decisión en particular le está vedada); motivo faltante es un 400 de validación. */
function mapGoNoGoRejectedError(err: unknown): Error {
  if (!(err instanceof GoNoGoRejectedError)) return err instanceof Error ? err : new Error(String(err));
  if (err.reasonCode === "motivo_requerido") return Errors.validation(err.message);
  return Errors.forbidden(err.message);
}

export function licitacionesGoNoGoRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  const engine = new MatchingEngine();
  const base = "/licitaciones/:propertyId/tenders/:tenderId/go-no-go";

  app.use(base, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  app.get(base, async (c) => {
    const repo = deps.licitacionesRepo(c.get("db"));
    const organizationId = c.get("organizationId");
    const tenderId = c.req.param("tenderId");
    const tender = await repo.findTender(organizationId, tenderId);
    if (!tender) throw Errors.notFound("Convocatoria no encontrada.");
    // Historial COMPLETO, no solo la última (§7 del diseño): permite ver por
    // qué se descartó antes una convocatoria que hoy se reabre con un "go".
    const decisions = await repo.listGoNoGoDecisions(organizationId, tenderId);
    return c.json({ decisions });
  });

  app.post(base, async (c) => {
    const repo = deps.licitacionesRepo(c.get("db"));
    // Enforcement de aplicación, ADEMÁS de RLS (`licitaciones.can_go_no_go_org`,
    // migración 008) y de la validación de dominio en `buildGoNoGoDecision`
    // (llamada dentro de `repo.createGoNoGoDecision`) -- ninguna capa confía
    // en que las otras dos ya filtraron.
    assertVerticalRole(c, GO_NO_GO_ROLES);
    const organizationId = c.get("organizationId");
    const actorId = c.get("userId");
    const actorRole = c.get("verticalRole")! as LicitacionesRole;
    const tenderId = c.req.param("tenderId");
    const raw = await readJsonCapped<GoNoGoCreateBody>(c.req.raw, 16 * 1024);

    if (raw.decision !== "go" && raw.decision !== "no_go") throw Errors.validation('decision: se esperaba "go" | "no_go".');
    if (!Array.isArray(raw.reasons) || raw.reasons.length === 0 || !raw.reasons.every((r) => typeof r === "string" && r.trim().length > 0)) {
      throw Errors.validation("reasons: se requiere un arreglo con al menos un motivo no vacío.");
    }
    const reasons = raw.reasons as string[];

    const tender = await repo.findTender(organizationId, tenderId);
    if (!tender) throw Errors.notFound("Convocatoria no encontrada.");

    // El MatchResult VIGENTE se calcula aquí, en vivo, contra el perfil y la
    // convocatoria actuales -- nunca uno que el cliente mande.
    const profileRecord = await repo.findMatchingProfile(organizationId);
    const profile = toOrganizationMatchingProfile(profileRecord, organizationId);
    const matchResult = engine.score(tender, profile);
    const matchInputsHash = computeMatchInputsHash(buildMatchInputsSnapshot(tender, profileRecord));

    try {
      const decision = await repo.createGoNoGoDecision(organizationId, tenderId, {
        decision: raw.decision,
        reasons,
        matchScore: matchResult.score,
        matchEligibilityStatus: matchResult.eligibility.status,
        matchInputsHash,
        actorId,
        actorRole,
      });
      return c.json(decision, 201);
    } catch (err) {
      throw mapGoNoGoRejectedError(err);
    }
  });

  return app;
}
