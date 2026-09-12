// Fase 4 (cierre de gap): el motor de nómina completa (Fase 3 — ISR nómina, IMSS/
// Infonavit, subsidio, prestaciones) quedó construido, verificado contra el
// intérprete Python real (136 casos de golden-set) y 100% cubierto por tests de
// dominio, pero ninguna ruta HTTP lo invocaba — mismo oversight real que
// declaraciones.ts (Fase 2/3 se enfocaron en el motor, no en cablearlo). Esta ruta
// lo cierra, exponiendo `procesarNomina()` (el puerto de `process_payroll`, que ya
// compone ISR+IMSS+Infonavit+subsidio para un periodo completo de empleados).
//
// Igual que declaraciones.ts: es un endpoint puro/calculadora, sin persistencia.
// Ningún esquema de despachos modela "periodo de nómina procesado" como entidad
// propia — agregar esa tabla sería alcance nuevo no pedido por este cierre de gap.
// `procesarNomina` ya trae su propia `idempotencyKey` derivada de (year, month,
// tenantId) en el resultado, para que quien persista la respuesta pueda deduplicar.
//
// Nota de negocio heredada y NO resuelta aquí (ver diseño Fase 3 despachos §5.2): el
// repo Python origen tiene un segundo motor de nómina (`services/payroll.py`) que no
// coincide con `nomina_completa` (~2.6× de diferencia en IMSS obrero). Esta ruta
// expone el motor YA PORTADO (`nomina_completa`, el que la tarea de Fase 3 pidió
// explícitamente) — cuál de los dos es "el bueno" para producción sigue siendo
// decisión de negocio pendiente de Javier/legal, no se resuelve unilateralmente aquí.
import { Hono } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { procesarNomina, NOMINA_ROLES } from "@atiende/domain-despachos";
import type { EmployeePayrollInput, PayrollPeriodInput } from "@atiende/domain-despachos";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";

interface PeriodBody {
  readonly month?: unknown;
  readonly year?: unknown;
  readonly diasPagados?: unknown;
  readonly salarioDiarioDefault?: unknown;
}

interface EmployeeBody {
  readonly employeeId?: unknown;
  readonly nombre?: unknown;
  readonly salarioBruto?: unknown;
  readonly percepciones?: unknown;
  readonly salarioDiario?: unknown;
}

interface ProcesarNominaBody {
  readonly period?: PeriodBody;
  readonly employees?: unknown;
  readonly tenantId?: unknown;
}

function optionalNumber(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw Errors.validation(`${field}: se esperaba un número.`);
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw Errors.validation(`${field}: se esperaba un texto.`);
  return value;
}

function parsePeriod(raw: PeriodBody | undefined): PayrollPeriodInput {
  const p = raw ?? {};
  return {
    month: optionalNumber(p.month, "period.month"),
    year: optionalNumber(p.year, "period.year"),
    diasPagados: optionalNumber(p.diasPagados, "period.diasPagados"),
    salarioDiarioDefault: optionalNumber(p.salarioDiarioDefault, "period.salarioDiarioDefault"),
  };
}

function parseEmployees(raw: unknown): readonly EmployeePayrollInput[] {
  if (!Array.isArray(raw)) throw Errors.validation("employees: se esperaba un arreglo.");
  return (raw as EmployeeBody[]).map((e, i) => ({
    employeeId: optionalString(e.employeeId, `employees[${i}].employeeId`),
    nombre: optionalString(e.nombre, `employees[${i}].nombre`),
    salarioBruto: optionalNumber(e.salarioBruto, `employees[${i}].salarioBruto`),
    percepciones: optionalNumber(e.percepciones, `employees[${i}].percepciones`),
    salarioDiario: optionalNumber(e.salarioDiario, `employees[${i}].salarioDiario`),
  }));
}

export function despachosNominaRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  app.use("/despachos/:propertyId/nomina/*", authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  app.post("/despachos/:propertyId/nomina/calcular", async (c) => {
    assertVerticalRole(c, NOMINA_ROLES);
    const raw = await readJsonCapped<ProcesarNominaBody>(c.req.raw, 64 * 1024);
    const period = parsePeriod(raw.period);
    const employees = parseEmployees(raw.employees);
    const tenantId = optionalNumber(raw.tenantId, "tenantId") ?? null;

    const resultado = procesarNomina(period, employees, tenantId);
    return c.json(resultado);
  });

  return app;
}
