// Backend propio de voz de restaurantes (migración 025), lado PANEL: reemplaza a la edge
// `agent-config` de ElevenLabs del repo suelto. Por sucursal (`:propertyId`):
//   GET  .../admin/voz/catalogo                 catálogo estático de las 30 voces + salud del proveedor
//   GET  .../admin/voz/config                   configuración de voz (vacío honesto si no hay / base sin migrar)
//   PUT  .../admin/voz/config                   reemplaza la configuración completa
//   POST .../admin/voz/preview/sesion           emite la sesión de preview (token efímero)
//   POST .../admin/voz/preview/:sesionId/herramienta   relevo de UNA herramienta del agente en modo preview (sin efectos)
//   GET  .../admin/voz/conversaciones           listado paginado de conversaciones
//   GET  .../admin/voz/conversaciones/:id       conversación + transcripción propia
//
// Autorización: owner/admin (`STAFF_INVITE_ROLES`) en TODAS, el mismo umbral que las policies de la
// migración (RLS es la autoridad; esta capa da defensa en profundidad y mejor mensaje): el prompt
// es configuración comercial y las transcripciones contienen la voz de comensales. Corren en la
// sesión de STAFF autenticado y respetan el alcance por membership (`resolveEffectivePropertyIds`).
//
// Base SIN migrar: lecturas -> `disponible: false` con lista/valores vacíos; escrituras y
// preview -> 503. Sin credencial del proveedor (`GEMINI_API_KEY`) o sin secreto del token
// (`VOICE_PREVIEW_TOKEN_SECRET`): 503 "voz no configurada", NUNCA un falso éxito ni una fila huérfana.
import { Hono } from "hono";
import type { Context } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import {
  CATALOGO_VOCES_GEMINI,
  PREVIEW_TOKEN_TTL_POR_DEFECTO_SEGUNDOS,
  STAFF_INVITE_ROLES,
  VOZ_COMPORTAMIENTO_MAX,
  VOZ_MENSAJE_INICIAL_MAX,
  VOZ_PROVEEDORES,
  VOZ_RESULTADOS,
  VozNoConfiguradaError,
  VozNoDisponibleError,
  VozProveedorError,
  VozRechazadaError,
  anteponerConocimiento,
  bloqueConocimientoDelTurno,
  esVozDeGemini,
  executeAgentToolSafely,
  firmarPreviewToken,
  instruccionVozConReglas,
  resolveAgentConfig,
  MARCADOR_SALUDO,
  resolverMarcadorSaludo,
  telefonoFicticioPreview,
  toolDefinitionsForChannel,
  verificarPreviewToken,
} from "@atiende/domain-restaurantes";
import type { VoiceAgentProvider, VozConfig, VozConfigEntrada, VozProveedorId, VozRepository, VozResultado } from "@atiende/domain-restaurantes";
import { Errors } from "../../../errors.ts";
import { readJsonCapped, requestActor } from "../../../http-security.ts";
import { logEvent } from "../../../logger.ts";
import type { AppDeps } from "../../../deps.ts";
import { resolveEffectivePropertyIds } from "./admin-scope.ts";
import { consumirTopesEnSesionDeSistema } from "./rate-limit-sistema.ts";

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SECRETO_PREVIEW_MIN = 16;

interface ConfigBody {
  readonly habilitado?: unknown;
  readonly proveedor?: unknown;
  readonly voiceId?: unknown;
  readonly comportamiento?: unknown;
  readonly mensajeInicial?: unknown;
  /** Opcional (migracion 053): ausente = se conserva lo guardado (un cliente anterior a la bandera no la pisa). */
  readonly mensajeInicialInterrumpible?: unknown;
}

/** PUT reemplaza la configuración COMPLETA: cada campo es obligatorio para que un cliente
 * desactualizado nunca borre por omisión lo que no conoce. */
function parseConfig(raw: ConfigBody): VozConfigEntrada {
  if (typeof raw.habilitado !== "boolean") throw Errors.validation("habilitado: campo requerido (true o false).");
  if (typeof raw.proveedor !== "string" || !(VOZ_PROVEEDORES as readonly string[]).includes(raw.proveedor)) {
    throw Errors.validation(`proveedor: debe ser uno de ${VOZ_PROVEEDORES.join(", ")}.`);
  }
  const proveedor = raw.proveedor as VozProveedorId;
  if (typeof raw.voiceId !== "string" || raw.voiceId.length < 1 || raw.voiceId.length > 64) throw Errors.validation("voiceId: campo requerido (1 a 64 caracteres).");
  if (proveedor === "gemini-3.8-live" && !esVozDeGemini(raw.voiceId)) {
    throw Errors.validation("voiceId: no está entre las 30 voces del catálogo de Gemini (GET .../admin/voz/catalogo).");
  }
  if (typeof raw.comportamiento !== "string" || raw.comportamiento.length > VOZ_COMPORTAMIENTO_MAX) {
    throw Errors.validation(`comportamiento: se esperaba texto de hasta ${VOZ_COMPORTAMIENTO_MAX} caracteres (puede ir vacío).`);
  }
  if (typeof raw.mensajeInicial !== "string" || raw.mensajeInicial.length > VOZ_MENSAJE_INICIAL_MAX) {
    throw Errors.validation(`mensajeInicial: se esperaba texto de hasta ${VOZ_MENSAJE_INICIAL_MAX} caracteres (puede ir vacío).`);
  }
  if (raw.mensajeInicialInterrumpible !== undefined && typeof raw.mensajeInicialInterrumpible !== "boolean") throw Errors.validation("mensajeInicialInterrumpible: se esperaba true o false.");
  return {
    habilitado: raw.habilitado,
    proveedor,
    voiceId: raw.voiceId,
    comportamiento: raw.comportamiento,
    mensajeInicial: raw.mensajeInicial,
    ...(raw.mensajeInicialInterrumpible === undefined ? {} : { mensajeInicialInterrumpible: raw.mensajeInicialInterrumpible }),
  };
}

function serializeConfig(c: VozConfig, disponible: boolean) {
  return { disponible, configurada: c.configurada, habilitado: c.habilitado, proveedor: c.proveedor, voiceId: c.voiceId, comportamiento: c.comportamiento, mensajeInicial: c.mensajeInicial, mensajeInicialInterrumpible: c.mensajeInicialInterrumpible !== false };
}

/** Resumen para bitácora: nunca el prompt completo (puede ser largo y es configuración comercial). */
function resumenConfig(c: Pick<VozConfig, "habilitado" | "proveedor" | "voiceId" | "comportamiento" | "mensajeInicial" | "mensajeInicialInterrumpible">): string {
  return JSON.stringify({ habilitado: c.habilitado, proveedor: c.proveedor, voiceId: c.voiceId, comportamientoChars: c.comportamiento.length, mensajeInicialChars: c.mensajeInicial.length, saludoInterrumpible: c.mensajeInicialInterrumpible !== false });
}

function parseEntero(value: string | undefined, campo: string, min: number, max: number, porDefecto: number): number {
  if (value === undefined || value === "") return porDefecto;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw Errors.validation(`${campo}: se esperaba un entero entre ${min} y ${max}.`);
  return n;
}

function parseResultado(value: string | undefined): VozResultado | null {
  if (value === undefined || value === "") return null;
  if (!(VOZ_RESULTADOS as readonly string[]).includes(value)) throw Errors.validation(`resultado: debe ser uno de ${VOZ_RESULTADOS.join(", ")}.`);
  return value as VozResultado;
}

function asServiceUnavailable(err: unknown): never {
  if (err instanceof VozNoDisponibleError) throw Errors.serviceUnavailable(err.message);
  if (err instanceof VozRechazadaError) throw Errors.forbidden(err.message);
  throw err;
}

export function restaurantesVozAdminRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  const base = "/v1/restaurantes/:propertyId/admin/voz";
  const catalogoPath = `${base}/catalogo`;
  const configPath = `${base}/config`;
  const previewPath = `${base}/preview/sesion`;
  const previewHerramientaPath = `${base}/preview/:sesionId/herramienta`;
  const conversacionesPath = `${base}/conversaciones`;
  const conversacionPath = `${base}/conversaciones/:conversationId`;

  for (const path of [catalogoPath, configPath, previewPath, previewHerramientaPath, conversacionesPath, conversacionPath]) {
    app.use(path, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  }

  function vozRepo(c: Context<CoreAuthHonoEnv>): VozRepository {
    if (!deps.vozRepo) throw Errors.serviceUnavailable("La voz no está disponible en este despliegue.");
    return deps.vozRepo(c.get("db"));
  }

  /** La sucursal debe existir en ESTA organización y estar dentro del alcance del staff. */
  async function resolverSucursal(c: Context<CoreAuthHonoEnv>): Promise<{ organizationId: string; propertyId: string }> {
    const organizationId = c.get("organizationId");
    const propertyId = c.req.param("propertyId") ?? "";
    await resolveEffectivePropertyIds(deps, c, organizationId, propertyId);
    return { organizationId, propertyId };
  }

  app.get(catalogoPath, async (c) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    await resolverSucursal(c);
    const provider = deps.voiceProvider;
    const salud = provider ? await provider.salud() : { ok: false, detalle: "Voz no configurada: no hay proveedor de voz en este despliegue." };
    return c.json({
      proveedor: provider?.id ?? null,
      salud,
      voces: (provider?.catalogoVoces() ?? CATALOGO_VOCES_GEMINI).map((v) => ({ id: v.id, nombre: v.nombre, estilo: v.estilo })),
    });
  });

  app.get(configPath, async (c) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    const { propertyId } = await resolverSucursal(c);
    const lectura = await vozRepo(c).getConfig(propertyId);
    return c.json(serializeConfig(lectura.valor, lectura.disponible));
  });

  app.put(configPath, async (c) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    const { organizationId, propertyId } = await resolverSucursal(c);
    const pedida = parseConfig(await readJsonCapped<ConfigBody>(c.req.raw, 32 * 1024));
    const repo = vozRepo(c);
    const anterior = await repo.getConfig(propertyId);
    // Un cliente anterior a la bandera del saludo (053) no la manda: se conserva lo guardado en vez de pisarla con el valor por omision.
    const nueva: VozConfigEntrada = pedida.mensajeInicialInterrumpible === undefined ? { ...pedida, mensajeInicialInterrumpible: anterior.valor.mensajeInicialInterrumpible !== false } : pedida;

    let guardada: VozConfig;
    try {
      guardada = await repo.upsertConfig(organizationId, propertyId, nueva);
    } catch (err) {
      return asServiceUnavailable(err);
    }

    logEvent(c, "info", "restaurantes_admin_voz_config_actualizada", { actorUserId: c.get("userId"), organizationId, propertyId });
    await deps.restaurantesRepo(c.get("db")).registrarAuditoria({
      organizationId,
      actorUserId: c.get("userId"),
      action: "configuracion.voz_actualizada",
      entityType: "configuracion",
      entityId: propertyId,
      campo: "voz",
      antes: anterior.disponible && anterior.valor.configurada ? resumenConfig(anterior.valor) : null,
      despues: resumenConfig(guardada),
    });
    return c.json(serializeConfig(guardada, true));
  });

  app.post(previewPath, async (c) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    const { organizationId, propertyId } = await resolverSucursal(c);
    const actorUserId = c.get("userId");

    const raw = await readJsonCapped<{ voiceId?: unknown }>(c.req.raw, 4 * 1024);
    if (raw.voiceId !== undefined && typeof raw.voiceId !== "string") throw Errors.validation("voiceId: se esperaba un texto.");

    // 1) Proveedor y secreto: SIN ellos no se escribe nada ni se finge un éxito.
    const provider: VoiceAgentProvider | undefined = deps.voiceProvider;
    if (!provider) throw Errors.serviceUnavailable("Voz no configurada: no hay proveedor de voz en este despliegue.");
    const salud = await provider.salud();
    if (!salud.ok) throw Errors.serviceUnavailable(salud.detalle);
    const secreto = deps.env.voicePreviewTokenSecret;
    if (!secreto || secreto.length < SECRETO_PREVIEW_MIN) throw Errors.serviceUnavailable("Voz no configurada: falta VOICE_PREVIEW_TOKEN_SECRET.");

    const restaurantes = deps.restaurantesRepo(c.get("db"));
    // `consume_api_rate_limit` es de SOLO sistema: se consume en su propia sesion de sistema (ver rate-limit-sistema.ts), no en la del staff.
    const agotado = await consumirTopesEnSesionDeSistema(deps, [{ scope: "voz-preview-sesion", actor: requestActor(c.req.raw, actorUserId), maxRequests: 20, windowSeconds: 600 }]);
    if (agotado !== null) throw Errors.tooManyRequests();

    // 2) Voz: la pedida o la guardada; siempre dentro del catálogo del proveedor.
    const repo = vozRepo(c);
    const lectura = await repo.getConfig(propertyId);
    const voiceId = raw.voiceId ?? lectura.valor.voiceId;
    if (!provider.catalogoVoces().some((v) => v.id === voiceId)) throw Errors.validation("voiceId: no está en el catálogo de voces del proveedor.");

    // 2b) Instruccion de la sesion (antes de crear la fila: un fallo aqui no deja una sesion huerfana).
    // Perfil PM: las reglas duras van ANEXADAS al final del texto editable (el dueno no puede borrarlas); el saludo inicial ya
    // viaja dentro de la instruccion, antes del bloque. Otros perfiles conservan el comportamiento editable tal cual.
    const agente = await resolveAgentConfig(restaurantes, organizationId, propertyId);
    // `{saludo}` se resuelve aqui con la zona horaria de la sucursal (tambien dentro de las reglas del perfil PM).
    const mensajeInicial = lectura.valor.mensajeInicial.includes(MARCADOR_SALUDO)
      ? resolverMarcadorSaludo(lectura.valor.mensajeInicial, (await restaurantes.findBranchZonaHoraria(propertyId)).zonaHoraria ?? "America/Merida", new Date())
      : lectura.valor.mensajeInicial;
    const comportamiento =
      agente.perfil === "taqueria_pm"
        ? instruccionVozConReglas({
            comportamiento: lectura.valor.comportamiento,
            mensajeInicial,
            businessName: agente.businessName,
            ...(agente.agentName ? { agentName: agente.agentName } : {}),
            deliveryTimeText: agente.deliveryTimeText,
            promosTexto: agente.promosText ?? null,
            salsasTexto: agente.salsasText ?? null,
            pedidoGrandeTexto: agente.largeOrderText ?? null,
            motivosDesactivados: agente.motivosDesactivados ?? [],
          })
        : lectura.valor.comportamiento;

    // 3) Fila de sesión (la base valida organización, sucursal, vigencia y created_by = staff).
    const ttlSegundos = PREVIEW_TOKEN_TTL_POR_DEFECTO_SEGUNDOS;
    let sesion;
    try {
      sesion = await repo.crearPreviewSession({ organizationId, propertyId, createdBy: actorUserId, proveedor: provider.id === "fake" ? "gemini-3.8-live" : provider.id, voiceId, ttlSegundos });
    } catch (err) {
      return asServiceUnavailable(err);
    }

    // 4) Sesión con el proveedor + token propio firmado. El token fija las herramientas del registro unico (canal voz); las
    // ejecuta el servidor en modo preview (ruta `.../preview/:sesionId/herramienta`). `{saludo}` se resuelve aqui con la zona
    // horaria de la sucursal.
    // Conocimiento del negocio vigente HOY (053): va ANTES del comportamiento guardado para que las reglas duras (que viven en el comportamiento) queden
    // al final y ganen. Sin entradas o con la base sin migrar el texto es identico al guardado.
    const bloqueConocimiento = await bloqueConocimientoDelTurno(restaurantes, organizationId, propertyId, "America/Merida", new Date());
    let emitida;
    try {
      emitida = await provider.emitirSesionPreview({
        organizationId,
        propertyId,
        sessionId: sesion.id,
        voiceId,
        comportamiento: anteponerConocimiento(comportamiento, bloqueConocimiento),
        mensajeInicial: agente.perfil === "taqueria_pm" ? "" : mensajeInicial,
        ttlSegundos,
        vertical: "restaurantes",
        herramientas: toolDefinitionsForChannel("voz").map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })),
      });
    } catch (err) {
      if (err instanceof VozNoConfiguradaError) throw Errors.serviceUnavailable(err.message);
      if (err instanceof VozProveedorError) {
        logEvent(c, "error", "restaurantes_admin_voz_preview_proveedor_fallo", { organizationId, propertyId, estado: err.estado ?? null });
        throw Errors.serviceUnavailable("El proveedor de voz no pudo emitir la sesión de preview. Reintenta en unos minutos.");
      }
      throw err;
    }
    const { token: tokenPreview } = firmarPreviewToken(
      secreto,
      { sessionId: sesion.id, organizationId, propertyId, voiceId, proveedor: emitida.proveedor },
      new Date(),
      ttlSegundos,
    );

    logEvent(c, "info", "restaurantes_admin_voz_preview_emitido", { actorUserId, organizationId, propertyId, sessionId: sesion.id });
    await restaurantes.registrarAuditoria({
      organizationId,
      actorUserId,
      action: "configuracion.voz_preview_emitido",
      entityType: "configuracion",
      entityId: propertyId,
      campo: "voiceId",
      antes: null,
      despues: voiceId,
    });

    return c.json(
      {
        sesionId: sesion.id,
        proveedor: emitida.proveedor,
        modelo: emitida.modelo,
        voiceId,
        websocketUrl: emitida.websocketUrl,
        tokenProveedor: emitida.tokenProveedor,
        tokenPreview,
        expiraEn: sesion.expiresAt,
      },
      201,
    );
  });

  // Relevo de herramientas de la llamada de PRUEBA: el navegador recibe el `toolCall` de Gemini Live y lo manda aquí; se
  // ejecuta el MISMO registro de tools del agente real, pero con `modo: "preview"` fijado por el servidor (pedidos y avisos
  // simulados, cero escrituras de dominio). Identidad: sesión de STAFF owner/admin + token de preview firmado y ligado a
  // ESTA organización, sucursal y sesión (un token vencido, de otra sucursal o de otra sesión se rechaza). El nombre de la
  // herramienta debe estar en el registro del canal voz; el modo y el teléfono NUNCA salen del cuerpo.
  app.post(previewHerramientaPath, async (c) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    const { organizationId, propertyId } = await resolverSucursal(c);
    const sesionId = c.req.param("sesionId") ?? "";
    if (!UUID_RE.test(sesionId)) throw Errors.notFound("Sesión de prueba no encontrada.");

    const secreto = deps.env.voicePreviewTokenSecret;
    if (!secreto || secreto.length < SECRETO_PREVIEW_MIN) throw Errors.serviceUnavailable("Voz no configurada: falta VOICE_PREVIEW_TOKEN_SECRET.");

    const raw = await readJsonCapped<{ tokenPreview?: unknown; nombre?: unknown; argumentos?: unknown }>(c.req.raw, 32 * 1024);
    const verificacion = verificarPreviewToken(secreto, raw.tokenPreview, new Date(), { sessionId: sesionId, organizationId, propertyId });
    if (!verificacion.ok) {
      // Vencido o de otra sesión => 401 (el panel pide una llamada nueva); de otra sucursal u organización => 403.
      if (verificacion.razon === "ligadura") throw Errors.forbidden("El token de la prueba no corresponde a esta sucursal o sesión.");
      throw Errors.unauthorized();
    }
    if (typeof raw.nombre !== "string" || !toolDefinitionsForChannel("voz").some((t) => t.name === raw.nombre)) throw Errors.validation("nombre: herramienta desconocida.");
    if (raw.argumentos !== undefined && (typeof raw.argumentos !== "object" || raw.argumentos === null || Array.isArray(raw.argumentos))) throw Errors.validation("argumentos: se esperaba un objeto.");

    const agotado = await consumirTopesEnSesionDeSistema(deps, [{ scope: "voz-preview-herramienta", actor: requestActor(c.req.raw, `${c.get("userId")}:${sesionId}`), maxRequests: 60, windowSeconds: 600 }]);
    if (agotado !== null) throw Errors.tooManyRequests();

    // Las funciones SQL de las que dependen estas herramientas (`cliente_memoria`, `read_order_flow_state`/`claim`/`write`) son de SOLO sistema: en la
    // sesion del staff lanzan 42501, `executeAgentToolSafely` lo traga y la ruta respondia 200 con «Error interno al ejecutar la herramienta» (no se podia
    // confirmar ni simular un pedido en la llamada de prueba). Se ejecuta en una sesion de sistema (`userId: null`), igual que las rutas de voz reales
    // (`voice-tools.ts`). Esto NO abre un hueco: organizacion y sucursal ya salieron de la membership del staff y del token de preview firmado ARRIBA
    // (nada del cuerpo las elige), y `modo: "preview"` lo fija el servidor, asi que el registro simula `crear_pedido`/avisos sin escribir dominio.
    const outcome = await deps.engine.withAppSession({ userId: null }, (db) =>
      executeAgentToolSafely(
        deps.restaurantesRepo(db),
        {
          organizationId,
          channel: "voz",
          phone: telefonoFicticioPreview(sesionId),
          lockedPropertyId: propertyId,
          modo: "preview",
          flow: { key: `voz-preview:${sesionId}`, turn: null },
        },
        raw.nombre as string,
        (raw.argumentos ?? {}) as Record<string, unknown>,
      ),
    );
    logEvent(c, "info", "restaurantes_admin_voz_preview_herramienta", { actorUserId: c.get("userId"), organizationId, propertyId, sessionId: sesionId, herramienta: raw.nombre });
    return c.json({ resultado: outcome.result, simulado: outcome.simulated === true });
  });

  app.get(conversacionesPath, async (c) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    const { organizationId, propertyId } = await resolverSucursal(c);
    const resultado = parseResultado(c.req.query("resultado"));
    const limit = parseEntero(c.req.query("limit"), "limit", 1, 100, 25);
    const offset = parseEntero(c.req.query("offset"), "offset", 0, 1_000_000, 0);
    const lectura = await vozRepo(c).listConversaciones(organizationId, propertyId, { resultado, limit, offset });
    return c.json({
      disponible: lectura.disponible,
      total: lectura.valor.total,
      nextOffset: offset + limit < lectura.valor.total ? offset + limit : null,
      items: lectura.valor.items.map(serializeConversacion),
    });
  });

  app.get(conversacionPath, async (c) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    const { organizationId, propertyId } = await resolverSucursal(c);
    const conversationId = c.req.param("conversationId") ?? "";
    if (!UUID_RE.test(conversationId)) throw Errors.notFound("Conversación no encontrada.");
    const lectura = await vozRepo(c).getConversacion(organizationId, propertyId, conversationId);
    if (!lectura.disponible) throw Errors.serviceUnavailable("Las conversaciones de voz todavía no están disponibles en esta base de datos.");
    if (!lectura.valor) throw Errors.notFound("Conversación no encontrada.");

    // Consultar una transcripción es acceso a PII de comensales: queda en la bitácora.
    await deps.restaurantesRepo(c.get("db")).registrarAuditoria({
      organizationId,
      actorUserId: c.get("userId"),
      action: "configuracion.voz_conversacion_consultada",
      entityType: "configuracion",
      entityId: conversationId,
      campo: null,
      antes: null,
      despues: null,
    });

    return c.json({
      ...serializeConversacion(lectura.valor.conversacion),
      turnos: lectura.valor.turnos.map((t) => ({ seq: t.seq, rol: t.rol, texto: t.texto, duracionMs: t.duracionMs, latenciaMs: t.latenciaMs, costoEstimadoMicroUsd: t.costoEstimadoMicroUsd, creadoEn: t.createdAt })),
    });
  });

  return app;
}

function serializeConversacion(c: {
  id: string;
  externalId: string;
  canal: string;
  proveedor: string;
  voiceId: string | null;
  startedAt: string;
  endedAt: string | null;
  durationS: number | null;
  costoEstimadoMicroUsd: number;
  latenciaP95Ms: number | null;
  resultado: string | null;
  orderId: string | null;
}) {
  return {
    id: c.id,
    externalId: c.externalId,
    canal: c.canal,
    proveedor: c.proveedor,
    voiceId: c.voiceId,
    iniciadaEn: c.startedAt,
    terminadaEn: c.endedAt,
    duracionS: c.durationS,
    costoEstimadoMicroUsd: c.costoEstimadoMicroUsd,
    latenciaP95Ms: c.latenciaP95Ms,
    resultado: c.resultado,
    pedidoId: c.orderId,
  };
}
