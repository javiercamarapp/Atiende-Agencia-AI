// Clonacion de la voz TELEFONICA de una sucursal (ElevenLabs Instant Voice Cloning), lado PANEL:
//   POST /v1/restaurantes/:propertyId/admin/voz/clonar     multipart: `muestras` (2 a 5 audios), `nombre`, `consentimiento=true`, `quitarRuido`
//
// La voz resultante se guarda en `restaurantes.branch_voice_config.tts_voice_id` (migracion 103) de ESA sucursal: es la que usa el worker
// para el TTS de la llamada. El id lo genera el proveedor en el servidor; el navegador nunca elige un id arbitrario (el PUT de config solo
// acepta voces del catalogo o la que ya esta guardada, ver voz-admin.ts).
//
// Seguridad:
//  * owner/admin (`STAFF_INVITE_ROLES`) de la organizacion y sucursal dentro de su alcance (mismo umbral que la config de voz).
//  * La llave de ElevenLabs vive solo en la API (`deps.clonadorVoz`); sin ella -> 503 "no disponible aun", nunca un falso exito.
//  * Consentimiento explicito obligatorio (la voz es un dato biometrico de quien graba): sin `consentimiento=true` -> 400.
//  * Cuerpo acotado en streaming (4 MB, debajo del tope de 4.5 MB de Vercel), 2 a 5 archivos `audio/*` (o `video/webm` de MediaRecorder).
//  * Tope de 5 clonaciones por hora por persona (cuesta un espacio de voz de la cuenta).
//  * Bitacora sin audio ni PII: solo cantidad de muestras, bytes totales y la voz anterior/nueva.
//  * Base sin la 103 o sucursal sin configuracion de voz -> se responde ANTES de llamar al proveedor (no se crea una voz huerfana); si el
//    guardado falla despues, se borra la voz recien creada (compensacion de mejor esfuerzo).
import { Hono } from "hono";
import type { Context } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { STAFF_INVITE_ROLES, VozNoDisponibleError, VozRechazadaError } from "@atiende/domain-restaurantes";
import { Errors } from "../../../errors.ts";
import { requestActor } from "../../../http-security.ts";
import { logEvent } from "../../../logger.ts";
import type { AppDeps } from "../../../deps.ts";
import { ClonacionVozError } from "../../../voz-clonacion.ts";
import type { MuestraVoz } from "../../../voz-clonacion.ts";
import { resolveEffectivePropertyIds } from "./admin-scope.ts";
import { consumirTopesEnSesionDeSistema } from "./rate-limit-sistema.ts";

export const CLONAR_MUESTRAS_MIN = 2;
export const CLONAR_MUESTRAS_MAX = 5;
/** Tope del cuerpo completo: debajo de los 4.5 MB que acepta una funcion de Vercel. */
export const CLONAR_CUERPO_MAX_BYTES = 4 * 1024 * 1024;
/** Una muestra util pesa decenas de KB; menos que esto es un archivo vacio o roto. */
const MUESTRA_MIN_BYTES = 2 * 1024;
const NOMBRE_MAX = 60;
const TIPO_AUDIO_RE = /^(audio\/[a-z0-9.+-]+|video\/webm)(;.*)?$/i;

async function leerCuerpoAcotado(req: Request, maxBytes: number): Promise<Uint8Array> {
  const declarado = Number(req.headers.get("content-length") ?? 0);
  if (!Number.isFinite(declarado) || declarado < 0 || declarado > maxBytes) throw Errors.payloadTooLarge("Las muestras pesan más de 4 MB en total: graba clips más cortos o sube menos archivos.");
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const partes: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw Errors.payloadTooLarge("Las muestras pesan más de 4 MB en total: graba clips más cortos o sube menos archivos.");
    }
    partes.push(value);
  }
  const cuerpo = new Uint8Array(total);
  let off = 0;
  for (const p of partes) {
    cuerpo.set(p, off);
    off += p.byteLength;
  }
  return cuerpo;
}

/** Nombre visible de la voz: texto corto sin caracteres de control; vacio -> uno por omision. */
export function sanearNombreVoz(raw: unknown): string {
  const limpio = typeof raw === "string" ? raw.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim() : "";
  return limpio.slice(0, NOMBRE_MAX);
}

function nombreArchivoSeguro(nombre: string, i: number): string {
  const base = nombre.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 40);
  return base.length > 0 ? base : `muestra-${i + 1}`;
}

export function restaurantesVozClonacionRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  const clonarPath = "/v1/restaurantes/:propertyId/admin/voz/clonar";
  app.use(clonarPath, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  async function resolverSucursal(c: Context<CoreAuthHonoEnv>): Promise<{ organizationId: string; propertyId: string }> {
    const organizationId = c.get("organizationId");
    const propertyId = c.req.param("propertyId") ?? "";
    await resolveEffectivePropertyIds(deps, c, organizationId, propertyId);
    return { organizationId, propertyId };
  }

  app.post(clonarPath, async (c) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    const { organizationId, propertyId } = await resolverSucursal(c);
    const actorUserId = c.get("userId");

    // 1) Configuracion de la plataforma y de la base, ANTES de leer audio o llamar al proveedor.
    const clonador = deps.clonadorVoz;
    if (!clonador) throw Errors.serviceUnavailable("Clonación de voz no disponible aún: requiere ELEVENLABS_API_KEY en la API.");
    if (!deps.vozRepo) throw Errors.serviceUnavailable("La voz no está disponible en este despliegue.");
    const repo = deps.vozRepo(c.get("db"));
    if (!repo.getVozTelefono || !repo.setVozTelefono) throw Errors.serviceUnavailable("La voz telefónica no está disponible aún: requiere la migración 103.");
    const anterior = await repo.getVozTelefono(propertyId);
    if (!anterior.disponible) throw Errors.serviceUnavailable("La voz telefónica no está disponible aún: requiere la migración 103.");
    const config = await repo.getConfig(propertyId);
    if (!config.valor.configurada) throw Errors.conflict("Guarda primero la configuración de voz de esta sucursal y después clona la voz.");

    const tipoContenido = c.req.header("content-type") ?? "";
    if (!/^multipart\/form-data\b/i.test(tipoContenido)) throw Errors.validation("Se esperaba multipart/form-data con las muestras de audio.");

    // 2) Formulario acotado.
    const cuerpo = await leerCuerpoAcotado(c.req.raw, CLONAR_CUERPO_MAX_BYTES);
    let formulario: FormData;
    try {
      formulario = await new Response(cuerpo, { headers: { "content-type": tipoContenido } }).formData();
    } catch {
      throw Errors.validation("El formulario de muestras no es válido.");
    }
    if (formulario.get("consentimiento") !== "true") {
      throw Errors.validation("consentimiento: confirma que la voz es tuya o que tienes permiso expreso de la persona para clonarla.");
    }
    const nombre = sanearNombreVoz(formulario.get("nombre"));
    if (nombre.length < 2) throw Errors.validation(`nombre: escribe un nombre para la voz (2 a ${NOMBRE_MAX} caracteres).`);
    const quitarRuido = formulario.get("quitarRuido") !== "false";
    const archivos = formulario.getAll("muestras").filter((v): v is File => typeof v !== "string");
    if (archivos.length < CLONAR_MUESTRAS_MIN || archivos.length > CLONAR_MUESTRAS_MAX) {
      throw Errors.validation(`muestras: se necesitan de ${CLONAR_MUESTRAS_MIN} a ${CLONAR_MUESTRAS_MAX} grabaciones.`);
    }
    const muestras: MuestraVoz[] = [];
    for (const [i, archivo] of archivos.entries()) {
      if (!TIPO_AUDIO_RE.test(archivo.type)) throw Errors.validation(`muestras[${i}]: solo se aceptan archivos de audio.`);
      const bytes = new Uint8Array(await archivo.arrayBuffer());
      if (bytes.byteLength < MUESTRA_MIN_BYTES) throw Errors.validation(`muestras[${i}]: la grabación está vacía o es demasiado corta.`);
      muestras.push({ nombre: nombreArchivoSeguro(archivo.name, i), tipo: archivo.type.split(";")[0]!.toLowerCase(), bytes });
    }
    const bytesTotales = muestras.reduce((s, m) => s + m.bytes.byteLength, 0);

    // 3) Proveedor. El tope cuenta solo intentos validos (un formulario mal armado no gasta el cupo de la hora).
    const agotado = await consumirTopesEnSesionDeSistema(deps, [{ scope: "voz-clonar", actor: requestActor(c.req.raw, actorUserId), maxRequests: 5, windowSeconds: 3600 }]);
    if (agotado !== null) throw Errors.tooManyRequests("Demasiadas clonaciones seguidas. Intenta de nuevo en una hora.");
    let voiceId: string;
    try {
      ({ voiceId } = await clonador.clonar({ nombre, muestras, quitarRuido, etiquetas: { atiende_org: organizationId, atiende_sucursal: propertyId } }));
    } catch (err) {
      if (err instanceof ClonacionVozError) {
        logEvent(c, "warn", "restaurantes_admin_voz_clonar_proveedor_fallo", { organizationId, propertyId, tipo: err.tipo, estado: err.estado });
        if (err.tipo === "rechazo") throw Errors.validation("El proveedor no aceptó las muestras: graba al menos 20 segundos por clip, en un lugar sin ruido y con una sola persona hablando.");
        throw Errors.serviceUnavailable("El proveedor de voz no pudo clonar la voz. Reintenta en unos minutos.");
      }
      throw err;
    }

    // 4) Guardado (misma transaccion de la peticion). Si falla, se compensa borrando la voz recien creada.
    try {
      const ok = await repo.setVozTelefono(organizationId, propertyId, voiceId);
      if (!ok) throw Errors.conflict("Guarda primero la configuración de voz de esta sucursal y después clona la voz.");
    } catch (err) {
      await clonador.borrar(voiceId);
      if (err instanceof VozNoDisponibleError) throw Errors.serviceUnavailable("La voz telefónica no está disponible aún: requiere la migración 103.");
      if (err instanceof VozRechazadaError) throw Errors.forbidden(err.message);
      throw err;
    }

    logEvent(c, "info", "restaurantes_admin_voz_clonada", { actorUserId, organizationId, propertyId, muestras: muestras.length, bytesTotales });
    await deps.restaurantesRepo(c.get("db")).registrarAuditoria({
      organizationId,
      actorUserId,
      action: "configuracion.voz_clonada",
      entityType: "configuracion",
      entityId: propertyId,
      campo: "vozTelefono",
      antes: anterior.valor,
      despues: JSON.stringify({ vozTelefono: voiceId, muestras: muestras.length, bytesTotales, quitarRuido, consentimiento: true }),
    });
    return c.json({ vozTelefono: voiceId, vozTelefonoClonada: true, nombre }, 201);
  });

  return app;
}
