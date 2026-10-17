// Purga por retencion de la PLATAFORMA (PL-13), lado SISTEMA (sin authMiddleware: el llamador es el
// scheduler o un operador). Autenticacion: secreto interno (`INTERNAL_SECRET`) o de cron, comparado en tiempo constante.
//
//   GET|POST /internal/plataforma/privacidad-retencion
//        ?ejecutar=1            purga de verdad. Por POST, o por GET SOLO si la llamada trae `Authorization: Bearer <secreto>`
//                               (la forma en que Vercel Cron invoca; ver abajo). Un GET con ?ejecutar=1 sin ese header responde 400.
//        ?ejecutar=0            fuerza la SIMULACION aunque sea un GET con Bearer
//        (sin ejecutar)         POST o GET sin Bearer: SIMULA; GET con Bearer (Vercel Cron, sin query): EJECUTA
//        &organizationId=<uuid> una sola organizacion (si no, recorre todas con clases de plataforma)
//        &despuesDe=<uuid>      cursor devuelto como `siguienteDespuesDe` cuando quedan organizaciones
//        &limite=<n>            filas por (organizacion, clase), 1..5000 (por defecto 500)
//
// PL-35: agendado en vercel.json (diario) y detenible por interruptor (SWITCHABLE_CRONS, `withHeartbeat`). Vercel Cron
// invoca por GET con `Authorization: Bearer $CRON_SECRET` (mismo valor que INTERNAL_SECRET, ver http-security.ts) y no
// permite query ni headers propios. La ejecucion por GET exige ESE header: el secreto en `x-atiende-internal-secret`
// (o cualquier otra forma) en un GET solo SIMULA, nunca borra; el secreto jamas se acepta por query. Cada corrida de
// cron procesa un lote ACOTADO (MAX_PAGINAS_CRON paginas de ORGS_POR_PAGINA organizaciones, con presupuesto de tiempo);
// lo que quede lo devuelve `siguienteDespuesDe` (continuacion manual con ?despuesDe=). La purga es idempotente: repetirla
// solo toca filas ya vencidas. Cada
// (organizacion, clase) corre en SU PROPIA transaccion de sistema (`userId: null`), de modo que un error en una
// unidad no revierte las ya purgadas ni deja la sesion abortada. El bloqueo previo (retencion legal activa) y la
// proteccion de titulares con ARCO abierta los aplica el SQL (core.system_run_retention_purge); cada llamada queda en
// core.purge_run_log sin PII. Base sin migrar: responde `disponible: false` y no toca nada.
import { Hono } from "hono";
import { PlataformaPrivacidadError } from "@atiende/db";
import { Errors } from "../../errors.ts";
import { constantTimeEqual, internalOrCronSecretMatches } from "../../http-security.ts";
import { logEvent } from "../../logger.ts";
import { purgarRetencionCitas } from "../verticals/citas/retencion.ts";
import { CronPartialFailureError, withHeartbeat } from "../../salud/with-heartbeat.ts";
import type { AppDeps } from "../../deps.ts";

export const PLATAFORMA_RETENCION_PATH = "/internal/plataforma/privacidad-retencion";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const ORGS_POR_PAGINA = 25;
/** Tope de paginas por corrida de cron (100 organizaciones): acota el tiempo dentro de maxDuration (30 s). */
const MAX_PAGINAS_CRON = 4;
/** Presupuesto de tiempo de una corrida de cron: no abre otra pagina pasado este punto. */
const PRESUPUESTO_CRON_MS = 18_000;
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

/** `Authorization: Bearer <secreto>` valido (comparacion en tiempo constante). Es la UNICA forma en que Vercel Cron
 *  invoca (no admite headers propios ni query), y la unica con la que un GET puede ejecutar la purga. */
function esLlamadaDeCron(req: Request, secreto: string): boolean {
  const auth = req.headers.get("authorization");
  return auth?.startsWith("Bearer ") === true && constantTimeEqual(auth.slice("Bearer ".length), secreto);
}

export function plataformaRetencionRoutes(deps: AppDeps): Hono {
  const app = new Hono();

  app.on(["GET", "POST"], PLATAFORMA_RETENCION_PATH, async (c) => {
    if (!internalOrCronSecretMatches(c.req.raw, deps.env.internalSecret)) throw Errors.unauthorized();
    const repoFor = deps.privacidadPlataformaRepo;
    if (!repoFor) return c.json({ ok: true, disponible: false, resultados: [] });

    const url = new URL(c.req.url);
    const esGet = c.req.method === "GET";
    const cron = esGet && esLlamadaDeCron(c.req.raw, deps.env.internalSecret);
    const bandera = url.searchParams.get("ejecutar");
    if (bandera === "1" && esGet && !cron) throw Errors.validation("ejecutar=1 por GET exige Authorization: Bearer (Vercel Cron); sin ese header usa POST (GET solo simula).");
    // POST: solo con ejecutar=1. GET: solo si es llamada de cron y no se fuerza ejecutar=0 (Vercel Cron no manda query).
    const ejecutar = bandera === "1" || (cron && bandera !== "0");
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

    // Interruptor por path + latido + bitacora de corrida (withHeartbeat). Una pausa responde 200 `skipped`.
    return withHeartbeat(deps, PLATAFORMA_RETENCION_PATH, async () => {
      const resultados: Resultado[] = [];
      // QA R1 citas 07 -- paso extra de la MISMA corrida: purga de datos de salud de citas (no tiene cron propio: vercel.json esta en el
      // tope de 40). Solo en el barrido completo (sin organizationId ni cursor), una vez por corrida; su propio error no impide la
      // purga de la plataforma y deja el latido como parcial.
      const citas = org === null && despuesDe === null ? await purgarRetencionCitas(deps, ejecutar) : undefined;
      if (citas?.error) logEvent(c, "error", "citas_retencion_fallida", {});
      let cursor = despuesDe;
      let siguienteDespuesDe: string | null = null;
      const inicio = Date.now();
      const maxPaginas = cron && org === null ? MAX_PAGINAS_CRON : 1;

      for (let pagina = 0; pagina < maxPaginas; pagina += 1) {
        // 1) Objetivos de la pagina (una transaccion propia de solo lectura).
        const desde = cursor;
        const objetivos = await deps.engine.withAppSession({ userId: null }, (db) => repoFor(db).listPurgeTargets(desde, ORGS_POR_PAGINA, org));
        if (objetivos.availability === "not_migrated") return c.json({ ok: true, disponible: false, resultados, ...(citas ? { citas } : {}) });
        const orgsEnPagina = [...new Set(objetivos.targets.map((t) => t.organizationId))];
        const ultima = orgsEnPagina[orgsEnPagina.length - 1] ?? null;
        siguienteDespuesDe = org === null && orgsEnPagina.length === ORGS_POR_PAGINA ? ultima : null;

        // 2) Una transaccion POR (organizacion, clase).
        for (const par of objetivos.targets) {
          try {
            const salida = await deps.engine.withAppSession({ userId: null }, (db) => repoFor(db).runRetentionPurge(par.organizationId, par.dataClass, !ejecutar, limite));
            if (salida.availability === "not_migrated" || !salida.result) {
              return c.json({ ok: true, disponible: false, resultados, ...(citas ? { citas } : {}) });
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

        cursor = siguienteDespuesDe;
        if (cursor === null || Date.now() - inicio > PRESUPUESTO_CRON_MS) break;
      }

      const errores = resultados.filter((r) => r.estado === "error").length + (citas?.error ? 1 : 0);
      const respuesta = c.json({
        ok: true,
        disponible: true,
        modo: ejecutar ? "ejecucion" : "simulacion",
        unidades: resultados.length,
        errores,
        bloqueadas: resultados.filter((r) => r.estado === "bloqueada").length,
        filasAfectadas: resultados.reduce((a, r) => a + r.filasAfectadas, 0),
        filasProtegidas: resultados.reduce((a, r) => a + r.filasProtegidas, 0),
        siguienteDespuesDe,
        resultados,
        ...(citas ? { citas } : {}),
      });
      // Una unidad que fallo deja el latido como error/parcial (el panel de salud no miente) sin devolver 500: la
      // respuesta ya trae el detalle y Vercel Cron no debe reintentar lo que ya purgo.
      if (ejecutar && errores > 0) throw new CronPartialFailureError(`${errores} unidad(es) de retencion fallaron`, respuesta);
      return respuesta;
    })();
  });

  return app;
}
