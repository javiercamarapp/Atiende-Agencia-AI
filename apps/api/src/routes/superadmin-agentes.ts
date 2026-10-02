// Panel de agentes (SA-L-08) y bitacora de corridas (SA-L-07) del superadmin:
//   GET /superadmin/agentes          -- una fila por agente del catalogo (core.agent_definition) con modelo, ultima
//                                       corrida, exito y costo de 30 dias, presupuesto/dia y el estado REAL de su
//                                       interruptor (core.platform_switch, scope 'agente').
//   GET /superadmin/agentes/corridas -- corridas recientes (core.agent_run), filtrables; cada fila trae su traza.
// La palanca NO tiene ruta propia: usa PUT /superadmin/interruptores (motivo de 20+ caracteres, step-up y bitacora).
//
// Va detras de la cadena de routes/superadmin.ts (autenticacion, gateo de superadmin, guard de impersonacion, zona
// CFO y step-up): son lecturas y no estan en RUTAS_FINANCIERAS. Ver packages/db/migrations/0044_*.sql y
// docs/SUPERADMIN_AGENTES.md.
//
// REGLA DE LA CASA: nunca inventar una cifra. Base sin migrar (la 0044 sin aplicar): 200 con `disponible: false`, lista
// vacia y la razon; el interruptor de cada agente se lee aparte (puede existir aunque la 0044 no).
import { Hono } from "hono";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import type { AgentPanelRow, AgentRunRow, EstadoCorrida, PlatformSwitchRow } from "@atiende/db";
import { Errors } from "../errors.ts";
import { isSwitchableTarget } from "../platform-switches.ts";
import { resolveRoleRoute } from "../production/llm-models.ts";
import { hoyMexico } from "./superadmin-consola.ts";
import type { AppDeps } from "../deps.ts";

const RAZON_NO_MIGRADO = "No disponible aún: falta aplicar la migración 0044_superadmin_corridas_y_panel_agentes en este despliegue.";
const RAZON_ERROR = "No se pudo leer esta fuente; intenta de nuevo en un momento.";
const ESTADOS = new Set<EstadoCorrida>(["ok", "parcial", "fallo"]);
const VERTICAL_RE = /^[a-z][a-z0-9_]{0,39}$/;
const AGENTE_RE = /^[A-Za-z0-9_:/.-]{3,120}$/;
const LIMITE_MAXIMO = 200;
const LIMITE_DEFECTO = 50;

const usd = (micro: number): number => Math.round(micro) / 1_000_000;

function serializarCorrida(r: AgentRunRow) {
  return {
    id: r.id,
    agente: r.agente,
    vertical: r.vertical,
    organizationId: r.organizationId,
    disparo: r.disparo,
    estado: r.estado,
    tareasHechas: r.tareasHechas,
    tareasTotal: r.tareasTotal,
    costoUsd: r.costoMicroUsd === null ? null : usd(r.costoMicroUsd),
    error: r.error,
    iniciadoEn: r.iniciadoEn,
    terminadoEn: r.terminadoEn,
    duracionMs: r.duracionMs,
  };
}

export function superadminAgentesRoutes(deps: AppDeps, opciones: { readonly ahora?: () => Date } = {}): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  const ahora = opciones.ahora ?? (() => new Date());

  function modeloDe(rol: string): string | null {
    if (deps.modeloPrincipalDeRol) return deps.modeloPrincipalDeRol(rol);
    return resolveRoleRoute(rol, undefined).models[0]?.model ?? null;
  }

  app.get("/superadmin/agentes", async (c) => {
    const callerId = c.get("userId");
    const now = ahora();
    const hoy = hoyMexico(now);

    const panel = deps.agentRunRepo
      ? await deps.engine.withAppSession({ userId: callerId }, (db) => deps.agentRunRepo!(db).panel(callerId, hoy))
      : ({ ok: false, razon: "no_migrado" } as const);

    // El interruptor se lee en su propia sesion: es otra fuente (migracion 0025) y no debe contaminar a la anterior.
    let interruptores: ReadonlyMap<string, PlatformSwitchRow> | null = null;
    if (deps.platformSwitchRepo) {
      const repo = deps.platformSwitchRepo;
      try {
        const r = await deps.engine.withAppSession({ userId: callerId }, (db) => repo(db).list(callerId));
        if (r.availability === "available") interruptores = new Map(r.switches.filter((s) => s.scope === "agente").map((s) => [s.target, s]));
      } catch {
        interruptores = null;
      }
    }

    const filas: readonly AgentPanelRow[] = panel.ok ? panel.data : [];
    return c.json({
      disponible: panel.ok,
      ...(panel.ok ? {} : { razon: panel.razon === "no_migrado" ? RAZON_NO_MIGRADO : RAZON_ERROR }),
      generadoEn: now.toISOString(),
      hoy,
      interruptoresDisponible: interruptores !== null,
      agentes: filas.map((a) => {
        const sw = interruptores?.get(a.id) ?? null;
        return {
          id: a.id,
          nombre: a.nombre,
          vertical: a.vertical,
          canal: a.canal,
          disparador: a.disparador,
          estado: a.estado,
          modelo: modeloDe(a.modeloRol),
          ultimaCorrida: a.ultimaCorridaEn === null ? null : { en: a.ultimaCorridaEn, estado: a.ultimaCorridaEstado },
          // null = no hay palanca real: el interruptor no se pudo leer (migracion 0025 sin aplicar o error) o el rol no esta
          // en el catalogo de interruptores (PUT /superadmin/interruptores lo rechazaria). NUNCA "no bloqueado" por omision.
          interruptor: interruptores === null || !isSwitchableTarget("agente", a.id) ? null : sw ? { bloqueado: sw.blocked, motivo: sw.reason, actualizadoEnMs: sw.updatedAtMs } : { bloqueado: false, motivo: null, actualizadoEnMs: null },
          exito30d: { corridas: a.corridas30d, ok: a.corridasOk30d, porcentaje: a.corridas30d > 0 ? Math.round((a.corridasOk30d / a.corridas30d) * 1000) / 10 : null },
          costo30dUsd: usd(a.costo30dMicroUsd),
          llamadas30d: a.llamadas30d,
          presupuestoDiaUsd: a.presupuestoDiaMicroUsd === null ? null : usd(a.presupuestoDiaMicroUsd),
          insumos: "fuera de alcance" as const,
        };
      }),
      notas: [
        "Éxito 30 días = corridas ok entre corridas registradas en core.agent_run; solo los agentes cuyo punto de salida escribe la bitácora tienen corridas (ver docs/SUPERADMIN_AGENTES.md).",
        "Costo 30 días = suma de core.llm_usage_daily del rol del agente y su variante escalada.",
      ],
    });
  });

  app.get("/superadmin/agentes/corridas", async (c) => {
    const callerId = c.get("userId");
    const agente = c.req.query("agente");
    const vertical = c.req.query("vertical");
    const estado = c.req.query("estado");
    const limiteRaw = c.req.query("limite");
    if (agente !== undefined && !AGENTE_RE.test(agente)) throw Errors.validation("agente inválido.");
    if (vertical !== undefined && !VERTICAL_RE.test(vertical)) throw Errors.validation("vertical inválida.");
    if (estado !== undefined && !ESTADOS.has(estado as EstadoCorrida)) throw Errors.validation("estado debe ser ok, parcial o fallo.");
    let limite = LIMITE_DEFECTO;
    if (limiteRaw !== undefined) {
      const n = Number(limiteRaw);
      if (!Number.isInteger(n) || n < 1 || n > LIMITE_MAXIMO) throw Errors.validation(`limite debe ser un entero entre 1 y ${LIMITE_MAXIMO}.`);
      limite = n;
    }

    const r = deps.agentRunRepo
      ? await deps.engine.withAppSession({ userId: callerId }, (db) =>
          deps.agentRunRepo!(db).listarCorridas(callerId, { agente: agente ?? null, vertical: vertical ?? null, estado: (estado as EstadoCorrida | undefined) ?? null, limite }),
        )
      : ({ ok: false, razon: "no_migrado" } as const);

    return c.json({
      disponible: r.ok,
      ...(r.ok ? {} : { razon: r.razon === "no_migrado" ? RAZON_NO_MIGRADO : RAZON_ERROR }),
      corridas: r.ok ? r.data.map(serializarCorrida) : [],
    });
  });

  return app;
}
