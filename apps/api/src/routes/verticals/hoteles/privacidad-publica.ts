// H-30 (P1) -- superficie PUBLICA de privacidad del huesped de hoteles, SIN login. Superficie publica sin login,
// este grupo se monta sin `authMiddleware` y abre su propia sesion de SISTEMA (`userId: null`); su defensa es CORS por origen,
// limite de tasa por IP / referencia / contacto (consumido en una sesion APARTE para que un rechazo no revierta el conteo),
// honeypot, validacion estricta y un modelo de datos que solo expone funciones `security definer` solo-sistema (migracion 042).
//
//   GET  /v1/hoteles/:orgSlug/privacidad[?property=slug]       aviso vigente (texto publico, sin datos personales)
//   POST /v1/hoteles/:orgSlug/privacidad/solicitud             alta de una solicitud ARCO: queda pendiente_verificacion
//   POST /v1/hoteles/:orgSlug/privacidad/solicitud/verificar   codigo de un solo uso -> recibida (corre el plazo) + aviso al staff
//   POST /v1/hoteles/:orgSlug/privacidad/mis-datos             datos del titular con enlace firmado de vida corta ({ token } en el cuerpo)
//
// Sin enumeracion: el alta responde IDENTICO exista o no el titular, el correo sea alcanzable o no, y aunque el contacto haya
// rebasado su tope o el robot haya llenado el honeypot (en esos casos no se guarda nada). Toda falla de verificacion responde
// lo mismo (no se distingue invalido/expirado/agotado/usado). `mis-datos` responde 404 igual con token falso, vencido o revocado.
//
// REGLA DURA de compatibilidad con la base sin migrar: el aviso responde `disponible: false`; el resto 503 honesto (SAVEPOINT en
// el repositorio). Nunca un 500 por una base vieja.
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import type { Context } from "hono";
import { emitirNotificacion } from "@atiende/db";
import { hoyFechaNegocio, resolverZonaHorariaNegocio } from "@atiende/core-tenancy";
import {
  PostgresPublicPrivacyRepository,
  PrivacyInvalidInputError,
  PrivacyUnavailableError,
  consumeRateLimit,
  correoCodigoArco,
  parsePublicArcoForm,
  parseVerificationCode,
  pickProperty,
  propertySlug,
  type PublicNoticeProperty,
  type PublicPrivacyRepository,
} from "@atiende/domain-hoteles";
import { Errors } from "../../../errors.ts";
import { originAllowed, readJsonCapped, requestActor as ipActor } from "../../../http-security.ts";
import { ARCO_CODE_TTL_SECONDS, generateArcoCode, hashArcoCode, privacyPublicKey, verifyMisDatosToken } from "../../../privacy-public-token.ts";
import { triggerHotelesEmailDispatchInline } from "./email-dispatch.ts";
import type { AppDeps } from "../../../deps.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BODY_BYTES = 8 * 1024;

const noStore = (c: Context) => c.header("Cache-Control", "no-store");

function unavailable(err: unknown): unknown {
  if (err instanceof PrivacyUnavailableError) return Errors.serviceUnavailable("La privacidad publica aun no esta disponible: falta aplicar la migracion 042 en esta base.");
  if (err instanceof PrivacyInvalidInputError) return Errors.validation(err.message);
  return err;
}

function serializeProperty(p: PublicNoticeProperty) {
  return {
    propiedad: { slug: propertySlug(p.propertyName), nombre: p.propertyName },
    aviso: p.notice
      ? {
          version: p.notice.version,
          textoSimplificado: p.notice.simplifiedText,
          urlIntegral: p.notice.integralUrl,
          finalidadesObligatorias: p.notice.mandatoryPurposes,
          finalidadesOpcionales: p.notice.optionalPurposes,
          publicadoEn: p.notice.publishedAt,
        }
      : null,
  };
}

export function hotelesPrivacidadPublicaRoutes(deps: AppDeps): Hono {
  const app = new Hono();
  const key = privacyPublicKey(deps.env.internalSecret);
  const repoOf = (db: Parameters<NonNullable<AppDeps["hotelesPrivacidadPublicaRepo"]>>[0]): PublicPrivacyRepository =>
    deps.hotelesPrivacidadPublicaRepo ? deps.hotelesPrivacidadPublicaRepo(db) : new PostgresPublicPrivacyRepository(db);

  function assertOrigin(c: Context) {
    if (!originAllowed(c.req.header("origin") ?? null, deps.env.allowedOrigins)) throw Errors.forbidden("Origen no permitido");
  }

  /** Consume UN cupo en su propia sesion (commit propio) y lanza 429 DESPUES: el rechazo no revierte el conteo. */
  async function limitOrThrow(scope: string, actor: string, max: number, windowSeconds: number) {
    const allowed = await deps.engine.withAppSession({ userId: null }, async (db) => (await consumeRateLimit(deps.hotelesRepo(db), scope, actor, max, windowSeconds)).allowed);
    if (!allowed) throw Errors.tooManyRequests();
    return true;
  }
  /** Igual pero devuelve false en vez de lanzar (limites por contacto: la respuesta no debe delatar nada). */
  async function limitQuiet(scope: string, actor: string, max: number, windowSeconds: number): Promise<boolean> {
    return deps.engine.withAppSession({ userId: null }, async (db) => (await consumeRateLimit(deps.hotelesRepo(db), scope, actor, max, windowSeconds)).allowed);
  }
  const ipOf = (c: Context) => ipActor(c.req.raw, "");

  // ---- Aviso vigente -------------------------------------------------------------------------------------------------------
  app.get("/v1/hoteles/:orgSlug/privacidad", async (c) => {
    noStore(c);
    await limitOrThrow("hoteles-privacidad-lectura", ipOf(c), 120, 60);
    const orgSlug = c.req.param("orgSlug");
    const propiedad = c.req.query("property") ?? null;
    return deps.engine.withAppSession({ userId: null }, async (db) => {
      const result = await repoOf(db).listNotices(orgSlug);
      if (!result.available) return c.json({ disponible: false, motivo: "La privacidad publica aun no esta disponible en esta base: falta aplicar la migracion 042." });
      if (result.properties.length === 0) throw Errors.notFound("Hotel no encontrado.");
      const hotel = { nombre: result.organizationName };
      if (propiedad) {
        const elegida = pickProperty(result.properties, propiedad);
        if (!elegida) throw Errors.notFound("Propiedad no encontrada.");
        return c.json({ disponible: true, hotel, propiedades: [serializeProperty(elegida)] });
      }
      return c.json({ disponible: true, hotel, propiedades: result.properties.map(serializeProperty) });
    });
  });

  // ---- Alta de solicitud ARCO -----------------------------------------------------------------------------------------------
  app.post("/v1/hoteles/:orgSlug/privacidad/solicitud", async (c) => {
    noStore(c);
    assertOrigin(c);
    await limitOrThrow("hoteles-arco-publico-alta", ipOf(c), 5, 60);
    const orgSlug = c.req.param("orgSlug");
    let form;
    try {
      form = parsePublicArcoForm(await readJsonCapped<unknown>(c.req.raw, MAX_BODY_BYTES));
    } catch (err) {
      throw unavailable(err);
    }
    // Respuesta unica para exito real, honeypot, tope por contacto y tope descartado en la base.
    const respuesta = (referencia: string) =>
      c.json(
        {
          ok: true,
          referencia,
          mensaje: "Si el correo es valido, te enviamos un codigo de 6 digitos. Captura el codigo para confirmar tu solicitud: hasta entonces no se tramita.",
          venceEnMinutos: ARCO_CODE_TTL_SECONDS / 60,
          envioDeCorreo: deps.env.resend.apiKey ? "habilitado" : "pendiente_de_configuracion",
        },
        202,
      );
    if (form.honeypot) return respuesta(randomUUID());
    // Tope por contacto en sesion aparte: 3 por hora por correo. Excedido = misma respuesta, sin guardar nada.
    if (!(await limitQuiet("hoteles-arco-publico-contacto", form.email, 3, 3600))) return respuesta(randomUUID());

    return deps.engine.withAppSession({ userId: null }, async (db) => {
      const repo = repoOf(db);
      let notices;
      try {
        notices = await repo.listNotices(orgSlug);
      } catch (err) {
        throw unavailable(err);
      }
      if (!notices.available) throw Errors.serviceUnavailable("La privacidad publica aun no esta disponible: falta aplicar la migracion 042 en esta base.");
      if (notices.properties.length === 0) throw Errors.notFound("Hotel no encontrado.");
      const property = pickProperty(notices.properties, form.propertySlug);
      if (!property) throw Errors.validation("propiedad: indica la propiedad del hotel a la que va dirigida la solicitud.");

      const requestId = randomUUID();
      const code = generateArcoCode();
      const hoteles = deps.hotelesRepo(db);
      const today = hoyFechaNegocio(resolverZonaHorariaNegocio(await hoteles.findPropertyTimezone(property.propertyId)));
      const email = correoCodigoArco({
        to: form.email,
        hotelNombre: notices.organizationName ?? property.propertyName,
        nombre: form.name,
        derecho: form.rightType,
        codigo: code,
        minutos: ARCO_CODE_TTL_SECONDS / 60,
      });
      let id: string | null;
      try {
        id = await repo.submitArco({
          requestId,
          propertyId: property.propertyId,
          rightType: form.rightType,
          name: form.name,
          contact: form.email,
          description: form.description,
          codeHash: hashArcoCode(key, requestId, code),
          ttlSeconds: ARCO_CODE_TTL_SECONDS,
          email,
          today,
        });
      } catch (err) {
        throw unavailable(err);
      }
      // Best-effort: sin llave de Resend no se reclama nada y el codigo queda en la cola (la respuesta lo dice).
      if (id !== null) await triggerHotelesEmailDispatchInline(deps, db, hoteles);
      return respuesta(id ?? randomUUID());
    });
  });

  // ---- Verificacion del codigo ----------------------------------------------------------------------------------------------
  app.post("/v1/hoteles/:orgSlug/privacidad/solicitud/verificar", async (c) => {
    noStore(c);
    assertOrigin(c);
    await limitOrThrow("hoteles-arco-publico-verificar", ipOf(c), 10, 60);
    const body = await readJsonCapped<{ referencia?: unknown; codigo?: unknown }>(c.req.raw, MAX_BODY_BYTES);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw Errors.validation("El cuerpo debe ser un objeto JSON.");
    if (typeof body.referencia !== "string" || !UUID_RE.test(body.referencia)) throw Errors.validation("referencia: se esperaba un UUID.");
    let code: string;
    try {
      code = parseVerificationCode(body.codigo);
    } catch (err) {
      throw unavailable(err);
    }
    const referencia = body.referencia.toLowerCase();
    // Tope por referencia (ademas de los 5 intentos de la base): 10 por hora.
    await limitOrThrow("hoteles-arco-publico-verificar-ref", referencia, 10, 3600);
    const outcome = await deps.engine.withAppSession({ userId: null }, async (db) => {
      try {
        // Fecha de negocio NULL: la base usa la zona horaria de la property (default Mexico).
        const out = await repoOf(db).verifyArco(referencia, hashArcoCode(key, referencia, code), null);
        if (out.result === "ok" && out.organizationId && out.propertyId) {
          // Aviso in-app al owner/gm (sin PII: la clave es el id de la solicitud). Best-effort, dentro de SAVEPOINT.
          await emitirNotificacion(db, { evento: "hoteles.arco.solicitud_publica", organizationId: out.organizationId, propertyId: out.propertyId, clave: referencia, entidadTipo: "arco", entidadId: referencia });
        }
        return out;
      } catch (err) {
        throw unavailable(err);
      }
    });
    if (outcome.result !== "ok") return c.json({ ok: false, mensaje: "El codigo no es valido o ya vencio. Si lo necesitas, haz una nueva solicitud." }, 422);
    return c.json({ ok: true, folio: outcome.folio, mensaje: "Solicitud confirmada. El hotel la atendera dentro del plazo legal y te respondera por el medio que indicaste." });
  });

  // ---- "Mis datos" (titular, enlace firmado) --------------------------------------------------------------------------------
  app.post("/v1/hoteles/:orgSlug/privacidad/mis-datos", async (c) => {
    noStore(c);
    assertOrigin(c);
    await limitOrThrow("hoteles-arco-publico-mis-datos", ipOf(c), 20, 60);
    const body = await readJsonCapped<{ token?: unknown }>(c.req.raw, MAX_BODY_BYTES);
    const noEncontrado = () => Errors.notFound("El enlace no es valido o ya vencio. Solicita uno nuevo al hotel.");
    const verification = verifyMisDatosToken(key, body && typeof body === "object" ? body.token : undefined);
    if (!verification.ok) throw noEncontrado();
    const doc = await deps.engine.withAppSession({ userId: null }, async (db) => {
      try {
        // La base liga la solicitud al hotel del slug: un enlace de otro hotel no abre datos de este.
        return await repoOf(db).accessSnapshot(verification.claims.req, c.req.param("orgSlug"));
      } catch (err) {
        throw unavailable(err);
      }
    });
    if (!doc) throw noEncontrado();
    return c.json({ ok: true, ...doc });
  });

  return app;
}

