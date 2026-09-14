// Fase 6 (cierre mensual): checklist de cierre + validaciones de balance +
// bloqueo de edición de movimientos ya cerrados. A diferencia de
// declaraciones.ts/conciliacion.ts, ESTE motor SÍ persiste estado
// (`despachos.periodo_cierre`/`periodo_cierre_tarea`, migrations/003) —
// necesario para que "bloquear edición de movimientos ya cerrados" tenga
// sentido entre requests (ver `cfdi.ts`, que consulta
// `findPeriodoCierrePorAnioMes` antes de ingestar). Las validaciones de
// balance (`validaciones.ts`) SÍ son un endpoint puro/calculadora aparte.
import { Hono } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import {
  VER_CIERRE_MENSUAL_ROLES,
  GESTIONAR_CIERRE_MENSUAL_ROLES,
  CERRAR_PERIODO_ROLES,
  getTemplate,
  verificarPeriodoNoDuplicado,
  completarTarea,
  autoCheckTareas,
  recomputeOverdue,
  calcularEstadoPeriodo,
  cerrarPeriodo,
  generarReporteCierre,
  validateBalanceCuadrada,
  validatePolizasCuadradas,
  validateNominaCuadrada,
  validateIvaConciliado,
  validateIsrProvisionado,
  validateBancosConciliados,
  PeriodoYaAbiertoError,
  CierreValidacionError,
  TareaCierreEstadoInvalidoError,
} from "@atiende/domain-despachos";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";

function optionalNumber(value: unknown, field: string, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) throw Errors.validation(`${field}: se esperaba un número.`);
  return value;
}

function requireNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw Errors.validation(`${field}: se esperaba un número.`);
  return value;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function despachosCierreMensualRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  app.use("/despachos/:propertyId/cierre-mensual/*", authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  app.post("/despachos/:propertyId/cierre-mensual/periodos", async (c) => {
    assertVerticalRole(c, GESTIONAR_CIERRE_MENSUAL_ROLES);
    const raw = await readJsonCapped<{ readonly anio?: unknown; readonly mes?: unknown; readonly templateName?: unknown }>(c.req.raw, 8 * 1024);
    const anio = requireNumber(raw.anio, "anio");
    const mes = requireNumber(raw.mes, "mes");
    if (mes < 1 || mes > 12) throw Errors.validation("mes: se esperaba 1-12.");
    const propertyId = c.req.param("propertyId");
    const repo = deps.despachosRepo(c.get("db"));

    const periodosExistentes = await repo.listPeriodosCierre(propertyId);
    try {
      verificarPeriodoNoDuplicado(periodosExistentes, anio, mes);
    } catch (err) {
      if (err instanceof PeriodoYaAbiertoError) throw Errors.conflict(err.message);
      throw err;
    }

    const template = getTemplate(typeof raw.templateName === "string" ? raw.templateName : undefined);
    const { periodo, tareas } = await repo.insertPeriodoCierre({ organizationId: c.get("organizationId"), propertyId, anio, mes, template });
    return c.json({ periodo, tareas }, 201);
  });

  app.get("/despachos/:propertyId/cierre-mensual/periodos", async (c) => {
    assertVerticalRole(c, VER_CIERRE_MENSUAL_ROLES);
    const repo = deps.despachosRepo(c.get("db"));
    const periodos = await repo.listPeriodosCierre(c.req.param("propertyId"));
    return c.json({ periodos });
  });

  app.get("/despachos/:propertyId/cierre-mensual/periodos/:periodoId", async (c) => {
    assertVerticalRole(c, VER_CIERRE_MENSUAL_ROLES);
    const repo = deps.despachosRepo(c.get("db"));
    const propertyId = c.req.param("propertyId");
    const periodoId = c.req.param("periodoId");
    const periodo = await repo.findPeriodoCierre(propertyId, periodoId);
    if (!periodo) throw Errors.notFound("Período de cierre no encontrado.");
    const tareas = await repo.listTareasCierre(periodoId);
    const hoy = todayIso();
    const periodoActualizado = recomputeOverdue(periodo, tareas, hoy);
    if (periodoActualizado.status !== periodo.status) await repo.updatePeriodoCierre(periodoActualizado);
    const estado = calcularEstadoPeriodo(tareas, hoy);
    return c.json({ periodo: periodoActualizado, tareas, estado });
  });

  app.post("/despachos/:propertyId/cierre-mensual/periodos/:periodoId/tareas/:tareaId/completar", async (c) => {
    assertVerticalRole(c, GESTIONAR_CIERRE_MENSUAL_ROLES);
    const raw = await readJsonCapped<{ readonly userId?: unknown }>(c.req.raw, 2 * 1024);
    const repo = deps.despachosRepo(c.get("db"));
    const propertyId = c.req.param("propertyId");
    const periodoId = c.req.param("periodoId");
    const periodo = await repo.findPeriodoCierre(propertyId, periodoId);
    if (!periodo) throw Errors.notFound("Período de cierre no encontrado.");
    const tareas = await repo.listTareasCierre(periodoId);
    const userId = typeof raw.userId === "string" ? raw.userId : "";
    try {
      const actualizadas = completarTarea(tareas, c.req.param("tareaId"), userId, new Date().toISOString());
      const persistidas = await repo.replaceTareasCierre(periodoId, actualizadas);
      return c.json({ tareas: persistidas });
    } catch (err) {
      if (err instanceof TareaCierreEstadoInvalidoError) throw Errors.conflict(err.message);
      throw err;
    }
  });

  app.post("/despachos/:propertyId/cierre-mensual/periodos/:periodoId/auto-check", async (c) => {
    assertVerticalRole(c, GESTIONAR_CIERRE_MENSUAL_ROLES);
    const raw = await readJsonCapped<{ readonly moduleState?: unknown; readonly userId?: unknown }>(c.req.raw, 32 * 1024);
    const repo = deps.despachosRepo(c.get("db"));
    const propertyId = c.req.param("propertyId");
    const periodoId = c.req.param("periodoId");
    const periodo = await repo.findPeriodoCierre(propertyId, periodoId);
    if (!periodo) throw Errors.notFound("Período de cierre no encontrado.");
    const tareas = await repo.listTareasCierre(periodoId);
    const moduleState = typeof raw.moduleState === "object" && raw.moduleState !== null ? (raw.moduleState as Record<string, unknown>) : {};
    const userId = typeof raw.userId === "string" ? raw.userId : "system";
    const { tareas: actualizadas, completadas } = autoCheckTareas(tareas, moduleState, userId, new Date().toISOString());
    const persistidas = await repo.replaceTareasCierre(periodoId, actualizadas);
    const periodoActualizado = recomputeOverdue(periodo, persistidas, todayIso());
    if (periodoActualizado.status !== periodo.status) await repo.updatePeriodoCierre(periodoActualizado);
    return c.json({ tareas: persistidas, completadas, periodo: periodoActualizado });
  });

  app.post("/despachos/:propertyId/cierre-mensual/periodos/:periodoId/cerrar", async (c) => {
    assertVerticalRole(c, CERRAR_PERIODO_ROLES);
    const raw = await readJsonCapped<{ readonly userId?: unknown }>(c.req.raw, 2 * 1024);
    const repo = deps.despachosRepo(c.get("db"));
    const propertyId = c.req.param("propertyId");
    const periodoId = c.req.param("periodoId");
    const periodo = await repo.findPeriodoCierre(propertyId, periodoId);
    if (!periodo) throw Errors.notFound("Período de cierre no encontrado.");
    const tareas = await repo.listTareasCierre(periodoId);
    const userId = typeof raw.userId === "string" ? raw.userId : "";
    try {
      const cerrado = cerrarPeriodo(periodo, tareas, userId, new Date().toISOString());
      const persistido = await repo.updatePeriodoCierre(cerrado);
      return c.json(persistido);
    } catch (err) {
      if (err instanceof CierreValidacionError) throw Errors.conflict(err.message);
      throw err;
    }
  });

  app.get("/despachos/:propertyId/cierre-mensual/periodos/:periodoId/reporte", async (c) => {
    assertVerticalRole(c, VER_CIERRE_MENSUAL_ROLES);
    const repo = deps.despachosRepo(c.get("db"));
    const propertyId = c.req.param("propertyId");
    const periodoId = c.req.param("periodoId");
    const periodo = await repo.findPeriodoCierre(propertyId, periodoId);
    if (!periodo) throw Errors.notFound("Período de cierre no encontrado.");
    const tareas = await repo.listTareasCierre(periodoId);
    return c.json(generarReporteCierre(periodo, tareas, todayIso()));
  });

  // ---- Validaciones de balance (endpoint puro/calculadora, sin persistencia) ----

  app.post("/despachos/:propertyId/cierre-mensual/validaciones/balance", async (c) => {
    assertVerticalRole(c, VER_CIERRE_MENSUAL_ROLES);
    const raw = await readJsonCapped<{ readonly totalDebe?: unknown; readonly totalHaber?: unknown; readonly toleranciaBalance?: unknown }>(c.req.raw, 2 * 1024);
    return c.json(validateBalanceCuadrada(requireNumber(raw.totalDebe, "totalDebe"), requireNumber(raw.totalHaber, "totalHaber"), optionalNumber(raw.toleranciaBalance, "toleranciaBalance", 1.0)));
  });

  app.post("/despachos/:propertyId/cierre-mensual/validaciones/polizas", async (c) => {
    assertVerticalRole(c, VER_CIERRE_MENSUAL_ROLES);
    const raw = await readJsonCapped<{ readonly polizas?: unknown }>(c.req.raw, 256 * 1024);
    if (!Array.isArray(raw.polizas)) throw Errors.validation("polizas: se esperaba un arreglo.");
    const polizas = (raw.polizas as { id?: unknown; totalDebe?: unknown; totalHaber?: unknown }[]).map((p, idx) => ({
      id: typeof p.id === "string" ? p.id : undefined,
      totalDebe: requireNumber(p.totalDebe, `polizas[${idx}].totalDebe`),
      totalHaber: requireNumber(p.totalHaber, `polizas[${idx}].totalHaber`),
    }));
    return c.json(validatePolizasCuadradas(polizas));
  });

  app.post("/despachos/:propertyId/cierre-mensual/validaciones/nomina", async (c) => {
    assertVerticalRole(c, VER_CIERRE_MENSUAL_ROLES);
    const raw = await readJsonCapped<{ readonly nominas?: unknown }>(c.req.raw, 256 * 1024);
    if (!Array.isArray(raw.nominas)) throw Errors.validation("nominas: se esperaba un arreglo.");
    const nominas = (raw.nominas as { sueldoBruto?: unknown; totalDeducciones?: unknown; sueldoNeto?: unknown }[]).map((n, idx) => ({
      sueldoBruto: requireNumber(n.sueldoBruto, `nominas[${idx}].sueldoBruto`),
      totalDeducciones: requireNumber(n.totalDeducciones, `nominas[${idx}].totalDeducciones`),
      sueldoNeto: requireNumber(n.sueldoNeto, `nominas[${idx}].sueldoNeto`),
    }));
    return c.json(validateNominaCuadrada(nominas));
  });

  app.post("/despachos/:propertyId/cierre-mensual/validaciones/iva", async (c) => {
    assertVerticalRole(c, VER_CIERRE_MENSUAL_ROLES);
    const raw = await readJsonCapped<{ readonly ivaTrasladado?: unknown; readonly ivaAcreditable?: unknown; readonly ivaProvisionado?: unknown; readonly tolerance?: unknown }>(c.req.raw, 2 * 1024);
    return c.json(
      validateIvaConciliado(
        requireNumber(raw.ivaTrasladado, "ivaTrasladado"),
        requireNumber(raw.ivaAcreditable, "ivaAcreditable"),
        requireNumber(raw.ivaProvisionado, "ivaProvisionado"),
        optionalNumber(raw.tolerance, "tolerance", 100.0),
      ),
    );
  });

  app.post("/despachos/:propertyId/cierre-mensual/validaciones/isr", async (c) => {
    assertVerticalRole(c, VER_CIERRE_MENSUAL_ROLES);
    const raw = await readJsonCapped<{ readonly isrProvision?: unknown; readonly utilidadFiscal?: unknown; readonly isrRate?: unknown }>(c.req.raw, 2 * 1024);
    return c.json(validateIsrProvisionado(requireNumber(raw.isrProvision, "isrProvision"), requireNumber(raw.utilidadFiscal, "utilidadFiscal"), optionalNumber(raw.isrRate, "isrRate", 0.3)));
  });

  app.post("/despachos/:propertyId/cierre-mensual/validaciones/bancos", async (c) => {
    assertVerticalRole(c, VER_CIERRE_MENSUAL_ROLES);
    const raw = await readJsonCapped<{ readonly matchRate?: unknown; readonly minReconciliationRate?: unknown; readonly totalMovements?: unknown; readonly matched?: unknown }>(c.req.raw, 2 * 1024);
    return c.json(
      validateBancosConciliados(
        requireNumber(raw.matchRate, "matchRate"),
        optionalNumber(raw.minReconciliationRate, "minReconciliationRate", 0.8),
        optionalNumber(raw.totalMovements, "totalMovements", 0),
        optionalNumber(raw.matched, "matched", 0),
      ),
    );
  });

  return app;
}
