// ds3 «Guía»: progreso del recorrido guiado por persona, comun a las 6 verticales y a la consola de plataforma.
//   GET /v1/onboarding/progreso?pista=<vertical>.<rol>&org=<slug>   (sin `org` y con pista=superadmin: consola de plataforma)
//   PUT /v1/onboarding/progreso  { pista, org, modo, paso, visto, omitido, descartado, activo, terminado }
//
// Autorizacion real: la lectura va por RLS (la propia fila, user_id = auth.uid()) y la escritura por el UNICO camino
// `core.guardar_onboarding_progreso` (migracion 0075), que toma al dueño de auth.uid() y exige membresia en la organizacion o
// superadmin para la pista de plataforma. Esta ruta solo valida el formato (400 antes de ir a la base) y traduce 42501 a 403.
// Base sin migrar o repo ausente: 200 con `disponible: false` y la guia sigue con el progreso del navegador (nunca un 500).
// Sin datos personales en el cuerpo ni en la bitacora: ids de paso del recorrido y banderas.
import { Hono } from "hono";
import type { Context } from "hono";
import { authMiddleware, dbSession } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { rateLimit } from "@atiende/core-ratelimit";
import { OnboardingProgresoInvalidoError, OnboardingProgresoProhibidoError, validarProgresoGuia } from "@atiende/db";
import type { GuardarProgresoGuia } from "@atiende/db";
import { Errors } from "../errors.ts";
import { readJsonCapped, requestActor } from "../http-security.ts";
import type { AppDeps } from "../deps.ts";

const RUTA = "/v1/onboarding/progreso";
const BODY_MAX = 2 * 1024;
/** Un guardado por cambio de paso: 58 pasos en un recorrido completo caben de sobra; un bucle no. */
const ESCRITURA_RATE_LIMIT = { max: 240, windowMs: 5 * 60_000 } as const;

function orgDe(valor: unknown): string | null {
  if (valor === undefined || valor === null || valor === "") return null;
  if (typeof valor !== "string") throw Errors.validation("org: se esperaba el slug de la organización.");
  return valor;
}

function bandera(valor: unknown, campo: string): boolean {
  if (valor === undefined) return false;
  if (typeof valor !== "boolean") throw Errors.validation(`${campo}: se esperaba verdadero o falso.`);
  return valor;
}

function textoONulo(valor: unknown, campo: string): string | null {
  if (valor === undefined || valor === null) return null;
  if (typeof valor !== "string") throw Errors.validation(`${campo}: se esperaba texto.`);
  return valor;
}

export function onboardingProgresoRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  app.use(RUTA, authMiddleware(deps.env), dbSession(deps.engine));

  function repoDe(c: Context<CoreAuthHonoEnv>) {
    return deps.onboardingProgresoRepo ? deps.onboardingProgresoRepo(c.get("db")) : null;
  }

  app.get(RUTA, async (c) => {
    const pista = c.req.query("pista") ?? "";
    const org = orgDe(c.req.query("org"));
    const motivo = validarProgresoGuia(org, pista);
    if (motivo) throw Errors.validation(motivo);
    const repo = repoDe(c);
    if (!repo) return c.json({ disponible: false, progreso: null });
    return c.json(await repo.leer(c.get("userId"), org, pista));
  });

  app.put(RUTA, async (c) => {
    const permitido = await rateLimit(`onboarding:progreso:${requestActor(c.req.raw, c.get("userId"))}`, ESCRITURA_RATE_LIMIT.max, ESCRITURA_RATE_LIMIT.windowMs);
    if (!permitido) throw Errors.tooManyRequests("Demasiados cambios del recorrido en poco tiempo.");
    const cuerpo = await readJsonCapped<Record<string, unknown>>(c.req.raw, BODY_MAX);
    if (!cuerpo || typeof cuerpo !== "object" || Array.isArray(cuerpo)) throw Errors.validation("Se esperaba un objeto.");
    const pista = typeof cuerpo.pista === "string" ? cuerpo.pista : "";
    const org = orgDe(cuerpo.org);
    const modo = textoONulo(cuerpo.modo, "modo");
    const datos: GuardarProgresoGuia = {
      modo: modo === "corto" || modo === "completo" || modo === null ? modo : ("invalido" as never),
      paso: textoONulo(cuerpo.paso, "paso"),
      visto: bandera(cuerpo.visto, "visto"),
      omitido: bandera(cuerpo.omitido, "omitido"),
      descartado: bandera(cuerpo.descartado, "descartado"),
      activo: bandera(cuerpo.activo, "activo"),
      terminado: bandera(cuerpo.terminado, "terminado"),
    };
    const motivo = validarProgresoGuia(org, pista, datos);
    if (motivo) throw Errors.validation(motivo);
    const repo = repoDe(c);
    if (!repo) return c.json({ disponible: false, actualizado: null });
    try {
      return c.json(await repo.guardar(c.get("userId"), org, pista, datos));
    } catch (err) {
      if (err instanceof OnboardingProgresoProhibidoError) throw Errors.forbidden(err.message);
      if (err instanceof OnboardingProgresoInvalidoError) throw Errors.validation(err.message);
      throw err;
    }
  });

  return app;
}
