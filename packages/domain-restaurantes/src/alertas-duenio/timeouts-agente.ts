// Alertas por TIMEOUTS y FALLAS SEGUIDAS del agente de WhatsApp de restaurantes (runbook de operacion del original, "proveedor externo lento":
// alertar si la tasa de timeout supera 1 % durante 10 minutos o si hay cinco fallos consecutivos).
//
//   * `superadmin.agente.timeouts_altos`: en la ventana de 10 min, MAS de 1 % de los turnos terminaron en timeout (con un minimo de turnos para
//     que 1 de 3 no dispare por ruido; ver MIN_TURNOS_VENTANA). Es una senal de la plataforma (un proveedor lento afecta a todos): va a superadmin.
//   * `superadmin.agente.fallos_seguidos` + `restaurantes.proveedor.falla` (proveedor = agente): una organizacion acumula 5 turnos fallidos
//     seguidos (el mas reciente hacia atras; un turno bien terminado rompe la racha). Avisa al operador y al dueno de ESA organizacion.
//
// Los turnos los lee un PUERTO (`LectorTurnosAgente`): este modulo es puro salvo la emision. La fuente real es
// `restaurantes.whatsapp_inbound_events` (migracion 085: funcion de solo sistema, sin telefono ni texto). Un turno cuenta cuando ya termino
// (`processed` o `failed`); `processing` aun no resolvio. LIMITACION CONOCIDA: Meta reintenta una entrega fallida y, si el reintento sale bien,
// la fila queda `processed`; ese fallo ya no se ve en la fuente (la alerta puede quedarse corta, nunca inventa fallos).
//
// El reloj es el inyectado: nunca `new Date()` aqui. Los umbrales son constantes de este archivo y se pueden sobrescribir por llamada.
import type { TenantDbSession } from "@atiende/core-tenancy";
import { emitirNotificacion, isMigrationPendingError, runWithSavepointFallback } from "@atiende/db";
import { diaMerida } from "./dia.ts";

/** Ventana (minutos) en que se mide la tasa de timeouts. */
export const VENTANA_TIMEOUTS_MIN = 10;
/** Se alerta cuando la tasa es ESTRICTAMENTE mayor a este porcentaje (1 timeout en 100 turnos = 1 % exacto = no alerta). */
export const UMBRAL_TASA_TIMEOUT_PCT = 1;
/** Turnos minimos en la ventana para evaluar la tasa: con menos, un solo timeout seria "33 %" y la alerta seria ruido. Decision de este paquete (POR CONFIRMAR con Javier). */
export const MIN_TURNOS_VENTANA = 20;
/** Fallos consecutivos de una organizacion que disparan la alerta. */
export const RACHA_FALLOS = 5;
/** Hasta donde mira hacia atras la racha (una racha vieja ya no describe el estado actual). */
export const VENTANA_RACHA_MIN = 60;
/** Una alerta de tasa por cubeta de este tamano (minutos): una tormenta de timeouts no llena la campana. */
export const CUBETA_ALERTA_MIN = 30;

export type ResultadoTurnoAgente = "ok" | "timeout" | "fallo";

export interface TurnoAgente {
  readonly organizationId: string;
  readonly at: Date;
  readonly resultado: ResultadoTurnoAgente;
}

/** Puerto de lectura de turnos terminados en [desde, hasta]. `null` = la fuente no esta disponible (base sin migrar): no se alerta, no se inventa. */
export interface LectorTurnosAgente {
  leer(desde: Date, hasta: Date): Promise<readonly TurnoAgente[] | null>;
}

export interface OpcionesTimeoutsAgente {
  readonly ventanaMin?: number;
  readonly umbralPct?: number;
  readonly minTurnos?: number;
  readonly racha?: number;
  readonly ventanaRachaMin?: number;
}

export interface RachaOrganizacion {
  readonly organizationId: string;
  readonly fallos: number;
}

export interface DiagnosticoAgente {
  readonly turnosVentana: number;
  readonly timeoutsVentana: number;
  /** Porcentaje de timeouts en la ventana (0 si no hubo turnos). */
  readonly tasaPct: number;
  readonly alertaTasa: boolean;
  /** Organizaciones con una racha >= `racha`, ordenadas por id. */
  readonly rachas: readonly RachaOrganizacion[];
}

/** La clase del error de un turno fallido es de timeout (`TimeoutError`, `AbortError` o cualquier nombre que lo diga). */
export function esClaseTimeout(clase: string | null | undefined): boolean {
  return typeof clase === "string" && /timeout|timedout|abort/i.test(clase);
}

/** Clase que se guarda en `last_error_class` al fallar un turno: el nombre del error, pero un timeout (de `fetch`, del gateway o de un `AbortSignal`) siempre se
 *  registra como `TimeoutError` (un `DOMException` o un `Error` con "timed out" en el mensaje de otro modo llegarian como `DOMException`/`Error`). */
export function claseErrorTurno(err: unknown): string {
  if (!(err instanceof Error)) return "UnknownError";
  if (/timeout|abort/i.test(err.name) || /timed out|timeout/i.test(err.message)) return "TimeoutError";
  return err.constructor.name;
}

/** Funcion pura: evalua los turnos (cualquier orden). Ventana = [ahora - ventanaMin, ahora]; el limite inferior es inclusivo. */
export function evaluarTimeoutsAgente(turnos: readonly TurnoAgente[], ahora: Date, opciones: OpcionesTimeoutsAgente = {}): DiagnosticoAgente {
  const ventanaMin = opciones.ventanaMin ?? VENTANA_TIMEOUTS_MIN;
  const umbralPct = opciones.umbralPct ?? UMBRAL_TASA_TIMEOUT_PCT;
  const minTurnos = opciones.minTurnos ?? MIN_TURNOS_VENTANA;
  const racha = opciones.racha ?? RACHA_FALLOS;
  const ventanaRachaMin = opciones.ventanaRachaMin ?? VENTANA_RACHA_MIN;
  const t = ahora.getTime();

  const enVentana = turnos.filter((x) => x.at.getTime() >= t - ventanaMin * 60_000 && x.at.getTime() <= t);
  const timeouts = enVentana.filter((x) => x.resultado === "timeout").length;
  // timeouts * 100 > umbral * turnos: comparacion entera exacta, sin flotantes (justo en el umbral NO alerta).
  const alertaTasa = enVentana.length >= minTurnos && timeouts * 100 > umbralPct * enVentana.length;

  const porOrg = new Map<string, TurnoAgente[]>();
  for (const x of turnos) {
    if (x.at.getTime() < t - ventanaRachaMin * 60_000 || x.at.getTime() > t) continue;
    const lista = porOrg.get(x.organizationId) ?? [];
    lista.push(x);
    porOrg.set(x.organizationId, lista);
  }
  const rachas: RachaOrganizacion[] = [];
  for (const [organizationId, lista] of porOrg) {
    lista.sort((a, b) => b.at.getTime() - a.at.getTime());
    let fallos = 0;
    for (const x of lista) {
      if (x.resultado === "ok") break;
      fallos += 1;
    }
    if (fallos >= racha) rachas.push({ organizationId, fallos });
  }
  rachas.sort((a, b) => a.organizationId.localeCompare(b.organizationId));

  return { turnosVentana: enVentana.length, timeoutsVentana: timeouts, tasaPct: enVentana.length === 0 ? 0 : (timeouts * 100) / enVentana.length, alertaTasa, rachas };
}

export interface ResultadoVigilanciaAgente {
  readonly disponible: boolean;
  readonly diagnostico: DiagnosticoAgente | null;
  readonly emitidas: number;
  readonly errores: number;
}

const SIN_DATOS: ResultadoVigilanciaAgente = { disponible: false, diagnostico: null, emitidas: 0, errores: 0 };

/** Lee, evalua y emite. Nunca lanza. Idempotente: tasa = una por cubeta de 30 min; racha = una por organizacion y dia de Merida. */
export async function vigilarAgenteWhatsapp(session: TenantDbSession, lector: LectorTurnosAgente, ahora: Date, opciones: OpcionesTimeoutsAgente = {}): Promise<ResultadoVigilanciaAgente> {
  const lookbackMin = Math.max(opciones.ventanaMin ?? VENTANA_TIMEOUTS_MIN, opciones.ventanaRachaMin ?? VENTANA_RACHA_MIN);
  let turnos: readonly TurnoAgente[] | null;
  try {
    turnos = await lector.leer(new Date(ahora.getTime() - lookbackMin * 60_000), ahora);
  } catch {
    return SIN_DATOS;
  }
  if (turnos === null) return SIN_DATOS;

  const d = evaluarTimeoutsAgente(turnos, ahora, opciones);
  let emitidas = 0;
  let errores = 0;
  const contar = (estado: string): void => {
    if (estado === "emitida") emitidas += 1;
    else if (estado !== "sin_nuevas" && estado !== "no_disponible") errores += 1;
  };
  try {
    if (d.alertaTasa) {
      const cubeta = Math.floor(ahora.getTime() / (CUBETA_ALERTA_MIN * 60_000));
      const r = await emitirNotificacion(session, {
        evento: "superadmin.agente.timeouts_altos",
        organizationId: null,
        clave: `c${cubeta}`,
        parametros: { porcentaje: Math.round(d.tasaPct * 10) / 10, turnos: d.turnosVentana },
      });
      contar(r.estado);
    }
    const dia = diaMerida(ahora);
    for (const r of d.rachas) {
      contar((await emitirNotificacion(session, { evento: "restaurantes.proveedor.falla", organizationId: r.organizationId, clave: `agente:${dia}`, parametros: { proveedor: "agente" } })).estado);
      contar(
        (
          await emitirNotificacion(session, {
            evento: "superadmin.agente.fallos_seguidos",
            organizationId: null,
            clave: `${r.organizationId}:${dia}`,
            parametros: { organizacion: r.organizationId.slice(0, 8), cantidad: r.fallos },
          })
        ).estado,
      );
    }
  } catch {
    errores += 1;
  }
  return { disponible: true, diagnostico: d, emitidas, errores };
}

/** Adaptador Postgres del puerto: lee `restaurantes.agente_turnos_recientes` (migracion 085, SOLO sistema). Base sin migrar -> `null`. */
export function crearLectorTurnosAgentePostgres(session: TenantDbSession): LectorTurnosAgente {
  return {
    async leer(desde: Date, hasta: Date): Promise<readonly TurnoAgente[] | null> {
      return runWithSavepointFallback<readonly TurnoAgente[] | null>({
        session,
        savepointName: "sp_agente_turnos_recientes",
        primary: async () => {
          const { rows } = await session.query<{ organization_id: string; claimed_at: Date | string; status: string; last_error_class: string | null }>(
            `select organization_id, claimed_at, status, last_error_class from restaurantes.agente_turnos_recientes($1::timestamptz, $2::timestamptz);`,
            [desde.toISOString(), hasta.toISOString()],
          );
          return rows.map((r) => ({
            organizationId: r.organization_id,
            at: r.claimed_at instanceof Date ? r.claimed_at : new Date(r.claimed_at),
            resultado: r.status === "processed" ? "ok" : esClaseTimeout(r.last_error_class) ? "timeout" : "fallo",
          }));
        },
        isRecoverable: (err) => isMigrationPendingError(err),
        fallback: async () => null,
      });
    },
  };
}
