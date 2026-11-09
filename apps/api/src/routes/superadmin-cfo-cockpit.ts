// CFO de la plataforma (cockpit del superadmin): economia por cliente, metricas SaaS, comparativos y
// alertas (GET), supuestos de costo unitario y capturas del dueño (GET/PUT) y exportacion CSV.
// Formulas: packages/billing/src/cockpit/*. Lectura y armado unicos: apps/api/src/cfo/cockpit.ts.
//
// Seguridad: todo cuelga de /superadmin/* (sesion de superadmin; ver routes/superadmin.ts). Las
// lecturas estan en la lista de la zona CFO (bitacora de cada consulta; el rol `finanzas` lee). Los
// PUT y la exportacion exigen step-up (superadmin-seguridad/step-up.ts) y el SQL vuelve a validar
// caller binding, rol y rangos (0085). Base sin migrar: 200 «no disponible» o 503 honesto, nunca 500.
import { Hono } from "hono";
import type { Context } from "hono";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { rateLimit } from "@atiende/core-ratelimit";
import { CLAVES_SUPUESTO_CFO, TIPOS_CAPTURA_CFO } from "@atiende/db";
import type { ClaveSupuestoCfo, TipoCapturaCfo } from "@atiende/db";
import { Errors } from "../errors.ts";
import { requestActor } from "../http-security.ts";
import { armarCockpit, COCKPIT_NO_DISPONIBLE, leerCockpit, mesActualUtc, sumarMeses } from "../cfo/cockpit.ts";
import type { Cockpit } from "../cfo/cockpit.ts";
import { economiaACsv } from "../cfo/cockpit-csv.ts";
import { informeInversionistas, libroCockpit, PDF_CONTENT_TYPE } from "../cfo/cockpit-exportar.ts";
import { XLSX_CONTENT_TYPE } from "@atiende/domain-despachos";
import { generarRecomendaciones } from "../cfo/recomendaciones.ts";
import { traducirErrorSeguridad } from "./superadmin-mfa.ts";
import type { AppDeps } from "../deps.ts";

export const SUPUESTOS_NO_DISPONIBLE = "Los supuestos y capturas del CFO todavía no están disponibles en este despliegue (falta aplicar la migración 0085_superadmin_cfo_cockpit).";
const MES_RE = /^(\d{4})-(0[1-9]|1[0-2])$/u;
const PROVEEDOR_RE = /^(\*|[a-z0-9][a-z0-9.-]{0,40})$/u;
const EXPORT_RATE_LIMIT = { max: 30, windowMs: 5 * 60_000 } as const;
const MUTACION_RATE_LIMIT = { max: 60, windowMs: 5 * 60_000 } as const;
const RECOMENDACIONES_RATE_LIMIT = { max: 10, windowMs: 10 * 60_000 } as const;
const MAX_MONTO_MXN = 1_000_000_000;

export function parseMesCockpit(raw: string | undefined): string {
  const mes = raw === undefined || raw === "" ? mesActualUtc() : raw;
  if (!MES_RE.test(mes)) throw Errors.validation("mes debe tener formato YYYY-MM.");
  if (mes > mesActualUtc()) throw Errors.validation("mes no puede ser futuro.");
  return mes;
}

/** Lee y arma el cockpit del mes con la sesion del superadmin; `null` = 0030 sin aplicar. Lo reusan exportaciones, recomendaciones y Copiloto. */
export async function cockpitDelMes(deps: AppDeps, callerId: string, mes: string): Promise<Cockpit | null> {
  const datos = await leerCockpit(deps, callerId, mes);
  return datos === null ? null : armarCockpit(datos);
}

function texto(raw: unknown, campo: string, min: number, max: number): string {
  const v = typeof raw === "string" ? raw.trim() : "";
  if (v.length < min || v.length > max) throw Errors.validation(`${campo} debe tener de ${min} a ${max} caracteres.`);
  return v;
}

function notaOpcional(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string" || raw.trim().length > 300) throw Errors.validation("nota debe ser texto de máximo 300 caracteres.");
  return raw.trim() === "" ? null : raw.trim();
}

export function superadminCfoCockpitRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  app.get("/superadmin/cfo/cockpit", async (c) => {
    const mes = parseMesCockpit(c.req.query("mes"));
    const r = await cockpitDelMes(deps, c.get("userId"), mes);
    if (r === null) return c.json({ disponible: false, mes, mensaje: COCKPIT_NO_DISPONIBLE });
    return c.json({ disponible: true, ...r });
  });

  app.get("/superadmin/cfo/cockpit/export.csv", async (c) => {
    const mes = parseMesCockpit(c.req.query("mes"));
    const callerId = c.get("userId");
    const allowed = await rateLimit(`admin:cfo-cockpit-export:${requestActor(c.req.raw, callerId)}`, EXPORT_RATE_LIMIT.max, EXPORT_RATE_LIMIT.windowMs, { category: "admin" });
    if (!allowed) throw Errors.tooManyRequests("Demasiadas exportaciones en poco tiempo.");
    const r = await cockpitDelMes(deps, callerId, mes);
    if (r === null) throw Errors.serviceUnavailable(COCKPIT_NO_DISPONIBLE);
    return new Response(economiaACsv(r), {
      status: 200,
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="cfo-economia-clientes-${mes}.csv"`,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  });

  // POST (no GET): cada llamada puede gastar en el modelo. Solo superadmin completo (la zona CFO no lo abre al rol `finanzas`). Queda en la
  // bitacora de la zona CFO ANTES de responder; si la bitacora falla, no se responde con datos.
  app.post("/superadmin/cfo/recomendaciones", async (c) => {
    const mes = parseMesCockpit(c.req.query("mes"));
    const callerId = c.get("userId");
    const allowed = await rateLimit(`admin:cfo-recomendaciones:${requestActor(c.req.raw, callerId)}`, RECOMENDACIONES_RATE_LIMIT.max, RECOMENDACIONES_RATE_LIMIT.windowMs, { category: "admin" });
    if (!allowed) throw Errors.tooManyRequests("Demasiadas solicitudes de recomendaciones en poco tiempo.");
    const cockpit = await cockpitDelMes(deps, callerId, mes);
    if (cockpit === null) return c.json({ disponible: false, mes, mensaje: COCKPIT_NO_DISPONIBLE });
    const r = await generarRecomendaciones(cockpit, deps.recomendacionesCfoLlmGateway);
    if (deps.cfoZoneRepo) {
      const zona = deps.cfoZoneRepo;
      const log = await deps.engine
        .withAppSession({ userId: callerId }, (db) => zona(db).logAccess(callerId, "consulta", "cfo/recomendaciones", { mes, fuente: r.fuente, recomendaciones: r.recomendaciones.length }))
        .catch(() => null);
      if (log === null) throw Errors.serviceUnavailable("No se pudo registrar la consulta en la bitácora de la zona CFO; por seguridad no se muestran las recomendaciones.");
    }
    return c.json({ disponible: true, mes, ...r });
  });

  // Excel (economia, comparativos, serie de MRR, cohortes y supuestos) y PDF mensual de inversionistas (sin nombres de clientes).
  // Step-up (SENSITIVE_ROUTES) y bitacora `exportacion` de la zona CFO antes de llegar aqui.
  for (const [ruta, tipo] of [["/superadmin/cfo/cockpit/export.xlsx", "xlsx"], ["/superadmin/cfo/cockpit/informe.pdf", "pdf"]] as const) {
    app.get(ruta, async (c) => {
      const mes = parseMesCockpit(c.req.query("mes"));
      const callerId = c.get("userId");
      const allowed = await rateLimit(`admin:cfo-cockpit-export:${requestActor(c.req.raw, callerId)}`, EXPORT_RATE_LIMIT.max, EXPORT_RATE_LIMIT.windowMs, { category: "admin" });
      if (!allowed) throw Errors.tooManyRequests("Demasiadas exportaciones en poco tiempo.");
      const r = await cockpitDelMes(deps, callerId, mes);
      if (r === null) throw Errors.serviceUnavailable(COCKPIT_NO_DISPONIBLE);
      const ahora = new Date();
      const cuerpo = tipo === "xlsx" ? libroCockpit(r, ahora) : await informeInversionistas(r, ahora);
      return new Response(Buffer.from(cuerpo), {
        status: 200,
        headers: {
          "content-type": tipo === "xlsx" ? XLSX_CONTENT_TYPE : PDF_CONTENT_TYPE,
          "content-disposition": `attachment; filename="${tipo === "xlsx" ? `cfo-plataforma-${mes}.xlsx` : `resumen-inversionistas-${mes}.pdf`}"`,
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        },
      });
    });
  }

  app.get("/superadmin/cfo/supuestos", async (c) => {
    if (!deps.cfoCockpitRepo) return c.json({ disponible: false, mensaje: SUPUESTOS_NO_DISPONIBLE, supuestos: [] });
    const repo = deps.cfoCockpitRepo;
    const callerId = c.get("userId");
    const r = await deps.engine.withAppSession({ userId: callerId }, (db) => repo(db).listSupuestos(callerId));
    if (r.availability === "not_migrated") return c.json({ disponible: false, mensaje: SUPUESTOS_NO_DISPONIBLE, supuestos: [] });
    return c.json({ disponible: true, supuestos: r.supuestos });
  });

  app.get("/superadmin/cfo/capturas", async (c) => {
    const desde = parseMesOpcional(c.req.query("desde"), sumarMeses(mesActualUtc(), -11));
    const hasta = parseMesOpcional(c.req.query("hasta"), sumarMeses(mesActualUtc(), 12));
    if (hasta < desde) throw Errors.validation("hasta no puede ser anterior a desde.");
    if (!deps.cfoCockpitRepo) return c.json({ disponible: false, mensaje: SUPUESTOS_NO_DISPONIBLE, capturas: [] });
    const repo = deps.cfoCockpitRepo;
    const callerId = c.get("userId");
    const r = await deps.engine.withAppSession({ userId: callerId }, (db) => repo(db).listCapturas(callerId, `${desde}-01`, `${hasta}-01`));
    if (r.availability === "not_migrated") return c.json({ disponible: false, mensaje: SUPUESTOS_NO_DISPONIBLE, capturas: [] });
    return c.json({ disponible: true, capturas: r.capturas });
  });

  async function limitarMutacion(c: Context<CoreAuthHonoEnv>, recurso: string) {
    const allowed = await rateLimit(`admin:cfo-${recurso}:${requestActor(c.req.raw, c.get("userId"))}`, MUTACION_RATE_LIMIT.max, MUTACION_RATE_LIMIT.windowMs, { category: "admin" });
    if (!allowed) throw Errors.tooManyRequests("Demasiados cambios en poco tiempo.");
  }

  // Sensible (step-up): un costo unitario o un umbral mueve el margen y las alertas de toda la plataforma.
  app.put("/superadmin/cfo/supuestos", async (c) => {
    if (!deps.cfoCockpitRepo) throw Errors.serviceUnavailable(SUPUESTOS_NO_DISPONIBLE);
    const repo = deps.cfoCockpitRepo;
    const callerId = c.get("userId");
    await limitarMutacion(c, "supuestos");
    const raw = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    if (typeof raw.clave !== "string" || !(CLAVES_SUPUESTO_CFO as readonly string[]).includes(raw.clave)) throw Errors.validation(`clave debe ser una de: ${CLAVES_SUPUESTO_CFO.join(", ")}.`);
    const clave = raw.clave as ClaveSupuestoCfo;
    const proveedor = raw.proveedor === undefined || raw.proveedor === null || raw.proveedor === "" ? "*" : String(raw.proveedor).trim();
    if (!PROVEEDOR_RE.test(proveedor)) throw Errors.validation("proveedor inválido (minúsculas, números, punto o guion).");
    if (proveedor !== "*" && clave !== "voz_usd_minuto" && clave !== "telefonia_usd_minuto") throw Errors.validation("Solo la voz y la telefonía distinguen proveedor.");
    let valor: number | null;
    if (raw.valor === null) valor = null;
    else if (typeof raw.valor === "number" && Number.isFinite(raw.valor) && raw.valor >= 0 && raw.valor <= (clave.startsWith("umbral_") ? 1000 : 1_000_000)) valor = raw.valor;
    else throw Errors.validation("valor debe ser un número no negativo (o null para volver al valor medido).");
    const fuente = valor === null ? "borrado" : texto(raw.fuente, "fuente", 3, 200);
    const nota = notaOpcional(raw.nota);
    try {
      const r = await deps.engine.withAppSession({ userId: callerId }, (db) => repo(db).setSupuesto(callerId, clave, proveedor, valor, fuente, nota));
      if (r.availability === "not_migrated") throw Errors.serviceUnavailable(SUPUESTOS_NO_DISPONIBLE);
      return c.json({ ok: true });
    } catch (err) {
      return traducirErrorSeguridad(err);
    }
  });

  // Sensible (step-up): gasto fijo, marketing, caja y presupuesto mueven burn, runway, CAC y plan contra real.
  app.put("/superadmin/cfo/capturas", async (c) => {
    if (!deps.cfoCockpitRepo) throw Errors.serviceUnavailable(SUPUESTOS_NO_DISPONIBLE);
    const repo = deps.cfoCockpitRepo;
    const callerId = c.get("userId");
    await limitarMutacion(c, "capturas");
    const raw = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const mes = typeof raw.mes === "string" ? raw.mes : "";
    if (!MES_RE.test(mes)) throw Errors.validation("mes debe tener formato YYYY-MM.");
    if (typeof raw.tipo !== "string" || !(TIPOS_CAPTURA_CFO as readonly string[]).includes(raw.tipo)) throw Errors.validation(`tipo debe ser uno de: ${TIPOS_CAPTURA_CFO.join(", ")}.`);
    const tipo = raw.tipo as TipoCapturaCfo;
    if (!tipo.startsWith("presupuesto_") && mes > mesActualUtc()) throw Errors.validation("Solo el presupuesto admite meses futuros.");
    if (mes > sumarMeses(mesActualUtc(), 24)) throw Errors.validation("mes fuera de rango.");
    const concepto = texto(raw.concepto, "concepto", 2, 80);
    let centavos: number | null;
    if (raw.montoMxn === null) centavos = null;
    else {
      if (typeof raw.montoMxn !== "number" || !Number.isFinite(raw.montoMxn) || raw.montoMxn < 0 || raw.montoMxn > MAX_MONTO_MXN) throw Errors.validation("montoMxn debe ser un número entre 0 y 1,000,000,000 (o null para borrar).");
      centavos = Math.round(raw.montoMxn * 100);
      if (Math.abs(raw.montoMxn * 100 - centavos) > 1e-6) throw Errors.validation("montoMxn admite como máximo 2 decimales.");
    }
    const nota = notaOpcional(raw.nota);
    try {
      const r = await deps.engine.withAppSession({ userId: callerId }, (db) => repo(db).setCaptura(callerId, `${mes}-01`, tipo, concepto, centavos, nota));
      if (r.availability === "not_migrated") throw Errors.serviceUnavailable(SUPUESTOS_NO_DISPONIBLE);
      return c.json({ ok: true });
    } catch (err) {
      return traducirErrorSeguridad(err);
    }
  });

  return app;
}

function parseMesOpcional(raw: string | undefined, porOmision: string): string {
  if (raw === undefined || raw === "") return porOmision;
  if (!MES_RE.test(raw)) throw Errors.validation("desde/hasta deben tener formato YYYY-MM.");
  return raw;
}
