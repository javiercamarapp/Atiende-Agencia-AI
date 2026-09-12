// Fase 5 hoteles (H16-014, REQ-REC-014, P1/SEG) — fraude interno. POST .../escaneos
// dispara la detección de los 2 patrones portados (ver
// domain-hoteles/src/fraude/deteccion.ts para el alcance completo) y persiste
// cualquier hallazgo NUEVO como alerta pendiente de revisión (idempotente por
// hallazgo); GET .../alertas lista lo ya detectado; POST .../confirmar|descartar
// resuelve la cola de revisión humana, gateada por el mismo espíritu de
// `requiresHumanReview` que otras verticales, con cada decisión auditada vía
// `@atiende/core-authz::AuditSink` — MISMO patrón exacto que
// `apps/api/src/routes/verticals/despachos/revisiones.ts` (leído primero como
// plantilla, ver diseño Fase 5 §2).
//
// Solo owner/gm/accountant pueden disparar un escaneo O resolver una alerta — ambos
// patrones portados son de dinero/administración (ver FRAUD_SCAN_ROLES/
// FRAUD_VIEW_ROLES/FRAUD_RESOLVER_ROLES en domain-hoteles/src/roles.ts).
import { Hono } from "hono";
import type { Context } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import {
  FRAUD_RESOLVER_ROLES,
  FRAUD_SCAN_ROLES,
  FRAUD_VIEW_ROLES,
  FraudAlertAlreadyResolvedError,
  detectDiscountOutsidePolicy,
  detectFolioReopenedAfterAudit,
  recipientRolesForPattern,
  type FraudAlertRecord,
  type FraudFinding,
} from "@atiende/domain-hoteles";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";

interface ResolverBody {
  readonly nota?: unknown;
}

function serializeAlert(alert: FraudAlertRecord) {
  return {
    id: alert.id,
    patron: alert.pattern,
    folioId: alert.folioId,
    cargoId: alert.chargeId,
    pagoId: alert.paymentId,
    razon: alert.reason,
    evidencia: alert.evidence,
    rolesDestinatario: alert.recipientRoles,
    estado: alert.status,
    notaDecision: alert.decisionNote,
    resueltoPor: alert.resolvedBy,
    resueltoEn: alert.resolvedAt,
    creadoEn: alert.createdAt,
  };
}

export function hotelesFraudeRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  app.use("/hoteles/:propertyId/fraude/*", authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  app.use("/hoteles/:propertyId/fraude", authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  // Escaneo determinista (nunca vía LLM) de los 2 patrones portados sobre los datos
  // YA reales de folio/charge de esta property -- ningún insumo externo (a
  // diferencia de los 2 patrones fuera de alcance, que sí lo requerirían).
  app.post("/hoteles/:propertyId/fraude/escaneos", async (c) => {
    assertVerticalRole(c, FRAUD_SCAN_ROLES);
    const organizationId = c.get("organizationId");
    const propertyId = c.req.param("propertyId");
    const repo = deps.hotelesRepo(c.get("db"));

    const findings: FraudFinding[] = [];

    const { discountThreshold } = await repo.loadTaxConfig(propertyId);
    const discountCharges = await repo.listDiscountChargesForFraudScan(propertyId);
    for (const row of discountCharges) {
      const finding = detectDiscountOutsidePolicy({
        chargeId: row.chargeId,
        folioId: row.folioId,
        discountAmount: row.amount,
        thresholdAmount: discountThreshold,
        discountAuthorizedByStaffId: row.discountAuthorizedBy,
        // NOTA DE FIDELIDAD (ver domain-hoteles/src/fraude/deteccion.ts): el esquema
        // real de `hoteles.charge` (Fase 1) no registra quién APLICÓ el cargo (solo
        // quién lo AUTORIZÓ, `discount_authorized_by`) -- sin esa columna no se puede
        // resolver esta señal honestamente, así que se pasa `false` SIEMPRE
        // (conservador por diseño: un descuento grande sin autorización verificable
        // siempre escala a la cola de revisión humana, nunca se da por bueno a ciegas).
        appliedByHasAdminRole: false,
      });
      if (finding) findings.push(finding);
    }

    const reopenedCharges = await repo.listReopenedFolioChargesForFraudScan(propertyId);
    for (const row of reopenedCharges) {
      const finding = detectFolioReopenedAfterAudit({ folioId: row.folioId, folioClosedAt: row.folioClosedAt, chargeId: row.chargeId, chargeCreatedAt: row.chargeCreatedAt });
      if (finding) findings.push(finding);
    }

    const alertas: (ReturnType<typeof serializeAlert> & { esNueva: boolean })[] = [];
    for (const finding of findings) {
      const roles = recipientRolesForPattern(finding.pattern);
      const { record, isNew } = await repo.recordFraudAlert({
        organizationId,
        propertyId,
        pattern: finding.pattern,
        folioId: finding.folioId,
        chargeId: finding.chargeId,
        paymentId: finding.paymentId,
        reason: finding.reason,
        evidence: finding.evidence,
        recipientRoles: roles,
        dedupeKey: finding.dedupeKey,
      });

      // Solo un hallazgo NUEVO (nunca alertado antes) se audita -- un re-escaneo del
      // mismo hallazgo no debe reenviar/reauditar la misma alerta una y otra vez.
      if (isNew) {
        await deps.hotelesFraudeAuditSink.record({
          at: new Date().toISOString(),
          actorUserId: c.get("userId"),
          actorEmail: c.get("userEmail") ?? null,
          organizationId,
          action: `hoteles.fraude:alerta_generada:${finding.pattern}`,
          route: c.req.path,
          method: c.req.method,
          decision: "allowed",
          metadata: { alertaId: record.id, folioId: finding.folioId, cargoId: finding.chargeId, pagoId: finding.paymentId },
        });
      }

      alertas.push({ ...serializeAlert(record), esNueva: isNew });
    }

    return c.json({ alertas, generadas: alertas.filter((a) => a.esNueva).length, yaExistentes: alertas.filter((a) => !a.esNueva).length }, 200);
  });

  app.get("/hoteles/:propertyId/fraude/alertas", async (c) => {
    assertVerticalRole(c, FRAUD_VIEW_ROLES);
    const repo = deps.hotelesRepo(c.get("db"));
    const estado = c.req.query("estado");
    if (estado !== undefined && estado !== "pendiente" && estado !== "confirmado" && estado !== "descartado") {
      throw Errors.validation("estado: se esperaba pendiente|confirmado|descartado.");
    }
    const alertas = await repo.listFraudAlerts(c.req.param("propertyId"), estado ? { status: estado } : undefined);
    return c.json(alertas.map(serializeAlert));
  });

  app.get("/hoteles/:propertyId/fraude/alertas/:alertId", async (c) => {
    assertVerticalRole(c, FRAUD_VIEW_ROLES);
    const repo = deps.hotelesRepo(c.get("db"));
    const alert = await repo.findFraudAlert(c.req.param("propertyId"), c.req.param("alertId"));
    if (!alert) throw Errors.notFound("Alerta de fraude no encontrada.");
    return c.json(serializeAlert(alert));
  });

  async function resolver(c: Context<CoreAuthHonoEnv>, status: "confirmado" | "descartado") {
    assertVerticalRole(c, FRAUD_RESOLVER_ROLES);
    const propertyId = c.req.param("propertyId")!;
    const alertId = c.req.param("alertId")!;
    const organizationId = c.get("organizationId");
    const userId = c.get("userId");
    const raw = await readJsonCapped<ResolverBody>(c.req.raw, 4 * 1024);
    const nota = typeof raw.nota === "string" ? raw.nota.trim() : null;
    const repo = deps.hotelesRepo(c.get("db"));

    try {
      const resolved = await repo.resolveFraudAlert(propertyId, alertId, userId, status, nota);
      await deps.hotelesFraudeAuditSink.record({
        at: new Date().toISOString(),
        actorUserId: userId,
        actorEmail: c.get("userEmail") ?? null,
        organizationId,
        action: `hoteles.fraude.alerta:${status}`,
        route: c.req.path,
        method: c.req.method,
        decision: "allowed",
        metadata: { alertaId: resolved.id, patron: resolved.pattern, nota },
      });
      return resolved;
    } catch (err) {
      if (err instanceof FraudAlertAlreadyResolvedError) throw Errors.conflict(err.message);
      throw err;
    }
  }

  app.post("/hoteles/:propertyId/fraude/alertas/:alertId/confirmar", async (c) => {
    const resolved = await resolver(c, "confirmado");
    return c.json(serializeAlert(resolved), 200);
  });

  app.post("/hoteles/:propertyId/fraude/alertas/:alertId/descartar", async (c) => {
    const resolved = await resolver(c, "descartado");
    return c.json(serializeAlert(resolved), 200);
  });

  return app;
}
