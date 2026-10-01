// H-03 (migracion 035) -- catalogo de agentes (kill switch, presupuesto mensual, costo acumulado), guardrails,
// politicas de aprobacion, plantillas de WhatsApp versionadas y COLA DE APROBACIONES HUMANAS. Mismo montaje que
// tickets.ts: authMiddleware + dbSession + requirePropertyMembership("propertyId"), filtrado fino con
// assertVerticalRole en cada handler (la RLS y las funciones definer de la 035 son la autoridad final).
//
// El agente PROPONE por sesion de sistema (`PostgresAgentesRepository.proposeAction`, ver production/deps.ts); aqui
// una persona decide con motivo. NUNCA se ejecuta sin aprobacion: `POST .../ejecutar` solo consume una solicitud ya
// aprobada, UNA vez (anti-replay), y respeta la expiracion y los guardrails vigentes.
//
// REGLA DURA DE COMPATIBILIDAD: contra una base sin la migracion 035 las lecturas degradan (`disponible: false`,
// listas vacias) y las escrituras responden 503 -- nunca un 500.
import { Hono } from "hono";
import type { Context } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { runWithSavepointFallback } from "@atiende/db";
import {
  AGENT_AUDIT_ROLES,
  AGENT_AUTHOR_ROLES,
  AGENT_CATALOG,
  AGENT_KEYS,
  AGENT_MANAGE_ROLES,
  AGENT_VIEW_ROLES,
  APPROVAL_ACTION_TYPES,
  APPROVAL_STATUSES,
  AUTO_ELIGIBLE_ACTION_TYPES,
  AgentesAccessDeniedError,
  AgentesConflictError,
  AgentesInvalidInputError,
  AgentesNotFoundError,
  AgentesUnavailableError,
  POLICY_APPROVER_ROLES,
  POLICY_MODES,
  PostgresAgentesRepository,
  TEMPLATE_CATEGORIES,
  TEMPLATE_LANGUAGES,
  agentRunState,
  currentUsageMonth,
  microUsdToUsd,
  normalizeBlockedWords,
  usdToMicroUsd,
  type Actor,
  type AgentConfigRecord,
  type AgentUsageRecord,
  type AgentesRepository,
  type ApprovalEventRecord,
  type ApprovalRecord,
  type GuardrailsRecord,
  type TemplateRecord,
  type ActionPolicyRecord,
} from "@atiende/domain-hoteles";
import { Errors } from "../../../errors.ts";
import type { AppDeps } from "../../../deps.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function serializeCatalog(configs: readonly AgentConfigRecord[], usage: readonly AgentUsageRecord[]) {
  return AGENT_CATALOG.map((entry) => {
    const cfg = configs.find((c) => c.agentKey === entry.key) ?? null;
    const use = usage.find((u) => u.agentKey === entry.key) ?? null;
    const spent = use?.costMicroUsd ?? 0;
    const budget = cfg?.budgetMicroUsd ?? null;
    const estado = agentRunState({ enabled: cfg?.enabled ?? true, budgetMicroUsd: budget, spentMicroUsd: spent, pausedReason: cfg?.pausedReason ?? null });
    return {
      clave: entry.key,
      nombre: entry.nombre,
      descripcion: entry.descripcion,
      /** false = ningun proceso consulta aun este interruptor/presupuesto (la UI lo advierte). */
      gobernado: entry.gobernado,
      activo: cfg?.enabled ?? true,
      estado,
      motivoPausa: cfg?.pausedReason ?? null,
      pausadoEn: cfg?.pausedAt ?? null,
      presupuestoUsd: budget === null ? null : microUsdToUsd(budget),
      gastoUsd: microUsdToUsd(spent),
      porcentajeUso: budget === null ? null : Math.round((spent / budget) * 1000) / 10,
      llamadas: use?.callCount ?? 0,
      tokensEntrada: use?.tokensIn ?? 0,
      tokensSalida: use?.tokensOut ?? 0,
    };
  });
}

function serializeApproval(a: ApprovalRecord) {
  return {
    id: a.id,
    agente: a.agentKey,
    accion: a.actionType,
    resumen: a.summary,
    detalle: a.payload,
    montoCentavos: a.amountCents,
    moneda: a.currency,
    porcentaje: a.percent,
    destinatarios: a.recipients,
    contenido: a.contentText,
    estado: a.status,
    propuestaPor: a.proposedBy,
    propuestaPorAgente: a.proposedBy === null,
    autoaprobada: a.autoApproved,
    motivoBloqueo: a.blockReason,
    expiraEn: a.expiresAt,
    decididaPor: a.decidedBy,
    decididaEn: a.decidedAt,
    motivoDecision: a.decisionReason,
    ejecutadaEn: a.executedAt,
    ejecutadaPor: a.executedBy,
    referenciaEjecucion: a.executionRef,
    creadaEn: a.createdAt,
  };
}

function serializeEvent(e: ApprovalEventRecord) {
  return { id: e.id, tipo: e.eventType, actorId: e.actorId, sistema: e.actorId === null, detalle: e.detail, creadoEn: e.createdAt };
}

function serializeGuardrails(g: GuardrailsRecord) {
  return {
    configurados: g.configured,
    maxDescuentoPct: g.maxDiscountPct,
    maxReembolsoCentavos: g.maxRefundCents,
    maxCargoFolioCentavos: g.maxFolioChargeCents,
    maxDestinatariosMasivo: g.maxMassRecipients,
    palabrasBloqueadas: g.blockedWords,
    ventanaEnvioInicio: g.sendWindowStart,
    ventanaEnvioFin: g.sendWindowEnd,
    actualizadoEn: g.updatedAt || null,
  };
}

function serializePolicy(p: ActionPolicyRecord) {
  return {
    accion: p.actionType,
    modo: p.mode,
    configurada: p.configured,
    umbralPorcentaje: p.autoMaxPercent,
    umbralMontoCentavos: p.autoMaxAmountCents,
    vigenciaMinutos: p.expiresMinutes,
    aprobadores: p.approverRoles,
    actualizadaEn: p.updatedAt,
  };
}

function serializeTemplate(t: TemplateRecord) {
  return {
    id: t.id,
    agente: t.agentKey,
    nombre: t.name,
    idioma: t.language,
    categoria: t.category,
    cuerpo: t.body,
    version: t.version,
    estado: t.status,
    creadaPor: t.createdBy,
    enviadaPor: t.submittedBy,
    enviadaEn: t.submittedAt,
    revisadaPor: t.reviewedBy,
    revisadaEn: t.reviewedAt,
    motivoRevision: t.reviewReason,
    creadaEn: t.createdAt,
  };
}

/** Traduce los errores de dominio de agentes a respuestas HTTP (nunca un 500 crudo). */
function toApiError(err: unknown): unknown {
  if (err instanceof AgentesUnavailableError) return Errors.serviceUnavailable(err.message);
  if (err instanceof AgentesNotFoundError) return Errors.notFound(err.message);
  if (err instanceof AgentesConflictError) return Errors.conflict(err.message);
  if (err instanceof AgentesInvalidInputError) return Errors.validation(err.message);
  if (err instanceof AgentesAccessDeniedError) return Errors.forbidden(err.message);
  return err;
}

async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw toApiError(err);
  }
}

function requireUuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID_RE.test(value)) throw Errors.validation(`${field}: se esperaba un UUID.`);
  return value;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) throw Errors.validation(`${field}: se esperaba ${allowed.join("|")}.`);
  return value as T;
}

function requireText(value: unknown, field: string, min: number, max: number): string {
  if (typeof value !== "string" || value.trim().length < min || value.length > max) throw Errors.validation(`${field}: texto de ${min} a ${max} caracteres.`);
  return value.trim();
}

function optionalNumber(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw Errors.validation(`${field}: se esperaba un numero.`);
  return value;
}

function positiveInt(value: unknown, field: string, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > max) throw Errors.validation(`${field}: entero entre 1 y ${max}.`);
  return value;
}

export function hotelesAgentesRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  const clock = () => new Date();

  for (const base of ["agentes", "aprobaciones"]) {
    app.use(`/hoteles/:propertyId/${base}/*`, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
    app.use(`/hoteles/:propertyId/${base}`, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  }

  function repoOf(c: Context<CoreAuthHonoEnv>): AgentesRepository {
    const db = c.get("db");
    return deps.hotelesAgentesRepo ? deps.hotelesAgentesRepo(db) : new PostgresAgentesRepository(db);
  }
  const actorOf = (c: Context<CoreAuthHonoEnv>): Actor => ({ userId: c.get("userId"), role: (c.get("verticalRole") ?? null) as string | null });

  async function readBody(c: Context<CoreAuthHonoEnv>): Promise<Record<string, unknown>> {
    const raw = await c.req.json().catch(() => ({}));
    return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  }

  // ---- catalogo de agentes ---------------------------------------------------------------

  async function catalogResponse(c: Context<CoreAuthHonoEnv>) {
    const now = clock();
    const month = currentUsageMonth(now);
    const result = await guarded(() => repoOf(c).listAgentConfig(c.req.param("propertyId") ?? "", month));
    return { disponible: result.disponible, mes: month, agentes: serializeCatalog(result.configs, result.usage) };
  }

  app.get("/hoteles/:propertyId/agentes", async (c) => {
    assertVerticalRole(c, AGENT_VIEW_ROLES);
    return c.json(await catalogResponse(c));
  });

  // ---- guardrails -----------------------------------------------------------------------

  app.get("/hoteles/:propertyId/agentes/guardrails", async (c) => {
    assertVerticalRole(c, AGENT_VIEW_ROLES);
    const result = await guarded(() => repoOf(c).getGuardrails(c.req.param("propertyId")));
    return c.json({ disponible: result.disponible, ...serializeGuardrails(result.guardrails) });
  });

  app.put("/hoteles/:propertyId/agentes/guardrails", async (c) => {
    assertVerticalRole(c, AGENT_MANAGE_ROLES);
    const raw = await readBody(c);
    const maxDiscountPct = optionalNumber(raw.maxDescuentoPct, "maxDescuentoPct");
    if (maxDiscountPct === undefined || !(maxDiscountPct > 0 && maxDiscountPct <= 100)) throw Errors.validation("maxDescuentoPct: numero en (0, 100].");
    const maxRefundCents = positiveInt(raw.maxReembolsoCentavos, "maxReembolsoCentavos", 100_000_000_00);
    const maxFolioChargeCents = positiveInt(raw.maxCargoFolioCentavos, "maxCargoFolioCentavos", 100_000_000_00);
    const maxMassRecipients = positiveInt(raw.maxDestinatariosMasivo, "maxDestinatariosMasivo", 100000);
    if (!Array.isArray(raw.palabrasBloqueadas) || raw.palabrasBloqueadas.length > 100 || raw.palabrasBloqueadas.some((w) => typeof w !== "string")) {
      throw Errors.validation("palabrasBloqueadas: lista de hasta 100 textos.");
    }
    let blockedWords: readonly string[];
    try {
      blockedWords = normalizeBlockedWords(raw.palabrasBloqueadas as string[]);
    } catch {
      throw Errors.validation("palabrasBloqueadas: cada palabra admite maximo 60 caracteres.");
    }
    const start = typeof raw.ventanaEnvioInicio === "string" && TIME_RE.test(raw.ventanaEnvioInicio) ? raw.ventanaEnvioInicio : null;
    const end = typeof raw.ventanaEnvioFin === "string" && TIME_RE.test(raw.ventanaEnvioFin) ? raw.ventanaEnvioFin : null;
    if (!start || !end) throw Errors.validation("ventanaEnvioInicio/ventanaEnvioFin: formato HH:MM.");
    if (!(start < end)) throw Errors.validation("La ventana de envio exige inicio < fin (sin ventanas nocturnas).");
    const saved = await guarded(() =>
      repoOf(c).upsertGuardrails(c.req.param("propertyId") ?? "", {
        maxDiscountPct, maxRefundCents, maxFolioChargeCents, maxMassRecipients, blockedWords, sendWindowStart: start, sendWindowEnd: end,
      }),
    );
    return c.json({ disponible: true, ...serializeGuardrails(saved) });
  });

  // ---- politicas de aprobacion -----------------------------------------------------------

  app.get("/hoteles/:propertyId/agentes/politicas", async (c) => {
    assertVerticalRole(c, AGENT_VIEW_ROLES);
    const result = await guarded(() => repoOf(c).listPolicies(c.req.param("propertyId")));
    return c.json({ disponible: result.disponible, politicas: result.politicas.map(serializePolicy), accionesAutomatizables: AUTO_ELIGIBLE_ACTION_TYPES });
  });

  app.put("/hoteles/:propertyId/agentes/politicas/:accion", async (c) => {
    assertVerticalRole(c, AGENT_MANAGE_ROLES);
    const action = oneOf(c.req.param("accion"), APPROVAL_ACTION_TYPES, "accion");
    const raw = await readBody(c);
    const mode = oneOf(raw.modo, POLICY_MODES, "modo");
    if (mode === "auto_bajo_umbral" && !AUTO_ELIGIBLE_ACTION_TYPES.includes(action)) {
      throw Errors.validation("El contenido para el huesped (resenas, mensajes masivos) exige aprobacion humana siempre.");
    }
    const percent = raw.umbralPorcentaje === undefined || raw.umbralPorcentaje === null ? null : optionalNumber(raw.umbralPorcentaje, "umbralPorcentaje") ?? null;
    const amount = raw.umbralMontoCentavos === undefined || raw.umbralMontoCentavos === null ? null : positiveInt(raw.umbralMontoCentavos, "umbralMontoCentavos", 100_000_000_00);
    if (mode === "auto_bajo_umbral") {
      if (action === "descuento_tarifa" && !(percent !== null && percent > 0 && percent <= 100)) throw Errors.validation("umbralPorcentaje: requerido, en (0, 100].");
      if (action !== "descuento_tarifa" && amount === null) throw Errors.validation("umbralMontoCentavos: requerido.");
    }
    const expiresMinutes = raw.vigenciaMinutos === undefined ? 1440 : positiveInt(raw.vigenciaMinutos, "vigenciaMinutos", 10080);
    if (expiresMinutes < 5) throw Errors.validation("vigenciaMinutos: minimo 5.");
    const roles = raw.aprobadores === undefined ? ["owner", "gm"] : raw.aprobadores;
    if (!Array.isArray(roles) || roles.length < 1 || roles.some((r) => !POLICY_APPROVER_ROLES.includes(r as never))) throw Errors.validation(`aprobadores: lista no vacia de ${POLICY_APPROVER_ROLES.join("|")}.`);
    const saved = await guarded(() =>
      repoOf(c).upsertPolicy(c.req.param("propertyId") ?? "", action, {
        mode, autoMaxPercent: mode === "auto_bajo_umbral" ? percent : null, autoMaxAmountCents: mode === "auto_bajo_umbral" ? amount : null,
        expiresMinutes, approverRoles: [...new Set(roles as typeof POLICY_APPROVER_ROLES[number][])],
      }),
    );
    return c.json(serializePolicy(saved));
  });

  // ---- plantillas de WhatsApp -------------------------------------------------------------

  app.get("/hoteles/:propertyId/agentes/plantillas", async (c) => {
    assertVerticalRole(c, AGENT_VIEW_ROLES);
    const result = await guarded(() => repoOf(c).listTemplates(c.req.param("propertyId")));
    return c.json({ disponible: result.disponible, plantillas: result.plantillas.map(serializeTemplate) });
  });

  app.post("/hoteles/:propertyId/agentes/plantillas", async (c) => {
    assertVerticalRole(c, AGENT_AUTHOR_ROLES);
    const raw = await readBody(c);
    const created = await guarded(() =>
      repoOf(c).createTemplate(
        {
          propertyId: c.req.param("propertyId") ?? "",
          agentKey: oneOf(raw.agente, AGENT_KEYS, "agente"),
          name: requireText(raw.nombre, "nombre", 3, 60),
          language: raw.idioma === undefined ? "es_MX" : oneOf(raw.idioma, TEMPLATE_LANGUAGES, "idioma"),
          category: raw.categoria === undefined ? "utility" : oneOf(raw.categoria, TEMPLATE_CATEGORIES, "categoria"),
          body: requireText(raw.cuerpo, "cuerpo", 1, 1024),
        },
        actorOf(c),
      ),
    );
    return c.json(serializeTemplate(created), 201);
  });

  app.post("/hoteles/:propertyId/agentes/plantillas/:id/enviar", async (c) => {
    assertVerticalRole(c, AGENT_AUTHOR_ROLES);
    const t = await guarded(() => repoOf(c).submitTemplate(c.req.param("propertyId") ?? "", requireUuid(c.req.param("id"), "id"), actorOf(c)));
    return c.json(serializeTemplate(t));
  });

  for (const [path, decision] of [["aprobar", "aprobar"], ["rechazar", "rechazar"]] as const) {
    app.post(`/hoteles/:propertyId/agentes/plantillas/:id/${path}`, async (c) => {
      assertVerticalRole(c, AGENT_MANAGE_ROLES);
      const reason = requireText((await readBody(c)).motivo, "motivo", 5, 300);
      const t = await guarded(() => repoOf(c).reviewTemplate(c.req.param("propertyId") ?? "", requireUuid(c.req.param("id"), "id"), decision, reason, actorOf(c)));
      return c.json(serializeTemplate(t));
    });
  }

  app.post("/hoteles/:propertyId/agentes/plantillas/:id/archivar", async (c) => {
    assertVerticalRole(c, AGENT_MANAGE_ROLES);
    const t = await guarded(() => repoOf(c).archiveTemplate(c.req.param("propertyId") ?? "", requireUuid(c.req.param("id"), "id"), actorOf(c)));
    return c.json(serializeTemplate(t));
  });

  // ---- config de un agente (kill switch / presupuesto): DEBE ir despues de las rutas estaticas ----

  app.put("/hoteles/:propertyId/agentes/:agentKey", async (c) => {
    assertVerticalRole(c, AGENT_MANAGE_ROLES);
    const agentKey = oneOf(c.req.param("agentKey"), AGENT_KEYS, "agente");
    const raw = await readBody(c);
    if (raw.activo !== undefined && typeof raw.activo !== "boolean") throw Errors.validation("activo: se esperaba true|false.");
    let budgetMicroUsd: number | null | undefined;
    if (raw.presupuestoUsd === null) budgetMicroUsd = null;
    else if (raw.presupuestoUsd !== undefined) {
      const usd = optionalNumber(raw.presupuestoUsd, "presupuestoUsd");
      if (usd === undefined || !(usd > 0) || usd > 1_000_000) throw Errors.validation("presupuestoUsd: mayor a 0 y hasta 1,000,000 (null quita el tope propio).");
      budgetMicroUsd = usdToMicroUsd(usd);
      if (budgetMicroUsd < 1) throw Errors.validation("presupuestoUsd: demasiado pequeno.");
    }
    if (raw.activo === undefined && budgetMicroUsd === undefined) throw Errors.validation("Se esperaba `activo` y/o `presupuestoUsd`.");
    if (raw.activo === false) requireText(raw.motivo, "motivo", 5, 300);
    await guarded(() =>
      repoOf(c).updateAgentConfig(c.req.param("propertyId") ?? "", agentKey, {
        ...(raw.activo !== undefined ? { enabled: raw.activo as boolean } : {}),
        ...(budgetMicroUsd !== undefined ? { budgetMicroUsd } : {}),
        ...(raw.activo === false ? { pausedReason: requireText(raw.motivo, "motivo", 5, 300) } : {}),
      }),
    );
    const catalog = await catalogResponse(c);
    return c.json({ ...catalog, agente: catalog.agentes.find((a) => a.clave === agentKey) });
  });

  // ---- cola de aprobaciones --------------------------------------------------------------

  app.get("/hoteles/:propertyId/aprobaciones", async (c) => {
    assertVerticalRole(c, AGENT_VIEW_ROLES);
    const estado = c.req.query("estado");
    const accion = c.req.query("accion");
    const result = await guarded(() =>
      repoOf(c).listApprovals(c.req.param("propertyId") ?? "", {
        ...(estado ? { status: oneOf(estado, APPROVAL_STATUSES, "estado") } : {}),
        ...(accion ? { actionType: oneOf(accion, APPROVAL_ACTION_TYPES, "accion") } : {}),
        ...(c.req.query("abiertas") === "1" ? { onlyOpen: true } : {}),
      }),
    );
    return c.json({ disponible: result.disponible, ahora: clock().toISOString(), aprobaciones: result.aprobaciones.map(serializeApproval) });
  });

  app.post("/hoteles/:propertyId/aprobaciones", async (c) => {
    assertVerticalRole(c, AGENT_AUTHOR_ROLES);
    const raw = await readBody(c);
    const action = oneOf(raw.accion, APPROVAL_ACTION_TYPES, "accion");
    const detalle = raw.detalle === undefined ? {} : raw.detalle;
    if (!detalle || typeof detalle !== "object" || Array.isArray(detalle)) throw Errors.validation("detalle: se esperaba un objeto.");
    const num = (v: unknown, field: string) => (v === undefined || v === null ? null : optionalNumber(v, field) ?? null);
    const created = await guarded(() =>
      repoOf(c).proposeAction(
        {
          propertyId: c.req.param("propertyId") ?? "",
          agentKey: "recepcion_whatsapp", // la base lo reemplaza por 'manual' en propuestas de personas
          actionType: action,
          summary: requireText(raw.resumen, "resumen", 1, 300),
          payload: detalle as Record<string, unknown>,
          amountCents: num(raw.montoCentavos, "montoCentavos"),
          percent: num(raw.porcentaje, "porcentaje"),
          recipients: num(raw.destinatarios, "destinatarios"),
          contentText: raw.contenido === undefined || raw.contenido === null ? null : requireText(raw.contenido, "contenido", 1, 4000),
          idempotencyKey: requireText(raw.llaveIdempotencia, "llaveIdempotencia", 8, 120),
        },
        actorOf(c),
      ),
    );
    return c.json(serializeApproval(created), created.status === "bloqueada" ? 200 : 201);
  });

  app.get("/hoteles/:propertyId/aprobaciones/:id", async (c) => {
    assertVerticalRole(c, AGENT_VIEW_ROLES);
    const propertyId = c.req.param("propertyId") ?? "";
    const id = requireUuid(c.req.param("id"), "id");
    const repo = repoOf(c);
    const approval = await guarded(() => repo.findApproval(propertyId, id));
    if (!approval) throw Errors.notFound("Solicitud no encontrada.");
    const canAudit = AGENT_AUDIT_ROLES.includes((c.get("verticalRole") ?? "") as never);
    const events = canAudit ? await guarded(() => repo.listApprovalEvents(propertyId, id)) : [];
    return c.json({ ...serializeApproval(approval), bitacora: events.map(serializeEvent), bitacoraVisible: canAudit });
  });

  for (const [path, decision] of [["aprobar", "aprobar"], ["rechazar", "rechazar"]] as const) {
    app.post(`/hoteles/:propertyId/aprobaciones/:id/${path}`, async (c) => {
      // El rol fino (aprobadores de la politica de la accion) lo decide la base: aqui solo el piso de lectura.
      assertVerticalRole(c, AGENT_VIEW_ROLES);
      const reason = requireText((await readBody(c)).motivo, "motivo", 5, 500);
      const updated = await guarded(() => repoOf(c).decideApproval(c.req.param("propertyId") ?? "", requireUuid(c.req.param("id"), "id"), decision, reason, actorOf(c)));
      if (updated.status === "expirada") throw Errors.conflict("La solicitud ya vencio: se marco como expirada y no se aprobo.");
      return c.json(serializeApproval(updated));
    });
  }

  app.post("/hoteles/:propertyId/aprobaciones/:id/cancelar", async (c) => {
    assertVerticalRole(c, AGENT_VIEW_ROLES);
    const reason = requireText((await readBody(c)).motivo, "motivo", 5, 500);
    const updated = await guarded(() => repoOf(c).cancelApproval(c.req.param("propertyId") ?? "", requireUuid(c.req.param("id"), "id"), reason, actorOf(c)));
    return c.json(serializeApproval(updated));
  });

  // Ejecutar a mano una solicitud YA aprobada (owner/gm). Se consume UNA vez (anti-replay). Para `respuesta_resena` el
  // efecto se aplica aqui mismo, en la MISMA transaccion (si falla, el consumo se revierte y la aprobacion sigue
  // disponible); para el resto la persona aplica el cambio por su pantalla y registra la referencia.
  app.post("/hoteles/:propertyId/aprobaciones/:id/ejecutar", async (c) => {
    assertVerticalRole(c, AGENT_MANAGE_ROLES);
    const propertyId = c.req.param("propertyId") ?? "";
    const id = requireUuid(c.req.param("id"), "id");
    const raw = await readBody(c);
    const repo = repoOf(c);
    const approval = await guarded(() => repo.findApproval(propertyId, id));
    if (!approval) throw Errors.notFound("Solicitud no encontrada.");
    if (approval.status !== "aprobada") throw Errors.conflict(`La solicitud esta ${approval.status}: solo se ejecuta una solicitud aprobada.`);
    const isReviewReply = approval.actionType === "respuesta_resena";
    const reviewId = isReviewReply ? approval.payload.resenaId : null;
    if (isReviewReply) requireUuid(reviewId, "detalle.resenaId");
    const reference = isReviewReply ? "respuesta-resena" : requireText(raw.referencia, "referencia", 5, 200);
    const hotelesRepo = deps.hotelesRepo(c.get("db"));
    if (isReviewReply && !(await hotelesRepo.findGuestReview(propertyId, reviewId as string))) throw Errors.conflict("La resena de la solicitud ya no existe.");
    const result = await guarded(() =>
      runWithSavepointFallback({
        session: c.get("db"),
        primary: async () => {
          const consumed = await repo.consumeApproval(propertyId, id, reference, actorOf(c), clock());
          if (consumed.status === "ejecutada" && isReviewReply) {
            await hotelesRepo.insertGuestReviewResponse({ organizationId: c.get("organizationId"), propertyId, reviewId: reviewId as string, texto: consumed.contentText ?? "", createdBy: c.get("userId") });
          }
          return consumed;
        },
        isRecoverable: () => true,
        fallback: (err) => {
          throw err;
        },
      }),
    );
    if (result.status === "ejecutada") return c.json(serializeApproval(result));
    // Estados devueltos sin ejecutar: se informa el motivo (nunca un 200 que aparente ejecucion).
    const reason: Record<string, string> = {
      aprobada: "Fuera del horario de envio de mensajes masivos: se difiere, reintenta dentro de la ventana.",
      expirada: "La aprobacion vencio y no se ejecuto.",
      bloqueada: `Un guardrail vigente la bloqueo (${result.blockReason ?? "guardrail"}).`,
    };
    throw Errors.conflict(reason[result.status] ?? `La solicitud quedo ${result.status}.`);
  });

  return app;
}

