// Fase 16 (post-adjudicación, pieza 0) — licitacionesResolutionRoutes:
// `POST`/`GET base/tenders/:tenderId/resolution`. Hasta esta pieza,
// `licitaciones.tender.status` podía llegar a "won"/"lost" (el enum ya los
// declaraba desde Fase 3, ver `TENDER_STATUSES`) pero NINGÚN endpoint HTTP
// escribía esa transición -- todo el flujo de post-adjudicación (contrato,
// cobranza, inconformidades, Fase 6/15) y la autopsia del fallo (Fase 15,
// `falloAutopsy.ts`) dependen de `tender.status === "won"/"lost"` (ver
// `apps/web/.../ConvocatoriaDetalle.tsx`) y eran, en la práctica,
// inalcanzables sin escribir directo a la base de datos.
//
// Marcar una licitación ganada/perdida es una decisión comercial/legal, no
// redacción -- exige DECISION_ROLES (owner/admin/analyst), mismo criterio
// exacto que aprobar el expediente completo (`cierre.ts`). La transición
// misma se valida con `checkTenderResolution` (tender-resolution.ts): nunca
// se puede saltar de "discovered"/"in_review" (sin decisión go/no-go real)
// ni desde "no_go"/"cancelled"/"won"/"lost" (terminales o ya descartada)
// directo a "won"/"lost" -- solo desde "go"/"in_progress"/"submitted".
import { Hono } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { DECISION_ROLES, TenderResolutionRejectedError, isTenderResolution } from "@atiende/domain-licitaciones";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";

interface TenderResolutionCreateBody {
  readonly resolution?: unknown;
  readonly reason?: unknown;
}

export function licitacionesResolutionRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  const base = "/licitaciones/:propertyId/tenders/:tenderId/resolution";

  app.use(base, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  app.get(base, async (c) => {
    const repo = deps.licitacionesRepo(c.get("db"));
    const organizationId = c.get("organizationId");
    const tenderId = c.req.param("tenderId");
    const tender = await repo.findTender(organizationId, tenderId);
    if (!tender) throw Errors.notFound("Convocatoria no encontrada.");
    // Historial COMPLETO (normalmente una sola fila -- won/lost son
    // terminales -- pero se conserva igual que `contract_status_history`).
    const resolutions = await repo.listTenderResolutions(organizationId, tenderId);
    return c.json({ resolutions });
  });

  app.post(base, async (c) => {
    const repo = deps.licitacionesRepo(c.get("db"));
    // Enforcement de aplicación, ADEMÁS de RLS (`licitaciones.can_decide_org`,
    // migración 019) y de la validación de dominio dentro de
    // `repo.resolveTender` (`checkTenderResolution`) -- ninguna capa confía
    // en que las otras dos ya filtraron.
    assertVerticalRole(c, DECISION_ROLES);
    const organizationId = c.get("organizationId");
    const actorId = c.get("userId");
    const tenderId = c.req.param("tenderId");
    const raw = await readJsonCapped<TenderResolutionCreateBody>(c.req.raw, 16 * 1024);

    if (typeof raw.resolution !== "string" || !isTenderResolution(raw.resolution)) throw Errors.validation('resolution: se esperaba "won" | "lost".');
    if (typeof raw.reason !== "string" || raw.reason.trim().length === 0) throw Errors.validation("reason requerido.");

    const tender = await repo.findTender(organizationId, tenderId);
    if (!tender) throw Errors.notFound("Convocatoria no encontrada.");

    try {
      const updated = await repo.resolveTender(organizationId, tenderId, { resolution: raw.resolution, reason: raw.reason, actorId });
      return c.json(updated, 200);
    } catch (err) {
      if (err instanceof TenderResolutionRejectedError) throw Errors.conflict(err.message);
      throw err;
    }
  });

  return app;
}
