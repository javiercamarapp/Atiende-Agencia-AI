// Wake Lock (pantalla encendida) para el panel movil del operador. Best-effort y honesto: si el navegador no lo ofrece o lo niega, se
// reporta el estado y la pantalla lo dice; nunca se finge que la pantalla seguira encendida.
export type EstadoWakeLock = "inactivo" | "activo" | "no_soportado" | "denegado";

interface Centinela {
  release: () => Promise<void>;
  addEventListener?: (t: "release", fn: () => void) => void;
}
interface ApiWakeLock {
  request: (tipo: "screen") => Promise<Centinela>;
}

export interface ControlWakeLock {
  readonly liberar: () => Promise<void>;
}

/** Pide mantener la pantalla encendida. Se vuelve a pedir solo cuando la pestana regresa a primer plano (el navegador lo suelta al ocultarla). */
export async function solicitarWakeLock(alCambiar: (estado: EstadoWakeLock) => void, entorno: { navigator?: { wakeLock?: ApiWakeLock }; document?: Document } = { navigator: globalThis.navigator as unknown as { wakeLock?: ApiWakeLock }, document: globalThis.document }): Promise<ControlWakeLock> {
  const api = entorno.navigator?.wakeLock;
  if (!api) {
    alCambiar("no_soportado");
    return { liberar: async () => undefined };
  }
  let centinela: Centinela | null = null;
  let activo = true;
  const pedir = async () => {
    try {
      centinela = await api.request("screen");
      alCambiar("activo");
      centinela.addEventListener?.("release", () => {
        if (activo) alCambiar("inactivo");
      });
    } catch {
      alCambiar("denegado");
    }
  };
  const alVolver = () => {
    if (activo && entorno.document?.visibilityState === "visible") void pedir();
  };
  entorno.document?.addEventListener("visibilitychange", alVolver);
  await pedir();
  return {
    async liberar() {
      activo = false;
      entorno.document?.removeEventListener("visibilitychange", alVolver);
      try {
        await centinela?.release();
      } catch {
        // Ya liberado.
      }
      centinela = null;
      alCambiar("inactivo");
    },
  };
}
