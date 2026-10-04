// El latido del Cerebro (portado de latido.ts de Likida, FE-16): el refresco automatico no late con la pestana OCULTA (se anota un
// latido a deber) y al VOLVER late UNA sola vez, no la rafaga de los que se saltaron. Sin React ni `document` para poder probarlo
// con relojes falsos. Con la lectura en vuelo no se encima otro latido.

export interface OpcionesLatido {
  /** Cada cuanto se intenta latir, en ms. */
  intervaloMs: number;
  /** ¿La pestana esta oculta AHORA? (en el navegador: `document.visibilityState === "hidden"`). */
  oculto: () => boolean;
  /** Suscribe un aviso de cambio de visibilidad; devuelve el desuscriptor. */
  alCambiarVisibilidad: (cb: () => void) => () => void;
  /** El latido en si. Si devuelve una promesa, no se encima otro hasta que termine. */
  latir: () => void | Promise<void>;
}

/** Arranca el latido. Devuelve el paro (para el cleanup del efecto). */
export function arrancarLatido(o: OpcionesLatido): () => void {
  let debe = false;
  let enVuelo = false;
  let vivo = true;

  const intentar = () => {
    if (!vivo || enVuelo) return;
    if (o.oculto()) {
      debe = true;
      return;
    }
    debe = false;
    enVuelo = true;
    void Promise.resolve(o.latir()).finally(() => {
      enVuelo = false;
    });
  };

  const reloj = setInterval(intentar, o.intervaloMs);
  const desuscribir = o.alCambiarVisibilidad(() => {
    if (o.oculto() || !debe) return;
    intentar();
  });

  return () => {
    vivo = false;
    clearInterval(reloj);
    desuscribir();
  };
}

/** El puente con el navegador: la unica parte que toca `document`. */
export function visibilidadDelNavegador(): Pick<OpcionesLatido, "oculto" | "alCambiarVisibilidad"> {
  return {
    oculto: () => document.visibilityState === "hidden",
    alCambiarVisibilidad: (cb) => {
      document.addEventListener("visibilitychange", cb);
      return () => document.removeEventListener("visibilitychange", cb);
    },
  };
}
