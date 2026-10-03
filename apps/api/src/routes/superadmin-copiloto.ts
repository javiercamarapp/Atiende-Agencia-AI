// Copiloto de superadmin (CHAT-16): "Chatea con tus datos" de la PLATAFORMA completa.
//
//   POST /superadmin/copiloto                              -> turno del chat (JSON, o NDJSON con `Accept: application/x-ndjson`; se aborta si el cliente corta)
//   GET  /superadmin/copiloto/estado                       -> que necesita la UI: disponibilidad, rol, step-up, interruptor, gasto del mes y herramientas
//   GET  /superadmin/copiloto/conversaciones[/:id]         -> conversaciones propias (scope plataforma)
//   PATCH/DELETE /superadmin/copiloto/conversaciones/:id   -> renombrar / borrar una conversacion propia
//
// Va DETRAS de la cadena de routes/superadmin.ts sobre `/superadmin/*` (autenticacion, gateo de superadmin, guard de impersonacion, zona CFO y step-up). Lo propio
// de esta ruta, en orden:
//   1. Impersonacion activa -> 409 (el Copiloto ve TODA la plataforma: no se usa mientras el superadmin actua como un cliente). El guard comun de escrituras la
//      deja pasar (ver `COPILOTO_CHAT_PATH_RE` en superadmin.ts) para que el rechazo sea este 409 y no un 403 generico.
//   2. Rol efectivo (core.cfo_zone_resolve_role): `superadmin` o `finanzas` (solo lectura: SOLO herramientas financieras, siempre con step-up). Quien no es
//      ninguno de los dos no llega aqui (403 de la cadena comun).
//   3. Step-up: la politica vigente de `exigirStepUp` (con factor MFA activo exige token reciente; `finanzas` no admite degradarse). Una herramienta CFO sin
//      step-up: la consulta directa responde 403 `stepup_required` ANTES de abrir el flujo; si la pide el modelo, la herramienta se niega, deja una fila
//      `denegado` en core.cfo_access_log y no devuelve cifras.
//   4. Interruptor de plataforma `agente superadmin:copiloto` apagado -> respuesta honesta SIN llamar al modelo (las consultas directas siguen).
//   5. Tope mensual propio (bitacora + acumulador en memoria) y circuit breaker del gateway dedicado -> modo sin IA, nunca 500.
//   6. Limite de 20 preguntas por minuto por usuario (el motor responde `rate_limited`).
//   7. Bitacora en core.data_chat_query_log con vertical 'plataforma' (sin texto ni resultados) y conversacion persistida con scope plataforma.
//
// El alcance (usuario, rol, step-up) lo fija ESTE codigo; el cuerpo solo aporta la pregunta, el historial y el id de conversacion. Las consultas son de solo lectura y
// corren con la sesion RLS del propio superadmin, nunca con una de sistema.
import { Hono } from "hono";
import type { Context } from "hono";
import { ApiError, dbSession } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { MonthlyBudgetExceededError, KillSwitchEngagedError } from "@atiende/agent-core";
import { runDataChatTurn } from "@atiende/agent-core/data-chat";
import type { DataChatCompletion } from "@atiende/agent-core/data-chat";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { emitirNotificacion } from "@atiende/db";
import type { AppDeps } from "../deps.ts";
import { Errors } from "../errors.ts";
import { exigirStepUp } from "../superadmin-seguridad/step-up.ts";
import { parseDataChatRequest } from "../data-chat/body.ts";
import { respondDataChat, respondDataChatStatic } from "../data-chat/ndjson.ts";
import { logUsoDataChat } from "../data-chat/uso-log.ts";
import {
  beginTurnPersistence,
  parseTitulo,
  type ConversacionScope,
  type ConversacionesRepository,
  PostgresConversacionesRepository,
} from "../data-chat/conversaciones.ts";
import { SUPERADMIN_COPILOTO_ROLE } from "../production/llm-models.ts";
import { PLATAFORMA_TIMEZONE, PLATAFORMA_VERTICAL, alcanceDelMotor, type PlatformScope, type RolPlataforma } from "../superadmin-copiloto/alcance.ts";
import { PostgresPlataformaAuditSink } from "../superadmin-copiloto/bitacora.ts";
import { HERRAMIENTAS_FINANCIERAS, buildCatalogoPlataforma } from "../superadmin-copiloto/catalogo.ts";
import { TOPE_MENSUAL_COPILOTO_MICRO_USD, type SuperadminCopilotoDeps } from "../superadmin-copiloto/deps.ts";
import { fuentesDeProduccion, type FuentesPlataforma } from "../superadmin-copiloto/fuentes.ts";

/** Ruta exacta del chat: el guard de escrituras bajo impersonacion la exime para devolver el 409 propio (ver routes/superadmin.ts). */
export const COPILOTO_CHAT_PATH_RE = /^\/superadmin\/copiloto$/;

export const COPILOTO_NO_ACTIVADO = {
  status: "unavailable",
  text: "El Copiloto de plataforma todavía no está activado en este despliegue. Tus tableros siguen disponibles.",
  blocks: [],
  sources: [],
  toolsUsed: [],
} as const;

/** 20 preguntas por minuto por usuario (spec): el motor responde `rate_limited` sin consultar nada. */
const LIMITES_COPILOTO = {
  userRateLimit: { limit: 20, windowMs: 60_000 },
  orgRateLimit: { limit: 300, windowMs: 60 * 60_000 },
} as const;

const CONVERSACION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ResultadoStepUp = { readonly ok: true } | { readonly ok: false; readonly error: ApiError };

export function superadminCopilotoRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  for (const path of ["/superadmin/copiloto", "/superadmin/copiloto/*"]) app.use(path, dbSession(deps.engine));

  const cfg = (): SuperadminCopilotoDeps | undefined => deps.superadminCopiloto;
  const fuentesDe = (db: TenantDbSession, callerId: string): FuentesPlataforma => cfg()?.fuentes?.(db, callerId) ?? fuentesDeProduccion(deps, db, callerId);
  const repoDe = (db: TenantDbSession): ConversacionesRepository => cfg()?.conversaciones?.(db) ?? new PostgresConversacionesRepository(db);
  const tope = (): number => cfg()?.topeMensualMicroUsd ?? TOPE_MENSUAL_COPILOTO_MICRO_USD;

  /** 409 con impersonacion activa (mismo criterio que el guard de routes/superadmin.ts). */
  async function rechazarSiImpersona(callerId: string): Promise<void> {
    const r = await deps.engine.withAppSession({ userId: callerId }, (db) => deps.impersonationRepo(db).getActiveSession(callerId));
    if (r.availability === "available" && r.session !== null) {
      throw Errors.conflict("El Copiloto de plataforma no está disponible mientras impersonas a una organización. Termina la sesión de impersonación y vuelve a intentar.");
    }
  }

  /** Rol efectivo. Sin repositorio de la zona CFO o con la migracion 0034 sin aplicar no hay rol restringido (mismo criterio que superadmin-seguridad/zona-cfo.ts). */
  async function resolverRol(callerId: string): Promise<RolPlataforma> {
    const repo = deps.cfoZoneRepo;
    if (!repo) return "superadmin";
    const { availability, rol } = await deps.engine.withAppSession({ userId: callerId }, (db) => repo(db).resolveRole(callerId));
    if (availability === "not_migrated") return "superadmin";
    // Ya paso el gateo de superadmin; un rol nulo aqui es una inconsistencia: se falla cerrado.
    if (rol === null) throw Errors.forbidden("No tienes acceso al Copiloto de plataforma.");
    return rol;
  }

  async function evaluarStepUp(c: Context<CoreAuthHonoEnv>, rol: RolPlataforma): Promise<ResultadoStepUp> {
    try {
      await exigirStepUp(deps, c, { obligatorio: rol === "finanzas" });
      return { ok: true };
    } catch (err) {
      if (err instanceof ApiError) return { ok: false, error: err };
      throw err;
    }
  }

  /** Huella de una denegacion en core.cfo_access_log (mejor esfuerzo: el error original es el que debe llegar al cliente). */
  async function registrarDenegado(callerId: string, recurso: string): Promise<void> {
    const repo = deps.cfoZoneRepo;
    if (!repo) return;
    try {
      await deps.engine.withAppSession({ userId: callerId }, (db) => repo(db).logAccess(callerId, "denegado", recurso, { _ruta: "/superadmin/copiloto" }));
    } catch {
      // sin huella: el 403 sigue siendo el resultado
    }
  }

  const scopeDe = (callerId: string, rol: RolPlataforma, stepUp: boolean): PlatformScope => ({ userId: callerId, rol, stepUp, timezone: PLATAFORMA_TIMEZONE });
  const convScope = (callerId: string): ConversacionScope => ({ organizationId: null, userId: callerId, vertical: PLATAFORMA_VERTICAL });

  /** Aviso in-app a los superadmins al llegar al 80 % y al 100 % del tope mensual propio (`superadmin.copiloto.tope_mensual`; solo el porcentaje, sin PII).
   *  Mejor esfuerzo, en una sesion de sistema propia: nunca altera ni retrasa el turno. Un aviso por umbral y mes por instancia (la base deduplica el resto). */
  const avisados = new Set<string>();
  async function avisarUmbral(gasto: number, limite: number): Promise<void> {
    const umbral = gasto >= limite ? 100 : gasto * 100 >= limite * 80 ? 80 : 0;
    if (umbral === 0) return;
    const clave = `${umbral}:${new Date().toISOString().slice(0, 7)}`;
    if (avisados.has(clave)) return;
    avisados.add(clave);
    try {
      await deps.engine.withAppSession({ userId: null }, (sesion) => emitirNotificacion(sesion, { evento: "superadmin.copiloto.tope_mensual", organizationId: null, clave, parametros: { porcentaje: umbral } }));
    } catch {
      avisados.delete(clave);
    }
  }

  /** Completador del turno: interruptor, tope mensual propio y luego el gateway dedicado. Si algo lo detiene, lanza el error que el motor traduce a modo sin IA. */
  function completadorDelTurno(c: SuperadminCopilotoDeps, fuentes: FuentesPlataforma): DataChatCompletion {
    const inner = c.completion;
    return async (req) => {
      const bloqueo = (await deps.platformSwitchGuard?.agentBlockedBy(SUPERADMIN_COPILOTO_ROLE)) ?? null;
      if (bloqueo) throw new KillSwitchEngagedError(bloqueo, SUPERADMIN_COPILOTO_ROLE);
      const limite = tope();
      const medido = await fuentes.copilotoGastoMes();
      const gasto = Math.max(medido.ok ? medido.data : 0, c.ledger.mes());
      await avisarUmbral(gasto, limite);
      if (gasto >= limite) throw new MonthlyBudgetExceededError("copilot", "plataforma", gasto, limite);
      if (!inner) throw new Error("superadmin_copiloto_sin_proveedor");
      return inner(req);
    };
  }

  // ------------------------------------------------------------------------------------------------------------------------------
  app.get("/superadmin/copiloto/estado", async (c) => {
    const callerId = c.get("userId");
    await rechazarSiImpersona(callerId);
    const rol = await resolverRol(callerId);
    const stepUp = await evaluarStepUp(c, rol);
    const config = cfg();
    const db = c.get("db");
    const fuentes = fuentesDe(db, callerId);
    const scope = scopeDe(callerId, rol, stepUp.ok);
    const catalogo = buildCatalogoPlataforma(fuentes, scope);
    const bloqueo = (await deps.platformSwitchGuard?.agentBlockedBy(SUPERADMIN_COPILOTO_ROLE)) ?? null;
    const medido = config ? await fuentes.copilotoGastoMes() : ({ ok: false, razon: "sin_repositorio" } as const);
    const limite = tope();
    const usado = config ? (medido.ok ? Math.max(medido.data, config.ledger.mes()) : config.ledger.mes() > 0 ? config.ledger.mes() : null) : null;
    const topeAgotado = usado !== null && usado >= limite;
    const conModelo = Boolean(config?.completion);
    const motivo = !conModelo ? "no_activado" : bloqueo ? "interruptor_apagado" : topeAgotado ? "tope_mensual" : null;
    return c.json({
      disponible: conModelo,
      permitido: motivo === null,
      motivo,
      rol,
      // Las consultas financieras necesitan step-up: sin el, la UI debe pedirlo antes (no se ofrecen "listas").
      financierasDisponibles: stepUp.ok,
      stepUpRequerido: !stepUp.ok,
      interruptor: { apagado: bloqueo !== null, clave: bloqueo },
      gastoMes: { usadoMicroUsd: usado, topeMicroUsd: limite, usoPct: usado === null ? null : Math.min(100, Math.round((usado / limite) * 100)), medidoEnBitacora: medido.ok },
      herramientas: catalogo.tools.map((t) => ({ nombre: t.name, etiqueta: t.label, descripcion: t.description, financiera: HERRAMIENTAS_FINANCIERAS.includes(t.name) })),
    });
  });

  // ------------------------------------------------------------------------------------------------------------------------------
  app.post("/superadmin/copiloto", async (c) => {
    const callerId = c.get("userId");
    await rechazarSiImpersona(callerId);
    const { question, history, tool, toolArgs, label, conversationId } = await parseDataChatRequest(c);
    const rol = await resolverRol(callerId);
    const stepUp = await evaluarStepUp(c, rol);
    // `finanzas` solo ve herramientas financieras y todas exigen step-up: sin el, ni siquiera se abre el turno.
    if (!stepUp.ok && rol === "finanzas") {
      await registrarDenegado(callerId, "POST copiloto (sin step-up)");
      throw stepUp.error;
    }
    // Consulta directa (chip/boton) a una herramienta financiera sin step-up: 403 de step-up antes de abrir el flujo.
    if (!stepUp.ok && tool !== undefined && HERRAMIENTAS_FINANCIERAS.includes(tool)) {
      await registrarDenegado(callerId, `copiloto/${tool} (sin step-up)`);
      throw stepUp.error;
    }

    const config = cfg();
    // La ruta directa (`tool`) no usa modelo: funciona aunque no haya proveedor de IA configurado.
    if (!config || (!config.completion && !tool)) return respondDataChatStatic(c, COPILOTO_NO_ACTIVADO);

    const db = c.get("db");
    const scope = scopeDe(callerId, rol, stepUp.ok);
    const persist = await beginTurnPersistence(deps, db, {
      conversationId,
      history,
      tool,
      signal: c.req.raw.signal,
      scope: convScope(callerId),
      propertyId: null,
      repo: repoDe,
    });
    return respondDataChat(
      c,
      deps,
      async (turnDb, onEvento, signal) => {
        const fuentes = fuentesDe(turnDb, callerId);
        const catalogo = buildCatalogoPlataforma(fuentes, scope, { topeCopilotoMicroUsd: tope() });
        const sink = config.audit?.(turnDb) ?? new PostgresPlataformaAuditSink(turnDb);
        const motor = await runDataChatTurn({
          catalog: catalogo,
          scope: alcanceDelMotor(scope),
          question,
          history: persist.history,
          ...(tool ? { directTool: tool, ...(toolArgs ? { directArgs: toolArgs } : {}) } : {}),
          complete: completadorDelTurno(config, fuentes),
          rateLimiter: config.rateLimiter,
          limits: LIMITES_COPILOTO,
          audit: persist.audit(sink),
          onEvento,
          signal,
          onUso: (uso) => {
            config.ledger.sumar(uso.costMicroUsd);
            logUsoDataChat(c, PLATAFORMA_VERTICAL)(uso);
          },
          auditRole: SUPERADMIN_COPILOTO_ROLE,
          onError: (where, err) => console.error(JSON.stringify({ level: "error", event: "superadmin_copiloto_error", where, message: err instanceof Error ? err.message.slice(0, 200) : "error" })),
        });
        return persist.finish(turnDb, label ?? question, tool, motor);
      },
      persist.despuesDelCommit,
    );
  });

  // ------------------------------------------------------------------------------------------------------------------------------
  // Conversaciones propias (scope plataforma). Solo el autor las ve (RLS de la migracion 0041); un id ajeno o inexistente es 404, nunca 403.
  const idDe = (c: Context<CoreAuthHonoEnv>): string => {
    const id = c.req.param("conversationId") ?? "";
    if (!CONVERSACION_ID_RE.test(id)) throw Errors.notFound("Conversación no encontrada.");
    return id.toLowerCase();
  };

  app.get("/superadmin/copiloto/conversaciones", async (c) => {
    const { disponible, items } = await repoDe(c.get("db")).list(convScope(c.get("userId")));
    return c.json({ disponible, conversaciones: items });
  });

  app.get("/superadmin/copiloto/conversaciones/:conversationId", async (c) => {
    const callerId = c.get("userId");
    const id = idDe(c);
    const repo = repoDe(c.get("db"));
    const found = await repo.get(convScope(callerId), id);
    if (!found) throw Errors.notFound("Conversación no encontrada.");
    // Los turnos guardados con herramientas financieras traen cifras (MRR, P&L, margenes) en el texto, los bloques y las fuentes: releerlos es una lectura
    // financiera y sigue la politica de la zona CFO igual que GET /superadmin/pyl: step-up (obligatorio para `finanzas`) y una fila en core.cfo_access_log
    // confirmada ANTES de devolver nada. Una conversacion sin herramientas financieras no cambia.
    const usadas = await repo.herramientasUsadas?.(convScope(callerId), id);
    if (usadas === undefined) {
      // El repositorio no sabe decir que herramientas la produjeron: se falla cerrado para quien solo ve cifras CFO.
      if ((await resolverRol(callerId)) === "finanzas") throw Errors.serviceUnavailable("No se pudo verificar el contenido de la conversación; por seguridad no se muestra.");
    }
    const financieras = (usadas ?? []).filter((t) => HERRAMIENTAS_FINANCIERAS.includes(t));
    if (financieras.length > 0) {
      const rol = await resolverRol(callerId);
      const recurso = "copiloto/conversaciones/:id";
      const stepUp = await evaluarStepUp(c, rol);
      if (!stepUp.ok) {
        await registrarDenegado(callerId, `GET ${recurso} (sin step-up)`);
        throw stepUp.error;
      }
      const repoCfo = deps.cfoZoneRepo;
      if (repoCfo) {
        try {
          await deps.engine.withAppSession({ userId: callerId }, (db) => repoCfo(db).logAccess(callerId, "consulta", recurso, { herramientas: financieras.slice(0, 8), _ruta: "/superadmin/copiloto/conversaciones" }));
        } catch {
          throw Errors.serviceUnavailable("No se pudo registrar la consulta financiera; por seguridad no se muestra.");
        }
      }
    }
    return c.json(found);
  });

  app.patch("/superadmin/copiloto/conversaciones/:conversationId", async (c) => {
    const id = idDe(c);
    const raw: unknown = await c.req.json().catch(() => {
      throw Errors.validation("Cuerpo inválido: se esperaba JSON.");
    });
    const titulo = parseTitulo(raw);
    const ok = await repoDe(c.get("db")).rename(convScope(c.get("userId")), id, titulo);
    if (!ok) throw Errors.notFound("Conversación no encontrada.");
    return c.json({ id, titulo });
  });

  app.delete("/superadmin/copiloto/conversaciones/:conversationId", async (c) => {
    const ok = await repoDe(c.get("db")).remove(convScope(c.get("userId")), idDe(c));
    if (!ok) throw Errors.notFound("Conversación no encontrada.");
    return c.body(null, 204);
  });

  return app;
}
