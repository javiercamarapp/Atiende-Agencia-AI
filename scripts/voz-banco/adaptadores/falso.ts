// Adaptador FALSO determinista (sin red, sin llaves, sin gasto): sirve para probar el corredor, la compuerta y los topes. Una "accion" por turno del cliente:
// lo que el agente dice, las herramientas que pide (en el orden dado) y el costo en micro-USD que reporta.
import type { AbrirSesionLlamada, ManejadoresSesion, ToolCallPedida } from "../../../packages/voice-core/src/llamada/sesion.ts";
import type { AdaptadorBanco, CostoAdaptador } from "../tipos.ts";

export interface AccionFalsa {
  readonly dice?: string;
  readonly herramientas?: readonly { readonly nombre: string; readonly args?: Readonly<Record<string, unknown>> }[];
  /** Si se da, el agente dice esto DESPUES de ejecutar las herramientas. */
  readonly diceDespues?: string;
  readonly costoMicroUsd?: number | unknown;
  /** El adaptador NO llama `h.costo` en este turno (pruebas: el corredor debe fallar cerrado, no tratarlo como gratis). */
  readonly sinReporteDeCosto?: true;
}

/** `guion(indiceDeTurno, textoOido)` decide la accion; por omision el agente repite lo que oyo (eco). */
export type GuionFalso = (turno: number, oido: string) => AccionFalsa;

export function crearAdaptadorFalso(guion: GuionFalso = (_t, oido) => ({ dice: `Entendido: ${oido}` })): AdaptadorBanco {
  const costo = { total: 0, real: false };
  const abrir: AbrirSesionLlamada = async (_apertura, h: ManejadoresSesion) => {
    let turno = 0;
    let n = 0;
    return {
      enviarTexto(texto: string) {
        const a = guion(turno, texto);
        turno += 1;
        void (async () => {
          if (a.sinReporteDeCosto !== true) {
            // Sin `costoMicroUsd` en la accion se reporta 0 EXPLICITO: un 0 reportado es un dato; la ausencia de reporte no lo es.
            const c = "costoMicroUsd" in a ? a.costoMicroUsd : 0;
            if (typeof c === "number" && Number.isFinite(c)) costo.total += c;
            h.costo?.(c as number, false, { proveedor: "falso", unidad: "unidad", cantidad: 1 });
          }
          if (a.dice) h.agenteDijo(a.dice);
          for (const t of a.herramientas ?? []) {
            n += 1;
            const llamada: ToolCallPedida = { id: `f${n}`, nombre: t.nombre, args: t.args ?? {} };
            try { await h.ejecutarTool(llamada); } catch { /* el corredor registra el fallo */ }
          }
          if (a.diceDespues) h.agenteDijo(a.diceDespues);
          h.agenteTermino();
        })();
      },
      interrumpir() { /* sin audio */ },
      async cerrar() { /* nada que cerrar */ },
    };
  };
  return {
    id: "falso",
    entradas: ["texto", "stt-final"],
    salidaAudio: false,
    async preflight() { return { ok: true, detalle: "doble local: sin red ni llaves" }; },
    crearAbrirSesion: () => abrir,
    costoMicroUsd: (): CostoAdaptador => ({ total: costo.total, real: costo.real, porComponente: { falso: costo.total } }),
    capacidades: { compuertaInterna: false, herramientasEnParalelo: false },
  };
}
