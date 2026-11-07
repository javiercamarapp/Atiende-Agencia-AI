// Plazo al PRIMER TOKEN del LLM con peticion de respaldo en paralelo (hedged request).
//
// El p95 de la voz lo pone el LLM (ANALISIS-LATENCIA-VOZ10: p50 ~1.9 s, p95 8.5 s, hasta 18 s con el proveedor degradado). Por eso:
//   - Se lanza la peticion principal. Si en `plazoMs` (2.5 s) no dio texto ni termino, se avisa `alVencer` (la sesion dice una frase corta de espera) y se lanza
//     la MISMA peticion con el modelo de respaldo, en paralelo.
//   - Si la principal FALLA antes de dar texto, el respaldo sale de inmediato (sin esperar el plazo).
//   - Gana la primera que dé texto (o que termine con herramientas): solo sus trozos llegan a `onTextDelta` y la otra se aborta.
//   - Si fallan las dos, sube el error de la principal.
// La perdedora abortada no reporta uso (OpenRouter no devuelve `usage` de un stream cortado): su costo, si lo hubo, no se registra. Es tolerable porque el respaldo
// solo corre cuando la principal ya se tardo, pero hay que saberlo al conciliar contra la factura de OpenRouter.
import type { PeticionLlmVoz, PuertoLlmVoz, RespuestaLlmVoz } from "../cascada-openrouter.ts";

export interface OpcionesPlazoLlm {
  /** Plazo al primer token (ms); 0 o menos = sin plazo (solo la principal). */
  readonly plazoMs: number;
  /** Modelo de la peticion de respaldo; igual al principal o vacio = sin respaldo. */
  readonly modeloRespaldo: string | null;
  /** Se llama UNA vez cuando vence el plazo sin texto (la sesion dice la frase de espera). */
  readonly alVencer?: () => void;
  /** Se llama cuando el respaldo gana (para el registro). */
  readonly alGanarRespaldo?: (motivo: "plazo" | "falla") => void;
  /** Temporizador inyectable (pruebas). */
  readonly temporizador?: { readonly poner: (fn: () => void, ms: number) => unknown; readonly quitar: (id: unknown) => void };
}

const TEMPORIZADOR_REAL = {
  poner: (fn: () => void, ms: number): unknown => setTimeout(fn, ms),
  quitar: (id: unknown): void => clearTimeout(id as ReturnType<typeof setTimeout>),
};

export interface ResultadoPlazoLlm {
  readonly respuesta: RespuestaLlmVoz;
  /** Modelo que gano (el principal o el de respaldo). */
  readonly modelo: string;
  readonly respaldo: boolean;
}

type Cual = "principal" | "respaldo";

export function completarConPlazo(llm: PuertoLlmVoz, peticion: PeticionLlmVoz & { readonly modeloPreferido: string }, o: OpcionesPlazoLlm): Promise<ResultadoPlazoLlm> {
  const t = o.temporizador ?? TEMPORIZADOR_REAL;
  const senalExterna = peticion.senal;
  const conRespaldo = o.plazoMs > 0 && typeof o.modeloRespaldo === "string" && o.modeloRespaldo.trim() !== "" && o.modeloRespaldo !== peticion.modeloPreferido;
  if (!conRespaldo) {
    return llm.completar(peticion).then((respuesta) => ({ respuesta, modelo: peticion.modeloPreferido, respaldo: false }));
  }
  return new Promise<ResultadoPlazoLlm>((resolve, reject) => {
    let ganadora: Cual | null = null;
    let terminado = false;
    let plazo: unknown = null;
    let errorPrincipal: unknown = null;
    let respaldoLanzado = false;
    const vivas = new Set<Cual>();
    const controles: Record<Cual, AbortController> = { principal: new AbortController(), respaldo: new AbortController() };
    const alAbortarExterno = (): void => {
      controles.principal.abort();
      controles.respaldo.abort();
    };
    senalExterna?.addEventListener("abort", alAbortarExterno, { once: true });
    const terminar = (): void => {
      terminado = true;
      if (plazo !== null) t.quitar(plazo);
      // El oyente de la senal externa se queda (es `once` y la senal es del turno): si el cliente interrumpe despues, la peticion ganadora queda abortada igual que antes.
    };
    const coronar = (cual: Cual): boolean => {
      if (ganadora === null) {
        ganadora = cual;
        if (plazo !== null) t.quitar(plazo);
        const otra: Cual = cual === "principal" ? "respaldo" : "principal";
        controles[otra].abort();
        if (cual === "respaldo") o.alGanarRespaldo?.(errorPrincipal !== null ? "falla" : "plazo");
      }
      return ganadora === cual;
    };
    const lanzar = (cual: Cual): void => {
      vivas.add(cual);
      const modelo = cual === "principal" ? peticion.modeloPreferido : (o.modeloRespaldo as string);
      if (senalExterna?.aborted) controles[cual].abort();
      llm
        .completar({
          ...peticion,
          modeloPreferido: modelo,
          senal: controles[cual].signal,
          ...(peticion.onTextDelta
            ? {
                onTextDelta: (delta: string) => {
                  if (terminado && ganadora !== cual) return;
                  if (delta !== "" && coronar(cual)) peticion.onTextDelta!(delta);
                },
              }
            : {}),
        })
        .then(
          (respuesta) => {
            vivas.delete(cual);
            if (terminado) return;
            if (!coronar(cual)) return;
            terminar();
            resolve({ respuesta, modelo, respaldo: cual === "respaldo" });
          },
          (err: unknown) => {
            vivas.delete(cual);
            if (terminado) return;
            if (cual === "principal") errorPrincipal = err;
            if (ganadora === cual || senalExterna?.aborted) {
              terminar();
              reject(err);
              return;
            }
            if (ganadora !== null) return; // la otra ya gano: su resultado resuelve
            if (cual === "principal" && !respaldoLanzado) {
              respaldoLanzado = true;
              lanzar("respaldo");
              return;
            }
            if (vivas.size === 0) {
              terminar();
              reject(errorPrincipal ?? err);
            }
          },
        );
    };
    lanzar("principal");
    plazo = t.poner(() => {
      plazo = null;
      if (terminado || ganadora !== null || respaldoLanzado) return;
      o.alVencer?.();
      respaldoLanzado = true;
      lanzar("respaldo");
    }, o.plazoMs);
  });
}
