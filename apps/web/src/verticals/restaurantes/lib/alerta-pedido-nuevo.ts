// Alerta de pedido nuevo del panel movil (PLAN-PANEL-OPERADOR §5.3): sonido repetido cada 8 s hasta que alguien atiende el pedido
// (o silencia 5 min), con vibracion donde el navegador la ofrece (Android). Logica pura con temporizadores inyectables para probarla.
//
// Limite honesto de la web: iOS y Android exigen un toque previo para reproducir audio y no garantizan sonido con la pantalla bloqueada o
// la app en segundo plano; la pantalla lo dice (`AVISO_SONIDO_LIMITES`) en vez de prometer lo que el navegador no cumple.

export const INTERVALO_ALERTA_MS = 8_000;
export const SILENCIO_MS = 5 * 60_000;

export const AVISO_SONIDO_LIMITES = "Con la pantalla bloqueada o la app en segundo plano el celular puede no sonar (sobre todo en iPhone). Deja esta pantalla abierta y encendida.";

export interface AlertaRepetida {
  /** Empieza a sonar (suena de inmediato y luego cada intervalo). No hace nada si ya esta sonando o esta en silencio. */
  readonly iniciar: () => void;
  /** Deja de sonar (el pedido ya se atendio). */
  readonly detener: () => void;
  /** Calla `ms` (por omision 5 min); si siguen pendientes al terminar, vuelve a sonar. */
  readonly silenciar: (ms?: number) => void;
  readonly sonando: () => boolean;
  readonly silenciada: () => boolean;
}

export interface OpcionesAlerta {
  readonly reproducir: () => void;
  readonly vibrar?: () => void;
  readonly intervaloMs?: number;
  readonly setTimer?: (fn: () => void, ms: number) => unknown;
  readonly clearTimer?: (id: unknown) => void;
}

export function crearAlertaRepetida(opc: OpcionesAlerta): AlertaRepetida {
  const intervalo = opc.intervaloMs ?? INTERVALO_ALERTA_MS;
  const setT = opc.setTimer ?? ((fn, ms) => setInterval(fn, ms));
  const clearT = opc.clearTimer ?? ((id) => clearInterval(id as ReturnType<typeof setInterval>));
  const setUna = (fn: () => void, ms: number) => setTimeout(fn, ms);
  let ciclo: unknown = null;
  let finSilencio: ReturnType<typeof setTimeout> | null = null;
  let quiere = false;

  const tocar = () => {
    try {
      opc.reproducir();
      opc.vibrar?.();
    } catch {
      // Sin audio: el indicador visual sigue avisando.
    }
  };
  const arrancar = () => {
    if (ciclo !== null) return;
    tocar();
    ciclo = setT(tocar, intervalo);
  };
  const parar = () => {
    if (ciclo !== null) clearT(ciclo);
    ciclo = null;
  };

  return {
    iniciar() {
      quiere = true;
      if (finSilencio === null) arrancar();
    },
    detener() {
      quiere = false;
      parar();
      if (finSilencio !== null) clearTimeout(finSilencio);
      finSilencio = null;
    },
    silenciar(ms = SILENCIO_MS) {
      parar();
      if (finSilencio !== null) clearTimeout(finSilencio);
      finSilencio = setUna(() => {
        finSilencio = null;
        if (quiere) arrancar();
      }, ms);
    },
    sonando: () => ciclo !== null,
    silenciada: () => finSilencio !== null,
  };
}

/** Vibracion corta (solo Android; en iOS no existe y se ignora). */
export function vibrarAviso(): void {
  try {
    const nav = globalThis.navigator as Navigator | undefined;
    if (nav && typeof nav.vibrate === "function") nav.vibrate([200, 100, 200]);
  } catch {
    // Sin vibracion: se ignora.
  }
}
