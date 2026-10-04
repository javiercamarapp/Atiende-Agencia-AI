// Controlador de UNA llamada (compartido por todas las verticales): une la maquina de estados (`maquina.ts`), la sesion con el proveedor (`sesion.ts`) y el
// ejecutor de herramientas. Es el nucleo que corre el worker de voz (LiveKit SIP) y, igual, el simulador local con el
// proveedor falso. No toca audio, relojes ni red por su cuenta: todo llega inyectado.
//
// Los eventos se procesan en serie (una cola), asi una acción async (reconectar, escalar) nunca se mezcla con el
// siguiente evento. Los logs salen por `eventoSinPII` y la transcripcion se redacta antes de guardarla.
import type { VozResultadoBase } from "../types.ts";
import { redactarTranscripcion } from "../transcripcion.ts";
import type { EjecutorTools } from "./ejecutor-tools.ts";
import { evaluarInicioLlamada } from "./inicio.ts";
import type { EntradaInicioLlamada } from "./inicio.ts";
import { eventoSinPII, referenciaLlamada } from "./log-sin-pii.ts";
import type { SumideroLog } from "./log-sin-pii.ts";
import { CallStateMachine, LIMITES_POR_DEFECTO } from "./maquina.ts";
import type { AccionLlamada, EventoLlamada, LimitesLlamada, ReglasCierreLlamada } from "./maquina.ts";
import type { MensajeId } from "./mensajes.ts";
import type { AbrirSesionLlamada, ToolCallPedida, VozSesionLlamada } from "./sesion.ts";

export type EventoKpiLlamada =
  | { readonly tipo: "tool_call"; readonly herramienta: string; readonly latenciaMs: number }
  | { readonly tipo: "error_proveedor"; readonly proveedor: "gemini" | "twilio" | "otro"; readonly codigo: string };

export interface TurnoTranscrito {
  readonly rol: "cliente" | "agente" | "herramienta";
  /** Ya redactado (PAN/CVV); las herramientas llevan solo el nombre. */
  readonly texto: string;
}

/** Lo que decide una guardia determinista del cliente (nunca el modelo). `texto` se dice TAL CUAL al cliente (no se reformula ni se resume). */
export interface DecisionGuardiaCliente {
  readonly texto: string;
  /** Motivo de la escalada (llega a `construirEscalacion`; sin datos del cliente). */
  readonly motivo: string;
  readonly resumen: string;
}

/** Guardia de seguridad de la vertical sobre lo que DICE el cliente (citas: crisis). Corre en cada habla inteligible, ANTES de que el modelo
 * la reciba (en modo texto) o conteste (en audio, se interrumpe al agente). Si decide, el controlador interrumpe al agente, dice el texto,
 * escala a una persona con `construirEscalacion` y cierra la llamada como `escalado`. `evaluar` es sincrona y pura (sin red): la escalacion
 * persistente corre en la herramienta de escalar, del lado del servidor. */
export interface GuardiaCliente {
  evaluar(texto: string): DecisionGuardiaCliente | null;
  /** Reproduce el texto al cliente (en produccion, sintesis local; en el simulador, queda en `textosGuardia`). Se espera a que termine. */
  decir(texto: string): void | Promise<void>;
}

export interface DepsControlador<R extends string = string> {
  readonly callId: string;
  /** Lo que la vertical le dice a la maquina sobre su objetivo y su herramienta de escalar. */
  readonly reglas: ReglasCierreLlamada<R>;
  /** Arma la llamada a la herramienta con la que se pasa a una persona (los argumentos son de la vertical: restaurantes pide `customer_name`). */
  readonly construirEscalacion: (motivo: string, resumen: string) => { readonly nombre: string; readonly args: Readonly<Record<string, unknown>> };
  readonly propertyId: string;
  readonly organizationId: string;
  readonly abrirSesion: AbrirSesionLlamada;
  /** Guardia determinista de la vertical sobre lo que dice el cliente (opcional). */
  readonly guardiaCliente?: GuardiaCliente;
  readonly ejecutor: EjecutorTools;
  readonly instruccion: string;
  readonly voiceId: string;
  readonly limites?: LimitesLlamada;
  /** Reproduce un mensaje pregrabado (audio local, independiente del proveedor). */
  readonly reproducir: (mensaje: MensajeId) => void | Promise<void>;
  /** Corta el audio que se este reproduciendo al cliente (barge-in). */
  readonly cortarAudio?: () => void;
  readonly log?: SumideroLog;
  readonly kpi?: (e: EventoKpiLlamada) => void | Promise<void>;
  readonly dormir?: (ms: number) => Promise<void>;
  /** Solo simulador/pruebas: recibe cada tool con sus argumentos reales (el log de produccion nunca los lleva). */
  readonly trazarTool?: (t: { readonly nombre: string; readonly args: unknown; readonly resultado: unknown }) => void;
}

export interface ResultadoLlamada<R extends string = string> {
  readonly resultado: R | VozResultadoBase;
  readonly costoMicroUsd: number;
}

const MENSAJES_QUE_NO_CORTAN: ReadonlySet<MensajeId> = new Set<MensajeId>(["tool_timeout", "silencio_reprompt", "aviso_duracion"]);

export class ControladorLlamada<R extends string = string> {
  readonly maquina: CallStateMachine<R>;
  readonly transcripcion: TurnoTranscrito[] = [];
  private sesion: VozSesionLlamada | null = null;
  private cola: Promise<void> = Promise.resolve();
  private handleReanudacion: string | null = null;
  /** Hablas inteligibles del cliente en esta llamada: es el "turno" con el que el servidor ordena cotizacion y confirmacion. */
  private turnosCliente = 0;
  private resolverFin!: (r: ResultadoLlamada<R>) => void;
  /** Se resuelve cuando la llamada termina (el sistema cuelga o el cliente cuelga). */
  readonly terminada: Promise<ResultadoLlamada<R>>;
  private readonly ref: string;

  constructor(private readonly deps: DepsControlador<R>) {
    this.maquina = new CallStateMachine<R>(deps.reglas, deps.limites ?? LIMITES_POR_DEFECTO);
    this.terminada = new Promise((resolve) => {
      this.resolverFin = resolve;
    });
    this.ref = referenciaLlamada(deps.callId);
  }

  /** Abre la llamada. Si la decision de inicio la rechaza NO se abre sesion con el proveedor (no cuesta): se dice el pregrabado y se deja callback. */
  async iniciar(entrada: EntradaInicioLlamada): Promise<{ readonly iniciada: boolean }> {
    const decision = evaluarInicioLlamada(entrada);
    this.log("llamada_inicio", { ok: decision.ok, ...(decision.ok ? {} : { razon: decision.razon }) });
    if (!decision.ok) {
      await this.deps.reproducir(decision.mensaje);
      await this.escalar(decision.razon === "tope_mensual" ? "otro" : "falla_sistema", `Llamada no atendida por el agente: ${decision.razon}.`);
      this.resolverFin({ resultado: "escalado", costoMicroUsd: 0 });
      return { iniciada: false };
    }
    try {
      this.sesion = await this.abrir(null);
    } catch {
      await this.encolar(() => this.eventoInterno({ tipo: "proveedor_cae" }));
      return { iniciada: this.maquina.estadoActual !== "cerrada" };
    }
    await this.encolar(() => this.eventoInterno({ tipo: "conectada" }));
    return { iniciada: true };
  }

  // ---- entradas desde la telefonia / el cliente ----
  usuarioHabla(): Promise<void> {
    return this.encolar(() => this.eventoInterno({ tipo: "usuario_habla" }));
  }
  /** Habla del cliente ya transcrita (en modo texto, el guion). */
  usuarioDijo(texto: string, inteligible = true): Promise<void> {
    return this.encolar(async () => {
      this.transcripcion.push({ rol: "cliente", texto: redactarTranscripcion(texto) });
      // La guardia va ANTES del modelo: el texto del cliente con una senal de seguridad nunca se le manda para que decida el.
      if (inteligible && (await this.aplicarGuardia(texto))) return;
      if (inteligible) this.turnosCliente += 1;
      await this.eventoInterno({ tipo: "usuario_dijo", inteligible });
      if (inteligible && this.maquina.estadoActual !== "cerrada") this.sesion?.enviarTexto(texto);
    });
  }
  silencio(ms: number): Promise<void> {
    return this.encolar(() => this.eventoInterno({ tipo: "silencio", ms }));
  }
  /** Costo adicional estimado de la llamada (micro-USD). */
  costo(microUsd: number): Promise<void> {
    return this.encolar(() => this.eventoInterno({ tipo: "costo", microUsd }));
  }
  /** El agente o el reconocedor no pudo interpretar lo que dijo el cliente. */
  noEntendido(): Promise<void> {
    return this.encolar(() => this.eventoInterno({ tipo: "no_entendido" }));
  }
  ruido(): Promise<void> {
    return this.encolar(() => this.eventoInterno({ tipo: "ruido" }));
  }
  dtmf(digito: string): Promise<void> {
    return this.encolar(() => this.eventoInterno({ tipo: "dtmf", digito }));
  }
  tick(segundos: number): Promise<void> {
    return this.encolar(() => this.eventoInterno({ tipo: "tick", segundos }));
  }
  /** El proveedor se cayo (red, error 5xx, `goAway`). */
  proveedorCae(razon = "cierre_inesperado"): Promise<void> {
    return this.encolar(() => this.alCaer(razon, this.handleReanudacion));
  }
  clienteCuelga(): Promise<void> {
    return this.encolar(() => this.eventoInterno({ tipo: "cliente_cuelga" }));
  }
  /** Espera a que se procesen todos los eventos pendientes. */
  async vacio(): Promise<void> {
    await this.cola;
  }

  // ---- internos ----
  private encolar(fn: () => Promise<void>): Promise<void> {
    const siguiente = this.cola.then(fn, fn);
    this.cola = siguiente.catch(() => undefined);
    return siguiente;
  }

  private log(evento: string, campos: Readonly<Record<string, unknown>> = {}): void {
    if (this.deps.log) eventoSinPII(this.deps.log, evento, { callRef: this.ref, propertyId: this.deps.propertyId, organizationId: this.deps.organizationId, ...campos });
  }

  private abrir(handle: string | null): Promise<VozSesionLlamada> {
    return this.deps.abrirSesion(
      { instruccion: this.deps.instruccion, voiceId: this.deps.voiceId, herramientas: this.deps.ejecutor.definiciones(), reanudarHandle: handle },
      {
        agenteDijo: (texto) => void this.encolar(async () => {
          this.transcripcion.push({ rol: "agente", texto: redactarTranscripcion(texto) });
          await this.eventoInterno({ tipo: "agente_empieza" });
        }),
        agenteTermino: () => void this.encolar(() => this.eventoInterno({ tipo: "agente_termina" })),
        interrumpido: () => void this.encolar(() => this.eventoInterno({ tipo: "agente_termina" })),
        usuarioDijo: (texto) => void this.encolar(async () => {
          this.transcripcion.push({ rol: "cliente", texto: redactarTranscripcion(texto) });
          if (await this.aplicarGuardia(texto)) return;
          this.turnosCliente += 1;
          await this.eventoInterno({ tipo: "usuario_dijo", inteligible: true });
        }),
        ejecutarTool: (llamada) => this.herramienta(llamada),
        costo: (microUsd) => void this.encolar(() => this.eventoInterno({ tipo: "costo", microUsd })),
        caido: (razon, handle) => void this.encolar(() => this.alCaer(razon, handle)),
      },
    );
  }

  /** Corre la guardia del cliente; `true` si actuo (dijo su texto, escalo y cerro): el evento ya no sigue su camino normal. */
  private async aplicarGuardia(texto: string): Promise<boolean> {
    const guardia = this.deps.guardiaCliente;
    if (!guardia || this.maquina.estadoActual === "cerrada") return false;
    const decision = guardia.evaluar(texto);
    if (!decision) return false;
    // Solo el MOTIVO queda en el log: nunca lo que dijo el cliente.
    this.log("guardia_cliente", { motivo: decision.motivo });
    this.sesion?.interrumpir();
    this.deps.cortarAudio?.();
    await guardia.decir(decision.texto);
    await this.escalar(decision.motivo, decision.resumen);
    await this.eventoInterno({ tipo: "escalada_forzada" });
    return true;
  }

  private async herramienta(llamada: ToolCallPedida): Promise<unknown> {
    const salida = await this.deps.ejecutor.ejecutar(llamada.nombre, llamada.args, { turno: this.turnosCliente });
    this.deps.trazarTool?.({ nombre: llamada.nombre, args: llamada.args, resultado: salida.resultado });
    this.transcripcion.push({ rol: "herramienta", texto: llamada.nombre });
    this.log("tool", { herramienta: llamada.nombre, ok: salida.ok, timeout: salida.timeout, ms: salida.latenciaMs });
    await this.deps.kpi?.({ tipo: "tool_call", herramienta: llamada.nombre, latenciaMs: salida.latenciaMs });
    // La maquina puede ordenar acciones (aviso por tool lenta, escalar tras dos timeouts) ANTES de contestar al modelo.
    await this.encolar(() => this.eventoInterno({ tipo: "tool_resultado", nombre: llamada.nombre, ok: salida.ok, entidadId: salida.entidadId, timeout: salida.timeout }));
    return salida.resultado;
  }

  private async alCaer(razon: string, handle: string | null): Promise<void> {
    if (this.maquina.estadoActual === "cerrada") return;
    if (handle) this.handleReanudacion = handle;
    this.log("proveedor_cae", { razon });
    await this.deps.kpi?.({ tipo: "error_proveedor", proveedor: "gemini", codigo: razon.slice(0, 40) });
    this.sesion = null;
    await this.eventoInterno({ tipo: "proveedor_cae" });
  }

  private async eventoInterno(ev: EventoLlamada): Promise<void> {
    const acciones = this.maquina.recibir(ev);
    for (const a of acciones) await this.ejecutarAccion(a);
    const resultado = this.maquina.resultado;
    if (resultado !== null) await this.finalizar(resultado);
  }

  private finalizado = false;
  /** Cierra la sesion y resuelve `terminada` una sola vez (cuelga el sistema o cuelga el cliente). */
  private async finalizar(resultado: R | VozResultadoBase): Promise<void> {
    if (this.finalizado) return;
    this.finalizado = true;
    const sesion = this.sesion;
    this.sesion = null;
    await sesion?.cerrar().catch(() => undefined);
    this.log("llamada_fin", { resultado, costoMicroUsd: this.maquina.costoMicroUsd });
    this.resolverFin({ resultado, costoMicroUsd: this.maquina.costoMicroUsd });
  }

  private async escalar(motivo: string, resumen: string): Promise<void> {
    const llamada = this.deps.construirEscalacion(motivo, resumen);
    const salida = await this.deps.ejecutor.ejecutar(llamada.nombre, llamada.args);
    this.log("escalada", { motivo, ok: salida.ok });
  }

  private async ejecutarAccion(a: AccionLlamada<R>): Promise<void> {
    this.log("accion", { mensaje: a.tipo === "decir" ? a.mensaje : a.tipo });
    switch (a.tipo) {
      case "decir":
        // Los avisos que no cierran la llamada (tool lenta, re-pregunta, aviso de duracion) se superponen sin cortar el
        // turno del agente: si no, una tool lenta dejaria al modelo a medias. Los terminales si lo callan.
        if (!MENSAJES_QUE_NO_CORTAN.has(a.mensaje)) this.sesion?.interrumpir();
        await this.deps.reproducir(a.mensaje);
        return;
      case "pedir_repetir":
        await this.deps.reproducir("pedir_repetir");
        return;
      case "cortar_audio_agente":
        this.deps.cortarAudio?.();
        this.sesion?.interrumpir();
        return;
      case "escalar":
        await this.escalar(a.motivo, `Escalada automática de la llamada: ${a.motivo}.`);
        return;
      case "reconectar": {
        await (this.deps.dormir ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms))))(a.esperaMs);
        try {
          this.sesion = await this.abrir(this.handleReanudacion);
          this.log("reconexion_ok", { intento: a.intento });
          await this.eventoInterno({ tipo: "proveedor_vuelve" });
        } catch {
          this.log("reconexion_fallo", { intento: a.intento });
          await this.deps.kpi?.({ tipo: "error_proveedor", proveedor: "gemini", codigo: "reconexion_fallo" });
          await this.eventoInterno({ tipo: "proveedor_cae" });
        }
        return;
      }
      case "colgar":
        await this.finalizar(a.resultado);
        return;
    }
  }
}
