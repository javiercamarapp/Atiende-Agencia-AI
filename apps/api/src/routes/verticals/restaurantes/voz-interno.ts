// Backend propio de voz de restaurantes (migración 025), lado SISTEMA: el registrador de
// conversaciones/turnos que escribirá el servicio de voz futuro (otra tarea) y la consumición del
// token de preview. Sin `authMiddleware`: el llamador es un servicio, no un staff. Autenticación:
// el secreto interno ya existente (`INTERNAL_SECRET`, header `x-atiende-internal-secret`),
// comparado en tiempo constante; sin header o con uno distinto: 401.
//
//   POST /internal/restaurantes/voz/conversaciones                 inicia (idempotente por externalId)
//   POST /internal/restaurantes/voz/conversaciones/:id/turnos      registra un turno (idempotente por seq)
//   POST /internal/restaurantes/voz/conversaciones/:id/cerrar      cierra (la base calcula duración/costo/p95)
//   POST /internal/restaurantes/voz/previews/consumir              verifica el token HMAC y lo consume UNA vez
//   POST /internal/restaurantes/voz/eventos                        reporta llamada a herramienta (latencia) o error de proveedor (R-13, migración 035)
//
// Cada operación corre en una sesión de sistema (`userId: null`): las funciones SQL exigen
// `auth.uid() is null` y validan que sucursal/conversación/pedido pertenezcan a la organización
// declarada. La transcripción se redacta (tarjeta/CVV) ANTES de persistir y el teléfono nunca se
// guarda en claro: solo su sha256.
import { createHash } from "node:crypto";
import { Hono } from "hono";
import { emitirNotificacion, runWithSavepointFallback } from "@atiende/db";
import {
  VOZ_EVENTO_TIPOS,
  VOZ_PROVEEDORES,
  VOZ_PROVEEDORES_FALLO,
  VOZ_RESULTADOS,
  VOZ_ROLES_TURNO,
  VOZ_TURNO_TEXTO_MAX,
  VozNoDisponibleError,
  VozRechazadaError,
  redactarTranscripcion,
  verificarPreviewToken,
} from "@atiende/domain-restaurantes";
import type { VozCanal, VozEventoTipo, VozProveedorFallo, VozProveedorId, VozRepository, VozResultado, VozRolTurno } from "@atiende/domain-restaurantes";
import { Errors } from "../../../errors.ts";
import { readJsonCapped, secretMatches } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";
import { UUID_RE } from "./voz-admin.ts";

const MAX_COSTO_MICRO_USD = 1_000_000_000; // 1000 USD por turno: tope de cordura, no un límite de negocio.
const MAX_DURACION_MS = 6 * 60 * 60 * 1000;

function exigirSecreto(deps: AppDeps, req: Request): void {
  if (!secretMatches(req, "x-atiende-internal-secret", deps.env.internalSecret)) throw Errors.unauthorized();
}

function uuid(value: unknown, campo: string): string {
  if (typeof value !== "string" || !UUID_RE.test(value)) throw Errors.validation(`${campo}: se esperaba un UUID.`);
  return value;
}

function enteroOpcional(value: unknown, campo: string, max: number): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > max) throw Errors.validation(`${campo}: se esperaba un entero entre 0 y ${max}.`);
  return value;
}

function fechaOpcional(value: unknown, campo: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) throw Errors.validation(`${campo}: se esperaba una fecha ISO 8601.`);
  return new Date(value).toISOString();
}

function mapErrorDeVoz(err: unknown): never {
  if (err instanceof VozNoDisponibleError) throw Errors.serviceUnavailable(err.message);
  if (err instanceof VozRechazadaError) throw Errors.notFound("El recurso no existe para esa organización o ya no admite cambios.");
  throw err;
}

/** CHECK que una base con la 035 pero SIN la 067 viola al recibir 'latencia_voz': la lista de tipos (`voice_event_tipo_check`) o la regla de campos por
 *  tipo autogenerada (`voice_event_check`, `voice_event_check1`...). Cualquier OTRO CHECK (p. ej. el rango de latencia_ms) es un error real y NO se enmascara. */
const CHECK_TIPO_SIN_MIGRAR = /\bvoice_event_(tipo_check|check\d*)\b/;

function esLatenciaSinMigrar(err: unknown): boolean {
  if (err instanceof VozNoDisponibleError) return true;
  const e = err as { code?: unknown; constraint?: unknown; message?: unknown } | null;
  const code = String(e?.code ?? "");
  if (["42703", "42883", "42P01"].includes(code)) return true;
  if (code !== "23514") return false;
  return CHECK_TIPO_SIN_MIGRAR.test(`${String(e?.constraint ?? "")} ${String(e?.message ?? "")}`);
}

export function restaurantesVozInternoRoutes(deps: AppDeps): Hono {
  const app = new Hono();
  const base = "/internal/restaurantes/voz";

  function repoDe(db: Parameters<NonNullable<AppDeps["vozRepo"]>>[0]): VozRepository {
    if (!deps.vozRepo) throw Errors.serviceUnavailable("La voz no está disponible en este despliegue.");
    return deps.vozRepo(db);
  }

  app.post(`${base}/conversaciones`, async (c) => {
    exigirSecreto(deps, c.req.raw);
    const body = await readJsonCapped<Record<string, unknown>>(c.req.raw, 8 * 1024);
    const organizationId = uuid(body.organizationId, "organizationId");
    const propertyId = uuid(body.propertyId, "propertyId");
    if (typeof body.externalId !== "string" || body.externalId.length < 1 || body.externalId.length > 200) throw Errors.validation("externalId: se esperaba texto de 1 a 200 caracteres.");
    if (body.canal !== "llamada" && body.canal !== "preview") throw Errors.validation("canal: debe ser llamada o preview.");
    if (typeof body.proveedor !== "string" || !(VOZ_PROVEEDORES as readonly string[]).includes(body.proveedor)) throw Errors.validation(`proveedor: debe ser uno de ${VOZ_PROVEEDORES.join(", ")}.`);
    if (body.voiceId !== undefined && body.voiceId !== null && (typeof body.voiceId !== "string" || body.voiceId.length < 1 || body.voiceId.length > 64)) throw Errors.validation("voiceId: se esperaba texto de 1 a 64 caracteres.");
    let callerHash: string | null = null;
    if (body.callerPhone !== undefined && body.callerPhone !== null) {
      const digitos = typeof body.callerPhone === "string" ? body.callerPhone.replace(/\D/g, "") : "";
      if (digitos.length < 7 || digitos.length > 15) throw Errors.validation("callerPhone: se esperaba un teléfono de 7 a 15 dígitos.");
      callerHash = createHash("sha256").update(digitos).digest("hex");
    }
    const startedAt = fechaOpcional(body.startedAt, "startedAt");

    return deps.engine.withAppSession({ userId: null }, async (db) => {
      try {
        const conversationId = await repoDe(db).iniciarConversacion({
          organizationId,
          propertyId,
          externalId: body.externalId as string,
          canal: body.canal as VozCanal,
          proveedor: body.proveedor as VozProveedorId,
          voiceId: typeof body.voiceId === "string" ? body.voiceId : null,
          callerHash,
          startedAt,
        });
        return c.json({ conversationId }, 201);
      } catch (err) {
        return mapErrorDeVoz(err);
      }
    });
  });

  app.post(`${base}/conversaciones/:conversationId/turnos`, async (c) => {
    exigirSecreto(deps, c.req.raw);
    const conversationId = uuid(c.req.param("conversationId"), "conversationId");
    const body = await readJsonCapped<Record<string, unknown>>(c.req.raw, 32 * 1024);
    const organizationId = uuid(body.organizationId, "organizationId");
    if (typeof body.seq !== "number" || !Number.isInteger(body.seq) || body.seq < 0 || body.seq > 100_000) throw Errors.validation("seq: se esperaba un entero entre 0 y 100000.");
    if (typeof body.rol !== "string" || !(VOZ_ROLES_TURNO as readonly string[]).includes(body.rol)) throw Errors.validation(`rol: debe ser uno de ${VOZ_ROLES_TURNO.join(", ")}.`);
    if (typeof body.texto !== "string" || body.texto.length > 20_000) throw Errors.validation("texto: se esperaba texto de hasta 20000 caracteres.");
    const texto = redactarTranscripcion(body.texto).slice(0, VOZ_TURNO_TEXTO_MAX);
    const duracionMs = enteroOpcional(body.duracionMs, "duracionMs", MAX_DURACION_MS);
    const latenciaMs = enteroOpcional(body.latenciaMs, "latenciaMs", MAX_DURACION_MS);
    const costoMicroUsd = enteroOpcional(body.costoMicroUsd, "costoMicroUsd", MAX_COSTO_MICRO_USD) ?? 0;

    return deps.engine.withAppSession({ userId: null }, async (db) => {
      try {
        const insertado = await repoDe(db).registrarTurno({ organizationId, conversationId, seq: body.seq as number, rol: body.rol as VozRolTurno, texto, duracionMs, latenciaMs, costoMicroUsd });
        return c.json({ insertado });
      } catch (err) {
        return mapErrorDeVoz(err);
      }
    });
  });

  app.post(`${base}/conversaciones/:conversationId/cerrar`, async (c) => {
    exigirSecreto(deps, c.req.raw);
    const conversationId = uuid(c.req.param("conversationId"), "conversationId");
    const body = await readJsonCapped<Record<string, unknown>>(c.req.raw, 4 * 1024);
    const organizationId = uuid(body.organizationId, "organizationId");
    if (typeof body.resultado !== "string" || !(VOZ_RESULTADOS as readonly string[]).includes(body.resultado)) throw Errors.validation(`resultado: debe ser uno de ${VOZ_RESULTADOS.join(", ")}.`);
    const endedAt = fechaOpcional(body.endedAt, "endedAt");
    const orderId = body.orderId === undefined || body.orderId === null ? null : uuid(body.orderId, "orderId");

    return deps.engine.withAppSession({ userId: null }, async (db) => {
      try {
        const cerrada = await repoDe(db).cerrarConversacion({ organizationId, conversationId, resultado: body.resultado as VozResultado, endedAt, orderId });
        // Notificacion in-app (best-effort, dentro de un SAVEPOINT: nunca rompe el cierre ni la base sin migrar): una llamada que
        // el agente paso a una persona es "algo nuevo que atender". Una sola vez por llamada (la clave es la conversacion).
        if (cerrada && body.resultado === "escalado") {
          await emitirNotificacion(db, { evento: "restaurantes.voz.llamada_escalada", organizationId, clave: conversationId, entidadTipo: "voz_conversacion", entidadId: conversationId });
        }
        return c.json({ cerrada });
      } catch (err) {
        return mapErrorDeVoz(err);
      }
    });
  });

  app.post(`${base}/previews/consumir`, async (c) => {
    exigirSecreto(deps, c.req.raw);
    const secreto = deps.env.voicePreviewTokenSecret;
    if (!secreto || secreto.length < 16) throw Errors.serviceUnavailable("Voz no configurada: falta VOICE_PREVIEW_TOKEN_SECRET.");
    const body = await readJsonCapped<{ token?: unknown }>(c.req.raw, 4 * 1024);
    const verificacion = verificarPreviewToken(secreto, body.token, new Date());
    if (!verificacion.ok) throw Errors.unauthorized("Token de preview inválido o expirado.");
    const { sid, org, prop, vid, prov } = verificacion.payload;

    return deps.engine.withAppSession({ userId: null }, async (db) => {
      try {
        const consumida = await repoDe(db).consumirPreview({ sessionId: sid, organizationId: org, propertyId: prop });
        if (!consumida) throw Errors.conflict("La sesión de preview ya fue usada o expiró.");
        return c.json({ valido: true, sessionId: sid, organizationId: org, propertyId: prop, voiceId: vid, proveedor: prov });
      } catch (err) {
        return mapErrorDeVoz(err);
      }
    });
  });

  // R-13 (migración 035): el servicio de voz reporta la latencia de una herramienta o un error de proveedor.
  // Alimenta el p95 de herramientas y la tasa de error del panel de KPI. Sin mensajes del proveedor (solo un código corto).
  app.post(`${base}/eventos`, async (c) => {
    exigirSecreto(deps, c.req.raw);
    const body = await readJsonCapped<Record<string, unknown>>(c.req.raw, 4 * 1024);
    const organizationId = uuid(body.organizationId, "organizationId");
    const propertyId = uuid(body.propertyId, "propertyId");
    const conversationId = body.conversationId === undefined || body.conversationId === null ? null : uuid(body.conversationId, "conversationId");
    if (typeof body.tipo !== "string" || !(VOZ_EVENTO_TIPOS as readonly string[]).includes(body.tipo)) throw Errors.validation(`tipo: debe ser uno de ${VOZ_EVENTO_TIPOS.join(", ")}.`);
    const tipo = body.tipo as VozEventoTipo;
    let proveedor: VozProveedorFallo | null = null;
    let herramienta: string | null = null;
    const latenciaMs = enteroOpcional(body.latenciaMs, "latenciaMs", MAX_DURACION_MS);
    if (tipo === "error_proveedor") {
      if (typeof body.proveedor !== "string" || !(VOZ_PROVEEDORES_FALLO as readonly string[]).includes(body.proveedor)) throw Errors.validation(`proveedor: debe ser uno de ${VOZ_PROVEEDORES_FALLO.join(", ")}.`);
      proveedor = body.proveedor as VozProveedorFallo;
    } else if (tipo === "latencia_voz") {
      // Latencia de voz a voz de UNA respuesta del agente (migración 067): solo el número, sin texto ni herramienta.
      if (latenciaMs === null) throw Errors.validation("latenciaMs: obligatorio en latencia_voz.");
    } else {
      if (typeof body.herramienta !== "string" || body.herramienta.length < 1 || body.herramienta.length > 80) throw Errors.validation("herramienta: se esperaba texto de 1 a 80 caracteres.");
      if (latenciaMs === null) throw Errors.validation("latenciaMs: obligatorio en tool_call.");
      herramienta = body.herramienta;
    }
    if (body.codigo !== undefined && body.codigo !== null && (typeof body.codigo !== "string" || body.codigo.length < 1 || body.codigo.length > 80)) throw Errors.validation("codigo: se esperaba texto de 1 a 80 caracteres.");
    const ocurridoAt = fechaOpcional(body.ocurridoAt, "ocurridoAt");

    return deps.engine.withAppSession({ userId: null }, async (db) => {
      if (!deps.vozKpiRepo) throw Errors.serviceUnavailable("Los KPI de voz no están disponibles en este despliegue.");
      try {
        const evento = { organizationId, propertyId, conversationId, tipo, proveedor, herramienta, latenciaMs, codigo: typeof body.codigo === "string" ? body.codigo : null, ocurridoAt };
        if (tipo === "latencia_voz") {
          // Base con la 035 pero SIN la 067: el CHECK del tipo rechaza 'latencia_voz' (23514). SAVEPOINT: nunca aborta la transacción del request
          // ni da un 500; la latencia queda "no disponible aun" (202) y la llamada, que ya ocurrio, no se ve afectada.
          const registrado = await runWithSavepointFallback<boolean>({
            session: db,
            savepointName: "sp_voz_evento_latencia",
            primary: async () => {
              await deps.vozKpiRepo!(db).registrarEvento(evento);
              return true;
            },
            isRecoverable: esLatenciaSinMigrar,
            fallback: async () => false,
          });
          return registrado ? c.json({ registrado: true }, 201) : c.json({ registrado: false, disponible: false }, 202);
        }
        await deps.vozKpiRepo(db).registrarEvento(evento);
        // Un error del proveedor de voz avisa al owner/admin (best-effort, sin PII, una por sucursal por hora).
        if (tipo === "error_proveedor") {
          const hora = (ocurridoAt ?? new Date().toISOString()).replace(/\D/g, "").slice(0, 10);
          await emitirNotificacion(db, { evento: "restaurantes.voz.proveedor_con_fallas", organizationId, propertyId, clave: `${propertyId}:${hora}` });
        }
        return c.json({ registrado: true }, 201);
      } catch (err) {
        return mapErrorDeVoz(err);
      }
    });
  });

  return app;
}
