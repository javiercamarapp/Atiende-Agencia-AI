// Vigilancia de la salud de WhatsApp/Meta enganchada al cron EXISTENTE /internal/whatsapp/dispatch (cada 5 min; sin cron nuevo):
//   * expiracion del token de Meta con avisos a 14, 7 y 1 dia (`@atiende/domain-restaurantes::vigilarTokenMeta`);
//   * mas de 1 % de timeouts del agente en 10 min o 5 fallos seguidos (`vigilarAgenteWhatsapp`).
// Todo es best-effort y en una sesion de sistema PROPIA: un error de Meta o de la base nunca altera la respuesta del despacho.
// La lectura del token va detras de un puerto (`LectorEstadoTokenMeta`): aqui solo vive el adaptador de Graph (`debug_token`, SOLO GET) y el
// token jamas se registra ni se incluye en un mensaje de error. Sin token configurado no hay lector y no se llama a Meta.
import { crearLectorTurnosAgentePostgres, vigilarAgenteWhatsapp, vigilarTokenMeta } from "@atiende/domain-restaurantes";
import type { EstadoTokenMeta, LectorEstadoTokenMeta, LectorTurnosAgente, OpcionesTimeoutsAgente } from "@atiende/domain-restaurantes";
import type { TenantDbSession } from "@atiende/core-tenancy";
import type { AppDeps } from "../deps.ts";

/** Lo minimo que el adaptador necesita del lector de Graph (`MetaGraphWhatsAppReader.solicitar`): una sola puerta de solo lectura. */
export interface SolicitudGraphDeSoloLectura {
  solicitar(method: string, ruta: string): Promise<unknown>;
}

/** Configuracion inyectable de la vigilancia. Todo opcional: ausente = sin esa parte (token) o valor real (turnos, reloj). */
export interface SaludMetaDeps {
  readonly lectorToken?: LectorEstadoTokenMeta;
  /** Fabrica del lector de turnos sobre la sesion de sistema; por omision, el adaptador Postgres. Las pruebas inyectan un doble. */
  readonly lectorTurnos?: (db: TenantDbSession) => LectorTurnosAgente;
  readonly reloj?: () => Date;
  readonly opcionesAgente?: OpcionesTimeoutsAgente;
}

/** Solo el primer tick de cada hora consulta el token (el cron corre cada 5 min). */
export const MINUTOS_TICK_TOKEN = 5;

interface RespuestaDebugToken {
  readonly data?: { readonly is_valid?: unknown; readonly expires_at?: unknown };
}

function esErrorDeTokenInvalido(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { tokenInvalido?: unknown }).tokenInvalido === true;
}

/** Adaptador de produccion del puerto: `GET /debug_token?input_token=<token>` (Graph). `expires_at` 0 o ausente = sin fecha (token permanente).
 *  El 190/401 de Graph (token invalido o vencido) se traduce a `valido: false`; cualquier otro error se propaga (el vigilante lo cuenta `no_leido`). */
export function crearLectorTokenMetaGraph(lector: SolicitudGraphDeSoloLectura, token: string): LectorEstadoTokenMeta {
  return {
    async leer(): Promise<EstadoTokenMeta> {
      let cuerpo: unknown;
      try {
        cuerpo = await lector.solicitar("GET", `/debug_token?input_token=${encodeURIComponent(token)}`);
      } catch (err) {
        if (esErrorDeTokenInvalido(err)) return { valido: false, expiraEn: null };
        throw err;
      }
      const data = (cuerpo as RespuestaDebugToken | null)?.data;
      if (data === null || typeof data !== "object") throw new Error("debug_token: cuerpo inesperado");
      const valido = typeof data.is_valid === "boolean" ? data.is_valid : null;
      const expiraS = typeof data.expires_at === "number" && Number.isFinite(data.expires_at) && data.expires_at > 0 ? data.expires_at : null;
      return { valido, expiraEn: expiraS === null ? null : new Date(expiraS * 1000) };
    },
  };
}

export interface ResultadoSaludMeta {
  readonly token: string;
  readonly agente: string;
}

/** Corre ambas vigilancias, cada una en su sesion de sistema. Nunca lanza. */
export async function vigilarSaludMetaBestEffort(deps: AppDeps): Promise<ResultadoSaludMeta> {
  const cfg = deps.saludMeta;
  const ahora = (cfg?.reloj ?? (() => new Date()))();
  let token = "omitido";
  const lectorToken = cfg?.lectorToken;
  // El token vence en dias: basta mirarlo una vez por hora (el primer tick de cada hora, minutos 0-4 UTC) en vez de llamar a Meta cada 5 minutos.
  if (lectorToken && ahora.getUTCMinutes() < MINUTOS_TICK_TOKEN) {
    try {
      const r = await deps.engine.withAppSession({ userId: null }, (db) => vigilarTokenMeta(db, lectorToken, ahora));
      token = r.estado;
    } catch {
      token = "error";
    }
  }
  let agente = "error";
  try {
    const r = await deps.engine.withAppSession({ userId: null }, (db) =>
      vigilarAgenteWhatsapp(db, (cfg?.lectorTurnos ?? crearLectorTurnosAgentePostgres)(db), ahora, cfg?.opcionesAgente),
    );
    agente = r.disponible ? "ok" : "no_disponible";
  } catch {
    agente = "error";
  }
  return { token, agente };
}
