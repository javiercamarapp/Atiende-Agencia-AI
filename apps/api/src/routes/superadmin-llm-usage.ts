// Control de gasto de API de LLM — primera pieza del "cerebro" de backoffice
// pedido por el dueño (superadmin con visión de gasto real de las 6
// verticales). Vive en un archivo APARTE de `superadmin.ts` (mismo criterio
// que separar `billing.ts`/`notifications.ts`: cada concern de plataforma en
// su propio archivo, montado por separado en `app.ts`), no una extensión del
// existente — evita que un archivo ya grande siga creciendo por temas no
// relacionados (prospectos/paneles vs. gasto de LLM).
//
// Auditoría previa de este gateway (ver `packages/agent-core/src/gateway`):
// medía tokens in/out, costo estimado y modelo/proveedor POR LLAMADA, pero
// NUNCA los persistía (solo un `BudgetLedgerStore` en memoria de proceso,
// defensa en profundidad por-instancia, ver budget.ts) — cero observabilidad
// real de gasto, y ningún tope sobrevivía a un reinicio o era compartido
// entre instancias de Vercel Fluid Compute. Esta ruta expone lo que
// `migrations/0010_llm_usage_budget_schema.sql` + `deps.llmUsageRepo` ya
// resuelven: lectura de gasto real (rango de fechas, desglose por
// organización/vertical/proveedor/modelo, % de tope usado) y escritura del
// tope mensual por organización + tope global de plataforma.
//
// Autorización real: las funciones SQL que `deps.llmUsageRepo` consume YA
// verifican `core.is_platform_superadmin(p_caller_id)` por dentro — el
// middleware de aquí (`requireSuperadmin`, MISMO patrón que
// `superadmin.ts::app.use("/superadmin/*", ...)`) es defensa en profundidad
// (403 explícito en vez de "0 resultados" silencioso), nunca la única
// autoridad real.
import { Hono } from "hono";
import { authMiddleware } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { LlmOrganizationNotFoundError, isMigrationPendingError } from "@atiende/db";
import { Errors } from "../errors.ts";
import type { AppDeps } from "../deps.ts";
import { ALL_PRODUCTION_ROLES, DATA_CHAT_RETRY_ROLES } from "../production/llm-gateway.ts";
import { NEW_PLATFORM_LLM_ROLES } from "../production/llm-models.ts";
import { defaultRoleDailyTurnLimit } from "../production/llm-role-limits.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NO_DISPONIBLE_AUN = "El reporte por rol requiere la migración 0046, que aún no está aplicada.";

/** Roles con tope diario de turnos (los que tienen default): los unicos que el superadmin puede ajustar por organizacion. */
function rolesConTopeDiario(): { role: string; maxTurnosDia: number }[] {
  const roles = [...new Set([...ALL_PRODUCTION_ROLES, ...DATA_CHAT_RETRY_ROLES, ...NEW_PLATFORM_LLM_ROLES])];
  return roles.flatMap((role) => {
    const maxTurnosDia = defaultRoleDailyTurnLimit(role);
    return maxTurnosDia === undefined ? [] : [{ role, maxTurnosDia }];
  });
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_RANGE_DAYS = 30;

/** `YYYY-MM-DD` en UTC (mismo formato que `core.llm_usage_daily.usage_date`,
 *  que agrega por `current_date` del servidor de Postgres) — nunca la hora
 *  local del proceso Node, para que "hoy" del rango por defecto coincida con
 *  "hoy" de las filas que Postgres ya escribió. */
function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Rango de fechas del query — ambos, uno, o ninguno de `from`/`to`. Sin
 *  ninguno de los dos: últimos 30 días (incluye hoy). `to` sin `from`: 30
 *  días terminando en `to`. `from` sin `to`: desde `from` hasta hoy. */
function parseDateRange(c: { req: { query: (name: string) => string | undefined } }): { from: string; to: string } {
  const rawFrom = c.req.query("from");
  const rawTo = c.req.query("to");
  if (rawFrom !== undefined && !DATE_RE.test(rawFrom)) throw Errors.validation("from debe tener formato YYYY-MM-DD");
  if (rawTo !== undefined && !DATE_RE.test(rawTo)) throw Errors.validation("to debe tener formato YYYY-MM-DD");

  const today = new Date();
  const to = rawTo ?? isoDate(today);
  if (rawFrom) return { from: rawFrom, to };

  const fromDate = new Date(`${to}T00:00:00.000Z`);
  fromDate.setUTCDate(fromDate.getUTCDate() - (DEFAULT_RANGE_DAYS - 1));
  return { from: isoDate(fromDate), to };
}

function parsePositiveUsd(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw Errors.validation(`${field} debe ser un número positivo (USD).`);
  }
  return value;
}

function parseAlertThresholdPct(value: unknown): number {
  if (value === undefined || value === null) return 80;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 100) {
    throw Errors.validation("alertThresholdPct debe estar entre 0 (exclusivo) y 100.");
  }
  return value;
}

interface SetCapBody {
  readonly monthlyCapUsd?: unknown;
  readonly alertThresholdPct?: unknown;
}

export function superadminLlmUsageRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  app.use("/superadmin/gasto-api/*", authMiddleware(deps.env));
  app.use("/superadmin/gasto-api/*", async (c, next) => {
    if (!(await deps.coreRepo.isPlatformSuperadmin(c.get("userId")))) {
      throw Errors.forbidden("Este panel es exclusivo del back office de plataforma.");
    }
    await next();
  });

  // Totales del periodo + tope/gasto de plataforma en un solo viaje — la
  // pantalla los muestra juntos arriba de todo (ver diseño de
  // `/superadmin/gasto-api` en el frontend).
  app.get("/superadmin/gasto-api/resumen", async (c) => {
    const { from, to } = parseDateRange(c);
    const callerId = c.get("userId");
    const [summary, platformBudget] = await Promise.all([
      deps.llmUsageRepo.getUsageSummaryForSuperadmin(callerId, from, to),
      deps.llmUsageRepo.getPlatformBudgetForSuperadmin(callerId),
    ]);
    return c.json({
      range: { from, to },
      usage: summary,
      platformBudget,
    });
  });

  // Desglose por organización — incluye el tope configurado (o el default) y
  // el % de tope usado este MES (no del rango, ver el comentario de la
  // función SQL): "cuánto cabe todavía este mes" es una pregunta distinta de
  // "cuánto gastó en el rango que estoy mirando". Ordenado por gasto del
  // rango descendente — la propia lista, tomando los primeros N, ES el "top
  // consumidores" pedido (no se duplica un endpoint aparte para lo mismo).
  app.get("/superadmin/gasto-api/organizaciones", async (c) => {
    const { from, to } = parseDateRange(c);
    const rows = await deps.llmUsageRepo.listUsageByOrganizationForSuperadmin(c.get("userId"), from, to);
    return c.json({
      range: { from, to },
      organizaciones: rows.map((r) => ({
        ...r,
        pctTopeUsado: r.monthlyCapMicroUsd > 0 ? Math.min(999, (r.spendThisMonthMicroUsd / r.monthlyCapMicroUsd) * 100) : 0,
      })),
    });
  });

  // Desglose por vertical + proveedor + modelo — `organizationId` opcional
  // (ausente = plataforma completa).
  app.get("/superadmin/gasto-api/desglose", async (c) => {
    const { from, to } = parseDateRange(c);
    const organizationId = c.req.query("organizationId") ?? null;
    const rows = await deps.llmUsageRepo.listUsageByProviderModelForSuperadmin(c.get("userId"), from, to, organizationId);
    return c.json({ range: { from, to }, desglose: rows });
  });

  // CHAT-07: gasto por organizacion, rol y mes (de core.llm_usage_daily, el costo REAL que reporto el proveedor). Detras de step-up
  // (SENSITIVE_ROUTES). Sin la migracion 0046 responde `disponible: false` con la lista vacia (nunca un 500).
  app.get("/superadmin/gasto-api/por-rol", async (c) => {
    const { from, to } = parseDateRange(c);
    try {
      const filas = await deps.llmUsageRepo.listUsageByOrgRoleMonthForSuperadmin(c.get("userId"), from, to);
      return c.json({ range: { from, to }, disponible: true, filas });
    } catch (err) {
      if (isMigrationPendingError(err)) return c.json({ range: { from, to }, disponible: false, mensaje: NO_DISPONIBLE_AUN, filas: [] });
      throw err;
    }
  });

  // Tope diario de turnos por rol de una organizacion: los defaults del sistema y los topes propios con el uso de hoy.
  app.get("/superadmin/gasto-api/organizaciones/:id/topes-rol", async (c) => {
    const organizationId = c.req.param("id");
    if (!UUID_RE.test(organizationId)) throw Errors.validation("El id de la organización no es válido.");
    try {
      const propios = await deps.llmUsageRepo.listOrgRoleLimitsForSuperadmin(c.get("userId"), organizationId);
      return c.json({ disponible: true, defaults: rolesConTopeDiario(), propios });
    } catch (err) {
      if (isMigrationPendingError(err)) return c.json({ disponible: false, mensaje: NO_DISPONIBLE_AUN, defaults: rolesConTopeDiario(), propios: [] });
      throw err;
    }
  });

  app.put("/superadmin/gasto-api/organizaciones/:id/topes-rol", async (c) => {
    const organizationId = c.req.param("id");
    if (!UUID_RE.test(organizationId)) throw Errors.validation("El id de la organización no es válido.");
    const raw = (await c.req.json().catch(() => ({}))) as { role?: unknown; maxTurnosDia?: unknown };
    const role = typeof raw.role === "string" ? raw.role : "";
    if (!rolesConTopeDiario().some((r) => r.role === role)) throw Errors.validation("role debe ser un rol con tope diario de turnos.");
    if (typeof raw.maxTurnosDia !== "number" || !Number.isInteger(raw.maxTurnosDia) || raw.maxTurnosDia < 1 || raw.maxTurnosDia > 100_000) {
      throw Errors.validation("maxTurnosDia debe ser un entero entre 1 y 100000.");
    }
    try {
      await deps.llmUsageRepo.setOrgRoleLimitForSuperadmin(c.get("userId"), organizationId, role, raw.maxTurnosDia);
    } catch (err) {
      if (err instanceof LlmOrganizationNotFoundError) throw Errors.notFound(err.message);
      if (isMigrationPendingError(err)) throw Errors.serviceUnavailable(NO_DISPONIBLE_AUN);
      throw err;
    }
    return c.json({ ok: true });
  });

  app.put("/superadmin/gasto-api/organizaciones/:id/tope", async (c) => {
    const raw = (await c.req.json().catch(() => ({}))) as SetCapBody;
    const monthlyCapUsd = parsePositiveUsd(raw.monthlyCapUsd, "monthlyCapUsd");
    const alertThresholdPct = parseAlertThresholdPct(raw.alertThresholdPct);
    try {
      await deps.llmUsageRepo.setOrgMonthlyCapForSuperadmin(c.get("userId"), c.req.param("id"), Math.round(monthlyCapUsd * 1_000_000), alertThresholdPct);
    } catch (err) {
      if (err instanceof LlmOrganizationNotFoundError) throw Errors.notFound(err.message);
      throw err;
    }
    return c.json({ ok: true });
  });

  app.put("/superadmin/gasto-api/plataforma/tope", async (c) => {
    const raw = (await c.req.json().catch(() => ({}))) as SetCapBody;
    const monthlyCapUsd = parsePositiveUsd(raw.monthlyCapUsd, "monthlyCapUsd");
    const alertThresholdPct = parseAlertThresholdPct(raw.alertThresholdPct);
    await deps.llmUsageRepo.setPlatformMonthlyCapForSuperadmin(c.get("userId"), Math.round(monthlyCapUsd * 1_000_000), alertThresholdPct);
    return c.json({ ok: true });
  });

  return app;
}
