// Flujo 2 (Fase 1 despachos §4): cola de revisión humana, gateada por el flag
// `requiresHumanReview` que produce `validarCfdiDespachos()` en la ingesta (ver
// cfdi.ts). Patrón "anti-alucinación" de esta vertical — igual en espíritu al
// `fnbAllergyGuard` de hoteles o al `resolveOrderItemsAgainstProducts` de
// restaurantes: nunca se declara un CFDI resuelto sin que un humano confirme cuando
// el motor tenía dudas. Cada decisión (aprobar/rechazar) se audita vía
// `@atiende/core-authz::AuditSink` — el TIPO se reutiliza tal cual (diseño Fase 1
// §3), aunque el adaptador de producción SÍ escribe a una tabla propia de despachos
// (`despachos.audit_log`, agregada en la migración 007 -- ver
// apps/api/src/production/despachos-audit-sink.ts para por qué).
import { Hono } from "hono";
import type { Context } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { InvoiceReviewAlreadyResolvedError, RESOLVER_REVISION_ROLES, VER_REVISIONES_ROLES } from "@atiende/domain-despachos";
import type { InvoiceReviewRecord } from "@atiende/domain-despachos";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";

interface ResolverBody {
  readonly decision?: unknown;
  readonly nota?: unknown;
}

function serializeReview(review: InvoiceReviewRecord) {
  return {
    id: review.id,
    invoiceId: review.invoiceId,
    motivo: review.reason,
    estado: review.status,
    notaDecision: review.decisionNote,
    resueltoPor: review.resolvedBy,
    resueltoEn: review.resolvedAt,
    creadoEn: review.createdAt,
  };
}

export function despachosRevisionesRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  app.use("/despachos/:propertyId/revisiones/*", authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  app.use("/despachos/:propertyId/revisiones", authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  // Hallazgo de auditoría (severidad MEDIO, "el rol 'readonly' está definido pero
  // ninguna ruta lo usa realmente"): ver la cola es lectura de un registro ya
  // persistido -- auditor/readonly SÍ pueden verla (VER_REVISIONES_ROLES), aunque
  // nunca resolverla (RESOLVER_REVISION_ROLES, sin cambios, abajo).
  app.get("/despachos/:propertyId/revisiones", async (c) => {
    assertVerticalRole(c, VER_REVISIONES_ROLES);
    const repo = deps.despachosRepo(c.get("db"));
    const pendientes = await repo.listPendingReviews(c.req.param("propertyId"));
    return c.json(pendientes.map(serializeReview));
  });

  app.get("/despachos/:propertyId/revisiones/:reviewId", async (c) => {
    assertVerticalRole(c, VER_REVISIONES_ROLES);
    const repo = deps.despachosRepo(c.get("db"));
    const review = await repo.findReview(c.req.param("propertyId"), c.req.param("reviewId"));
    if (!review) throw Errors.notFound("Revisión no encontrada.");
    return c.json(serializeReview(review));
  });

  async function resolver(c: Context<CoreAuthHonoEnv>, decision: "aprobado" | "rechazado") {
    assertVerticalRole(c, RESOLVER_REVISION_ROLES);
    // `c.req.param(...)` pierde la inferencia literal de ruta dentro de este helper
    // genérico (`Context<CoreAuthHonoEnv>`, no atado a un patrón concreto) — ambos
    // parámetros ya fueron validados por `requirePropertyMembership`/el router antes
    // de llegar aquí, así que siempre están presentes en runtime.
    const propertyId = c.req.param("propertyId")!;
    const reviewId = c.req.param("reviewId")!;
    const organizationId = c.get("organizationId");
    const userId = c.get("userId");
    const raw = await readJsonCapped<ResolverBody>(c.req.raw, 4 * 1024);
    const nota = typeof raw.nota === "string" ? raw.nota.trim() : null;
    const repo = deps.despachosRepo(c.get("db"));

    try {
      const resolved = await repo.resolveReview(propertyId, reviewId, userId, decision, nota);
      await deps.despachosAuditSink.record({
        at: new Date().toISOString(),
        actorUserId: userId,
        actorEmail: c.get("userEmail") ?? null,
        organizationId,
        action: `despachos.revision:${decision}`,
        route: c.req.path,
        method: c.req.method,
        decision: "allowed",
        metadata: { reviewId: resolved.id, invoiceId: resolved.invoiceId, nota },
      });
      return resolved;
    } catch (err) {
      if (err instanceof InvoiceReviewAlreadyResolvedError) throw Errors.conflict(err.message);
      throw err;
    }
  }

  app.post("/despachos/:propertyId/revisiones/:reviewId/aprobar", async (c) => {
    const resolved = await resolver(c, "aprobado");
    return c.json(serializeReview(resolved), 200);
  });

  app.post("/despachos/:propertyId/revisiones/:reviewId/rechazar", async (c) => {
    const resolved = await resolver(c, "rechazado");
    return c.json(serializeReview(resolved), 200);
  });

  return app;
}
