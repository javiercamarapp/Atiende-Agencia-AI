// H-P3-03 (paridad3) -- el huesped se entera de todo el viaje sin que nadie escriba a mano: avisos de la pre-reserva (aprobada, rechazada,
// confirmada, vencida), reserva confirmada, pre-llegada, post-estancia y oferta de lista de espera. Cada evento sale por WhatsApp con la
// plantilla HSM aprobada del catalogo de la organizacion (PL-31) o, dentro de las 24 h de Meta, como texto libre; si no se puede, por
// correo; si tampoco hay correo, queda "no enviado" con su motivo a la vista del staff.
//
//   GET    /hoteles/:propertyId/mensajes-huesped                         config de los 8 eventos + canal + plantillas   (owner, gm, frontdesk, reservations, accountant)
//   PUT    /hoteles/:propertyId/mensajes-huesped/:evento                 activar/apagar, horas de pre-llegada, enlace de resena   (owner, gm)
//   PUT    /hoteles/:propertyId/mensajes-huesped/:evento/plantilla       registrar la plantilla HSM del evento en el catalogo   (owner, gm; la RLS exige owner/admin de la organizacion)
//   DELETE /hoteles/:propertyId/mensajes-huesped/:evento/plantilla       quitarla del catalogo
//   GET    /hoteles/:propertyId/mensajes-huesped/historial               ultimos envios con el estado real del outbox
//   GET|POST /internal/hoteles/mensajes-huesped                          cron (cada 15 min): barre TODAS las propiedades
//
// El cron y el disparo inmediato tras una decision del staff (`programarMensajesHuesped`, en postCommitTasks: DESPUES del commit, en sesion
// de sistema) comparten el mismo ejecutor idempotente (@atiende/domain-hoteles::ejecutarMensajesHuesped): una referencia recibe a lo mucho
// UN mensaje por evento aunque corran los dos. El envio real lo hacen los despachadores existentes (WhatsApp y Resend), que aplican ademas
// la supresion de plataforma (BAJA/STOP) y la cuota del plan.
//
// REGLA DURA DE COMPATIBILIDAD: contra la base sin la migracion 046 las lecturas responden `disponible: false` (estado honesto), las
// escrituras 503 y el cron `disponible: false` sin tocar nada -- nunca un 500 ni un flujo vigente roto.
import type { Context } from "hono";
import { Hono } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { emitirNotificacion } from "@atiende/db";
import {
  EVENTOS_PLANTILLA_HOTELES,
  HORAS_ANTES_MAX,
  HORAS_ANTES_MIN,
  HORAS_ANTES_POR_OMISION,
  HORA_POST_ESTANCIA,
  MENSAJES_HUESPED_CONFIG_ROLES,
  MENSAJES_HUESPED_VER_ROLES,
  MOTIVO_TEXTO,
  MensajesHuespedAccessDeniedError,
  MensajesHuespedUnavailableError,
  PLANTILLA_ESTADOS,
  PostgresMensajeriaConfigRepository,
  PostgresMensajesHuespedStaffRepository,
  PostgresMensajesHuespedSistemaRepository,
  VENTANA_GRACIA_HORAS,
  ejecutarMensajesHuesped,
  esEventoMensajeHuesped,
  esEventoTransaccional,
  eventoPlantillaHoteles,
  validarConfigEvento,
  validarPlantillaWhatsapp,
  type EventoMensajeHuesped,
  type MensajeriaConfigRepository,
  type MensajesHuespedSistemaRepository,
  type MensajesHuespedStaffRepository,
  type ResumenMensajesHuesped,
} from "@atiende/domain-hoteles";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { Errors } from "../../../errors.ts";
import { internalOrCronSecretMatches, readJsonCapped } from "../../../http-security.ts";
import { logEvent } from "../../../logger.ts";
import { CronPartialFailureError, withHeartbeat } from "../../../salud/with-heartbeat.ts";
import { crearGuardSupresion } from "../../../supresion/index.ts";
import { dispatchWhatsAppVertical } from "../../internal/whatsapp-dispatch.ts";
import { INLINE_BATCH_SIZE, runHotelesEmailDispatch } from "./email-dispatch.ts";
import type { AppDeps } from "../../../deps.ts";

export const MENSAJES_HUESPED_CRON_PATH = "/internal/hoteles/mensajes-huesped";
const BODY_MAX_BYTES = 4 * 1024;
const HISTORIAL_LIMITE_DEFAULT = 50;
const HISTORIAL_LIMITE_MAX = 200;
const WHATSAPP_INLINE_LIMIT = 5;

const sistemaRepoDe = (deps: AppDeps, db: TenantDbSession): MensajesHuespedSistemaRepository => (deps.hotelesMensajesHuespedRepo ? deps.hotelesMensajesHuespedRepo(db) : new PostgresMensajesHuespedSistemaRepository(db));
const staffRepoDe = (deps: AppDeps, db: TenantDbSession): MensajesHuespedStaffRepository => (deps.hotelesMensajesHuespedRepo ? deps.hotelesMensajesHuespedRepo(db) : new PostgresMensajesHuespedStaffRepository(db));

export interface CorridaMensajesHuespedOpciones {
  readonly propertyId?: string;
  readonly refId?: string;
  readonly ahora?: Date;
}

/**
 * Corrida real del ejecutor: una transaccion de SISTEMA por candidato. Tambien la usa el disparo inmediato tras una decision del staff
 * (acotada a la propiedad y a la referencia). Los avisos in-app de "no se pudo enviar" van aparte, uno por propiedad y dia.
 */
export async function runHotelesMensajesHuesped(deps: AppDeps, o: CorridaMensajesHuespedOpciones = {}): Promise<ResumenMensajesHuesped> {
  const ahora = o.ahora ?? new Date();
  return ejecutarMensajesHuesped(
    (fn) => deps.engine.withAppSession({ userId: null }, (db) => fn({ repo: sistemaRepoDe(deps, db), esSuprimido: crearGuardSupresion(db) })),
    {
      ahora,
      ...(o.propertyId ? { propertyId: o.propertyId } : {}),
      ...(o.refId ? { refId: o.refId } : {}),
      appBaseUrl: deps.env.appBaseUrl,
      credencialMeta: Boolean(deps.env.whatsappAccessToken),
      // Aviso in-app (campana) a gerencia/recepcion cuando hay mensajes que NO pudieron salir (sin contacto, sin plantilla, BAJA...):
      // una por propiedad por dia, sin PII. emitirNotificacion corre en su propio SAVEPOINT.
      alNoEnviados: async (propiedades) => {
        for (const p of propiedades) {
          await deps.engine.withAppSession({ userId: null }, (db) =>
            emitirNotificacion(db, {
              evento: "hoteles.mensaje_huesped.no_enviado",
              organizationId: p.organizationId,
              propertyId: p.propertyId,
              clave: `${p.propertyId}:${ahora.toISOString().slice(0, 10)}`,
              parametros: { cantidad: p.cantidad },
            }),
          );
        }
      },
    },
  );
}

/**
 * Dispara el ejecutor DESPUES del commit de la peticion de staff que cambio el estado (decision de un hold, oferta de lista de espera...):
 * recien entonces una sesion de sistema nueva ve ese cambio. Acotado a la propiedad (y a la referencia, si se conoce). Best-effort: un fallo
 * jamas afecta la respuesta ya armada y el cron (cada 15 min) lo recoge. Si algo se encolo, intenta ya el drenado de WhatsApp / correo.
 */
export function programarMensajesHuesped(deps: AppDeps, c: Context<CoreAuthHonoEnv>, o: { readonly propertyId: string; readonly refId?: string }): void {
  programarMensajesHuespedEn(deps, c.get("postCommitTasks"), o);
}

export function programarMensajesHuespedEn(deps: AppDeps, tareas: Array<() => Promise<void>>, o: { readonly propertyId: string; readonly refId?: string }): void {
  tareas.push(async () => {
    const resumen = await runHotelesMensajesHuesped(deps, o);
    if (resumen.porWhatsapp > 0) await dispatchWhatsAppVertical(deps, "hoteles", WHATSAPP_INLINE_LIMIT);
    if (resumen.porCorreo > 0) await runHotelesEmailDispatch(deps, INLINE_BATCH_SIZE);
  });
}

function toApiError(err: unknown): unknown {
  if (err instanceof MensajesHuespedUnavailableError) return Errors.serviceUnavailable(err.message);
  if (err instanceof MensajesHuespedAccessDeniedError) return Errors.forbidden();
  return err;
}

async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw toApiError(err);
  }
}

function eventoDelParametro(valor: string | undefined): EventoMensajeHuesped {
  if (!valor || !esEventoMensajeHuesped(valor)) throw Errors.notFound("Ese evento no existe.");
  return valor;
}

export function hotelesMensajesHuespedRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  const base = "/hoteles/:propertyId/mensajes-huesped";
  for (const path of [base, `${base}/historial`, `${base}/:evento`, `${base}/:evento/plantilla`]) {
    app.use(path, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  }

  const mensajeriaRepoDe = (db: TenantDbSession): MensajeriaConfigRepository => (deps.hotelesMensajeriaConfigRepo ? deps.hotelesMensajeriaConfigRepo(db) : new PostgresMensajeriaConfigRepository(db));

  app.get(base, async (c) => {
    assertVerticalRole(c, MENSAJES_HUESPED_VER_ROLES);
    const propertyId = c.req.param("propertyId");
    const organizationId = c.get("organizationId");
    const db = c.get("db");
    const repo = staffRepoDe(deps, db);
    // En SECUENCIA: cada lectura abre un SAVEPOINT sobre la misma transaccion del request; en paralelo el RELEASE del primero destruye el segundo.
    const config = await guarded(() => repo.listarConfig(propertyId));
    const catalogo = await guarded(() => repo.listarPlantillas(organizationId));
    const canal = await mensajeriaRepoDe(db).getWhatsAppChannel(propertyId);
    const credencialMeta = Boolean(deps.env.whatsappAccessToken);
    const canalListo = canal.configurado && canal.enabled && credencialMeta;
    const porEvento = new Map(config.disponible ? config.valor.map((x) => [x.evento, x]) : []);
    const plantillas = new Map(catalogo.disponible ? catalogo.valor.map((x) => [x.evento, x]) : []);
    const puedeAdministrar = (MENSAJES_HUESPED_CONFIG_ROLES as readonly string[]).includes(c.get("verticalRole") ?? "");

    return c.json({
      disponible: config.disponible,
      // El catalogo de plantillas (core.whatsapp_plantilla) solo lo ve owner/admin de la organizacion (RLS): para otros roles la lista llega vacia.
      catalogoDisponible: catalogo.disponible,
      puedeConfigurar: puedeAdministrar,
      whatsapp: {
        canalConfigurado: canal.configurado,
        canalHabilitado: canal.enabled,
        credencialMeta,
        listo: canalListo,
        // Estado honesto cuando no hay con que mandar por WhatsApp: se envia por correo.
        aviso: canalListo ? null : !credencialMeta ? "requiere credencial de WhatsApp (Meta); se enviará por correo" : "el canal de WhatsApp del hotel no está activo; se enviará por correo",
      },
      ventanaGraciaHoras: VENTANA_GRACIA_HORAS,
      horasAntesPorOmision: HORAS_ANTES_POR_OMISION,
      horasAntesMin: HORAS_ANTES_MIN,
      horasAntesMax: HORAS_ANTES_MAX,
      horaPostEstancia: HORA_POST_ESTANCIA,
      estadosPlantilla: PLANTILLA_ESTADOS,
      eventos: EVENTOS_PLANTILLA_HOTELES.map((def) => {
        const cfg = porEvento.get(def.evento);
        const p = plantillas.get(def.evento);
        return {
          evento: def.evento,
          etiqueta: def.etiqueta,
          transaccional: esEventoTransaccional(def.evento),
          variables: def.variables,
          activo: cfg?.activo ?? (def.evento !== "pre_llegada" && def.evento !== "post_estancia"),
          horasAntes: cfg?.horasAntes ?? null,
          resenaUrl: cfg?.resenaUrl ?? null,
          configurada: cfg?.configurada ?? false,
          actualizadoEn: cfg?.actualizadoEn ?? null,
          plantilla: p ? { nombre: p.nombre, idioma: p.idioma, variables: p.variables, estado: p.estado, aprobadaEn: p.aprobadaEn, actualizadaEn: p.actualizadaEn } : null,
        };
      }),
    });
  });

  app.put(`${base}/:evento`, async (c) => {
    assertVerticalRole(c, MENSAJES_HUESPED_CONFIG_ROLES);
    const propertyId = c.req.param("propertyId");
    const evento = eventoDelParametro(c.req.param("evento"));
    const raw = await readJsonCapped<unknown>(c.req.raw, BODY_MAX_BYTES);
    const validada = validarConfigEvento(evento, raw);
    if (!validada.ok) throw Errors.validation(validada.error);
    const guardada = await guarded(() => staffRepoDe(deps, c.get("db")).guardarConfig(propertyId, evento, validada.valor));
    logEvent(c, "info", "hoteles_mensaje_huesped_configurado", { propertyId, eventoMensaje: evento, activo: guardada.activo, horasAntes: guardada.horasAntes, conResena: guardada.resenaUrl !== null, actorUserId: c.get("userId") });
    return c.json({ evento: guardada.evento, activo: guardada.activo, horasAntes: guardada.horasAntes, resenaUrl: guardada.resenaUrl, configurada: true, actualizadoEn: guardada.actualizadoEn });
  });

  app.put(`${base}/:evento/plantilla`, async (c) => {
    assertVerticalRole(c, MENSAJES_HUESPED_CONFIG_ROLES);
    const evento = eventoDelParametro(c.req.param("evento"));
    const def = eventoPlantillaHoteles(evento);
    if (!def) throw Errors.notFound("Ese evento no tiene plantilla de WhatsApp.");
    const validada = validarPlantillaWhatsapp(await readJsonCapped<unknown>(c.req.raw, BODY_MAX_BYTES), def);
    if (!validada.ok) throw Errors.validation(validada.error);
    const organizationId = c.get("organizationId");
    const repo = staffRepoDe(deps, c.get("db"));
    const resultado = await guarded(() => repo.guardarPlantilla(organizationId, evento, validada.valor));
    if (resultado === "forbidden") throw Errors.forbidden();
    if (resultado === "unavailable") throw Errors.serviceUnavailable("Las plantillas de WhatsApp todavía no están disponibles en este ambiente (migración pendiente).");
    logEvent(c, "info", "hoteles_mensaje_huesped_plantilla_guardada", { organizationId, eventoMensaje: evento, estado: validada.valor.estado, actorUserId: c.get("userId") });
    const lista = await guarded(() => repo.listarPlantillas(organizationId));
    const p = lista.disponible ? lista.valor.find((x) => x.evento === evento) : undefined;
    return c.json({ evento, plantilla: p ? { nombre: p.nombre, idioma: p.idioma, variables: p.variables, estado: p.estado, aprobadaEn: p.aprobadaEn, actualizadaEn: p.actualizadaEn } : null });
  });

  app.delete(`${base}/:evento/plantilla`, async (c) => {
    assertVerticalRole(c, MENSAJES_HUESPED_CONFIG_ROLES);
    const evento = eventoDelParametro(c.req.param("evento"));
    const organizationId = c.get("organizationId");
    const resultado = await guarded(() => staffRepoDe(deps, c.get("db")).eliminarPlantilla(organizationId, evento));
    if (resultado === "forbidden") throw Errors.forbidden();
    if (resultado === "unavailable") throw Errors.serviceUnavailable("Las plantillas de WhatsApp todavía no están disponibles en este ambiente (migración pendiente).");
    if (resultado === "not_found") throw Errors.notFound("Ese evento no tiene plantilla guardada.");
    logEvent(c, "info", "hoteles_mensaje_huesped_plantilla_eliminada", { organizationId, eventoMensaje: evento, actorUserId: c.get("userId") });
    return c.json({ ok: true });
  });

  app.get(`${base}/historial`, async (c) => {
    assertVerticalRole(c, MENSAJES_HUESPED_VER_ROLES);
    const crudo = c.req.query("limite");
    let limite = HISTORIAL_LIMITE_DEFAULT;
    if (crudo !== undefined) {
      if (!/^\d{1,3}$/u.test(crudo) || Number(crudo) < 1 || Number(crudo) > HISTORIAL_LIMITE_MAX) throw Errors.validation(`limite: entero entre 1 y ${HISTORIAL_LIMITE_MAX}.`);
      limite = Number(crudo);
    }
    const r = await guarded(() => staffRepoDe(deps, c.get("db")).historial(c.req.param("propertyId"), limite));
    return c.json({
      disponible: r.disponible,
      envios: r.disponible
        ? r.valor.map((f) => ({
            id: f.id,
            evento: f.evento,
            etiqueta: eventoPlantillaHoteles(f.evento)?.etiqueta ?? f.evento,
            estado: f.estado,
            canal: f.canal,
            motivo: f.motivo,
            motivoTexto: f.motivo ? MOTIVO_TEXTO[f.motivo] : null,
            // Estado real del outbox: pending, processing, sent, failed, dead (null = no se encolo nada).
            envio: f.envio,
            errorClase: f.errorClase,
            creadoEn: f.creadoEn,
          }))
        : [],
    });
  });

  return app;
}

/**
 * Un ciclo completo: emite los mensajes pendientes de todas las propiedades y drena de inmediato el outbox de WhatsApp / correo.
 * Lo usan la ruta manual de abajo y el cron `holds-vencidos` (cada 15 min): `vercel.json` ya esta en el tope de 40 crons del plan Pro,
 * asi que este barrido NO tiene cron propio sino que se encadena al de las pre-reservas vencidas (que es quien dispara `hold.vencido`).
 */
export async function runCicloMensajesHuesped(deps: AppDeps): Promise<Awaited<ReturnType<typeof runHotelesMensajesHuesped>>> {
  const resumen = await runHotelesMensajesHuesped(deps);
  if (resumen.porWhatsapp > 0) await dispatchWhatsAppVertical(deps, "hoteles", WHATSAPP_INLINE_LIMIT).catch(() => undefined);
  if (resumen.porCorreo > 0) await runHotelesEmailDispatch(deps, INLINE_BATCH_SIZE).catch(() => undefined);
  return resumen;
}

/** Ruta manual (ya no esta en vercel.json): barre todas las propiedades. Sin autenticacion de usuario: secreto interno o de Vercel Cron. */
export function hotelesMensajesHuespedCronRoutes(deps: AppDeps): Hono {
  const app = new Hono();

  app.on(["GET", "POST"], MENSAJES_HUESPED_CRON_PATH, async (c) => {
    if (!internalOrCronSecretMatches(c.req.raw, deps.env.internalSecret)) throw Errors.unauthorized();

    return withHeartbeat(deps, MENSAJES_HUESPED_CRON_PATH, async () => {
      const resumen = await runCicloMensajesHuesped(deps);
      const response = c.json(
        {
          ok: resumen.errores === 0,
          disponible: resumen.disponible,
          candidatos: resumen.candidatos,
          encolados: resumen.encolados,
          por_whatsapp: resumen.porWhatsapp,
          por_correo: resumen.porCorreo,
          no_enviados: resumen.noEnviados,
          diferidos: resumen.diferidos,
          ya_procesados: resumen.yaProcesados,
          errores: resumen.errores,
          truncada: resumen.truncada,
        },
        200,
      );
      if (resumen.errores > 0) throw new CronPartialFailureError(`mensajes-huesped: ${resumen.errores} mensaje(s) fallaron`, response);
      return response;
    })();
  });

  return app;
}
