// POST /v1/csp-report -- colector de violaciones de la CSP de la SPA (`vercel.json`, `report-uri` y
// `report-to csp`). Acepta los dos formatos que mandan los navegadores:
//   - `report-uri` (Firefox/Safari): `Content-Type: application/csp-report`, cuerpo `{ "csp-report": { ... } }`.
//   - Reporting API (`report-to`, Chromium): `Content-Type: application/reports+json`, cuerpo `[{ type: "csp-violation", body: { ... } }]`.
// Solo registra un resumen SIN datos personales ni tokens: directiva, ORIGEN del recurso bloqueado (o su palabra clave:
// inline, eval, data, blob...), RUTA del documento (sin query ni fragmento) y si fue enforce o report. Nunca guarda el cuerpo
// crudo ni `sample`/`script-sample` (fragmentos de código de la página). Público y sin sesión (el navegador no manda
// credenciales en los reportes): por eso tope de tamaño, tope de reportes por petición y rate limit por IP.
import { Hono } from "hono";
import { rateLimit } from "@atiende/core-ratelimit";
import { Errors } from "../errors.ts";
import { readTextCapped, requestActor } from "../http-security.ts";
import { logEvent } from "../logger.ts";

export const CSP_REPORT_PATH = "/v1/csp-report";
const MAX_BYTES = 16 * 1024;
const MAX_REPORTES_POR_PETICION = 10;
const RATE = { max: 30, windowMs: 60_000 } as const;

export interface ViolacionCsp {
  readonly directiva: string;
  readonly bloqueado: string;
  readonly documento: string;
  readonly disposicion: string;
}

function texto(v: unknown, max = 200): string {
  return typeof v === "string" ? v.slice(0, max) : "";
}

/** Reduce una URL bloqueada a su origen; deja las palabras clave del navegador (inline, eval, data, blob, self...). */
export function resumirBloqueado(raw: string): string {
  const v = raw.trim();
  if (v.length === 0) return "desconocido";
  if (/^[a-z-]+$/iu.test(v)) return v.toLowerCase();
  try {
    const u = new URL(v);
    if (u.protocol === "data:" || u.protocol === "blob:") return u.protocol.slice(0, -1);
    return u.origin === "null" ? u.protocol.slice(0, -1) : u.origin;
  } catch {
    return "invalido";
  }
}

/** Solo la ruta del documento: nunca query (tokens de enlace, magic links) ni fragmento. */
export function resumirDocumento(raw: string): string {
  try {
    return new URL(raw).pathname.slice(0, 200);
  } catch {
    return "desconocido";
  }
}

function desdeCuerpo(b: Record<string, unknown>, formatoReporting: boolean): ViolacionCsp {
  const directiva = formatoReporting
    ? texto(b["effectiveDirective"]) || texto(b["violatedDirective"])
    : texto(b["effective-directive"]) || texto(b["violated-directive"]);
  const bloqueado = formatoReporting ? texto(b["blockedURL"], 2048) : texto(b["blocked-uri"], 2048);
  const documento = formatoReporting ? texto(b["documentURL"], 2048) : texto(b["document-uri"], 2048);
  const disposicion = texto(b["disposition"]) || "desconocida";
  return { directiva: directiva.split(" ")[0] || "desconocida", bloqueado: resumirBloqueado(bloqueado), documento: resumirDocumento(documento), disposicion };
}

const esObjeto = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Extrae las violaciones de cualquiera de los dos formatos; lo que no reconoce lo ignora. */
export function extraerViolaciones(cuerpo: unknown): ViolacionCsp[] {
  if (esObjeto(cuerpo) && esObjeto(cuerpo["csp-report"])) return [desdeCuerpo(cuerpo["csp-report"], false)];
  if (Array.isArray(cuerpo)) {
    return cuerpo
      .filter((r): r is Record<string, unknown> => esObjeto(r) && r["type"] === "csp-violation" && esObjeto(r["body"]))
      .slice(0, MAX_REPORTES_POR_PETICION)
      .map((r) => desdeCuerpo(r["body"] as Record<string, unknown>, true));
  }
  return [];
}

export function cspReportRoutes(): Hono {
  const app = new Hono();
  app.post(CSP_REPORT_PATH, async (c) => {
    const allowed = await rateLimit(`csp-report:${requestActor(c.req.raw)}`, RATE.max, RATE.windowMs, { category: "csp:report" });
    if (!allowed) throw Errors.tooManyRequests("Demasiados reportes de CSP.");
    const raw = await readTextCapped(c.req.raw, MAX_BYTES);
    let cuerpo: unknown;
    try {
      cuerpo = JSON.parse(raw);
    } catch {
      throw Errors.validation("Reporte de CSP inválido.");
    }
    for (const v of extraerViolaciones(cuerpo)) logEvent(c, "warn", "csp_violacion", { ...v });
    return c.body(null, 204);
  });
  return app;
}
