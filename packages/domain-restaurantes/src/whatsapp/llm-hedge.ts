// PM-R21 (caidas del modelo): hedging de la llamada al LLM. En vez de CORTAR el primer intento a los 9-11 s y recien entonces llamar al modelo alterno
// (PM-R19: el respaldo se queda con 7 s o menos y, en R20, 71 de los 113 `error_proveedor` tuvieron el respaldo tambien sin contestar), se lanza el
// alterno EN PARALELO cuando el primario pasa de `hedgeAfterMs` (~p95 de una vuelta normal, 6 s) y gana el primero que conteste. El perdedor se aborta.
//
// Seguro por la misma razon que el respaldo de R19: la llamada al modelo no tiene efectos laterales (las herramientas corren ENTRE llamadas, nunca dentro).
// Solo el rol por defecto y solo modelos economicos lo usan (el que decide es el llamador). Costo: una llamada extra (~20 mil tokens de entrada) solo en la
// cola lenta (~10 % de las vueltas), es decir ~0.0015 USD por vuelta en promedio con DeepSeek V4.1 Flash como alterno.
//
// Este modulo no sabe de modelos ni de telemetria de negocio: recibe dos funciones `(signal) => Promise<T>` y devuelve quien gano y cuanto tardo cada pata.
import { LlmCallCancelledError } from "@atiende/agent-core";
import { TopeLlamadaLlmError } from "./observabilidad-turno.ts";

/** Interruptor de entorno: milisegundos tras los que se lanza el alterno en paralelo. APAGADO por omision (queda el respaldo secuencial de R19); R21 lo enciende con 5500. */
export const HEDGE_LLM_ENV = "WHATSAPP_LLM_HEDGE_MS";
/** Valor por omision: ~p95 de una vuelta normal medida en R20 (6.0 s) y en las sondas de R21; una vuelta con tool-calls largos tarda 4-6 s sin estar atascada. */
export const HEDGE_LLM_DESPUES_MS_POR_OMISION = 5_500;
/** Tiempo minimo que debe quedarle al alterno tras lanzarse (~mediana de una llamada, 3.4 s): con menos no vale la pena pagar la llamada. */
export const HEDGE_LLM_RESTANTE_MIN_TRAS_LANZAR_MS = 3_500;
/** Retraso efectivo minimo cuando el presupuesto aprieta: ~mediana de una llamada normal (3.4 s); antes de eso casi cada vuelta duplicaria su llamada. */
export const HEDGE_LLM_RETRASO_MIN_EFECTIVO_MS = 3_500;
/** Piso del retraso configurable: menos que esto duplicaria casi todas las llamadas. */
export const HEDGE_LLM_DESPUES_MIN_MS = 1_500;

/** Retraso del hedging desde el entorno; null = APAGADO. Apagado por omision (variable ausente o vacia): se enciende con `WHATSAPP_LLM_HEDGE_MS=5500`. Un valor invalido o menor al piso lo deja apagado. */
export function hedgeLlmDespuesMs(env: Readonly<Record<string, string | undefined>> = process.env): number | null {
  const crudo = (env[HEDGE_LLM_ENV] ?? "").trim().toLowerCase();
  if (crudo === "" || crudo === "0" || crudo === "off" || crudo === "false" || crudo === "no") return null;
  const n = Number(crudo);
  if (!Number.isFinite(n) || n < HEDGE_LLM_DESPUES_MIN_MS) return null;
  return Math.round(n);
}

/**
 * Retraso efectivo del hedging para una vuelta con `restanteMs` de presupuesto: el configurado, pero nunca tan tarde que al alterno le queden menos de
 * `HEDGE_LLM_RESTANTE_MIN_TRAS_LANZAR_MS` (en R20, 29 de los 42 turnos sin respaldo llegaron a la 4.a vuelta o mas con 7-10 s: con el retraso fijo no cabia).
 * null = no cabe (con menos de ~7 s el alterno no tendria tiempo util: una sola llamada con todo lo que queda).
 */
export function hedgeLlmRetrasoEfectivoMs(restanteMs: number, hedgeMs: number): number | null {
  const retraso = Math.min(hedgeMs, restanteMs - HEDGE_LLM_RESTANTE_MIN_TRAS_LANZAR_MS);
  return retraso >= HEDGE_LLM_RETRASO_MIN_EFECTIVO_MS ? Math.round(retraso) : null;
}

export type PataHedge = "primario" | "alterno";
/** Como termino una pata: contesto, vencio el tope, fallo con otro error o la cancelo el hedging porque la otra gano. */
export type ResultadoPataHedge = "ok" | "tope" | "error" | "cancelada";

export interface PataHedgeInforme {
  readonly pata: PataHedge;
  readonly resultado: ResultadoPataHedge;
  /** Milisegundos desde que arranco ESTA pata hasta que termino (o la cancelaron / vencio el tope). */
  readonly ms: number;
  /** Solo si fallo con otro error que no es el tope; para clasificar con `clasificarCausaError`. */
  readonly error?: unknown;
}

export interface ResultadoHedge<T> {
  readonly valor: T;
  readonly ganador: PataHedge;
  /** El alterno llego a lanzarse (el primario paso de `hedgeDespuesMs` sin contestar). */
  readonly alternoLanzado: boolean;
  readonly patas: readonly PataHedgeInforme[];
}

/** Error de `completarConHedging` cuando ninguna pata contesta: conserva el informe de las patas y la causa (el ultimo error, o el tope). */
export class HedgeLlmFalloError extends Error {
  constructor(
    readonly causa: unknown,
    readonly alternoLanzado: boolean,
    readonly patas: readonly PataHedgeInforme[],
  ) {
    super("ninguna pata del hedging contesto");
    this.name = "HedgeLlmFalloError";
    (this as { cause?: unknown }).cause = causa;
  }
}

export interface OpcionesHedge<T> {
  /** Reloj absoluto (ms epoch) en que se corta TODO: el limite del turno. */
  readonly limiteMs: number;
  /** Tras cuantos ms de iniciado el primario se lanza el alterno si aun no contesto. */
  readonly hedgeDespuesMs: number;
  readonly primario: (signal: AbortSignal) => Promise<T>;
  readonly alterno: (signal: AbortSignal) => Promise<T>;
  readonly ahora?: () => number;
}

/**
 * Corre `primario`; si pasa de `hedgeDespuesMs` sin contestar corre `alterno` en paralelo. Un error RAPIDO del primario antes de ese retraso NO lanza el alterno: se propaga (la escalera del gateway ya probo los demas modelos). Devuelve la
 * primera respuesta valida y aborta la otra pata. Si ninguna contesta antes de `limiteMs`, rechaza con `HedgeLlmFalloError` cuya causa es `TopeLlamadaLlmError`
 * (si alguna pata vencio el tope) o el ultimo error. Tambien corre con Promise.race por si un proveedor ignora la senal de aborto.
 */
export function completarConHedging<T>(op: OpcionesHedge<T>): Promise<ResultadoHedge<T>> {
  const ahora = op.ahora ?? Date.now;
  return new Promise<ResultadoHedge<T>>((resolver, rechazar) => {
    const inicio = ahora();
    const patas: PataHedgeInforme[] = [];
    const controles: Record<PataHedge, AbortController | null> = { primario: null, alterno: null };
    const inicios: Record<PataHedge, number> = { primario: inicio, alterno: inicio };
    const terminadas = new Set<PataHedge>();
    let alternoLanzado = false;
    let resuelto = false;
    let ultimoError: unknown = null;
    let huboTope = false;

    // Declaracion (hoisted): se llama solo despues de que los dos temporizadores existen.
    function limpiar(): void {
      clearTimeout(temporizadorHedge);
      clearTimeout(temporizadorLimite);
    }
    const informar = (pata: PataHedge, resultado: ResultadoPataHedge, error?: unknown) => {
      patas.push({ pata, resultado, ms: Math.max(0, ahora() - inicios[pata]), ...(error !== undefined ? { error } : {}) });
    };
    const cancelarPata = (pata: PataHedge) => {
      if (terminadas.has(pata) || controles[pata] === null) return;
      terminadas.add(pata);
      informar(pata, "cancelada");
      // Motivo explicito: el gateway no cuenta esta cancelacion como falla del proveedor en su circuit breaker.
      controles[pata]!.abort(new LlmCallCancelledError());
    };
    const intentarCerrarSinExito = () => {
      const quedan = (["primario", "alterno"] as const).some((p) => controles[p] !== null && !terminadas.has(p));
      // El alterno todavia puede lanzarse: mientras no se lance y el primario haya terminado mal, se lanza de inmediato (ver `lanzar`).
      if (quedan || resuelto) return;
      resuelto = true;
      limpiar();
      rechazar(new HedgeLlmFalloError(huboTope ? new TopeLlamadaLlmError() : ultimoError, alternoLanzado, patas));
    };

    const lanzar = (pata: PataHedge, llamar: (s: AbortSignal) => Promise<T>) => {
      const control = new AbortController();
      controles[pata] = control;
      inicios[pata] = ahora();
      if (pata === "alterno") alternoLanzado = true;
      const trabajo = llamar(control.signal);
      trabajo.then(
        (valor) => {
          if (resuelto || terminadas.has(pata)) return;
          terminadas.add(pata);
          informar(pata, "ok");
          resuelto = true;
          limpiar();
          cancelarPata(pata === "primario" ? "alterno" : "primario");
          resolver({ valor, ganador: pata, alternoLanzado, patas });
        },
        (err: unknown) => {
          if (resuelto || terminadas.has(pata)) return;
          terminadas.add(pata);
          if (err instanceof TopeLlamadaLlmError) huboTope = true;
          else ultimoError = err;
          informar(pata, err instanceof TopeLlamadaLlmError ? "tope" : "error", err instanceof TopeLlamadaLlmError ? undefined : err);
          // Un error RAPIDO del primario antes de que venza el hedge (5xx/429 ya agotados en la escalera del gateway, presupuesto, regla) no es un atasco: se propaga
          // como siempre (la escalera ya probo los demas escalones). El hedging solo cubre el modelo que NO contesta.
          if (pata === "primario" && !alternoLanzado && !(err instanceof TopeLlamadaLlmError)) {
            resuelto = true;
            limpiar();
            rechazar(new HedgeLlmFalloError(err, false, patas));
            return;
          }
          intentarCerrarSinExito();
        },
      );
    };
    const limiteMs = () => op.limiteMs - ahora();

    const temporizadorLimite = setTimeout(() => {
      if (resuelto) return;
      huboTope = true;
      for (const p of ["primario", "alterno"] as const) {
        if (controles[p] !== null && !terminadas.has(p)) {
          terminadas.add(p);
          informar(p, "tope");
          // El primario atascado SI cuenta como falla del proveedor (abort sin motivo); el alterno recien lanzado no tuvo oportunidad justa: se cancela sin culparlo.
          controles[p]!.abort(p === "alterno" ? new LlmCallCancelledError() : undefined);
        }
      }
      resuelto = true;
      limpiar();
      rechazar(new HedgeLlmFalloError(new TopeLlamadaLlmError(), alternoLanzado, patas));
    }, Math.max(0, limiteMs()));

    const temporizadorHedge = setTimeout(() => {
      if (resuelto || alternoLanzado) return;
      lanzar("alterno", op.alterno);
    }, Math.max(0, op.hedgeDespuesMs));

    lanzar("primario", op.primario);
  });
}
