// D-04: lista 69-B del SAT (EFOS) -- estado de la lista, alertas del panel y subida/ingesta
// manual. SIN llamadas al SAT. Todo es compatible con la base sin migrar: el repositorio
// degrada a `estado: "no_disponible"` (honesto, nunca "limpio") si falta la migración 014.
//
//  GET  /despachos/:propertyId/efos/estado   -- edición vigente (periodo, filas, fecha de ingesta).
//  GET  /despachos/:propertyId/efos/alertas  -- invoices YA ingeridos de la property cuyo emisor figura
//                                               hoy como presunto/definitivo (re-evaluación: una
//                                               edición nueva alerta CFDI anteriores).
//  POST /internal/despachos/efos-69b/ingestar?periodo=YYYY-MM  -- ingesta de UNA edición (solo secreto
//                                               interno; el CSV va en el cuerpo). Idempotente por SHA.
import { Hono } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { decodificarListado69B, Efos69bFormatoError, EfosUnavailableError, esPeriodoEfosValido, VER_CFDI_ROLES } from "@atiende/domain-despachos";
import type { DespachosRepository } from "@atiende/domain-despachos";
import { runEfos69bIngestion } from "@atiende/worker";
import { Errors } from "../../../errors.ts";
import { internalOrCronSecretMatches } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";

/** Tope de la subida manual. Vercel limita el cuerpo de una función a ~4.5 MB: una edición
 * completa del SAT puede exceder eso, y en ese caso la ingesta debe hacerse por un adaptador
 * (`Efos69bSource`) corriendo fuera de la función HTTP (ver README del job). */
const MAX_EFOS_CSV_BYTES = 4 * 1024 * 1024;

async function readBytesCapped(req: Request, maxBytes: number): Promise<Uint8Array> {
  const length = Number(req.headers.get("content-length") ?? 0);
  if (!Number.isFinite(length) || length < 0 || length > maxBytes) throw Errors.payloadTooLarge();
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (bytes.byteLength > maxBytes) throw Errors.payloadTooLarge();
  return bytes;
}

export function despachosEfosRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  app.use("/despachos/:propertyId/efos/*", authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  app.get("/despachos/:propertyId/efos/estado", async (c) => {
    assertVerticalRole(c, VER_CFDI_ROLES);
    return c.json(await deps.despachosRepo(c.get("db")).estadoEfos());
  });

  app.get("/despachos/:propertyId/efos/alertas", async (c) => {
    assertVerticalRole(c, VER_CFDI_ROLES);
    const repo = deps.despachosRepo(c.get("db"));
    const [estado, afectados] = await Promise.all([repo.estadoEfos(), repo.listarInvoicesEfosAfectados(c.req.param("propertyId"))]);
    return c.json({ lista: estado, estado: afectados.estado, alertas: afectados.items });
  });

  app.post("/internal/despachos/efos-69b/ingestar", async (c) => {
    if (!internalOrCronSecretMatches(c.req.raw, deps.env.internalSecret)) throw Errors.unauthorized();
    const periodo = c.req.query("periodo") ?? "";
    if (!esPeriodoEfosValido(periodo)) throw Errors.validation("periodo: se esperaba el formato YYYY-MM.");
    const texto = decodificarListado69B(await readBytesCapped(c.req.raw, MAX_EFOS_CSV_BYTES));

    try {
      const withRepo = <T>(fn: (repo: DespachosRepository) => Promise<T>) => deps.engine.withAppSession({ userId: null }, (db) => fn(deps.despachosRepo(db)));
      const r = await runEfos69bIngestion(withRepo, { obtenerListado: async () => texto }, periodo);
      return c.json({ ok: true, periodo: r.periodo, resultado: r.resultado, filas: r.filas, descartadas: r.descartadas.length, detalle_descartadas: r.descartadas.slice(0, 50), fuente_sha256: r.fuenteSha256 });
    } catch (err) {
      if (err instanceof Efos69bFormatoError) throw Errors.validation(err.message);
      if (err instanceof EfosUnavailableError) throw Errors.serviceUnavailable(err.message);
      throw err;
    }
  });

  return app;
}
