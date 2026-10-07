// Ajustes del agente de restaurantes por ORGANIZACION (migración 055) y base de conocimiento automatica: el equivalente en la arquitectura vigente de lo
// que el original hacia con ElevenLabs (modelo y temperatura, estilo de habla, sonido de fondo, documentos `[Auto]`).
//   GET  /v1/restaurantes/:propertyId/admin/agente/ajustes        ajustes vigentes + lista permitida de modelos con costo estimado + estados honestos
//   PUT  /v1/restaurantes/:propertyId/admin/agente/ajustes        reemplaza los ajustes completos (owner/admin; bitacora)
//   GET  /v1/restaurantes/:propertyId/admin/agente/conocimiento   documentos generados AHORA de los datos de la cuenta (no hay copia que envejezca)
//   GET  /internal/restaurantes/voz/ajustes-llamada               lo que el servicio de llamadas necesita al abrir una llamada (secreto interno)
//
// Autorizacion: owner/admin (`STAFF_INVITE_ROLES`), el mismo umbral que las policies de la migracion (RLS es la autoridad; esta capa da defensa en
// profundidad y mejor mensaje). Corren en la sesion de STAFF autenticado. Base SIN migrar: la lectura devuelve `disponible: false` con los valores de
// siempre (el agente se comporta igual) y la escritura responde 503 honesto, nunca un falso exito.
import { Hono } from "hono";
import type { Context } from "hono";
import { assertVerticalRole, authMiddleware, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import {
  AjustesInvalidosError,
  AjustesNoDisponiblesError,
  AjustesRechazadosError,
  CLONACION_DE_VOZ_ESTADO,
  DOCUMENTOS_AUTO_OMITIDOS,
  MODELOS_AGENTE,
  PERFIL_COSTO_AGENTE,
  STAFF_INVITE_ROLES,
  TOPE_CARACTERES_PROMPT,
  UMBRAL_COLONIA_AMBIGUA_KM,
  ajustesDeLlamada,
  bloqueConocimientoOVacio,
  bloqueConocimientoParaPrompt,
  cargarDatosConocimiento,
  costoEstimadoModelo,
  generarConocimientoAuto,
  validarAjustesAgente,
} from "@atiende/domain-restaurantes";
import type { AjustesAgente, AjustesAgenteRepository, AjustesEntrada, LecturaAjustes } from "@atiende/domain-restaurantes";
import { ESTILOS_HABLA, FONDO_VOLUMEN_MAX, RITMOS_HABLA, TEMPERATURA_VOZ_MAX, TEMPERATURA_VOZ_MIN, VOZ_PLATAFORMA } from "@atiende/voice-core";
import { Errors } from "../../../errors.ts";
import { readJsonCapped, secretMatches } from "../../../http-security.ts";
import { logEvent } from "../../../logger.ts";
import type { AppDeps } from "../../../deps.ts";
import { UUID_RE } from "./voz-admin.ts";

function serializarModelo(m: (typeof MODELOS_AGENTE)[number]) {
  const whatsapp = costoEstimadoModelo(m.id, "whatsapp_mensaje");
  const voz = costoEstimadoModelo(m.id, "voz_cascada_minuto");
  return {
    id: m.id,
    etiqueta: m.etiqueta,
    nivel: m.nivel,
    descripcion: m.descripcion,
    aceptaTemperatura: m.aceptaTemperatura,
    predeterminado: m.predeterminado,
    costoWhatsappMicroUsdPorMensaje: whatsapp.microUsdPorUnidad,
    costoVozMicroUsdPorMinuto: voz.microUsdPorUnidad,
    precioVerificadoEn: whatsapp.verificadoEn,
  };
}

function serializarAjustes(l: LecturaAjustes) {
  const a = l.valor;
  return {
    disponible: l.disponible,
    configurados: l.configurados,
    actualizadoEn: l.actualizadoEn,
    ajustes: {
      whatsappModelo: a.whatsappModelo,
      whatsappTemperatura: a.whatsappTemperatura,
      vozModeloCascada: a.vozModeloCascada,
      vozTemperatura: a.vozTemperatura,
      vozRitmo: a.vozRitmo,
      vozEstilo: a.vozEstilo,
      vozFondoActivo: a.vozFondoActivo,
      vozFondoVolumen: a.vozFondoVolumen,
    },
  };
}

/** Todo lo que la pantalla necesita para no inventar nada: la lista permitida, los rangos y los estados honestos de lo que no se construye o depende de otro despliegue. */
function opciones() {
  return {
    modelos: MODELOS_AGENTE.map(serializarModelo),
    supuestosCosto: {
      whatsappMensaje: PERFIL_COSTO_AGENTE.whatsapp_mensaje,
      vozCascadaMinuto: PERFIL_COSTO_AGENTE.voz_cascada_minuto,
      nota: "Estimacion con precios de lista y un uso tipico; el costo real lo reporta OpenRouter por llamada. No es una factura.",
    },
    temperatura: { min: TEMPERATURA_VOZ_MIN, max: TEMPERATURA_VOZ_MAX, paso: 0.1 },
    habla: {
      ritmos: RITMOS_HABLA,
      estilos: ESTILOS_HABLA,
      nota: "Gemini Live no tiene un control numerico de velocidad ni de estabilidad: el ritmo y el estilo se piden al modelo por instruccion. La temperatura si es un parametro real.",
    },
    fondo: { volumenMax: FONDO_VOLUMEN_MAX, porOmision: "apagado" },
    escaleraVoz: { principal: VOZ_PLATAFORMA.gemini.modelo, respaldo: "cascada por OpenRouter" },
    // Lo que ya aplica y lo que espera al servicio de llamadas (apps/voice-worker, PR aparte): la pantalla lo dice tal cual.
    aplicaEn: {
      whatsappModeloYTemperatura: "ahora",
      vozTemperaturaYHabla: "vista previa ahora; llamadas reales cuando se despliegue el servicio de llamadas",
      vozModeloCascada: "llamadas reales cuando se despliegue el servicio de llamadas (la cascada solo atiende llamadas)",
      vozFondo: "llamadas reales cuando se despliegue el servicio de llamadas (la mezcla ya esta probada en aislado)",
    },
    clonacionDeVoz: CLONACION_DE_VOZ_ESTADO,
    documentosOmitidos: DOCUMENTOS_AUTO_OMITIDOS,
  };
}

export function restaurantesAjustesAgenteRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  const base = "/v1/restaurantes/:propertyId/admin/agente";
  const ajustesPath = `${base}/ajustes`;
  const conocimientoPath = `${base}/conocimiento`;

  for (const path of [ajustesPath, conocimientoPath]) {
    app.use(path, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  }

  function repo(c: Context<CoreAuthHonoEnv>): AjustesAgenteRepository {
    if (!deps.ajustesAgenteRepo) throw Errors.serviceUnavailable("Los ajustes del agente no estan disponibles en este despliegue.");
    return deps.ajustesAgenteRepo(c.get("db"));
  }

  app.get(ajustesPath, async (c) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    const lectura = await repo(c).leer(c.get("organizationId"));
    return c.json({ ...serializarAjustes(lectura), ...opciones() });
  });

  app.put(ajustesPath, async (c) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    const organizationId = c.get("organizationId");
    const actorUserId = c.get("userId");
    let nuevos: AjustesAgente;
    try {
      nuevos = validarAjustesAgente(await readJsonCapped<AjustesEntrada>(c.req.raw, 4 * 1024));
    } catch (err) {
      if (err instanceof AjustesInvalidosError) throw Errors.validation(err.message);
      throw err;
    }
    const r = repo(c);
    const anterior = await r.leer(organizationId);
    let guardado: LecturaAjustes;
    try {
      guardado = await r.guardar(organizationId, actorUserId, nuevos);
    } catch (err) {
      if (err instanceof AjustesNoDisponiblesError) throw Errors.serviceUnavailable(err.message);
      if (err instanceof AjustesRechazadosError) throw Errors.forbidden(err.message);
      throw err;
    }
    logEvent(c, "info", "restaurantes_admin_agente_ajustes_actualizados", { actorUserId, organizationId });
    await deps.restaurantesRepo(c.get("db")).registrarAuditoria({
      organizationId,
      actorUserId,
      action: "configuracion.agente_ajustes_actualizados",
      entityType: "configuracion",
      entityId: organizationId,
      campo: "agente_ajustes",
      antes: anterior.configurados ? resumenAjustes(anterior.valor) : null,
      despues: resumenAjustes(guardado.valor),
    });
    return c.json({ ...serializarAjustes(guardado), ...opciones() });
  });

  app.get(conocimientoPath, async (c) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    const datos = await cargarDatosConocimiento(deps.restaurantesRepo(c.get("db")), c.get("organizationId"));
    const conocimiento = generarConocimientoAuto(datos);
    const bloque = bloqueConocimientoParaPrompt(conocimiento);
    return c.json({
      generadoEn: new Date().toISOString(),
      huella: conocimiento.huella,
      // No se guardan copias: cada lectura sale de los datos vigentes, por eso nunca quedan desactualizadas.
      nota: "Estos documentos se generan al momento desde los datos de tu cuenta (sucursales, horarios, menu, colonias). No hay copia que se desactualice: al cambiar un dato, el documento cambia solo.",
      documentos: conocimiento.documentos.map((d) => ({
        tipo: d.tipo,
        titulo: d.titulo,
        contenido: d.contenido,
        caracteres: d.caracteres,
        huella: d.huella,
        vacio: d.vacio,
        motivoVacio: d.motivoVacio,
        truncado: d.truncado === true,
        enPrompt: bloque.incluidos.includes(d.tipo),
      })),
      prompt: { topeCaracteres: TOPE_CARACTERES_PROMPT, caracteresUsados: bloque.texto.length, omitidos: bloque.omitidos },
      alertasColonias: { umbralKm: UMBRAL_COLONIA_AMBIGUA_KM, items: conocimiento.alertasColonias, sinSucursal: conocimiento.coloniasSinSucursal },
      documentosOmitidos: DOCUMENTOS_AUTO_OMITIDOS,
    });
  });

  return app;
}

/** Resumen para bitacora: ids de modelo y numeros, nunca texto libre. */
function resumenAjustes(a: AjustesAgente): string {
  return JSON.stringify({
    wa: [a.whatsappModelo, a.whatsappTemperatura],
    vozCascada: [a.vozModeloCascada],
    vozTemp: a.vozTemperatura,
    habla: [a.vozRitmo, a.vozEstilo],
    fondo: [a.vozFondoActivo, a.vozFondoVolumen],
  });
}

/**
 * Lado SISTEMA: el servicio de llamadas pide, al abrir una llamada, los ajustes de la organizacion (modelo de cascada, temperatura, ritmo, estilo, fondo) y el bloque
 * de conocimiento automatico para anexarlo a la instruccion (`instruccionConAjustes`). Autenticacion: el secreto interno (`x-atiende-internal-secret`) en tiempo
 * constante; sin el, 401. Corre en una sesion de sistema (`userId: null`); sin la migracion devuelve los valores de siempre.
 */
export function restaurantesAjustesLlamadaInternoRoutes(deps: AppDeps): Hono {
  const app = new Hono();
  app.get("/internal/restaurantes/voz/ajustes-llamada", async (c) => {
    if (!secretMatches(c.req.raw, "x-atiende-internal-secret", deps.env.internalSecret)) throw Errors.unauthorized();
    const organizationId = c.req.query("organizationId") ?? "";
    if (!UUID_RE.test(organizationId)) throw Errors.validation("organizationId: se esperaba un UUID.");
    if (!deps.ajustesAgenteRepo) throw Errors.serviceUnavailable("Los ajustes del agente no estan disponibles en este despliegue.");
    const ajustesRepo = deps.ajustesAgenteRepo;
    return deps.engine.withAppSession({ userId: null }, async (db) => {
      const lectura = await ajustesRepo(db).leer(organizationId);
      const bloque = await bloqueConocimientoOVacio(db, deps.restaurantesRepo(db), organizationId);
      return c.json({
        disponible: lectura.disponible,
        ajustes: ajustesDeLlamada(lectura.valor),
        conocimiento: { texto: bloque.texto, incluidos: bloque.incluidos, omitidos: bloque.omitidos },
      });
    });
  });
  return app;
}
