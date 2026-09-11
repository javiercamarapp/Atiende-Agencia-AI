// Flujo 3 (Fase 1 despachos §4): vencimientos fiscales con escalamiento. Autocontenido
// (sin SAT-RPA/FIEL/IMSS, Fase 2+), motor 100% determinista
// (@atiende/domain-despachos/vencimientos/engine.ts — mismo criterio que
// folioEngine.ts/quote.ts de hoteles: lógica de negocio pura, nunca un LLM decidiendo
// una fecha límite fiscal).
import { Hono } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import {
  GESTION_VENCIMIENTOS_ROLES,
  calcularVencimientosDelPeriodo,
  diasHasta,
  decidirEscalamiento,
} from "@atiende/domain-despachos";
import type { FiscalDeadlineRecord } from "@atiende/domain-despachos";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";

interface CalcularBody {
  readonly year?: unknown;
  readonly month?: unknown;
}

interface CompletarBody {
  readonly comprobanteUrl?: unknown;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function serializeDeadline(d: FiscalDeadlineRecord) {
  return {
    id: d.id,
    tipo: d.tipo,
    periodo: d.periodo,
    fechaLimite: d.fechaLimite,
    prioridad: d.prioridad,
    estado: d.estado,
    fechaPresentacion: d.fechaPresentacion,
    comprobanteUrl: d.comprobanteUrl,
    diasRestantes: diasHasta(d.fechaLimite, todayIso()),
    creadoEn: d.createdAt,
  };
}

export function despachosVencimientosRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  const repo = deps.despachosRepo;

  app.use("/despachos/:propertyId/vencimientos/*", authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  app.use("/despachos/:propertyId/vencimientos", authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  app.get("/despachos/:propertyId/vencimientos", async (c) => {
    assertVerticalRole(c, GESTION_VENCIMIENTOS_ROLES);
    const estado = c.req.query("estado");
    const deadlines = await repo.listDeadlines(c.req.param("propertyId"), estado ? { estado } : undefined);
    return c.json(deadlines.map(serializeDeadline));
  });

  app.post("/despachos/:propertyId/vencimientos/calcular", async (c) => {
    assertVerticalRole(c, GESTION_VENCIMIENTOS_ROLES);
    const organizationId = c.get("organizationId");
    const propertyId = c.req.param("propertyId");
    const raw = await readJsonCapped<CalcularBody>(c.req.raw, 1024);
    const now = new Date();
    const year = typeof raw.year === "number" ? raw.year : now.getUTCFullYear();
    const month = typeof raw.month === "number" ? raw.month : now.getUTCMonth() + 1;
    if (!Number.isInteger(month) || month < 1 || month > 12) throw Errors.validation("month: se esperaba un entero 1-12.");

    const nuevos = calcularVencimientosDelPeriodo(year, month, todayIso());
    const creados: FiscalDeadlineRecord[] = [];
    for (const n of nuevos) {
      creados.push(await repo.createDeadline({ organizationId, propertyId, tipo: n.tipo, periodo: n.periodo, fechaLimite: n.fechaLimite, prioridad: n.prioridad }));
    }
    return c.json(creados.map(serializeDeadline), 201);
  });

  app.post("/despachos/:propertyId/vencimientos/:deadlineId/completar", async (c) => {
    assertVerticalRole(c, GESTION_VENCIMIENTOS_ROLES);
    const propertyId = c.req.param("propertyId");
    const deadlineId = c.req.param("deadlineId");
    const raw = await readJsonCapped<CompletarBody>(c.req.raw, 1024);
    const comprobanteUrl = typeof raw.comprobanteUrl === "string" ? raw.comprobanteUrl : null;

    const existing = await repo.findDeadline(propertyId, deadlineId);
    if (!existing) throw Errors.notFound("Vencimiento no encontrado.");
    if (existing.estado === "completado") throw Errors.conflict("Este vencimiento ya está marcado como completado.");

    const updated = await repo.markDeadlineCompleted(deadlineId, comprobanteUrl, todayIso());
    return c.json(serializeDeadline(updated!));
  });

  app.post("/despachos/:propertyId/vencimientos/:deadlineId/escalar", async (c) => {
    assertVerticalRole(c, GESTION_VENCIMIENTOS_ROLES);
    const propertyId = c.req.param("propertyId");
    const deadlineId = c.req.param("deadlineId");

    const deadline = await repo.findDeadline(propertyId, deadlineId);
    if (!deadline) throw Errors.notFound("Vencimiento no encontrado.");
    if (deadline.estado === "completado") throw Errors.conflict("No se puede escalar un vencimiento ya completado.");

    const dias = diasHasta(deadline.fechaLimite, todayIso());
    const decision = decidirEscalamiento(deadline.tipo, deadline.fechaLimite, dias);
    const escalation = await repo.insertEscalation(deadlineId, decision.level, new Date().toISOString(), decision.notes);
    await repo.updateDeadlineEstado(deadlineId, "escalado");

    return c.json({ escalamiento: { id: escalation.id, nivel: escalation.level, enviadoEn: escalation.sentAt, notas: escalation.notes }, requiereRevisionHumana: decision.requiresHumanReview, motivoRevisionHumana: decision.humanReviewReason }, 201);
  });

  return app;
}
