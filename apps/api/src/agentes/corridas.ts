// Bitacora de corridas de agentes (SA-L-07): lo que escriben withHeartbeat (cada corrida de cron) y los puntos
// unicos de salida del turno de los agentes de WhatsApp (restaurantes, hoteles, citas) y el borrador de mensajeria
// de rentas. Ver packages/db/migrations/0044_superadmin_corridas_y_panel_agentes.sql.
//
// REGLA DURA: escribir la bitacora es best-effort. Un fallo (tabla sin migrar, conexion caida, error de SQL) NUNCA
// tumba ni altera la corrida real: se traga, se deja un rastro en logs (solo el SQLSTATE, nunca el mensaje) y la
// corrida sigue como si la bitacora no existiera. Contra la base sin migrar (la 0044 sin aplicar) la escritura se
// omite en silencio.
//
// TRANSACCIONES: cada escritura abre una sesion de SISTEMA PROPIA (`withAppSession({ userId: null })`), separada de la
// transaccion de la operacion que se mide (el turno de WhatsApp o la ruta de rentas bajo `dbSession`): un error al
// escribir aqui no puede dejar abortada una transaccion ajena. Dentro de esa sesion propia el repositorio usa
// SAVEPOINT, y la consulta del aviso in-app corre en OTRA sesion, despues de confirmar la corrida.
import { emitirNotificacion, type DisparoCorrida, type EstadoCorrida } from "@atiende/db";
import type { AppDeps } from "../deps.ts";

/** Lo unico que la bitacora necesita de las dependencias (asi production/deps.ts puede usarla antes de armar AppDeps). */
export type DepsBitacora = Pick<AppDeps, "engine" | "agentRunRepo">;

const MAX_ERROR = 500;

/**
 * Redacta un texto de error para la bitacora: sin correos, telefonos, tokens ni secuencias largas de digitos, y a
 * 500 caracteres o menos. Es la primera barrera; core.record_agent_run aplica otra en la base.
 */
export function redactarErrorCorrida(err: unknown): string {
  const crudo = err instanceof Error ? err.message : typeof err === "string" ? err : "error desconocido";
  let t = crudo.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[correo]");
  t = t.replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "[credencial]");
  t = t.replace(/\b(?:sk|pk|rk|key|token|secret)[-_][A-Za-z0-9_-]{8,}/gi, "[credencial]");
  t = t.replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[credencial]");
  t = t.replace(/\+?[0-9]{7,}/g, "[numero]");
  t = t.replace(/\(?[0-9]{2,4}\)?[ -][0-9]{3,4}[ -][0-9]{4}/g, "[numero]");
  t = t.replace(/\s+/g, " ").trim();
  if (t.length === 0) t = "error desconocido";
  return t.length > MAX_ERROR ? `${t.slice(0, MAX_ERROR - 1)}…` : t;
}

export interface CorridaMedida {
  readonly agente: string;
  readonly vertical: string;
  readonly organizationId?: string | null;
  readonly disparo: DisparoCorrida;
  readonly estado: EstadoCorrida;
  readonly tareasHechas?: number | null;
  readonly tareasTotal?: number | null;
  readonly costoMicroUsd?: number | null;
  /** Crudo: se redacta aqui. */
  readonly error?: unknown;
  readonly iniciadoEn: Date;
  readonly terminadoEn: Date;
}

/** Aviso in-app a los superadmins: una corrida en `fallo` de un agente `vivo` (dedupe por agente y dia, sin PII:
 *  solo el id del agente viaja en el texto). Best-effort y en su propia sesion. */
async function avisarFalloDeAgenteBestEffort(deps: DepsBitacora, agente: string, ahora: Date): Promise<void> {
  const repoFactory = deps.agentRunRepo;
  if (!repoFactory) return;
  try {
    const vivo = await deps.engine.withAppSession({ userId: null }, (db) => repoFactory(db).agenteVivo(agente));
    if (vivo !== true) return;
    await deps.engine.withAppSession({ userId: null }, (db) =>
      emitirNotificacion(db, { evento: "superadmin.agente.fallo", organizationId: null, clave: `${agente}:${ahora.toISOString().slice(0, 10)}`, parametros: { agente } }),
    );
  } catch {
    // best-effort
  }
}

/**
 * Escribe una corrida en core.agent_run. NUNCA lanza. Los crons NO emiten el aviso `superadmin.agente.fallo`
 * (withHeartbeat ya emite `superadmin.cron.fallo`); los turnos y borradores de agentes si, cuando fallan.
 */
export async function registrarCorridaBestEffort(deps: DepsBitacora, c: CorridaMedida): Promise<void> {
  const repoFactory = deps.agentRunRepo;
  if (!repoFactory) return;
  try {
    await deps.engine.withAppSession({ userId: null }, (db) =>
      repoFactory(db).registrarCorrida({
        agente: c.agente,
        vertical: c.vertical,
        organizationId: c.organizationId ?? null,
        disparo: c.disparo,
        estado: c.estado,
        tareasHechas: c.tareasHechas ?? null,
        tareasTotal: c.tareasTotal ?? null,
        costoMicroUsd: c.costoMicroUsd ?? null,
        error: c.estado === "ok" || c.error === undefined || c.error === null ? null : redactarErrorCorrida(c.error),
        iniciadoEn: c.iniciadoEn,
        terminadoEn: c.terminadoEn,
      }),
    );
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err ? String((err as { code?: unknown }).code) : "desconocido";
    console.error(`agentes/corridas: no se pudo registrar la corrida de "${c.agente}" (SQLSTATE ${code}); la corrida real no se altera.`);
    return;
  }
  if (c.estado === "fallo" && c.disparo !== "cron") await avisarFalloDeAgenteBestEffort(deps, c.agente, c.terminadoEn);
}

/** Vertical de una ruta de cron `/internal/<vertical>/...` (`plataforma` para `/internal/whatsapp/...` y `/internal/superadmin/...`). */
export function verticalDeCron(cronName: string): string {
  const m = /^\/internal\/([a-z0-9_-]+)\//.exec(cronName);
  const v = m?.[1] ?? "plataforma";
  return ["restaurantes", "hoteles", "rentas", "citas", "despachos", "licitaciones"].includes(v) ? v : "plataforma";
}

/**
 * Envuelve el UNICO punto de entrada del turno de un agente de WhatsApp (`handleInboundMessage`): mide la duracion,
 * registra `ok` o `fallo` (el error se RELANZA tal cual, igual que sin el envoltorio) y no cambia el resultado.
 */
export function conBitacoraDeTurno<A extends { readonly organizationId: string }, R, H extends { handleInboundMessage(args: A): Promise<R> }>(
  handler: H,
  opciones: { readonly deps: DepsBitacora; readonly agente: string; readonly vertical: string; readonly ahora?: () => Date },
): H {
  const ahora = opciones.ahora ?? (() => new Date());
  return {
    ...handler,
    handleInboundMessage: async (args: A): Promise<R> => {
      const iniciadoEn = ahora();
      try {
        const resultado = await handler.handleInboundMessage(args);
        await registrarCorridaBestEffort(opciones.deps, { agente: opciones.agente, vertical: opciones.vertical, organizationId: args.organizationId, disparo: "whatsapp", estado: "ok", iniciadoEn, terminadoEn: ahora() });
        return resultado;
      } catch (err) {
        await registrarCorridaBestEffort(opciones.deps, { agente: opciones.agente, vertical: opciones.vertical, organizationId: args.organizationId, disparo: "whatsapp", estado: "fallo", error: err, iniciadoEn, terminadoEn: ahora() });
        throw err;
      }
    },
  };
}
