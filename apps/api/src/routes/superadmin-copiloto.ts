// Copiloto de superadmin (CHAT-16): "Chatea con tus datos" de la PLATAFORMA completa.
//
//   POST /superadmin/copiloto                              -> turno del chat (JSON, o NDJSON con `Accept: application/x-ndjson`; se aborta si el cliente corta)
//   GET  /superadmin/copiloto/estado                       -> que necesita la UI: disponibilidad, rol, step-up, interruptor, gasto del mes y herramientas
//   GET  /superadmin/copiloto/conversaciones[/:id]         -> conversaciones propias (scope plataforma)
//   PATCH/DELETE /superadmin/copiloto/conversaciones/:id   -> renombrar / borrar una conversacion propia
//   POST /superadmin/copiloto/conversaciones/:id/reporte?seq=N -> reporte PDF del mensaje (mismo pipeline que las verticales: re-consulta con el alcance actual; paridad CHAT-14)
//   GET/POST /superadmin/copiloto/pins, PATCH/DELETE /superadmin/copiloto/pins/:pinId, GET .../pins/:pinId/resultado -> fijados del tablero (personales, sin organizacion; migracion 0056)
//   POST /superadmin/copiloto/adjuntos                     -> adjuntar archivo (CSV / Excel / PDF): perfil determinista en el servidor, sin guardar el archivo (superadmin completo)
//   GET  /superadmin/copiloto/acciones/:propuesta          -> estado y vista previa de una propuesta de `proponer_accion` (CHAT-17)
//   POST /superadmin/copiloto/acciones/confirmar           -> confirma una propuesta de apagar/encender agente (step-up + motivo); los intents se confirman en /superadmin/acciones
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
import { createHmac } from "node:crypto";
import { ApiError, dbSession } from "@atiende/core-auth";
import { rateLimit } from "@atiende/core-ratelimit";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { MonthlyBudgetExceededError, KillSwitchEngagedError } from "@atiende/agent-core";
import { ejecutarHerramientasReporte, generarContenidoReporte, runDataChatTurn } from "@atiende/agent-core/data-chat";
import type { DataChatAuditEntry, DataChatCompletion } from "@atiende/agent-core/data-chat";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { emitirNotificacion, runWithSavepointFallback } from "@atiende/db";
import type { AppDeps } from "../deps.ts";
import { Errors } from "../errors.ts";
import { requestActor } from "../http-security.ts";
import { SWITCHABLE_AGENT_ROLES } from "../platform-switches.ts";
import { componerResumenYPayload } from "../superadmin-acciones/componer.ts";
import { traducirErrorSeguridad } from "./superadmin-mfa.ts";
import { exigirStepUp } from "../superadmin-seguridad/step-up.ts";
import { parseDataChatRequest } from "../data-chat/body.ts";
import { REPORTE_PDF_CONTENT_TYPE, REPORTE_PDF_MAX_BYTES } from "../data-chat/reporte-routes.ts";
import { renderReportePdf } from "../data-chat/reporte-pdf.ts";
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
import {
  UUID_RE,
  consumirNonce,
  esTokenInterruptor,
  estaApagado,
  liberarNonce,
  verificarPropuestaInterruptor,
  vistaDeIntent,
  vistaDeInterruptor,
  type DependenciasAcciones,
} from "../superadmin-copiloto/acciones.ts";
import { HERRAMIENTAS_ACCION, HERRAMIENTAS_FINANCIERAS, buildCatalogoPlataforma } from "../superadmin-copiloto/catalogo.ts";
import { TOPE_MENSUAL_COPILOTO_MICRO_USD, type SuperadminCopilotoDeps } from "../superadmin-copiloto/deps.ts";
import { fuentesDeProduccion, type FuentesPlataforma } from "../superadmin-copiloto/fuentes.ts";
import { PostgresPinsPlataformaRepository, type PinsPlataformaRepository } from "../superadmin-copiloto/pins.ts";
import { cleanPinTitle, parseCreatePin } from "../data-chat/pins.ts";
import { procesarAdjunto } from "../data-chat/adjuntos-routes.ts";
import { NO_LLM_COMPLETION } from "../data-chat/turno.ts";
import { parseArgs } from "@atiende/agent-core/data-chat";

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
  const pinsDe = (db: TenantDbSession): PinsPlataformaRepository => cfg()?.pins?.(db) ?? new PostgresPinsPlataformaRepository(db);
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
      void avisarUmbral(gasto, limite); // sin await: abre una sesion de sistema y escribe; nunca retrasa la llamada al modelo (no lanza: atrapa todo)
      if (gasto >= limite) throw new MonthlyBudgetExceededError("copilot", "plataforma", gasto, limite);
      if (!inner) throw new Error("superadmin_copiloto_sin_proveedor");
      return inner(req);
    };
  }

  // ---- CHAT-17: acciones propuestas (el modelo solo PROPONE; ver superadmin-copiloto/acciones.ts) ------------------------------
  const subllave = (): string => createHmac("sha256", deps.env.jwtSecret).update("superadmin-copiloto-accion-v1").digest("hex");

  /** Aviso in-app a los superadmins de que hay una accion propuesta esperando (`superadmin.copiloto.accion_propuesta`). Mejor esfuerzo, sesion de sistema propia, sin PII. */
  async function avisarPropuesta(clave: string): Promise<void> {
    try {
      await deps.engine.withAppSession({ userId: null }, (sesion) => emitirNotificacion(sesion, { evento: "superadmin.copiloto.accion_propuesta", organizationId: null, clave }));
    } catch {
      // sin aviso: la propuesta sigue siendo valida y visible en la tarjeta
    }
  }

  function accionesDe(callerId: string, fuentes: FuentesPlataforma): DependenciasAcciones {
    return {
      secreto: subllave(),
      ahora: () => Date.now(),
      componerIntent: (tipo, payload) => componerResumenYPayload(deps, callerId, tipo, payload),
      crearIntent: (tipo, payload, resumen, minutos) => deps.accionesRepo.crearIntent(callerId, tipo, payload, resumen, minutos),
      interruptores: () => fuentes.interruptores(),
      avisar: avisarPropuesta,
    };
  }

  /** Estado actual del interruptor del agente: true/false, o null si no se puede leer (base sin migrar o repositorio ausente). */
  async function agenteApagado(callerId: string, agente: string): Promise<boolean | null> {
    const repo = deps.platformSwitchRepo;
    if (!repo) return null;
    const { availability, switches } = await deps.engine.withAppSession({ userId: callerId }, (db) => repo(db).list(callerId));
    return availability === "available" ? estaApagado(switches, agente) : null;
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
      // CHAT-17: el superadmin completo puede pedirle al Copiloto que PROPONGA acciones (nunca las ejecuta); `finanzas`, de solo lectura, no.
      acciones: { propone: rol === "superadmin" },
      // El tablero de fijados es personal y solo del superadmin completo (la zona CFO no deja pasar al rol `finanzas` por /pins).
      fijados: rol === "superadmin",
      // Adjuntar archivo (CSV / Excel / PDF): solo el superadmin completo (la zona CFO no deja pasar a `finanzas` por /adjuntos).
      adjuntos: rol === "superadmin",
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
        const catalogo = buildCatalogoPlataforma(fuentes, scope, { topeCopilotoMicroUsd: tope(), acciones: accionesDe(callerId, fuentes) });
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

  // ------------------------------------------------------------------------------------------------------------------------------
  // Reporte PDF de un mensaje (paridad con el "Descargar PDF" de las verticales, CHAT-14). MISMO pipeline (`ejecutarHerramientasReporte` -> analista y redactor con
  // guardia numerica -> PDF determinista) pero con la cadena de autorizacion de ESTE Copiloto: JWT -> superadmin vigente (cadena comun de /superadmin/*) -> sin
  // impersonacion (409) -> rol efectivo -> conversacion PROPIA (404 si es ajena o inexistente). Es POST porque cada llamada RE-EJECUTA las herramientas con el alcance
  // actual (jamas reutiliza cifras del texto del chat) y puede gastar IA.
  //   * Las herramientas financieras exigen step-up igual que en el chat: sin el, 403 `stepup_required` ANTES de consultar nada (el cliente abre el dialogo y reintenta),
  //     y cada consulta financiera deja su huella en core.cfo_access_log como en el chat.
  //   * `proponer_accion` JAMAS se re-ejecuta: el catalogo del reporte no la incluye (un reporte nunca crea propuestas).
  //   * La narrativa usa el completador del Copiloto (interruptor de plataforma y tope mensual propio); sin IA, con el interruptor apagado o el tope agotado el PDF sale
  //     SOLO con datos y lo dice (cabecera `x-reporte-narrativa: no_disponible`).
  const REPORTE_LIMITE = { limit: 6, windowMs: 10 * 60_000 } as const;
  app.post("/superadmin/copiloto/conversaciones/:conversationId/reporte", async (c) => {
    const callerId = c.get("userId");
    const id = idDe(c);
    const seqRaw = c.req.query("seq") ?? "";
    const seq = /^\d{1,3}$/.test(seqRaw) ? Number(seqRaw) : NaN;
    if (!Number.isInteger(seq) || seq < 1 || seq > 100) throw Errors.validation("seq: se esperaba la posición del mensaje (1 a 100).");
    await rechazarSiImpersona(callerId);
    const config = cfg();
    if (!config) throw Errors.serviceUnavailable("Los reportes del Copiloto todavía no están activados en este despliegue.");

    // Limite por usuario, fail-closed: un reporte re-consulta datos y puede gastar IA.
    let permitido = false;
    try {
      permitido = await config.rateLimiter.allow(`superadmin:copiloto:reporte:u:${callerId}`, REPORTE_LIMITE.limit, REPORTE_LIMITE.windowMs);
    } catch {
      permitido = false;
    }
    if (!permitido) throw Errors.tooManyRequests("Has pedido muchos reportes en poco tiempo. Espera unos minutos e inténtalo de nuevo.");

    const db = c.get("db");
    const repo = repoDe(db);
    if (!repo.cargarFuenteReporte) throw Errors.serviceUnavailable("Los reportes todavía no están disponibles en este despliegue.");
    const fuente = await repo.cargarFuenteReporte(convScope(callerId), id, seq);
    if (!fuente) throw Errors.notFound("Conversación no encontrada.");
    const llamadas = fuente.toolCalls.filter((t) => !HERRAMIENTAS_ACCION.includes(t.tool));
    if (llamadas.length === 0) throw new ApiError(422, "report_no_data", "Esta respuesta no tiene cifras para armar un reporte.");

    const rol = await resolverRol(callerId);
    const stepUp = await evaluarStepUp(c, rol);
    if (!stepUp.ok && (rol === "finanzas" || llamadas.some((t) => HERRAMIENTAS_FINANCIERAS.includes(t.tool)))) {
      await registrarDenegado(callerId, "POST copiloto/conversaciones/:id/reporte (sin step-up)");
      throw stepUp.error;
    }

    const scope = scopeDe(callerId, rol, stepUp.ok);
    const abort = new AbortController();
    const raw = c.req.raw.signal;
    const onAbort = (): void => abort.abort();
    if (raw.aborted) abort.abort();
    else raw.addEventListener("abort", onAbort, { once: true });
    const onError = (where: string, err: unknown): void =>
      console.error(JSON.stringify({ level: "error", event: "superadmin_copiloto_reporte_error", where, message: err instanceof Error ? err.message.slice(0, 200) : "error" }));

    try {
      const fuentes = fuentesDe(db, callerId);
      // Sin `acciones`: el catalogo del reporte es de solo lectura.
      const catalogo = buildCatalogoPlataforma(fuentes, scope, { topeCopilotoMicroUsd: tope() });
      const inicio = Date.now();
      const { tablas, omitidas } = await ejecutarHerramientasReporte({
        catalog: catalogo,
        scope: alcanceDelMotor(scope),
        calls: llamadas,
        now: new Date(),
        signal: abort.signal,
        onError,
        aislar: <T>(trabajo: () => Promise<T>) =>
          runWithSavepointFallback<T>({
            session: db,
            primary: trabajo,
            isRecoverable: () => false,
            fallback: async (err) => {
              throw err;
            },
          }),
      });

      // Bitacora de las consultas (sin resultados), como en el chat: quien, que herramienta, con que parametros, cuantas filas.
      const durationMs = Date.now() - inicio;
      const sink = config.audit?.(db) ?? new PostgresPlataformaAuditSink(db);
      for (const call of llamadas) {
        const t = tablas.find((x) => x.tool === call.tool);
        const entry: DataChatAuditEntry = {
          organizationId: alcanceDelMotor(scope).organizationId,
          userId: callerId,
          vertical: PLATAFORMA_VERTICAL,
          tool: call.tool,
          params: call.args,
          outcome: t ? "ok" : "unavailable",
          rowCount: t?.rows.length ?? 0,
          durationMs,
          role: SUPERADMIN_COPILOTO_ROLE,
        };
        try {
          await sink.record(entry);
        } catch (err) {
          onError("audit", err);
        }
      }
      if (tablas.length === 0) throw new ApiError(422, "report_no_data", omitidas[0]?.motivo ?? "No hay cifras para armar el reporte con tu alcance actual.");

      const completion = config.completion ? completadorDelTurno(config, fuentes) : undefined;
      const contenido = await generarContenidoReporte({
        tablas,
        omitidas,
        vertical: PLATAFORMA_VERTICAL,
        ...(completion ? { analisis: completion, redaccion: completion } : {}),
        signal: abort.signal,
        onError,
      });
      config.ledger.sumar(Math.round(contenido.uso.costUsd * 1_000_000));

      const generadoEn = new Date();
      const bytes = await renderReportePdf({ contenido, organizacion: "Atiende · Plataforma", vertical: PLATAFORMA_VERTICAL, generadoEn, zonaHoraria: PLATAFORMA_TIMEZONE });
      if (bytes.byteLength > REPORTE_PDF_MAX_BYTES) throw Errors.payloadTooLarge("El reporte excede el tamaño máximo permitido.");
      c.header("cache-control", "no-store");
      c.header("x-content-type-options", "nosniff");
      c.header("content-type", REPORTE_PDF_CONTENT_TYPE);
      c.header("content-disposition", `attachment; filename="reporte-plataforma-${generadoEn.toISOString().slice(0, 10)}.pdf"`);
      c.header("x-reporte-narrativa", contenido.narrativa ? "ok" : "no_disponible");
      return c.body(bytes as unknown as ArrayBuffer);
    } finally {
      raw.removeEventListener("abort", onAbort);
    }
  });

  // ------------------------------------------------------------------------------------------------------------------------------
  // Fijados del tablero (personales, sin organizacion; migracion 0056). El alta deriva herramienta y argumentos del mensaje GUARDADO de una conversacion propia (el
  // cliente solo manda conversacion + posicion + bloque) y exige que sigan siendo validos en el catalogo ACTUAL del rol del autor. Los fijados no guardan cifras:
  // al abrirlos se re-ejecutan sin modelo con el rol y el step-up de ahora; una herramienta financiera sin step-up responde 403 `stepup_required` ANTES de consultar.
  const pinIdDe = (c: Context<CoreAuthHonoEnv>): string => {
    const id = c.req.param("pinId") ?? "";
    // Un id mal formado jamas llega a la base (22P02) y es indistinguible de uno inexistente.
    if (!CONVERSACION_ID_RE.test(id)) throw Errors.notFound("Fijado no encontrado.");
    return id.toLowerCase();
  };
  const jsonDe = async (c: Context<CoreAuthHonoEnv>): Promise<Record<string, unknown>> => {
    const raw: unknown = await c.req.json().catch(() => {
      throw Errors.validation("Cuerpo inválido: se esperaba JSON.");
    });
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw Errors.validation("Cuerpo inválido: se esperaba un objeto JSON.");
    return raw as Record<string, unknown>;
  };

  app.get("/superadmin/copiloto/pins", async (c) => {
    const callerId = c.get("userId");
    await rechazarSiImpersona(callerId);
    const { disponible, items } = await pinsDe(c.get("db")).list(callerId);
    return c.json({ disponible, pins: items });
  });

  app.post("/superadmin/copiloto/pins", async (c) => {
    const callerId = c.get("userId");
    await rechazarSiImpersona(callerId);
    const input = parseCreatePin(await jsonDe(c));
    const db = c.get("db");
    const repo = pinsDe(db);
    const origin = await repo.origin(callerId, input.conversationId, input.seq, input.bloque);
    if (!origin) throw Errors.notFound("No encontré ese resultado para fijarlo.");
    // La herramienta y sus argumentos deben seguir siendo validos en el catalogo ACTUAL del rol (`proponer_accion` nunca esta: no se pasa `acciones`).
    const rol = await resolverRol(callerId);
    const catalogo = buildCatalogoPlataforma(fuentesDe(db, callerId), scopeDe(callerId, rol, false));
    const tool = catalogo.tools.find((t) => t.name === origin.tool);
    if (!tool || !parseArgs(tool.params, origin.args).ok) throw Errors.notFound("Esa consulta ya no se puede fijar.");
    const creado = await repo.create({ ...input, origin });
    if (creado.ok) return c.json({ id: creado.id }, 201);
    switch (creado.motivo) {
      case "limite":
        throw Errors.conflict("Llegaste al límite de 50 fijados. Quita alguno para fijar otro.");
      case "no_disponible":
        throw Errors.serviceUnavailable("Los fijados todavía no están disponibles en este ambiente (migración pendiente).");
      case "sin_acceso":
        throw Errors.forbidden();
      case "conversacion_no_encontrada":
        throw Errors.notFound("No encontré ese resultado para fijarlo.");
      default:
        throw Errors.serviceUnavailable("No pude fijar el resultado en este momento. Inténtalo de nuevo.");
    }
  });

  app.patch("/superadmin/copiloto/pins/:pinId", async (c) => {
    const callerId = c.get("userId");
    await rechazarSiImpersona(callerId);
    const id = pinIdDe(c);
    const raw = await jsonDe(c);
    for (const key of Object.keys(raw)) if (key !== "titulo") throw Errors.validation(`Campo no permitido: ${key.slice(0, 40)}.`);
    if (typeof raw["titulo"] !== "string") throw Errors.validation("titulo: se esperaba texto.");
    const titulo = cleanPinTitle(raw["titulo"]);
    if (titulo.length === 0) throw Errors.validation("titulo: no puede estar vacío.");
    if ((await pinsDe(c.get("db")).rename(callerId, id, titulo)) !== "ok") throw Errors.notFound("Fijado no encontrado.");
    return c.json({ id, titulo });
  });

  app.delete("/superadmin/copiloto/pins/:pinId", async (c) => {
    const callerId = c.get("userId");
    await rechazarSiImpersona(callerId);
    if (!(await pinsDe(c.get("db")).remove(callerId, pinIdDe(c)))) throw Errors.notFound("Fijado no encontrado.");
    return c.body(null, 204);
  });

  app.get("/superadmin/copiloto/pins/:pinId/resultado", async (c) => {
    const callerId = c.get("userId");
    await rechazarSiImpersona(callerId);
    const id = pinIdDe(c);
    const db = c.get("db");
    const pin = await pinsDe(db).get(callerId, id);
    if (!pin) throw Errors.notFound("Fijado no encontrado.");
    const rol = await resolverRol(callerId);
    const stepUp = await evaluarStepUp(c, rol);
    if (!stepUp.ok && (rol === "finanzas" || HERRAMIENTAS_FINANCIERAS.includes(pin.herramienta))) {
      await registrarDenegado(callerId, `GET copiloto/pins/:id/resultado (sin step-up)`);
      throw stepUp.error;
    }
    const config = cfg();
    if (!config) return c.json({ id: pin.id, titulo: pin.titulo, status: "unavailable", text: "El Copiloto de plataforma todavía no está activado en este despliegue.", blocks: [], sources: [] });
    const scope = scopeDe(callerId, rol, stepUp.ok);
    const catalogo = buildCatalogoPlataforma(fuentesDe(db, callerId), scope, { topeCopilotoMicroUsd: tope() });
    const respuesta = await runDataChatTurn({
      catalog: catalogo,
      scope: alcanceDelMotor(scope),
      question: "",
      directTool: pin.herramienta,
      directArgs: pin.args,
      complete: NO_LLM_COMPLETION,
      audit: config.audit?.(db) ?? new PostgresPlataformaAuditSink(db),
      auditRole: SUPERADMIN_COPILOTO_ROLE,
      onError: (where, err) => console.error(JSON.stringify({ level: "error", event: "superadmin_copiloto_pin_error", where, message: err instanceof Error ? err.message.slice(0, 200) : "error" })),
    });
    return c.json({ id: pin.id, titulo: pin.titulo, status: respuesta.status, text: respuesta.text, blocks: respuesta.blocks, sources: respuesta.sources });
  });

  // ------------------------------------------------------------------------------------------------------------------------------
  // Adjuntar archivo (CSV / Excel / PDF). Analisis determinista (sin modelo, sin guardar el archivo) con la bitacora del Copiloto. Solo el superadmin completo:
  // el rol `finanzas` (solo lectura) no tiene esta ruta (la zona CFO no la deja pasar) y aqui se vuelve a comprobar.
  app.post("/superadmin/copiloto/adjuntos", async (c) => {
    const callerId = c.get("userId");
    await rechazarSiImpersona(callerId);
    if ((await resolverRol(callerId)) !== "superadmin") throw Errors.forbidden("Tu rol es de solo lectura: no puede adjuntar archivos.");
    const db = c.get("db");
    return procesarAdjunto(c, {
      organizationId: alcanceDelMotor(scopeDe(callerId, "superadmin", false)).organizationId,
      userId: callerId,
      vertical: PLATAFORMA_VERTICAL,
      role: SUPERADMIN_COPILOTO_ROLE,
      audit: cfg()?.audit?.(db) ?? new PostgresPlataformaAuditSink(db),
    });
  });

  // ------------------------------------------------------------------------------------------------------------------------------
  // Acciones propuestas (CHAT-17). Lectura del estado + confirmacion de las propuestas de interruptor. Los intents del catalogo
  // se confirman con POST /superadmin/acciones/intents/:id/confirmar (ya exige step-up y es de un solo uso en la base).
  app.get("/superadmin/copiloto/acciones/:propuesta", async (c) => {
    const callerId = c.get("userId");
    await rechazarSiImpersona(callerId);
    const propuesta = c.req.param("propuesta") ?? "";
    const ahora = Date.now();
    if (UUID_RE.test(propuesta)) {
      const intents = await deps.accionesRepo.listIntentsForSuperadmin(callerId, 200);
      const encontrado = intents.find((i) => i.id.toLowerCase() === propuesta.toLowerCase());
      // Un intent que ya no aparece entre los recientes se muestra como archivado (no se afirma nada sobre su resultado).
      const vista = encontrado ? vistaDeIntent(encontrado, callerId, ahora) : null;
      return c.json(vista ?? { propuesta, clase: "intent", estado: "archivada" });
    }
    const agente = c.req.query("agente") ?? "";
    if (!esTokenInterruptor(propuesta) || !SWITCHABLE_AGENT_ROLES.includes(agente)) return c.json({ propuesta, clase: "interruptor", estado: "archivada" });
    const apagadoAhora = await agenteApagado(callerId, agente).catch(() => null);
    const vista = vistaDeInterruptor({ secreto: subllave(), actor: callerId, agente, token: propuesta, ahoraMs: ahora, apagadoAhora });
    return c.json(vista ?? { propuesta, clase: "interruptor", estado: "archivada" });
  });

  const CONFIRMAR_RATE_LIMIT = { max: 30, windowMs: 5 * 60_000 } as const;

  app.post("/superadmin/copiloto/acciones/confirmar", async (c) => {
    const callerId = c.get("userId");
    await rechazarSiImpersona(callerId);
    const allowed = await rateLimit(`admin:copiloto-accion:${requestActor(c.req.raw, callerId)}`, CONFIRMAR_RATE_LIMIT.max, CONFIRMAR_RATE_LIMIT.windowMs, { category: "admin" });
    if (!allowed) throw Errors.tooManyRequests("Demasiadas confirmaciones de acciones en poco tiempo.");
    const raw = (await c.req.json().catch(() => null)) as { propuesta?: unknown; agente?: unknown; motivo?: unknown } | null;
    const propuesta = typeof raw?.propuesta === "string" ? raw.propuesta : "";
    const agente = typeof raw?.agente === "string" ? raw.agente : "";
    const motivo = typeof raw?.motivo === "string" ? raw.motivo.trim() : "";
    if (!SWITCHABLE_AGENT_ROLES.includes(agente)) throw Errors.validation("agente no existe en el catálogo de interruptores.");
    if (motivo.length < 20) throw Errors.validation("motivo obligatorio (mínimo 20 caracteres).");
    // Solo el superadmin completo ejecuta: el rol `finanzas` es de solo lectura.
    if ((await resolverRol(callerId)) !== "superadmin") throw Errors.forbidden("Tu rol es de solo lectura: no puede confirmar acciones.");
    const ahora = Date.now();
    const v = verificarPropuestaInterruptor(subllave(), callerId, agente, propuesta, ahora);
    if (!v.ok) {
      if (v.motivo === "vencida") throw Errors.conflict("Esta propuesta ya venció. Pídele al Copiloto que la prepare de nuevo.");
      throw Errors.notFound("No encontré esa propuesta.");
    }
    const p = v.propuesta;
    const repo = deps.platformSwitchRepo;
    if (!repo) throw Errors.serviceUnavailable("Los interruptores de plataforma todavía no están disponibles en este despliegue.");
    const actual = await agenteApagado(callerId, agente);
    if (actual === null) throw Errors.serviceUnavailable("Los interruptores de plataforma todavía no están disponibles en este despliegue (falta aplicar la migración 0025_superadmin_mfa_switches_orgs).");
    // Compare-and-set: si el interruptor ya no esta como cuando se propuso (alguien lo cambio, o esta misma propuesta ya se aplico), no se ejecuta.
    if (p.antes !== null && actual !== p.antes) throw Errors.conflict("El interruptor de ese agente ya cambió desde la propuesta. Pídele al Copiloto que la prepare de nuevo.");
    if (actual === p.bloquear) throw Errors.conflict(`Ese agente ya está ${p.bloquear ? "apagado" : "encendido"}.`);
    if (!consumirNonce(p.nonce, p.venceMs, ahora)) throw Errors.conflict("Esta propuesta ya se usó.");
    try {
      const result = await deps.engine.withAppSession({ userId: callerId }, (db) => repo(db).setSwitch(callerId, "agente", agente, p.bloquear, `[Copiloto] ${motivo}`));
      if (result.availability === "not_migrated" || !result.row) {
        liberarNonce(p.nonce);
        throw Errors.serviceUnavailable("Los interruptores de plataforma todavía no están disponibles en este despliegue (falta aplicar la migración 0025_superadmin_mfa_switches_orgs).");
      }
      deps.platformSwitchGuard?.invalidate();
      const r = result.row;
      return c.json({ estado: "ejecutada", interruptor: { scope: r.scope, target: r.target, bloqueado: r.blocked, motivo: r.reason, actualizadoPor: r.updatedBy, actualizadoEnMs: r.updatedAtMs } });
    } catch (err) {
      liberarNonce(p.nonce);
      return traducirErrorSeguridad(err);
    }
  });

  return app;
}
