// PM PR-9 (restaurantes) -- privacidad, lado SISTEMA (sin authMiddleware: el llamador es un servicio o
// el scheduler). Autenticacion: secreto interno (`INTERNAL_SECRET`) comparado en tiempo constante.
//
//   GET|POST /internal/restaurantes/privacidad-retencion
//        purga por retencion de conversaciones de WhatsApp y transcripciones de voz (cron diario en
//        vercel.json, envuelto en `withHeartbeat`). Solo tiene efecto despues de aplicar la migracion 030
//        (sin ella responde `disponible:false` y no toca nada).
//   POST /internal/restaurantes/voz/privacidad/apertura
//        guion de apertura de la llamada (asistente virtual + aviso simplificado + pregunta de
//        grabacion) y registro de la evidencia de entrega del aviso por telefono-hash.
//   POST /internal/restaurantes/voz/conversaciones/:conversationId/consentimiento-grabacion
//        interpreta la respuesta del titular y la registra: si no consiente (o no responde con
//        claridad) la llamada se atiende SIN grabar; negar borra lo ya guardado.
//   POST /internal/restaurantes/voz/arco
//        fast-path ARCO por voz (acceso, rectificacion, cancelacion, oposicion): el telefono sale del
//        identificador de llamada y NUNCA de lo que dicta el titular; la identidad se marca como
//        'llamada_identificador' (puede falsearse: el staff debe verificar por otra via antes de
//        responder).
//
// Cada operacion corre en una sesion de sistema (`userId: null`); las funciones SQL exigen
// `auth.uid() is null`. Contra una base sin migrar todo responde "no disponible" sin abortar la
// transaccion (SAVEPOINT en el repositorio) ni lanzar 500.
import { createHash } from "node:crypto";
import { Hono } from "hono";
import {
  VOICE_CONSENT_DENIED_REPLY,
  VOICE_CONSENT_GRANTED_REPLY,
  VOICE_CONSENT_REPEAT_REPLY,
  interpretRecordingConsent,
  runArcoFastPath,
  voiceOpeningScript,
} from "@atiende/domain-restaurantes";
import { Errors } from "../../../errors.ts";
import { readJsonCapped, internalOrCronSecretMatches, secretMatches } from "../../../http-security.ts";
import { withHeartbeat } from "../../../salud/with-heartbeat.ts";
import type { AppDeps } from "../../../deps.ts";
import { UUID_RE } from "./voz-admin.ts";

const PURGE_BATCH = 500;
const PURGE_MAX_BATCHES = 10;

function exigirSecreto(deps: AppDeps, req: Request): void {
  if (!secretMatches(req, "x-atiende-internal-secret", deps.env.internalSecret)) throw Errors.unauthorized();
}

function uuid(value: unknown, campo: string): string {
  if (typeof value !== "string" || !UUID_RE.test(value)) throw Errors.validation(`${campo}: se esperaba un UUID.`);
  return value;
}

/** Telefono del identificador de llamada -> "+<digitos>" (7 a 15 digitos). */
function telefonoDeLlamada(value: unknown): string {
  const digitos = typeof value === "string" ? value.replace(/\D/g, "") : "";
  if (digitos.length < 7 || digitos.length > 15) throw Errors.validation("callerPhone: se esperaba un teléfono de 7 a 15 dígitos.");
  return `+${digitos}`;
}

export function restaurantesPrivacidadInternoRoutes(deps: AppDeps): Hono {
  const app = new Hono();

  function repoDe(db: Parameters<NonNullable<AppDeps["privacidadRepo"]>>[0]) {
    if (!deps.privacidadRepo) throw Errors.serviceUnavailable("La privacidad no está disponible en este despliegue.");
    return deps.privacidadRepo(db);
  }

  app.on(["GET", "POST"], "/internal/restaurantes/privacidad-retencion", async (c) => {
    if (!internalOrCronSecretMatches(c.req.raw, deps.env.internalSecret)) throw Errors.unauthorized();
    return withHeartbeat(deps, "/internal/restaurantes/privacidad-retencion", async () => {
      let disponible = true;
      let conversaciones = 0;
      let turnosVoz = 0;
      let llamadasAnonimizadas = 0;
      let pedidosConVozLimpiados = 0;
      let payloadsOutboxBorrados = 0;
      let avisosStaffBorrados = 0;
      let lotes = 0;
      // Una transaccion POR lote: un lote con datos raros no revierte los ya purgados.
      for (let i = 0; i < PURGE_MAX_BATCHES; i++) {
        const outcome = await deps.engine.withAppSession({ userId: null }, (db) => repoDe(db).purgeExpiredPrivacyData(PURGE_BATCH));
        lotes += 1;
        if (!outcome.disponible) {
          disponible = false;
          break;
        }
        conversaciones += outcome.conversationsCleared;
        turnosVoz += outcome.voiceTurnsDeleted;
        llamadasAnonimizadas += outcome.voiceCallsAnonymized;
        pedidosConVozLimpiados += outcome.ordersVoiceCleared ?? 0;
        payloadsOutboxBorrados += outcome.outboxPayloadsErased ?? 0;
        avisosStaffBorrados += outcome.staffNotificationsErased ?? 0;
        // El lote se acota por tabla: si ninguna lleno su tope, ya no queda nada vencido. Desde la 042
        // `voiceCallsAnonymized` cuenta las llamadas procesadas (con o sin caller_hash): QA-restaurantes-R1-automatizacion-04.
        const llenoElLote = [outcome.conversationsCleared, outcome.voiceCallsAnonymized, outcome.ordersVoiceCleared ?? 0, outcome.outboxPayloadsErased ?? 0, outcome.staffNotificationsErased ?? 0].some((n) => n >= PURGE_BATCH);
        if (!llenoElLote) break;
      }
      return c.json({ ok: true, disponible, lotes, conversacionesVaciadas: conversaciones, turnosDeVozBorrados: turnosVoz, llamadasAnonimizadas, pedidosConVozLimpiados, payloadsOutboxBorrados, avisosStaffBorrados });
    })();
  });

  app.post("/internal/restaurantes/voz/privacidad/apertura", async (c) => {
    exigirSecreto(deps, c.req.raw);
    const body = await readJsonCapped<Record<string, unknown>>(c.req.raw, 4 * 1024);
    const organizationId = uuid(body.organizationId, "organizationId");
    const callerPhone = body.callerPhone === undefined || body.callerPhone === null ? null : telefonoDeLlamada(body.callerPhone);

    return deps.engine.withAppSession({ userId: null }, async (db) => {
      const repo = repoDe(db);
      const config = await repo.getPrivacyConfig(organizationId);
      let avisoEntregadoAhora: boolean | null = null;
      if (callerPhone) {
        const phoneHash = createHash("sha256").update(callerPhone.replace(/\D/g, "")).digest("hex");
        avisoEntregadoAhora = await repo.claimPrivacyNotice(organizationId, phoneHash, "voice", config.noticeVersion);
      }
      return c.json({
        guion: voiceOpeningScript(config),
        pideConsentimientoGrabacion: config.voiceRetentionDays > 0 && config.recordingConsentRequired,
        retencionVozDias: config.voiceRetentionDays,
        avisoVersion: config.noticeVersion,
        avisoEntregadoAhora,
        configurada: config.configurada,
      });
    });
  });

  app.post("/internal/restaurantes/voz/conversaciones/:conversationId/consentimiento-grabacion", async (c) => {
    exigirSecreto(deps, c.req.raw);
    const conversationId = uuid(c.req.param("conversationId"), "conversationId");
    const body = await readJsonCapped<Record<string, unknown>>(c.req.raw, 4 * 1024);
    const organizationId = uuid(body.organizationId, "organizationId");
    if (typeof body.respuesta !== "string" || body.respuesta.length > 500) throw Errors.validation("respuesta: se esperaba el texto de la respuesta del titular (máximo 500 caracteres).");

    const interpretado = interpretRecordingConsent(body.respuesta);
    // Ambiguo: no se cambia nada (la llamada sigue 'pendiente', o sea sin grabar) y se repite la pregunta.
    if (!interpretado) return c.json({ consentimiento: "pendiente", grabando: false, respuestaSugerida: VOICE_CONSENT_REPEAT_REPLY });

    return deps.engine.withAppSession({ userId: null }, async (db) => {
      const result = await repoDe(db).setVoiceRecordingConsent(organizationId, conversationId, interpretado);
      if (result.outcome === "rejected") throw Errors.notFound("La conversación no existe para esa organización o ya no admite cambios.");
      if (result.outcome === "unavailable") {
        // Base sin migrar: no hay donde registrar el consentimiento ni transcripcion que borrar.
        return c.json({ consentimiento: "no_disponible", grabando: false, respuestaSugerida: interpretado === "negado" ? VOICE_CONSENT_DENIED_REPLY : VOICE_CONSENT_GRANTED_REPLY });
      }
      return c.json({
        consentimiento: result.consent,
        grabando: result.consent === "otorgado",
        respuestaSugerida: result.consent === "otorgado" ? VOICE_CONSENT_GRANTED_REPLY : VOICE_CONSENT_DENIED_REPLY,
      });
    });
  });

  app.post("/internal/restaurantes/voz/arco", async (c) => {
    exigirSecreto(deps, c.req.raw);
    const body = await readJsonCapped<Record<string, unknown>>(c.req.raw, 8 * 1024);
    const organizationId = uuid(body.organizationId, "organizationId");
    const callerPhone = telefonoDeLlamada(body.callerPhone);
    if (typeof body.texto !== "string" || body.texto.length > 2000) throw Errors.validation("texto: se esperaba lo que dijo el titular (máximo 2000 caracteres).");

    return deps.engine.withAppSession({ userId: null }, async (db) => {
      const result = await runArcoFastPath(repoDe(db), organizationId, callerPhone, body.texto as string, "voice");
      if (!result) return c.json({ atendido: false });
      return c.json({ atendido: true, respuesta: result.reply });
    });
  });

  return app;
}
