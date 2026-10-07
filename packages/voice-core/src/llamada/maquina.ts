// Maquina de estados de UNA llamada de voz (ADR-PM-001 §4), compartida por todas las verticales. Es pura y determinista: recibe eventos del
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
import { COSTO_MAX_LLAMADA_MICRO_USD } from "../costo-gemini.ts";
import type { VozResultadoBase } from "../types.ts";
import type { MensajeId } from "./mensajes.ts";

/** Motivos con los que la maquina escala por su cuenta. Los registros de tools de cada vertical aceptan un conjunto mayor. */
export type MotivoEscalacionLlamada = "no_entiende" | "cliente_lo_pide" | "falla_sistema" | "no_puedo_resolver" | "otro";

/** Lo que la vertical le dice a la maquina sobre SU objetivo: que herramienta, cuando sale bien, cierra la llamada como lograda
 * (restaurantes: `crear_pedido` -> `pedido_creado`; hoteles: `crear_pre_reserva` -> `pre_reserva_creada`) y cual es la de pasar a una
 * persona. Una llamada ya lograda nunca se escala: solo se despide. */
export interface ReglasCierreLlamada<R extends string> {
  /** Herramienta (o varias) que, al salir bien y devolver una entidad (`entidadId`), logran el objetivo de la llamada. */
  readonly herramientaObjetivo: string | readonly string[];
  readonly resultadoObjetivo: R;
  /** Herramienta con la que el agente pasa por su cuenta a una persona. */
  readonly herramientaEscalar: string;
}

export interface LimitesLlamada {
  /** Duracion maxima de la llamada, en segundos (ADR: 8 min). */
  readonly duracionMaxS: number;
  /** A partir de aqui se avisa que la llamada esta por terminar. */
  readonly avisoDuracionS: number;
  /** Costo maximo estimado por llamada, en micro-USD (antes US$0.10 del ADR; ver costo-gemini.ts). */
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

/** Opciones de comportamiento de la maquina (no son limites numericos). */
export interface OpcionesMaquinaLlamada {
  /** `false` = el PRIMER turno del agente (el saludo con el aviso de asistente virtual y grabacion) no se corta aunque el cliente hable encima: el
   * barge-in se ignora hasta que el saludo termina. Cumplimiento (P37): el aviso se escucha completo. Por omision `true` (como siempre). */
  readonly saludoInterrumpible?: boolean;
}

export const LIMITES_POR_DEFECTO: LimitesLlamada = {
  duracionMaxS: 8 * 60,
  avisoDuracionS: 7 * 60,
  // US$0.50: la facturacion compuesta de Gemini Live deja una llamada media en ~US$0.17 y una larga en ~US$0.42 (src/costo-gemini.ts). Antes US$0.10.
  costoMaxMicroUsd: COSTO_MAX_LLAMADA_MICRO_USD,
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
  | {
      readonly tipo: "tool_resultado";
      readonly nombre: string;
      readonly ok: boolean;
      readonly entidadId?: string | null;
      readonly timeout?: boolean;
      /** La herramienta objetivo salio bien pero NO creo la entidad: el servidor retuvo el pedido para que una persona lo confirme (pedido grande). La llamada termina `escalado`. */
      readonly retenido?: boolean;
      /** El timeout de una herramienta de escritura dejo el resultado INCIERTO (el servidor pudo haberla registrado). */
      readonly incierto?: boolean;
    }
  /** El agente ya se despidio (el controlador lo detecta en su texto): si el objetivo esta logrado, la llamada cuelga al terminar ese turno (checklist C02 / X51). */
  | { readonly tipo: "despedida_dicha" }
  /** Costo adicional estimado (micro-USD) desde el ultimo evento de costo. */
  | { readonly tipo: "costo"; readonly microUsd: number }
  /** Segundos transcurridos desde que se conecto la llamada. */
  | { readonly tipo: "tick"; readonly segundos: number }
  | { readonly tipo: "proveedor_cae" }
  | { readonly tipo: "proveedor_vuelve" }
  | { readonly tipo: "cliente_cuelga" }
  /** Una guardia DETERMINISTA de la vertical (p. ej. crisis) ya dijo su texto y escalo a una persona: la llamada se cierra como `escalado`,
   * aunque ya se hubiera logrado el objetivo (una guardia de seguridad pesa mas que un cierre exitoso). */
  | { readonly tipo: "escalada_forzada" };

export type AccionLlamada<R extends string = string> =
  | { readonly tipo: "decir"; readonly mensaje: MensajeId }
  | { readonly tipo: "cortar_audio_agente" }
  | { readonly tipo: "pedir_repetir" }
  | { readonly tipo: "reconectar"; readonly intento: number; readonly esperaMs: number }
  | { readonly tipo: "escalar"; readonly motivo: MotivoEscalacionLlamada }
  | { readonly tipo: "colgar"; readonly resultado: R | VozResultadoBase };

export class CallStateMachine<R extends string = string> {
  private estado: EstadoLlamada = "iniciando";
  private agenteHablando = false;
  private silencios = 0;
  private malentendidos = 0;
  private ruidos = 0;
  private timeouts = 0;
  private reconexiones = 0;
  private costo = 0;
  private avisoDuracionDado = false;
  /** La llamada ya logro su objetivo (la herramienta objetivo salio bien): no se escala algo resuelto. */
  private objetivoLogrado = false;
  private escalado = false;
  /** Una guardia de la vertical forzo la escalada: el resultado es `escalado` pase lo que pase. */
  private escaladoForzado = false;
  /** El saludo (primer turno del agente) esta sonando y no es interrumpible. */
  private saludoProtegido = false;
  private saludoDicho = false;
  /** El agente ya paso a la persona por su cuenta: la llamada termina cuando acabe de despedirse. */
  private cerrarAlTerminar = false;
  /** Ya se dejo el aviso de un resultado incierto de la herramienta objetivo (una sola vez). */
  private avisoIncierto = false;
  private resultadoFinal: R | VozResultadoBase | null = null;

  constructor(
    private readonly reglas: ReglasCierreLlamada<R>,
    private readonly limites: LimitesLlamada = LIMITES_POR_DEFECTO,
    private readonly opciones: OpcionesMaquinaLlamada = {},
  ) {}

  get estadoActual(): EstadoLlamada {
    return this.estado;
  }
  get resultado(): R | VozResultadoBase | null {
    return this.resultadoFinal;
  }
  get costoMicroUsd(): number {
    return this.costo;
  }
  /** La herramienta objetivo de la vertical ya salio bien (hay pedido, hay reserva apartada...). */
  get hayObjetivo(): boolean {
    return this.objetivoLogrado;
  }

  recibir(ev: EventoLlamada): readonly AccionLlamada<R>[] {
    if (this.estado === "cerrada") return [];
    switch (ev.tipo) {
      case "conectada":
        if (this.estado === "iniciando") this.estado = "activa";
        return [];
      case "agente_empieza":
        this.agenteHablando = true;
        // El primer turno del agente ES el saludo; si no es interrumpible, queda protegido hasta que termine.
        if (!this.saludoDicho) {
          this.saludoDicho = true;
          this.saludoProtegido = this.opciones.saludoInterrumpible === false;
        }
        return [];
      case "agente_termina":
        this.agenteHablando = false;
        this.saludoProtegido = false;
        return this.cerrarAlTerminar ? this.cerrar([]) : [];
      case "usuario_habla":
        // Saludo no interrumpible: el cliente habla encima y el audio NO se corta (el agente sigue hablando hasta terminar el aviso).
        if (this.saludoProtegido) return [];
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
      case "despedida_dicha":
        if (this.objetivoLogrado) this.cerrarAlTerminar = true;
        return [];
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
      case "escalada_forzada":
        this.escalado = true;
        this.escaladoForzado = true;
        return this.cerrar([]);
    }
  }

  /** Cierra la llamada. `colgar` solo se emite cuando la llamada la termina el sistema (el cliente que cuelga ya no la necesita). */
  private cerrar(acciones: AccionLlamada<R>[], colgar = true): AccionLlamada<R>[] {
    const resultado: R | VozResultadoBase = this.escaladoForzado ? "escalado" : this.objetivoLogrado ? this.reglas.resultadoObjetivo : this.escalado ? "escalado" : "abandonado";
    this.estado = "cerrada";
    this.resultadoFinal = resultado;
    return colgar ? [...acciones, { tipo: "colgar", resultado }] : [];
  }

  /** Pasa a una persona (callback) y cierra. Con un pedido ya creado solo se despide: no se escala algo resuelto. */
  private aPersona(motivo: MotivoEscalacionLlamada, mensaje: MensajeId): AccionLlamada<R>[] {
    if (this.objetivoLogrado) return this.cerrar([{ tipo: "decir", mensaje: "despedida" }]);
    this.escalado = true;
    return this.cerrar([{ tipo: "decir", mensaje }, { tipo: "escalar", motivo }]);
  }

  private cortar(mensaje: "limite_duracion" | "limite_costo"): AccionLlamada<R>[] {
    return this.aPersona("no_puedo_resolver", mensaje);
  }

  private ruido(): AccionLlamada<R>[] {
    this.ruidos += 1;
    if (this.ruidos < this.limites.ruidosParaMalentendido) return [];
    this.ruidos = 0;
    return this.malentendido();
  }

  private malentendido(): AccionLlamada<R>[] {
    this.malentendidos += 1;
    if (this.malentendidos >= this.limites.malentendidosMax) return this.aPersona("no_entiende", "handoff");
    return [{ tipo: "pedir_repetir" }];
  }

  private silencio(): AccionLlamada<R>[] {
    if (this.objetivoLogrado) return this.cerrar([{ tipo: "decir", mensaje: "despedida" }]);
    this.silencios += 1;
    if (this.silencios <= this.limites.silenciosMax) return [{ tipo: "decir", mensaje: "silencio_reprompt" }];
    return this.cerrar([{ tipo: "decir", mensaje: "silencio_despedida" }]);
  }

  private dtmf(digito: string): AccionLlamada<R>[] {
    if (!this.limites.dtmf) return [];
    if (digito === "0") return this.aPersona("cliente_lo_pide", "handoff");
    if (digito === "*") return [{ tipo: "pedir_repetir" }];
    return [];
  }

  private herramienta(ev: Extract<EventoLlamada, { tipo: "tool_resultado" }>): AccionLlamada<R>[] {
    if (ev.timeout) {
      this.timeouts += 1;
      if (this.timeouts >= this.limites.timeoutsMax) return this.aPersona("falla_sistema", "proveedor_caido");
      // QA-PM-R2-voz-04: el timeout de la herramienta objetivo deja un resultado INCIERTO (el pedido pudo quedar en cocina). Se promete "una persona le confirma",
      // asi que esa persona SI debe enterarse: aviso inmediato (sin colgar) para que verifique, y la llamada termina `escalado`, no `abandonado`.
      if (ev.incierto && this.esObjetivo(ev.nombre) && !this.objetivoLogrado && !this.avisoIncierto) {
        this.avisoIncierto = true;
        this.escalado = true;
        return [{ tipo: "decir", mensaje: "tool_timeout" }, { tipo: "escalar", motivo: "falla_sistema" }];
      }
      return [{ tipo: "decir", mensaje: "tool_timeout" }];
    }
    this.timeouts = 0;
    if (ev.ok && ev.entidadId && this.esObjetivo(ev.nombre)) this.objetivoLogrado = true;
    // Pedido grande retenido por el servidor: el aviso ya existe; la llamada es `escalado` en los KPI (antes quedaba `abandonado`).
    if (ev.ok && !ev.entidadId && ev.retenido && this.esObjetivo(ev.nombre)) this.escalado = true;
    if (ev.ok && ev.nombre === this.reglas.herramientaEscalar) {
      this.escalado = true;
      this.cerrarAlTerminar = !this.objetivoLogrado;
    }
    return [];
  }

  private esObjetivo(nombre: string): boolean {
    const h = this.reglas.herramientaObjetivo;
    return typeof h === "string" ? h === nombre : h.includes(nombre);
  }

  private reloj(segundos: number): AccionLlamada<R>[] {
    if (segundos >= this.limites.duracionMaxS) return this.cortar("limite_duracion");
    if (segundos >= this.limites.avisoDuracionS && !this.avisoDuracionDado) {
      this.avisoDuracionDado = true;
      return [{ tipo: "decir", mensaje: "aviso_duracion" }];
    }
    return [];
  }

  private proveedorCae(): AccionLlamada<R>[] {
    if (this.reconexiones < this.limites.reconexionesMax) {
      this.reconexiones += 1;
      this.estado = "reconectando";
      this.agenteHablando = false;
      this.saludoProtegido = false;
      const espera = this.limites.reconexionEsperaMs[Math.min(this.reconexiones - 1, this.limites.reconexionEsperaMs.length - 1)] ?? 0;
      return [{ tipo: "reconectar", intento: this.reconexiones, esperaMs: espera }];
    }
    return this.aPersona("falla_sistema", "proveedor_caido");
  }
}
