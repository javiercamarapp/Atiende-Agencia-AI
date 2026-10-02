// Rn-24 / Rn-25 -- automatizaciones de mensajes al huesped por evento (pre_llegada, check_in,
// check_out, resena). Cada evento se programa por propiedad: plantilla APROBADA por el tenant +
// offset en horas respecto al ancla (check-in o check-out) + activo.
//
//   GET /rentas/:propertyId/mensajes-automaticos           cualquier staff con acceso a la propiedad
//   PUT /rentas/:propertyId/mensajes-automaticos/:evento   solo admin_gestora (MENSAJERIA_PLANTILLA_APROBACION_ROLES)
// Cron (guard de secreto interno/Vercel Cron, igual que checkin-recordatorio.ts):
//   GET|POST /internal/rentas/mensajes-automaticos   cada hora (vercel.json)
//
// El cron NUNCA envia: deja un BORRADOR pendiente_aprobacion en la cola de aprobacion humana
// existente (mensajeria-borradores.ts) y avisa con `rentas.aprobacion.pendiente` (catalogo
// compartido de notificaciones). El envio real depende de un canal conectado (Rn-16/Rn-28): sin el,
// el borrador queda pendiente y aprobarlo responde 503 honesto.
//
// Compatibilidad con la base sin migrar (migracion rentas 029 pendiente): GET responde
// `disponible: false` con los eventos por defecto y PUT 409 "aun no disponible"; el cron responde ok
// con `disponible: false` -- nunca un 500.
import { Hono } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { emitirNotificacion } from "@atiende/db";
import {
  ANCLA_EVENTO,
  EVENTOS_AUTOMATICOS,
  MENSAJERIA_PLANTILLA_APROBACION_ROLES,
  OFFSET_HORAS_MAX,
  OFFSET_HORAS_MIN,
  OFFSET_HORAS_SUGERIDO,
  PlantillaNoAprobadaError,
  PostgresRentasMensajesAutomaticosRepository,
  VARIABLES_PLANTILLA,
  VENTANA_GRACIA_HORAS,
  ejecutarMensajesAutomaticos,
  esEventoAutomatico,
  exigirPlantillaAprobadaParaProgramar,
  variablesNoSoportadas,
} from "@atiende/domain-rentas";
import type { EventoAutomatico, PlantillaRecord, ProgramacionMensaje, RentasMensajesAutomaticosRepository } from "@atiende/domain-rentas";
import { Errors } from "../../../errors.ts";
import { internalOrCronSecretMatches, readJsonCapped } from "../../../http-security.ts";
import { logEvent } from "../../../logger.ts";
import { CronPartialFailureError, withHeartbeat } from "../../../salud/with-heartbeat.ts";
import type { AppDeps } from "../../../deps.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface GuardarProgramacionBody {
  readonly activo?: unknown;
  readonly offsetHoras?: unknown;
  readonly plantillaId?: unknown;
}

function programacionAJson(p: ProgramacionMensaje) {
  return { evento: p.evento, programada: true, activo: p.activo, offsetHoras: p.offsetHoras, plantillaId: p.plantillaId, actualizadoEn: p.actualizadoEn };
}

export function rentasMensajesAutomaticosRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  const repoDe = (db: Parameters<AppDeps["rentasRepo"]>[0]): RentasMensajesAutomaticosRepository => (deps.rentasMensajesAutomaticosRepo ? deps.rentasMensajesAutomaticosRepo(db) : new PostgresRentasMensajesAutomaticosRepository(db));

  const base = "/rentas/:propertyId/mensajes-automaticos";
  app.use(base, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  app.use(`${base}/:evento`, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  app.get(base, async (c) => {
    const propertyId = c.req.param("propertyId");
    const resultado = await repoDe(c.get("db")).listarProgramaciones(propertyId);
    const guardadas = new Map<EventoAutomatico, ProgramacionMensaje>(resultado.disponible ? resultado.valor.map((p) => [p.evento, p]) : []);
    const eventos = EVENTOS_AUTOMATICOS.map((evento) => {
      const guardada = guardadas.get(evento);
      return guardada
        ? { ...programacionAJson(guardada), ancla: ANCLA_EVENTO[evento], offsetSugerido: OFFSET_HORAS_SUGERIDO[evento] }
        : { evento, programada: false, activo: false, offsetHoras: OFFSET_HORAS_SUGERIDO[evento], plantillaId: null, actualizadoEn: null, ancla: ANCLA_EVENTO[evento], offsetSugerido: OFFSET_HORAS_SUGERIDO[evento] };
    });
    return c.json({ disponible: resultado.disponible, eventos, variables: VARIABLES_PLANTILLA, ventanaGraciaHoras: VENTANA_GRACIA_HORAS, offsetMin: OFFSET_HORAS_MIN, offsetMax: OFFSET_HORAS_MAX }, 200);
  });

  app.put(`${base}/:evento`, async (c) => {
    assertVerticalRole(c, MENSAJERIA_PLANTILLA_APROBACION_ROLES);
    const propertyId = c.req.param("propertyId");
    const evento = c.req.param("evento");
    if (!esEventoAutomatico(evento)) throw Errors.validation(`evento: se esperaba uno de ${EVENTOS_AUTOMATICOS.join(", ")}.`);

    const raw = await readJsonCapped<GuardarProgramacionBody>(c.req.raw, 2 * 1024);
    if (typeof raw.activo !== "boolean") throw Errors.validation("activo: se esperaba boolean.");
    if (typeof raw.offsetHoras !== "number" || !Number.isInteger(raw.offsetHoras) || raw.offsetHoras < OFFSET_HORAS_MIN || raw.offsetHoras > OFFSET_HORAS_MAX) {
      throw Errors.validation(`offsetHoras: se esperaba un entero entre ${OFFSET_HORAS_MIN} y ${OFFSET_HORAS_MAX}.`);
    }
    if (typeof raw.plantillaId !== "string" || !UUID_RE.test(raw.plantillaId)) throw Errors.validation("plantillaId: se esperaba un UUID.");

    const organizationId = c.get("organizationId");
    const db = c.get("db");
    // La plantilla se busca SIEMPRE dentro de la organizacion de la sesion: la de otro tenant es 404.
    const plantilla: PlantillaRecord | null = await deps.rentasMensajeriaRepo(db).findPlantilla(organizationId, raw.plantillaId);
    if (!plantilla) throw Errors.notFound("Plantilla no encontrada en esta organización.");
    if (plantilla.evento !== evento) throw Errors.validation(`plantillaId: la plantilla es del evento "${plantilla.evento}", no de "${evento}".`);
    if (raw.activo) {
      // H-056: solo se programan plantillas aprobadas por el tenant (y activas); el cron lo revalida.
      try {
        exigirPlantillaAprobadaParaProgramar({ id: plantilla.id, evento: plantilla.evento, idioma: plantilla.idioma, canal: plantilla.canal, cuerpo: plantilla.cuerpo, aprobadaPorTenant: plantilla.aprobadaPorTenant, activa: plantilla.activa });
      } catch (err) {
        if (err instanceof PlantillaNoAprobadaError) throw Errors.rentasMensajeAprobacionRequerida("La plantilla debe estar aprobada y activa antes de activar el envío automático.");
        throw err;
      }
      const desconocidas = variablesNoSoportadas(plantilla.cuerpo);
      if (desconocidas.length > 0) throw Errors.validation(`La plantilla usa variables que el sistema no sabe llenar: ${desconocidas.join(", ")}.`);
    }

    const guardado = await repoDe(db).guardarProgramacion({ organizationId, propertyId, evento, plantillaId: plantilla.id, offsetHoras: raw.offsetHoras, activo: raw.activo, actorId: c.get("userId") });
    if (!guardado.disponible) throw Errors.conflict("Los mensajes automáticos aún no están disponibles en esta base de datos (falta aplicar la migración 029 de rentas).");
    logEvent(c, "info", "rentas_mensaje_automatico_programado", { propertyId, evento, activo: raw.activo, offsetHoras: raw.offsetHoras, plantillaId: plantilla.id });
    return c.json(programacionAJson(guardado.valor), 200);
  });

  // ---- Cron ----
  app.on(["GET", "POST"], "/internal/rentas/mensajes-automaticos", async (c) => {
    if (!internalOrCronSecretMatches(c.req.raw, deps.env.internalSecret)) throw Errors.unauthorized();

    return withHeartbeat(deps, "/internal/rentas/mensajes-automaticos", async () => {
      // Una transaccion POR RESERVA (ver @atiende/domain-rentas::ejecutarMensajesAutomaticos): el borrador, la
      // marca de idempotencia y el aviso in-app comparten la misma transaccion.
      const resumen = await ejecutarMensajesAutomaticos((fn) =>
        deps.engine.withAppSession({ userId: null }, (db) =>
          fn({
            repo: repoDe(db),
            // Aviso in-app (campana) reutilizando el evento del catalogo compartido; uno por borrador (clave = id), sin PII.
            // emitirNotificacion corre en su propio SAVEPOINT: contra la base sin migrar no aborta la transaccion.
            alCrearBorrador: async (b) => {
              await emitirNotificacion(db, { evento: "rentas.aprobacion.pendiente", organizationId: b.organizationId, propertyId: b.propertyId, clave: b.borradorId, entidadTipo: "borrador_mensaje", entidadId: b.borradorId });
            },
          }),
        ),
      );
      const response = c.json(
        {
          ok: resumen.errores === 0,
          disponible: resumen.disponible,
          candidatas: resumen.candidatas,
          borradores_creados: resumen.borradoresCreados,
          omitidas_variable_faltante: resumen.omitidasVariableFaltante,
          ya_procesadas: resumen.yaProcesadas,
          fuera_de_ventana: resumen.fueraDeVentana,
          errores: resumen.errores,
          truncada: resumen.truncada,
        },
        200,
      );
      if (resumen.errores > 0) throw new CronPartialFailureError(`mensajes-automaticos: ${resumen.errores} reserva(s) fallaron`, response);
      return response;
    })();
  });

  return app;
}
