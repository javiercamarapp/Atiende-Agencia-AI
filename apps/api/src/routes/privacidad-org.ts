// Privacidad por organizacion (PL-13), para el owner/admin del cliente: solicitudes ARCO de TODOS los
// verticales con plazos y estados, politicas de retencion (con valores por defecto documentados),
// bloqueo previo a purga, registro de purgas y aviso de privacidad versionado con su aceptacion.
// Ver packages/db/migrations/0036_plataforma_arco_retencion_aviso.sql y docs/PRIVACIDAD-PLATAFORMA.md.
//
//   GET    /v1/privacidad/resumen                    todo lo anterior en una llamada
//   GET    /v1/privacidad/arco                       solicitudes ARCO paginadas (soloAbiertas=1)
//   PUT    /v1/privacidad/retencion/:claseDato       fija los dias de retencion de la organizacion
//   DELETE /v1/privacidad/retencion/:claseDato       vuelve al valor del vertical o al defecto
//   POST   /v1/privacidad/bloqueos                   coloca un bloqueo previo a purga (retencion legal)
//   POST   /v1/privacidad/bloqueos/:id/liberar       libera el bloqueo
//   POST   /v1/privacidad/avisos                     publica una nueva version del aviso (la acepta quien la publica)
//   POST   /v1/privacidad/avisos/:version/aceptar    otro owner/admin acepta la version vigente
//
// La organizacion sale SIEMPRE del token (claim `org_id`), nunca de la URL ni del cuerpo; el SQL vuelve
// a exigir membresia owner/admin. Las solicitudes se devuelven sin telefono, correo ni nombre del
// titular: el detalle con datos personales sigue en el panel de cada vertical. Base sin migrar:
// `disponible: false` en lecturas y 503 explicito en escrituras, nunca un 500.
import { Hono } from "hono";
import type { Context } from "hono";
import { authMiddleware, dbSession } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { rateLimit } from "@atiende/core-ratelimit";
import { PlataformaPrivacidadError } from "@atiende/db";
import { Errors } from "../errors.ts";
import { readJsonCapped, requestActor } from "../http-security.ts";
import { serializarArco } from "../privacidad/plazos.ts";
import { PLAZOS_PRIVACIDAD, PRIVACIDAD_NO_DISPONIBLE, banderaQuery, entero } from "./superadmin-privacidad.ts";
import type { AppDeps } from "../deps.ts";

const MUTACION_RATE_LIMIT = { max: 30, windowMs: 5 * 60_000 } as const;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const CLASE_RE = /^[a-z0-9_]{3,80}$/u;
const BODY_MAX = 8 * 1024;
const RESUMEN_ARCO = 50;
const RESUMEN_PURGAS = 20;

function traducir(err: unknown): never {
  if (err instanceof PlataformaPrivacidadError) {
    if (err.code === "forbidden") throw Errors.forbidden("Solo el owner o un admin de la organización puede administrar la privacidad.");
    if (err.code === "conflict") throw Errors.conflict(err.message);
    throw Errors.validation(err.message);
  }
  throw err;
}

function texto(valor: unknown, campo: string, max: number): string {
  if (typeof valor !== "string") throw Errors.validation(`${campo}: se esperaba texto.`);
  const t = valor.trim();
  if (t.length === 0 || t.length > max) throw Errors.validation(`${campo}: entre 1 y ${max} caracteres.`);
  return t;
}

export function privacidadOrgRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  app.use("/v1/privacidad/*", authMiddleware(deps.env), dbSession(deps.engine));

  function repoDe(c: Context<CoreAuthHonoEnv>) {
    if (!deps.privacidadPlataformaRepo) throw Errors.serviceUnavailable(PRIVACIDAD_NO_DISPONIBLE);
    return deps.privacidadPlataformaRepo(c.get("db"));
  }

  async function limitar(c: Context<CoreAuthHonoEnv>): Promise<void> {
    const permitido = await rateLimit(`privacidad:org:${requestActor(c.req.raw, c.get("userId"))}`, MUTACION_RATE_LIMIT.max, MUTACION_RATE_LIMIT.windowMs, { category: "admin" });
    if (!permitido) throw Errors.tooManyRequests("Demasiados cambios de privacidad en poco tiempo.");
  }

  app.get("/v1/privacidad/resumen", async (c) => {
    if (!deps.privacidadPlataformaRepo) return c.json({ disponible: false, mensaje: PRIVACIDAD_NO_DISPONIBLE });
    const repo = repoDe(c);
    const org = c.get("organizationId");
    const retencion = await repo.orgListRetention(org);
    if (retencion.availability === "not_migrated") return c.json({ disponible: false, mensaje: PRIVACIDAD_NO_DISPONIBLE });
    // El catalogo nunca esta vacio para un owner/admin: una lista vacia significa que NO lo es.
    if (retencion.items.length === 0) throw Errors.forbidden("Solo el owner o un admin de la organización puede administrar la privacidad.");
    // SECUENCIAL a proposito: cada metodo corre bajo SAVEPOINT en la MISMA sesion de request; en paralelo el
    // cliente pg encola SAVEPOINT a,b,c,d y luego RELEASE a,b,... y RELEASE a destruye los anidados b,c,d (3B001).
    const arco = await repo.orgListArco(org, { onlyOpen: false, limit: RESUMEN_ARCO, offset: 0 });
    const bloqueos = await repo.orgListHolds(org);
    const purgas = await repo.orgListPurgeRuns(org, RESUMEN_PURGAS, null);
    const avisos = await repo.orgListNotices(org, 20);
    const ahora = Date.now();
    return c.json({
      disponible: true,
      plazos: PLAZOS_PRIVACIDAD,
      arco: { total: arco.total, solicitudes: arco.items.map((r) => serializarArco(r, ahora)) },
      retencion: retencion.items.map((p) => ({
        claseDato: p.dataClass,
        vertical: p.vertical,
        descripcion: p.description,
        ejecuta: p.executor,
        defectoDias: p.defaultDays,
        minimoDias: p.minDays,
        maximoDias: p.maxDays,
        diasEfectivos: p.effectiveDays,
        origen: p.source,
        actualizadaEnMs: p.updatedAtMs,
      })),
      bloqueos: bloqueos.items.map((h) => ({ id: h.id, claseDato: h.dataClass, motivo: h.reason, colocadoEnMs: h.placedAtMs, liberadoEnMs: h.releasedAtMs, notaLiberacion: h.releaseNote, activo: h.active })),
      purgas: purgas.items.map((p) => ({
        seq: p.seq,
        claseDato: p.dataClass,
        estado: p.status,
        retencionDias: p.retentionDays,
        corteEnMs: p.cutoffAtMs,
        filasAfectadas: p.rowsAffected,
        filasAnonimizadas: p.rowsAnonymized,
        filasProtegidas: p.rowsProtected,
        motivoBloqueo: p.blockedReason,
        ocurrioEnMs: p.createdAtMs,
      })),
      avisos: avisos.items.map((n) => ({
        version: n.version,
        titulo: n.title,
        resumen: n.summary,
        url: n.noticeUrl,
        huellaSha256: n.contentSha256,
        publicadoEnMs: n.createdAtMs,
        aceptaciones: n.acceptedCount,
        aceptadoPorMi: n.acceptedByCaller,
        vigente: n.isCurrent,
      })),
    });
  });

  app.get("/v1/privacidad/arco", async (c) => {
    if (!deps.privacidadPlataformaRepo) return c.json({ disponible: false, mensaje: PRIVACIDAD_NO_DISPONIBLE, total: 0, solicitudes: [] });
    const limite = entero(c.req.query("limite"), "limite", 50, 1, 200);
    const desde = entero(c.req.query("desde"), "desde", 0, 0, 1_000_000);
    const r = await repoDe(c).orgListArco(c.get("organizationId"), { onlyOpen: banderaQuery(c.req.query("soloAbiertas")), limit: limite, offset: desde });
    if (r.availability === "not_migrated") return c.json({ disponible: false, mensaje: PRIVACIDAD_NO_DISPONIBLE, total: 0, solicitudes: [] });
    const ahora = Date.now();
    return c.json({ disponible: true, plazos: PLAZOS_PRIVACIDAD, total: r.total, solicitudes: r.items.map((row) => serializarArco(row, ahora)) });
  });

  app.put("/v1/privacidad/retencion/:claseDato", async (c) => {
    await limitar(c);
    const clase = c.req.param("claseDato");
    if (!CLASE_RE.test(clase)) throw Errors.validation("claseDato inválida.");
    const body = await readJsonCapped<{ dias?: unknown }>(c.req.raw, BODY_MAX);
    if (typeof body.dias !== "number" || !Number.isInteger(body.dias) || body.dias < 0 || body.dias > 36_500) throw Errors.validation("dias: se esperaba un entero entre 0 y 36500.");
    try {
      const r = await repoDe(c).orgSetRetention(c.get("organizationId"), clase, body.dias);
      if (r.availability === "not_migrated") throw Errors.serviceUnavailable(PRIVACIDAD_NO_DISPONIBLE);
      return c.json({ claseDato: clase, dias: body.dias });
    } catch (err) {
      return traducir(err);
    }
  });

  app.delete("/v1/privacidad/retencion/:claseDato", async (c) => {
    await limitar(c);
    const clase = c.req.param("claseDato");
    if (!CLASE_RE.test(clase)) throw Errors.validation("claseDato inválida.");
    try {
      const r = await repoDe(c).orgClearRetention(c.get("organizationId"), clase);
      if (r.availability === "not_migrated") throw Errors.serviceUnavailable(PRIVACIDAD_NO_DISPONIBLE);
      return c.json({ claseDato: clase, restablecida: r.cleared });
    } catch (err) {
      return traducir(err);
    }
  });

  app.post("/v1/privacidad/bloqueos", async (c) => {
    await limitar(c);
    const body = await readJsonCapped<{ claseDato?: unknown; motivo?: unknown }>(c.req.raw, BODY_MAX);
    const clase = body.claseDato === undefined || body.claseDato === null ? null : texto(body.claseDato, "claseDato", 80);
    if (clase !== null && !CLASE_RE.test(clase)) throw Errors.validation("claseDato inválida.");
    const motivo = texto(body.motivo, "motivo", 300);
    if (motivo.length < 10) throw Errors.validation("motivo: mínimo 10 caracteres.");
    try {
      const r = await repoDe(c).orgPlaceHold(c.get("organizationId"), clase, motivo);
      if (r.availability === "not_migrated") throw Errors.serviceUnavailable(PRIVACIDAD_NO_DISPONIBLE);
      return c.json({ id: r.id, claseDato: clase }, 201);
    } catch (err) {
      return traducir(err);
    }
  });

  app.post("/v1/privacidad/bloqueos/:id/liberar", async (c) => {
    await limitar(c);
    const id = c.req.param("id");
    if (!UUID_RE.test(id)) throw Errors.validation("id inválido.");
    const body = await readJsonCapped<{ nota?: unknown }>(c.req.raw, BODY_MAX);
    const nota = body.nota === undefined || body.nota === null ? null : texto(body.nota, "nota", 300);
    try {
      const r = await repoDe(c).orgReleaseHold(c.get("organizationId"), id, nota);
      if (r.availability === "not_migrated") throw Errors.serviceUnavailable(PRIVACIDAD_NO_DISPONIBLE);
      if (!r.released) throw Errors.notFound("No hay un bloqueo activo con ese id en tu organización.");
      return c.json({ id, liberado: true });
    } catch (err) {
      return traducir(err);
    }
  });

  app.post("/v1/privacidad/avisos", async (c) => {
    await limitar(c);
    const body = await readJsonCapped<{ titulo?: unknown; resumen?: unknown; url?: unknown }>(c.req.raw, BODY_MAX);
    const titulo = texto(body.titulo, "titulo", 200);
    const resumen = texto(body.resumen, "resumen", 2000);
    const url = texto(body.url, "url", 500);
    try {
      const r = await repoDe(c).orgPublishNotice(c.get("organizationId"), titulo, resumen, url);
      if (r.availability === "not_migrated") throw Errors.serviceUnavailable(PRIVACIDAD_NO_DISPONIBLE);
      return c.json({ version: r.version }, 201);
    } catch (err) {
      return traducir(err);
    }
  });

  app.post("/v1/privacidad/avisos/:version/aceptar", async (c) => {
    await limitar(c);
    const raw = c.req.param("version");
    if (!/^\d{1,6}$/u.test(raw)) throw Errors.validation("version inválida.");
    try {
      const r = await repoDe(c).orgAcceptNotice(c.get("organizationId"), Number(raw));
      if (r.availability === "not_migrated") throw Errors.serviceUnavailable(PRIVACIDAD_NO_DISPONIBLE);
      return c.json({ version: Number(raw), aceptada: r.accepted, yaAceptadaPorTi: !r.accepted });
    } catch (err) {
      return traducir(err);
    }
  });

  return app;
}
