// Catalogo de planes y precios por vertical, limites por plan y asignacion de plan a
// organizaciones (SA-03, superadmin "CFO"). Ver packages/db/migrations/0027_superadmin_costos_planes.sql
// y docs/SUPERADMIN_COSTOS_PLANES.md.
//
// Asignar un plan es DOS pasos (solicitar -> confirmar), motivo >= 20 caracteres, solo el
// solicitante confirma, una pendiente por organizacion (misma mecanica que
// superadmin-organizaciones.ts). Confirmar y editar el catalogo/limites exigen step-up MFA
// (ver superadmin-seguridad/step-up.ts). Asignar un plan NO toca Stripe ni cobra nada: fija el
// contrato interno (de donde sale el ingreso esperado del margen) y, solo si el plan trae un
// limite LLM con accion `pausar`, aplica ese tope a core.llm_org_budget.
//
// Precios: la API habla en PESOS MXN (hasta 2 decimales); la base guarda centavos enteros.
import { Hono } from "hono";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { rateLimit } from "@atiende/core-ratelimit";
import { ACCIONES_LIMITE, METRICAS_LIMITE, VERTICALES_COSTOS } from "@atiende/db";
import type { AccionLimiteRow, MetricaLimiteRow, PlanAssignmentRow, PlanRow } from "@atiende/db";
import { Errors } from "../errors.ts";
import { requestActor } from "../http-security.ts";
import { traducirErrorSeguridad } from "./superadmin-mfa.ts";
import type { AppDeps } from "../deps.ts";

const NO_DISPONIBLE = "El catálogo de planes todavía no está disponible en este despliegue (falta aplicar la migración 0027_superadmin_costos_planes).";
const MUTACION_RATE_LIMIT = { max: 30, windowMs: 5 * 60_000 } as const;
const PLAN_ID_RE = /^[a-z0-9][a-z0-9-]{1,58}[a-z0-9]$/u;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function pesos(centavos: number | null): number | null {
  return centavos === null ? null : centavos / 100;
}

function serializePlan(p: PlanRow) {
  return {
    id: p.id,
    nombre: p.nombre,
    vertical: p.vertical,
    precioBaseMxn: pesos(p.precioBaseCentavos),
    precioAsientoMxn: pesos(p.precioAsientoCentavos),
    asientosIncluidos: p.asientosIncluidos,
    activo: p.activo,
    limites: p.limites,
    organizaciones: p.organizaciones,
    actualizadoEnMs: p.updatedAtMs,
  };
}

function serializeAsignacion(a: PlanAssignmentRow) {
  return {
    id: a.id,
    organizationId: a.organizationId,
    organizacion: a.organizationName,
    planId: a.planId,
    motivo: a.motivo,
    estado: a.estado,
    creadoPor: a.creadoPor,
    creadoEnMs: a.creadoEnMs,
    venceEnMs: a.venceEnMs,
    confirmadoPor: a.confirmadoPor,
    confirmadoEnMs: a.confirmadoEnMs,
    resultado: a.resultado,
  };
}

/** Pesos con hasta 2 decimales -> centavos enteros; `null`/ausente -> null (precio por configurar). */
function parseCentavos(value: unknown, field: string): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100_000_000) throw Errors.validation(`${field} debe ser un monto en MXN mayor o igual a 0 (o null para dejarlo por configurar).`);
  const centavos = Math.round(value * 100);
  if (Math.abs(value * 100 - centavos) > 1e-6) throw Errors.validation(`${field} admite como máximo 2 decimales.`);
  return centavos;
}

export function superadminPlanesRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  async function limitar(c: { req: { raw: Request } }, callerId: string, nombre: string): Promise<void> {
    const allowed = await rateLimit(`admin:${nombre}:${requestActor(c.req.raw, callerId)}`, MUTACION_RATE_LIMIT.max, MUTACION_RATE_LIMIT.windowMs, { category: "admin" });
    if (!allowed) throw Errors.tooManyRequests("Demasiadas solicitudes de gestión de planes en poco tiempo.");
  }

  app.get("/superadmin/planes", async (c) => {
    const catalogo = { verticales: VERTICALES_COSTOS, metricas: METRICAS_LIMITE, acciones: ACCIONES_LIMITE };
    if (!deps.costosPlanesRepo) return c.json({ disponible: false, catalogo, planes: [] });
    const repo = deps.costosPlanesRepo;
    const callerId = c.get("userId");
    const { availability, plans } = await deps.engine.withAppSession({ userId: callerId }, (db) => repo(db).listPlans(callerId));
    return c.json({ disponible: availability === "available", catalogo, planes: plans.map(serializePlan) });
  });

  app.put("/superadmin/planes/:id", async (c) => {
    if (!deps.costosPlanesRepo) throw Errors.serviceUnavailable(NO_DISPONIBLE);
    const repo = deps.costosPlanesRepo;
    const callerId = c.get("userId");
    await limitar(c, callerId, "planes-catalogo");
    const id = c.req.param("id");
    if (!PLAN_ID_RE.test(id)) throw Errors.validation("id de plan inválido (minúsculas, dígitos y guiones, 3 a 60 caracteres).");

    const raw = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const nombre = typeof raw.nombre === "string" ? raw.nombre.trim() : "";
    if (nombre.length < 2 || nombre.length > 80) throw Errors.validation("nombre debe tener entre 2 y 80 caracteres.");
    const vertical = typeof raw.vertical === "string" ? raw.vertical : "";
    if (!(VERTICALES_COSTOS as readonly string[]).includes(vertical)) throw Errors.validation(`vertical debe ser una de: ${VERTICALES_COSTOS.join(", ")}.`);
    const asientosIncluidos = raw.asientosIncluidos === undefined ? 0 : raw.asientosIncluidos;
    if (typeof asientosIncluidos !== "number" || !Number.isInteger(asientosIncluidos) || asientosIncluidos < 0 || asientosIncluidos > 100_000) throw Errors.validation("asientosIncluidos debe ser un entero >= 0.");
    if (raw.activo !== undefined && typeof raw.activo !== "boolean") throw Errors.validation("activo debe ser true o false.");
    const precioBaseCentavos = parseCentavos(raw.precioBaseMxn, "precioBaseMxn");
    const precioAsientoCentavos = parseCentavos(raw.precioAsientoMxn, "precioAsientoMxn");

    try {
      const result = await deps.engine.withAppSession({ userId: callerId }, (db) =>
        repo(db).upsertPlan(callerId, { id, nombre, vertical, precioBaseCentavos, precioAsientoCentavos, asientosIncluidos, activo: typeof raw.activo === "boolean" ? raw.activo : true }),
      );
      if (result.availability === "not_migrated") throw Errors.serviceUnavailable(NO_DISPONIBLE);
      return c.json({ ok: true });
    } catch (err) {
      return traducirErrorSeguridad(err);
    }
  });

  app.put("/superadmin/planes/:id/limites/:metrica", async (c) => {
    if (!deps.costosPlanesRepo) throw Errors.serviceUnavailable(NO_DISPONIBLE);
    const repo = deps.costosPlanesRepo;
    const callerId = c.get("userId");
    await limitar(c, callerId, "planes-limites");
    const planId = c.req.param("id");
    const metrica = c.req.param("metrica") as MetricaLimiteRow;
    if (!PLAN_ID_RE.test(planId)) throw Errors.validation("id de plan inválido.");
    if (!METRICAS_LIMITE.includes(metrica)) throw Errors.validation(`metrica debe ser una de: ${METRICAS_LIMITE.join(", ")}.`);
    const raw = (await c.req.json().catch(() => ({}))) as { limite?: unknown; accion?: unknown };
    if (typeof raw.limite !== "number" || !Number.isInteger(raw.limite) || raw.limite < 0 || raw.limite > Number.MAX_SAFE_INTEGER) throw Errors.validation("limite debe ser un entero >= 0 (el tope LLM va en micro-USD).");
    const accion = raw.accion as AccionLimiteRow;
    if (!ACCIONES_LIMITE.includes(accion)) throw Errors.validation(`accion debe ser una de: ${ACCIONES_LIMITE.join(", ")}.`);

    try {
      const result = await deps.engine.withAppSession({ userId: callerId }, (db) => repo(db).setPlanLimit(callerId, planId, metrica, raw.limite as number, accion));
      if (result.availability === "not_migrated") throw Errors.serviceUnavailable(NO_DISPONIBLE);
      return c.json({ ok: true });
    } catch (err) {
      return traducirErrorSeguridad(err);
    }
  });

  app.delete("/superadmin/planes/:id/limites/:metrica", async (c) => {
    if (!deps.costosPlanesRepo) throw Errors.serviceUnavailable(NO_DISPONIBLE);
    const repo = deps.costosPlanesRepo;
    const callerId = c.get("userId");
    await limitar(c, callerId, "planes-limites");
    const planId = c.req.param("id");
    const metrica = c.req.param("metrica") as MetricaLimiteRow;
    if (!PLAN_ID_RE.test(planId)) throw Errors.validation("id de plan inválido.");
    if (!METRICAS_LIMITE.includes(metrica)) throw Errors.validation(`metrica debe ser una de: ${METRICAS_LIMITE.join(", ")}.`);
    try {
      const result = await deps.engine.withAppSession({ userId: callerId }, (db) => repo(db).deletePlanLimit(callerId, planId, metrica));
      if (result.availability === "not_migrated") throw Errors.serviceUnavailable(NO_DISPONIBLE);
      return c.json({ ok: true });
    } catch (err) {
      return traducirErrorSeguridad(err);
    }
  });

  app.get("/superadmin/planes/asignaciones", async (c) => {
    if (!deps.costosPlanesRepo) return c.json({ disponible: false, asignaciones: [] });
    const repo = deps.costosPlanesRepo;
    const callerId = c.get("userId");
    const { availability, assignments } = await deps.engine.withAppSession({ userId: callerId }, (db) => repo(db).listAssignments(callerId, 100));
    return c.json({ disponible: availability === "available", asignaciones: assignments.map(serializeAsignacion) });
  });

  // Primer paso: NUNCA asigna nada, solo registra la solicitud (vence en 10 min).
  app.post("/superadmin/planes/asignaciones", async (c) => {
    if (!deps.costosPlanesRepo) throw Errors.serviceUnavailable(NO_DISPONIBLE);
    const repo = deps.costosPlanesRepo;
    const callerId = c.get("userId");
    await limitar(c, callerId, "planes-solicitar");
    const raw = (await c.req.json().catch(() => ({}))) as { organizationId?: unknown; planId?: unknown; motivo?: unknown };
    const organizationId = typeof raw.organizationId === "string" ? raw.organizationId.trim() : "";
    if (!UUID_RE.test(organizationId)) throw Errors.validation("organizationId debe ser un UUID válido.");
    const planId = typeof raw.planId === "string" ? raw.planId : "";
    if (!PLAN_ID_RE.test(planId)) throw Errors.validation("planId inválido.");
    const motivo = typeof raw.motivo === "string" ? raw.motivo : "";
    if (motivo.trim().length < 20) throw Errors.validation("motivo obligatorio (mínimo 20 caracteres).");

    try {
      const result = await deps.engine.withAppSession({ userId: callerId }, (db) => repo(db).requestAssignment(callerId, organizationId, planId, motivo));
      if (result.availability === "not_migrated" || !result.assignment) throw Errors.serviceUnavailable(NO_DISPONIBLE);
      return c.json({ asignacion: serializeAsignacion(result.assignment) }, 201);
    } catch (err) {
      return traducirErrorSeguridad(err);
    }
  });

  // Segundo paso (sensible, step-up): confirma y APLICA. Solo el solicitante; el SQL revalida el estado del mundo.
  app.post("/superadmin/planes/asignaciones/:id/confirmar", async (c) => {
    if (!deps.costosPlanesRepo) throw Errors.serviceUnavailable(NO_DISPONIBLE);
    const repo = deps.costosPlanesRepo;
    const callerId = c.get("userId");
    await limitar(c, callerId, "planes-confirmar");
    const id = c.req.param("id");
    if (!UUID_RE.test(id)) throw Errors.validation("id de solicitud inválido.");
    try {
      const result = await deps.engine.withAppSession({ userId: callerId }, (db) => repo(db).confirmAssignment(callerId, id));
      if (result.availability === "not_migrated" || !result.assignment) throw Errors.serviceUnavailable(NO_DISPONIBLE);
      if (result.assignment.estado === "expired") throw Errors.conflict("Esta solicitud ya venció: créala de nuevo.");
      return c.json({ asignacion: serializeAsignacion(result.assignment) });
    } catch (err) {
      return traducirErrorSeguridad(err);
    }
  });

  app.post("/superadmin/planes/asignaciones/:id/cancelar", async (c) => {
    if (!deps.costosPlanesRepo) throw Errors.serviceUnavailable(NO_DISPONIBLE);
    const repo = deps.costosPlanesRepo;
    const callerId = c.get("userId");
    const id = c.req.param("id");
    if (!UUID_RE.test(id)) throw Errors.validation("id de solicitud inválido.");
    try {
      const result = await deps.engine.withAppSession({ userId: callerId }, (db) => repo(db).cancelAssignment(callerId, id));
      if (result.availability === "not_migrated" || !result.assignment) throw Errors.serviceUnavailable(NO_DISPONIBLE);
      return c.json({ asignacion: serializeAsignacion(result.assignment) });
    } catch (err) {
      return traducirErrorSeguridad(err);
    }
  });

  return app;
}
