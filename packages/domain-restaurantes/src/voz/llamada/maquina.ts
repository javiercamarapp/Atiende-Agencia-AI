// Maquina de estados de UNA llamada de voz de restaurantes (ADR-PM-001 §4). Es pura y determinista: recibe eventos del
// proveedor y de la telefonia, devuelve ACCIONES que el controlador ejecuta (decir un pregrabado, cortar el audio del
// agente, reconectar, escalar, colgar). No sabe de Gemini ni de LiveKit, por eso la misma maquina corre contra el
// proveedor real y contra el falso del simulador.
//
// Politicas que impone (todas con limite explicito, nada queda a criterio del modelo):
//   * barge-in: si el cliente habla mientras el agente habla, se corta el audio del agente;
//   * silencio: re-pregunta hasta `silenciosMax` veces y luego se despide (abandonada);
//   * ruido / no entendido: pide repetir; `malentendidosMax` seguidos pasan a una persona (no_entiende);
//   * DTMF opcional: 0 = persona, * = repetir;
//   * duracion maxima y costo maximo por llamada: avisa, corta y deja callback (nunca cuelga un pedido ya creado);
//   * proveedor caido: una reanudacion (`reconexionesMax`) y despues pregrabado + persona (falla_sistema);
//   * herramienta lenta (timeout): avisa; dos seguidas pasan a una persona.
import type { MotivoEscalacion } from "../../agent-tools/registry.ts";
import type { VozResultado } from "../types.ts";
import type { MensajeId } from "./mensajes.ts";

export interface LimitesLlamada {
  /** Duracion maxima de la llamada, en segundos (ADR: 8 min). */
  readonly duracionMaxS: number;
  /** A partir de aqui se avisa que la llamada esta por terminar. */
  readonly avisoDuracionS: number;
  /** Costo maximo estimado por llamada, en micro-USD (ADR: US$0.10). */
  readonly costoMaxMicroUsd: number;
  /** Silencio del cliente (tras hablar el agente) que cuenta como "no contesta". */
  readonly silencioMs: number;
  readonly silenciosMax: number;
  readonly malentendidosMax: number;
  /** Eventos de ruido sin habla inteligible seguidos que cuentan como un malentendido. */
  readonly ruidosParaMalentendido: number;
  readonly toolTimeoutMs: number;
  readonly timeoutsMax: number;
  readonly reconexionesMax: number;
  readonly reconexionEsperaMs: readonly number[];
  readonly dtmf: boolean;
}

export const LIMITES_POR_DEFECTO: LimitesLlamada = {
  duracionMaxS: 8 * 60,
  avisoDuracionS: 7 * 60,
  costoMaxMicroUsd: 100_000,
  silencioMs: 7_000,
  silenciosMax: 2,
  malentendidosMax: 2,
  ruidosParaMalentendido: 3,
  toolTimeoutMs: 4_000,
  timeoutsMax: 2,
  reconexionesMax: 1,
  reconexionEsperaMs: [400],
  dtmf: true,
};

export type EstadoLlamada = "iniciando" | "activa" | "reconectando" | "cerrada";

export type EventoLlamada =
  | { readonly tipo: "conectada" }
  /** El detector de voz oyo al cliente (sirve para el barge-in). */
  | { readonly tipo: "usuario_habla" }
  /** Habla del cliente ya transcrita. `inteligible: false` = ruido o voz que no se pudo interpretar. */
  | { readonly tipo: "usuario_dijo"; readonly inteligible?: boolean }
  | { readonly tipo: "agente_empieza" }
  | { readonly tipo: "agente_termina" }
  /** El cliente lleva `ms` sin hablar desde que el agente termino. */
  | { readonly tipo: "silencio"; readonly ms: number }
  | { readonly tipo: "ruido" }
  | { readonly tipo: "no_entendido" }
  | { readonly tipo: "dtmf"; readonly digito: string }
  | { readonly tipo: "tool_resultado"; readonly nombre: string; readonly ok: boolean; readonly orderId?: string | null; readonly timeout?: boolean }
  /** Costo adicional estimado (micro-USD) desde el ultimo evento de costo. */
  | { readonly tipo: "costo"; readonly microUsd: number }
  /** Segundos transcurridos desde que se conecto la llamada. */
  | { readonly tipo: "tick"; readonly segundos: number }
  | { readonly tipo: "proveedor_cae" }
  | { readonly tipo: "proveedor_vuelve" }
  | { readonly tipo: "cliente_cuelga" };

export type AccionLlamada =
  | { readonly tipo: "decir"; readonly mensaje: MensajeId }
  | { readonly tipo: "cortar_audio_agente" }
  | { readonly tipo: "pedir_repetir" }
  | { readonly tipo: "reconectar"; readonly intento: number; readonly esperaMs: number }
  | { readonly tipo: "escalar"; readonly motivo: MotivoEscalacion }
  | { readonly tipo: "colgar"; readonly resultado: VozResultado };

export class CallStateMachine {
  private estado: EstadoLlamada = "iniciando";
  private agenteHablando = false;
  private silencios = 0;
  private malentendidos = 0;
  private ruidos = 0;
  private timeouts = 0;
  private reconexiones = 0;
  private costo = 0;
  private avisoDuracionDado = false;
  private pedidoCreado = false;
  private escalado = false;
  /** El agente ya paso a la persona por su cuenta: la llamada termina cuando acabe de despedirse. */
  private cerrarAlTerminar = false;
  private resultadoFinal: VozResultado | null = null;

  constructor(private readonly limites: LimitesLlamada = LIMITES_POR_DEFECTO) {}

  get estadoActual(): EstadoLlamada {
    return this.estado;
  }
  get resultado(): VozResultado | null {
    return this.resultadoFinal;
  }
  get costoMicroUsd(): number {
    return this.costo;
  }
  get hayPedido(): boolean {
    return this.pedidoCreado;
  }

  recibir(ev: EventoLlamada): readonly AccionLlamada[] {
    if (this.estado === "cerrada") return [];
    switch (ev.tipo) {
      case "conectada":
        if (this.estado === "iniciando") this.estado = "activa";
        return [];
      case "agente_empieza":
        this.agenteHablando = true;
        return [];
      case "agente_termina":
        this.agenteHablando = false;
        return this.cerrarAlTerminar ? this.cerrar([]) : [];
      case "usuario_habla":
        if (this.agenteHablando) {
          this.agenteHablando = false;
          return [{ tipo: "cortar_audio_agente" }];
        }
        return [];
      case "usuario_dijo":
        if (ev.inteligible === false) return this.ruido();
        this.silencios = 0;
        this.malentendidos = 0;
        this.ruidos = 0;
        return [];
      case "ruido":
        return this.ruido();
      case "no_entendido":
        return this.malentendido();
      case "silencio":
        return ev.ms >= this.limites.silencioMs ? this.silencio() : [];
      case "dtmf":
        return this.dtmf(ev.digito);
      case "tool_resultado":
        return this.herramienta(ev);
      case "costo":
        this.costo += Math.max(0, ev.microUsd);
        return this.costo >= this.limites.costoMaxMicroUsd ? this.cortar("limite_costo") : [];
      case "tick":
        return this.reloj(ev.segundos);
      case "proveedor_cae":
        return this.proveedorCae();
      case "proveedor_vuelve":
        if (this.estado === "reconectando") this.estado = "activa";
        return [];
      case "cliente_cuelga":
        return this.cerrar([], false);
    }
  }

  /** Cierra la llamada. `colgar` solo se emite cuando la llamada la termina el sistema (el cliente que cuelga ya no la necesita). */
  private cerrar(acciones: AccionLlamada[], colgar = true): AccionLlamada[] {
    const resultado: VozResultado = this.pedidoCreado ? "pedido_creado" : this.escalado ? "escalado" : "abandonado";
    this.estado = "cerrada";
    this.resultadoFinal = resultado;
    return colgar ? [...acciones, { tipo: "colgar", resultado }] : [];
  }

  /** Pasa a una persona (callback) y cierra. Con un pedido ya creado solo se despide: no se escala algo resuelto. */
  private aPersona(motivo: MotivoEscalacion, mensaje: MensajeId): AccionLlamada[] {
    if (this.pedidoCreado) return this.cerrar([{ tipo: "decir", mensaje: "despedida" }]);
    this.escalado = true;
    return this.cerrar([{ tipo: "decir", mensaje }, { tipo: "escalar", motivo }]);
  }

  private cortar(mensaje: "limite_duracion" | "limite_costo"): AccionLlamada[] {
    return this.aPersona("no_puedo_resolver", mensaje);
  }

  private ruido(): AccionLlamada[] {
    this.ruidos += 1;
    if (this.ruidos < this.limites.ruidosParaMalentendido) return [];
    this.ruidos = 0;
    return this.malentendido();
  }

  private malentendido(): AccionLlamada[] {
    this.malentendidos += 1;
    if (this.malentendidos >= this.limites.malentendidosMax) return this.aPersona("no_entiende", "handoff");
    return [{ tipo: "pedir_repetir" }];
  }

  private silencio(): AccionLlamada[] {
    if (this.pedidoCreado) return this.cerrar([{ tipo: "decir", mensaje: "despedida" }]);
    this.silencios += 1;
    if (this.silencios <= this.limites.silenciosMax) return [{ tipo: "decir", mensaje: "silencio_reprompt" }];
    return this.cerrar([{ tipo: "decir", mensaje: "silencio_despedida" }]);
  }

  private dtmf(digito: string): AccionLlamada[] {
    if (!this.limites.dtmf) return [];
    if (digito === "0") return this.aPersona("cliente_lo_pide", "handoff");
    if (digito === "*") return [{ tipo: "pedir_repetir" }];
    return [];
  }

  private herramienta(ev: Extract<EventoLlamada, { tipo: "tool_resultado" }>): AccionLlamada[] {
    if (ev.timeout) {
      this.timeouts += 1;
      if (this.timeouts >= this.limites.timeoutsMax) return this.aPersona("falla_sistema", "proveedor_caido");
      return [{ tipo: "decir", mensaje: "tool_timeout" }];
    }
    this.timeouts = 0;
    if (ev.ok && ev.nombre === "crear_pedido" && ev.orderId) this.pedidoCreado = true;
    if (ev.ok && ev.nombre === "escalar_a_humano") {
      this.escalado = true;
      this.cerrarAlTerminar = !this.pedidoCreado;
    }
    return [];
  }

  private reloj(segundos: number): AccionLlamada[] {
    if (segundos >= this.limites.duracionMaxS) return this.cortar("limite_duracion");
    if (segundos >= this.limites.avisoDuracionS && !this.avisoDuracionDado) {
      this.avisoDuracionDado = true;
      return [{ tipo: "decir", mensaje: "aviso_duracion" }];
    }
    return [];
  }

  private proveedorCae(): AccionLlamada[] {
    if (this.reconexiones < this.limites.reconexionesMax) {
      this.reconexiones += 1;
      this.estado = "reconectando";
      this.agenteHablando = false;
      const espera = this.limites.reconexionEsperaMs[Math.min(this.reconexiones - 1, this.limites.reconexionEsperaMs.length - 1)] ?? 0;
      return [{ tipo: "reconectar", intento: this.reconexiones, esperaMs: espera }];
    }
    return this.aPersona("falla_sistema", "proveedor_caido");
  }
}
