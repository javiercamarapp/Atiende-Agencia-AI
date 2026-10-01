// Privacidad de plataforma (PL-13), vista del SUPERADMIN, solo lectura: solicitudes ARCO de TODAS las
// organizaciones con plazos y estados normalizados, resumen por organizacion (ARCO abiertas/vencidas,
// aviso vigente, bloqueos de purga, ultima purga) y registro global de purgas (sin PII).
// Ver packages/db/migrations/0036_plataforma_arco_retencion_aviso.sql y docs/PRIVACIDAD-PLATAFORMA.md.
//
//   GET /superadmin/privacidad/resumen   una fila por organizacion
//   GET /superadmin/privacidad/arco      solicitudes ARCO (abiertas=1, vencidas=1)
//   GET /superadmin/privacidad/purgas    registro de purgas
//
// Autenticacion, gateo de superadmin y corte por rol montados una vez en routes/superadmin.ts sobre
// `/superadmin/*`; la autoridad real sigue en SQL (cero filas a quien no es superadmin completo). Base sin
// migrar: `disponible: false` con mensaje honesto (200), nunca un 500.
import { Hono } from "hono";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { Errors } from "../errors.ts";
import { ARCO_EJECUCION_DIAS, ARCO_POR_VENCER_DIAS, ARCO_RESPUESTA_DIAS, serializarArco } from "../privacidad/plazos.ts";
import type { AppDeps } from "../deps.ts";

export const PRIVACIDAD_NO_DISPONIBLE = "La privacidad de plataforma todavía no está disponible en este despliegue (falta aplicar la migración 0036_plataforma_arco_retencion_aviso).";
const LIMITE_DEFAULT = 50;
const LIMITE_MAX = 200;
const UINT_RE = /^\d{1,15}$/u;

export function entero(raw: string | undefined, campo: string, def: number, min: number, max: number): number {
  if (raw === undefined || raw === "") return def;
  if (!UINT_RE.test(raw)) throw Errors.validation(`${campo} debe ser un entero.`);
  const n = Number(raw);
  if (n < min) throw Errors.validation(`${campo} debe ser un entero >= ${min}.`);
  return Math.min(max, n);
}

export function banderaQuery(raw: string | undefined): boolean {
  return raw === "1" || raw === "true";
}

export const PLAZOS_PRIVACIDAD = { respuestaDias: ARCO_RESPUESTA_DIAS, ejecucionDias: ARCO_EJECUCION_DIAS, porVencerDias: ARCO_POR_VENCER_DIAS } as const;

export function superadminPrivacidadRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  app.get("/superadmin/privacidad/resumen", async (c) => {
    if (!deps.privacidadPlataformaRepo) return c.json({ disponible: false, mensaje: PRIVACIDAD_NO_DISPONIBLE, total: 0, organizaciones: [] });
    const repo = deps.privacidadPlataformaRepo;
    const limite = entero(c.req.query("limite"), "limite", LIMITE_DEFAULT, 1, LIMITE_MAX);
    const desde = entero(c.req.query("desde"), "desde", 0, 0, 1_000_000);
    const callerId = c.get("userId");
    const r = await deps.engine.withAppSession({ userId: callerId }, (db) => repo(db).platformOverview(callerId, limite, desde));
    if (r.availability === "not_migrated") return c.json({ disponible: false, mensaje: PRIVACIDAD_NO_DISPONIBLE, total: 0, organizaciones: [] });
    return c.json({
      disponible: true,
      plazos: PLAZOS_PRIVACIDAD,
      total: r.total,
      organizaciones: r.items.map((o) => ({
        organizacionId: o.organizationId,
        organizacion: o.organizationName,
        vertical: o.vertical,
        arcoAbiertas: o.openArco,
        arcoVencidas: o.overdueArco,
        avisoVersion: o.noticeVersion,
        avisoAceptaciones: o.noticeAcceptances,
        bloqueosActivos: o.activeHolds,
        ultimaPurgaEnMs: o.lastPurgeAtMs,
        ultimaPurgaEstado: o.lastPurgeStatus,
      })),
    });
  });

  app.get("/superadmin/privacidad/arco", async (c) => {
    if (!deps.privacidadPlataformaRepo) return c.json({ disponible: false, mensaje: PRIVACIDAD_NO_DISPONIBLE, total: 0, solicitudes: [] });
    const repo = deps.privacidadPlataformaRepo;
    const limite = entero(c.req.query("limite"), "limite", LIMITE_DEFAULT, 1, LIMITE_MAX);
    const desde = entero(c.req.query("desde"), "desde", 0, 0, 1_000_000);
    const soloVencidas = banderaQuery(c.req.query("vencidas"));
    const soloAbiertas = banderaQuery(c.req.query("abiertas")) || soloVencidas;
    const callerId = c.get("userId");
    const r = await deps.engine.withAppSession({ userId: callerId }, (db) => repo(db).platformListArco(callerId, { onlyOpen: soloAbiertas, onlyOverdue: soloVencidas, limit: limite, offset: desde }));
    if (r.availability === "not_migrated") return c.json({ disponible: false, mensaje: PRIVACIDAD_NO_DISPONIBLE, total: 0, solicitudes: [] });
    const ahora = Date.now();
    return c.json({ disponible: true, plazos: PLAZOS_PRIVACIDAD, total: r.total, solicitudes: r.items.map((row) => serializarArco(row, ahora)) });
  });

  app.get("/superadmin/privacidad/purgas", async (c) => {
    if (!deps.privacidadPlataformaRepo) return c.json({ disponible: false, mensaje: PRIVACIDAD_NO_DISPONIBLE, purgas: [], siguienteAntesDeSeq: null });
    const repo = deps.privacidadPlataformaRepo;
    const limite = entero(c.req.query("limite"), "limite", LIMITE_DEFAULT, 1, LIMITE_MAX);
    const antesRaw = c.req.query("antesDeSeq");
    const antes = antesRaw === undefined || antesRaw === "" ? null : entero(antesRaw, "antesDeSeq", 0, 0, Number.MAX_SAFE_INTEGER);
    const callerId = c.get("userId");
    const r = await deps.engine.withAppSession({ userId: callerId }, (db) => repo(db).platformListPurgeRuns(callerId, limite, antes));
    if (r.availability === "not_migrated") return c.json({ disponible: false, mensaje: PRIVACIDAD_NO_DISPONIBLE, purgas: [], siguienteAntesDeSeq: null });
    return c.json({
      disponible: true,
      purgas: r.items.map((p) => ({
        seq: p.seq,
        organizacionId: p.organizationId,
        organizacion: p.organizationName,
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
      siguienteAntesDeSeq: r.items.length === limite ? (r.items[r.items.length - 1]?.seq ?? null) : null,
    });
  });

  return app;
}
