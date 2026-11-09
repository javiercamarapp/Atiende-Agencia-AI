// T04: cliente simulado M0. Entrega al agente, turno por turno, lo que el cliente "dice":
//  - modo "texto":     la linea tal cual (sin degradar). Sirve de control.
//  - modo "stt-final": la linea pasada por el ruido sintetico de STT de #696 (`ruido-stt.ts`: cifras, confusiones, muletillas, repeticiones, palabras comidas), como si fuera el
//                      resultado final de un reconocedor. NO es audio: no mide endpointing, eco ni barge-in reales (eso es M1/M2).
// Determinista y PAREADO: la semilla de cada turno depende solo de (semillaBase, id, rep, indice de turno), nunca de la arquitectura ni de cuanto ruido consumio otro turno, asi
// todas las arquitecturas reciben exactamente el mismo texto con ruido. El guion es fijo (cada turno de texto se dice casi tal cual); un generador LLM es opcional e inyectable
// (`generador`) y este modulo no llama a ningun proveedor.
import type { Escenario, Evento } from "../voz-medicion-real/escenarios.ts";
import { cortarMensaje, rngDesdeSemilla, ruidoStt } from "../voz-medicion-real/ruido-stt.ts";
import type { TurnoCliente } from "./tipos.ts";

export const SEMILLA_BASE = "2610";

export const semillaDe = (id: string, rep: number, base: string = SEMILLA_BASE): string => `${base}|${id}|${rep}`;

export interface OpcionesCliente {
  readonly modo: "texto" | "stt-final";
  readonly rep: number;
  readonly semillaBase?: string;
  /** 0 apaga el ruido; 1 = calibrado; 2 = linea mala. Solo aplica a "stt-final". */
  readonly nivelRuido?: number;
  /** Opcional (cliente adaptativo): convierte la intencion del guion en lo que dice el cliente. Por omision, la intencion se dice tal cual. */
  readonly generador?: (intenciones: readonly string[], historial: readonly { who: "cliente" | "agente"; text: string }[]) => Promise<string>;
}

export class ClienteSimulado {
  private k = 0;
  private gi = 0;
  readonly semilla: string;
  private readonly guion: readonly string[];
  readonly historial: { who: "cliente" | "agente"; text: string }[] = [];

  constructor(readonly escenario: Escenario, private readonly o: OpcionesCliente) {
    this.semilla = semillaDe(escenario.id, o.rep, o.semillaBase);
    this.guion = escenario.turnos.filter((t): t is string => typeof t === "string");
  }

  /** El agente respondio: lo necesita el generador adaptativo (no el guion fijo). */
  registrarAgente(texto: string): void {
    this.historial.push({ who: "agente", text: texto });
  }

  private degradar(dicho: string, indice: number, sinRuido: boolean): { oido: string; cambios: readonly string[] } {
    if (this.o.modo === "texto" || sinRuido || this.escenario.sinRuido === true) return { oido: dicho, cambios: [] };
    const r = ruidoStt(dicho, rngDesdeSemilla(`${this.semilla}|ruido|${indice}`), { nivel: this.o.nivelRuido ?? 1 });
    return { oido: r.texto, cambios: r.cambios };
  }

  /** Siguiente turno del cliente, o null cuando el guion se acabo. */
  async siguiente(): Promise<TurnoCliente | null> {
    if (this.k >= this.escenario.turnos.length) return null;
    const indice = this.k;
    const t = this.escenario.turnos[this.k]!;
    this.k += 1;
    const modo = this.o.modo;
    if (typeof t === "string") {
      const dicho = this.o.generador ? ((await this.o.generador(this.guion.slice(this.gi, this.gi + 3), this.historial)).replace(/\s+/g, " ").trim() || "Hola") : t;
      this.gi += 1;
      const { oido, cambios } = this.degradar(dicho, indice, false);
      this.historial.push({ who: "cliente", text: dicho });
      return { tipo: modo, dicho, oido, cambios };
    }
    const ev = t as Evento;
    if (ev.k === "interrumpe") {
      const { oido, cambios } = this.degradar(ev.dice, indice, false);
      this.historial.push({ who: "cliente", text: ev.dice });
      return { tipo: modo, dicho: ev.dice, oido, cambios, interrumpe: true };
    }
    if (ev.k === "cortada") {
      const cortado = cortarMensaje(ev.dice, rngDesdeSemilla(`${this.semilla}|corte|${indice}`));
      this.historial.push({ who: "cliente", text: cortado });
      return { tipo: modo, dicho: ev.dice, oido: cortado, cambios: [], sinRuido: true };
    }
    return { tipo: "evento", evento: ev };
  }
}
