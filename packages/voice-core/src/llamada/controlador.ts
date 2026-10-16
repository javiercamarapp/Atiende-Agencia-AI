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
  /** `false` = el saludo del agente no se corta si el cliente habla encima (`branch_voice_config.mensaje_inicial_interrumpible`). Por omision `true`. */
  readonly saludoInterrumpible?: boolean;
  /** Reproduce un mensaje pregrabado (audio local, independiente del proveedor). */
  readonly reproducir: (mensaje: MensajeId) => void | Promise<void>;
  /** Corta el audio que se este reproduciendo al cliente (barge-in). */
  readonly cortarAudio?: () => void;
  readonly log?: SumideroLog;
  readonly kpi?: (e: EventoKpiLlamada) => void | Promise<void>;
  readonly dormir?: (ms: number) => Promise<void>;
  /** Si el agente se queda CALLADO tantos ms despues de recibir el resultado de una herramienta (el modelo se colgo 55 a 105 s en la corrida real), el
   * controlador dice el pregrabado "tool_timeout" (un momento, por favor) en vez de dejar al cliente en silencio (QA-PM-R2-voz-06). Sin valor = apagado. */
  readonly vigilarSilencioAgenteMs?: number;
  /** Solo simulador/pruebas: recibe cada tool con sus argumentos reales (el log de produccion nunca los lleva). */
  readonly trazarTool?: (t: { readonly nombre: string; readonly args: unknown; readonly resultado: unknown }) => void;
}

export interface ResultadoLlamada<R extends string = string> {
  readonly resultado: R | VozResultadoBase;
  readonly costoMicroUsd: number;
}

/** El agente se despide (la llamada ya logro su objetivo): "hasta luego", "que tenga buen dia", "gracias por llamar". */
const DESPEDIDA_RE = /\b(?:hasta\s+luego|que\s+tenga\s+(?:un\s+)?(?:excelente\s+|muy\s+)?(?:buen|bonit)[oa]\s+(?:d[ií]a|tarde|noche)|buen[oa]s?\s+(?:d[ií]as?|tardes?|noches?)\s*$|gracias\s+por\s+(?:llamar|su\s+llamada|comunicarse)|con\s+gusto,?\s+que\s+est[eé]\s+bien)/i;

/** Quita de lo que dice el agente las llamadas a herramienta que el modelo a veces "pronuncia" (":buscar_cliente{output:{isNew:true}}", "tool_code ..."). */
export function limpiarTextoAgente(texto: string): string {
  return texto
    .replace(/[:`]?\b[a-z]+(?:_[a-z]+)+\s*\{(?:[^{}]|\{[^{}]*\})*\}?/g, " ")
    .replace(/\b(?:tool_code|tool_outputs?|function_call|print\(default_api)[^\n]*/gi, " ")
    .replace(/\s{2,}/g, " ");
}

/** "Carrito cotizado (sin confirmar): 3 x Tacos, 1 x Horchata. Total $126." a partir del resultado de cotizar_pedido (camelCase de dominio o snake_case wire). */
function resumenCarrito(resultado: unknown): string | null {
  const r = resultado as { quote?: { lines?: unknown; total?: unknown }; total?: unknown; lines?: unknown } | null;
  const quote = r?.quote ?? r;
  if (!quote || !Array.isArray(quote.lines) || quote.lines.length === 0) return null;
  const renglones = (quote.lines as { name?: unknown; requested_quantity?: unknown; requestedQuantity?: unknown; quantity?: unknown }[])
    .map((l) => ({ nombre: typeof l.name === "string" ? l.name : null, cantidad: l.requested_quantity ?? l.requestedQuantity ?? l.quantity }))
    .filter((l) => l.nombre !== null && typeof l.cantidad === "number")
    .slice(0, 12)
    .map((l) => `${l.cantidad} x ${l.nombre}`);
  if (renglones.length === 0) return null;
  const total = typeof quote.total === "number" ? ` Total $${quote.total}.` : "";
  return `Carrito cotizado (sin confirmar): ${renglones.join(", ")}.${total}`.slice(0, 480);
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
  /** Carrito de la ultima cotizacion vigente (renglones y total, sin datos del cliente): lo lleva el aviso a una persona si la llamada se escala antes de crear el pedido. */
  private carritoCotizado: string | null = null;
  /** Texto del turno actual del agente (para detectar su despedida) y vigilancia de silencio tras una herramienta. */
  private turnoAgenteTexto = "";
  /** Nota para el aviso cuando el timeout de crear_pedido dejo el resultado incierto. */
  private notaIncierto: string | null = null;
  private vigiaSilencio: ReturnType<typeof setTimeout> | null = null;
  private resolverFin!: (r: ResultadoLlamada<R>) => void;
  /** Se resuelve cuando la llamada termina (el sistema cuelga o el cliente cuelga). */
  readonly terminada: Promise<ResultadoLlamada<R>>;
  private readonly ref: string;

  constructor(private readonly deps: DepsControlador<R>) {
    this.maquina = new CallStateMachine<R>(deps.reglas, deps.limites ?? LIMITES_POR_DEFECTO, deps.saludoInterrumpible === undefined ? {} : { saludoInterrumpible: deps.saludoInterrumpible });
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
    // Reconexion SIN handle de reanudacion (la caida llego antes del primer `sessionResumptionUpdate`): la sesion nueva arrancaria sin memoria y volveria a saludar.
    // Se le siembra la conversacion hasta ahora (ya redactada) para que continue donde iba.
    const historial = handle === null && this.transcripcion.length > 0 ? this.historialParaReanudar() : undefined;
    return this.deps.abrirSesion(
      { instruccion: this.deps.instruccion, voiceId: this.deps.voiceId, herramientas: this.deps.ejecutor.definiciones(), reanudarHandle: handle, ...(historial ? { historial } : {}) },
      {
        agenteDijo: (texto) => void this.encolar(async () => {
          this.cancelarVigiaSilencio();
          // QA-PM-R2-voz-12: el modelo llego a "pronunciar" la llamada a una herramienta (":buscar_cliente{...}"): no entra a la transcripcion.
          const limpio = limpiarTextoAgente(texto);
          if (limpio.trim() !== "") this.transcripcion.push({ rol: "agente", texto: redactarTranscripcion(limpio) });
          this.turnoAgenteTexto += limpio;
          await this.eventoInterno({ tipo: "agente_empieza" });
          if (this.maquina.hayObjetivo && DESPEDIDA_RE.test(this.turnoAgenteTexto)) await this.eventoInterno({ tipo: "despedida_dicha" });
        }),
        agenteTermino: () => void this.encolar(async () => {
          this.turnoAgenteTexto = "";
          await this.eventoInterno({ tipo: "agente_termina" });
        }),
        interrumpido: () => void this.encolar(async () => {
          this.turnoAgenteTexto = "";
          await this.eventoInterno({ tipo: "agente_termina" });
        }),
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
    if (salida.ok && llamada.nombre === "cotizar_pedido") this.carritoCotizado = resumenCarrito(salida.resultado);
    else if (salida.ok && salida.entidadId) this.carritoCotizado = null;
    await this.deps.kpi?.({ tipo: "tool_call", herramienta: llamada.nombre, latenciaMs: salida.latenciaMs });
    // La maquina puede ordenar acciones (aviso por tool lenta, escalar tras dos timeouts) ANTES de contestar al modelo.
    const res = (typeof salida.resultado === "object" && salida.resultado !== null ? salida.resultado : {}) as { pedido_grande?: unknown; escalado?: unknown; incierto?: unknown };
    if (res.incierto === true) this.notaIncierto = "El registro del pedido expiró y PUDO quedar registrado: verifique en la sucursal antes de contactar al cliente.";
    await this.encolar(() =>
      this.eventoInterno({
        tipo: "tool_resultado",
        nombre: llamada.nombre,
        ok: salida.ok,
        entidadId: salida.entidadId,
        timeout: salida.timeout,
        ...(salida.ok && (res.pedido_grande === true || res.escalado === true) ? { retenido: true } : {}),
        ...(res.incierto === true ? { incierto: true } : {}),
      }),
    );
    this.armarVigiaSilencio();
    return salida.resultado;
  }

  /** Despues de devolverle al modelo el resultado de una herramienta, si no dice nada en `vigilarSilencioAgenteMs`, se dice el pregrabado (una vez por herramienta). */
  private armarVigiaSilencio(): void {
    const ms = this.deps.vigilarSilencioAgenteMs;
    if (ms === undefined || this.maquina.estadoActual === "cerrada") return;
    this.cancelarVigiaSilencio();
    this.vigiaSilencio = setTimeout(() => {
      this.vigiaSilencio = null;
      void this.encolar(async () => {
        if (this.maquina.estadoActual === "cerrada") return;
        this.log("agente_callado", { ms });
        await this.deps.reproducir("tool_timeout");
        // QA-PM-R5-voz-03: tras el "un momento" el modelo seguia mudo (58 s en una llamada de la medida: solo hablaba cuando el cliente decia algo). Pasado otro intervalo se le empuja UNA vez
        // con un texto de turno para que conteste con el resultado de la herramienta que ya tiene.
        this.armarEmpujeAlAgente(ms);
      });
    }, ms);
    (this.vigiaSilencio as { unref?: () => void }).unref?.();
  }

  private armarEmpujeAlAgente(ms: number): void {
    this.vigiaSilencio = setTimeout(() => {
      this.vigiaSilencio = null;
      void this.encolar(async () => {
        if (this.maquina.estadoActual === "cerrada") return;
        this.log("agente_empujado", { ms });
        this.sesion?.enviarTexto("(Aviso del sistema: ya tiene el resultado de la herramienta. Continúe ahora con el cliente y respóndale en una o dos frases.)");
      });
    }, ms);
    (this.vigiaSilencio as { unref?: () => void }).unref?.();
  }

  private cancelarVigiaSilencio(): void {
    if (this.vigiaSilencio) clearTimeout(this.vigiaSilencio);
    this.vigiaSilencio = null;
  }

  /** Ultimos turnos de la conversacion (ya redactados), con tope de tamano, para sembrar una sesion nueva tras una caida. */
  private historialParaReanudar(): { readonly rol: "cliente" | "agente"; readonly texto: string }[] {
    const turnos = this.transcripcion.filter((t): t is TurnoTranscrito & { rol: "cliente" | "agente" } => t.rol !== "herramienta").slice(-30);
    let total = 0;
    const out: { rol: "cliente" | "agente"; texto: string }[] = [];
    for (const t of [...turnos].reverse()) {
      total += t.texto.length;
      if (total > 6000) break;
      out.unshift({ rol: t.rol, texto: t.texto });
    }
    const carrito = this.carritoCotizado;
    return carrito ? [...out, { rol: "agente", texto: `(Contexto del sistema: ${carrito})` }] : out;
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
    this.cancelarVigiaSilencio();
    const sesion = this.sesion;
    this.sesion = null;
    await sesion?.cerrar().catch(() => undefined);
    this.log("llamada_fin", { resultado, costoMicroUsd: this.maquina.costoMicroUsd });
    this.resolverFin({ resultado, costoMicroUsd: this.maquina.costoMicroUsd });
  }

  private async escalar(motivo: string, resumen: string): Promise<void> {
    // QA-PM-R2-voz-13: un carrito ya cotizado no se pierde con el aviso (la persona que lo recibe sabe que pedia el cliente).
    const llamada = this.deps.construirEscalacion(motivo, [resumen, this.notaIncierto, this.carritoCotizado].filter((t) => t).join(" "));
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
