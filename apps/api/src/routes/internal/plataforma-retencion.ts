// Purga por retencion de la PLATAFORMA (PL-13), lado SISTEMA (sin authMiddleware: el llamador es el
// scheduler o un operador). Autenticacion: secreto interno (`INTERNAL_SECRET`) o de cron, comparado en tiempo constante.
//
//   GET|POST /internal/plataforma/privacidad-retencion
//        ?ejecutar=1            purga de verdad y SOLO por POST (un GET con efecto de borrado podria dispararse por
//                               prefetch o reintento; GET + ejecutar=1 responde 400); SIN la bandera solo SIMULA (GET o POST)
//        &organizationId=<uuid> una sola organizacion (si no, recorre todas con clases de plataforma)
//        &despuesDe=<uuid>      cursor devuelto como `siguienteDespuesDe` cuando quedan organizaciones
//        &limite=<n>            filas por (organizacion, clase), 1..5000 (por defecto 500)
//
// NO esta registrado en vercel.json: programarlo es una decision de costo y despliegue. Cada
// (organizacion, clase) corre en SU PROPIA transaccion de sistema (`userId: null`), de modo que un error en una
// unidad no revierte las ya purgadas ni deja la sesion abortada. El bloqueo previo (retencion legal activa) y la
// proteccion de titulares con ARCO abierta los aplica el SQL (core.system_run_retention_purge); cada llamada queda en
// core.purge_run_log sin PII. Base sin migrar: responde `disponible: false` y no toca nada.
import { Hono } from "hono";
import { PlataformaPrivacidadError } from "@atiende/db";
import { Errors } from "../../errors.ts";
import { internalOrCronSecretMatches } from "../../http-security.ts";
import { logEvent } from "../../logger.ts";
import type { AppDeps } from "../../deps.ts";

export const PLATAFORMA_RETENCION_PATH = "/internal/plataforma/privacidad-retencion";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const ORGS_POR_PAGINA = 25;
const LIMITE_DEFAULT = 500;
const LIMITE_MAX = 5000;

interface Resultado {
  readonly organizationId: string;
  readonly claseDato: string;
  readonly estado: string;
  readonly retencionDias: number | null;
  readonly filasAfectadas: number;
  readonly filasAnonimizadas: number;
  readonly filasProtegidas: number;
  readonly error?: string;
}

export function plataformaRetencionRoutes(deps: AppDeps): Hono {
  const app = new Hono();

  app.on(["GET", "POST"], PLATAFORMA_RETENCION_PATH, async (c) => {
    if (!internalOrCronSecretMatches(c.req.raw, deps.env.internalSecret)) throw Errors.unauthorized();
    const repoFor = deps.privacidadPlataformaRepo;
    if (!repoFor) return c.json({ ok: true, disponible: false, resultados: [] });

    const url = new URL(c.req.url);
    const ejecutar = url.searchParams.get("ejecutar") === "1";
    if (ejecutar && c.req.method !== "POST") throw Errors.validation("ejecutar=1 exige el metodo POST (GET solo simula).");
    const org = url.searchParams.get("organizationId");
    const despuesDe = url.searchParams.get("despuesDe");
    for (const [campo, valor] of [["organizationId", org], ["despuesDe", despuesDe]] as const) {
      if (valor !== null && !UUID_RE.test(valor)) throw Errors.validation(`${campo}: se esperaba un UUID.`);
    }
    const limiteRaw = url.searchParams.get("limite");
    let limite = LIMITE_DEFAULT;
    if (limiteRaw !== null) {
      if (!/^\d{1,5}$/u.test(limiteRaw) || Number(limiteRaw) < 1) throw Errors.validation("limite debe ser un entero >= 1.");
      limite = Math.min(LIMITE_MAX, Number(limiteRaw));
    }

    // 1) Objetivos (una transaccion propia de solo lectura).
    const objetivos = await deps.engine.withAppSession({ userId: null }, (db) => repoFor(db).listPurgeTargets(despuesDe, ORGS_POR_PAGINA, org));
    if (objetivos.availability === "not_migrated") return c.json({ ok: true, disponible: false, resultados: [] });
    const pares = objetivos.targets;
    const orgsEnPagina = [...new Set(objetivos.targets.map((t) => t.organizationId))];
    const siguienteDespuesDe = org === null && orgsEnPagina.length === ORGS_POR_PAGINA ? (orgsEnPagina[orgsEnPagina.length - 1] ?? null) : null;

    // 2) Una transaccion POR (organizacion, clase).
    const resultados: Resultado[] = [];
    for (const par of pares) {
      try {
        const salida = await deps.engine.withAppSession({ userId: null }, (db) => repoFor(db).runRetentionPurge(par.organizationId, par.dataClass, !ejecutar, limite));
        if (salida.availability === "not_migrated" || !salida.result) {
          return c.json({ ok: true, disponible: false, resultados });
        }
        resultados.push({
          organizationId: par.organizationId,
          claseDato: par.dataClass,
          estado: salida.result.status,
          retencionDias: salida.result.retentionDays,
          filasAfectadas: salida.result.rowsAffected,
          filasAnonimizadas: salida.result.rowsAnonymized,
          filasProtegidas: salida.result.rowsProtected,
        });
      } catch (err) {
        logEvent(c, "error", "plataforma_retencion_unidad_fallida", { organizationId: par.organizationId, claseDato: par.dataClass, code: err instanceof PlataformaPrivacidadError ? err.code : "error" });
        resultados.push({ organizationId: par.organizationId, claseDato: par.dataClass, estado: "error", retencionDias: null, filasAfectadas: 0, filasAnonimizadas: 0, filasProtegidas: 0, error: "fallo_inesperado" });
      }
    }

    return c.json({
      ok: true,
      disponible: true,
      modo: ejecutar ? "ejecucion" : "simulacion",
      unidades: resultados.length,
      errores: resultados.filter((r) => r.estado === "error").length,
      bloqueadas: resultados.filter((r) => r.estado === "bloqueada").length,
      filasAfectadas: resultados.reduce((a, r) => a + r.filasAfectadas, 0),
      filasProtegidas: resultados.reduce((a, r) => a + r.filasProtegidas, 0),
      siguienteDespuesDe,
      resultados,
    });
  });

  return app;
}
