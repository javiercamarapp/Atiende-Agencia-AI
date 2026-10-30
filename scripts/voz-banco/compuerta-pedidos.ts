// T03: la compuerta `confirmacionAntesDeCrear` como decorador de `ejecutarTool`, reutilizable por CUALQUIER adaptador y con tres modos (factor on/off del banco).
//
// Produccion NO se toca. La logica de decision es la MISMA funcion de produccion (`ejecutarHerramientas`, cascada-v2/herramientas.ts), invocada de a una herramienta con un
// `EstadoEspera` persistente; asi "bloquea igual que produccion" es verdad por construccion y no por copia. Lo que la sesion de la cascada v2 hace ADEMAS de llamar a esa funcion
// (alimentar el estado: afirmacion del turno, total oido, huella oida, interrupciones; sesion.ts ~l.191, 232, 324-330, 434-462) lo hace aqui `CompuertaPedidos` para los
// adaptadores que no tienen sesion v2 (Gemini Live, OpenAI Realtime): el corredor del banco llama a `alTurnoCliente`, `alAgenteDijo`, `alAgenteTermino` y `alInterrumpir`.
//
// Modos:
//  - "on":       la regla de produccion completa (afirmacion pura + total oido + huella vigente + espera tras confirmar).
//  - "off":      todo pasa (mide cuanto vale la compuerta). El estado de la compuerta se sigue alimentando y cada `crear` recibe un VEREDICTO («lo habria bloqueado la compuerta»)
//                que la traza usa para contar los pedidos indebidos con la MISMA regla que el modo `on`.
//  - "servidor": igual que `off` pero entrega ademas el numero de turno del cliente al ejecutor (`ctx.turno`) para que el transporte lo mande como `x-atiende-call-turn`
//                y la defensa del servidor (confirmar en un turno posterior al de la cotizacion) se ejerza.
//
// Generacion (barge-in): como `vigente()` de la sesion v2, cada llamada a herramienta captura la generacion al LLEGAR. Si el cliente habla o interrumpe antes de que le toque
// ejecutarse, es de una generacion cortada: en modo `on` devuelve `interrumpido_por_el_cliente` (lo hace `ejecutarHerramientas` por `continuar`) y nunca se evalua contra el estado del turno nuevo.
import type { ToolCallLlmVoz } from "../../packages/voice-core/src/llamada/cascada-openrouter.ts";
import { contieneTotal, esAfirmacion, esRechazo } from "../../packages/voice-core/src/llamada/cascada-v2/afirmacion.ts";
import { ejecutarHerramientas } from "../../packages/voice-core/src/llamada/cascada-v2/herramientas.ts";
import type { EstadoEspera } from "../../packages/voice-core/src/llamada/cascada-v2/herramientas.ts";
import type { ToolCallPedida } from "../../packages/voice-core/src/llamada/sesion.ts";
import type { EjecutarTool, ModoCompuerta } from "./tipos.ts";

export interface ReglaPedidos {
  readonly confirmar: string;
  readonly crear: string;
  readonly cotizar?: string;
}
/** La regla que el worker activa en produccion (apps/voice-worker/src/main.ts). */
export const REGLA_PEDIDOS_PM: ReglaPedidos = { confirmar: "confirmar_resumen", crear: "crear_pedido", cotizar: "cotizar_pedido" };

/** Lo que la compuerta de produccion HABRIA decidido para un `crear`, calculado sobre una copia del estado ANTES de ejecutar (igual en los tres modos). */
export interface VeredictoCrear {
  readonly bloquearia: boolean;
  /** Error que habria devuelto la compuerta; null si habria dejado pasar. */
  readonly motivo: string | null;
}

const CENTINELA = { __centinela: true };
const ERRORES_COMPUERTA = new Set(["espera_confirmacion_del_cliente", "resumen_distinto_al_leido", "interrumpido_por_el_cliente"]);

/** Misma nocion de «salida con error» que `herramientas.ts` (no se exporta alla; produccion no se toca). */
function conError(salida: unknown): boolean {
  if (salida === null || salida === undefined) return true;
  if (typeof salida !== "object" || Array.isArray(salida)) return false;
  const o = salida as Record<string, unknown>;
  return ("error" in o && o["error"] !== undefined && o["error"] !== null && o["error"] !== false) || o["ok"] === false;
}

export class CompuertaPedidos {
  readonly estado: EstadoEspera = { pendiente: false, huellaOida: null, huellaCotizada: null, cotizoEnTurno: false };
  readonly eventos: { evento: string; campos: Record<string, unknown> | undefined }[] = [];
  private turnoCliente = 0;
  private rechazoTurno = false;
  private habladoTurno = "";
  /** La generacion en curso fue cortada (barge-in): su `agenteTermino` no cuenta como resumen leido (la sesion v2 retorna antes de llegar a esa rama). */
  private cortada = false;
  /** Generacion de la respuesta del agente: sube con cada turno del cliente y con cada barge-in (equivale a `generacion` de la sesion v2). */
  private generacion = 0;
  private readonly veredictos = new WeakMap<object, VeredictoCrear>();

  constructor(readonly modo: ModoCompuerta, readonly regla: ReglaPedidos = REGLA_PEDIDOS_PM) {}

  get turno(): number {
    return this.turnoCliente;
  }

  /** El cliente termino de hablar (final del STT o texto inyectado). Equivale a `alTurnoFinal` + el inicio de `turno()` de la sesion v2. */
  alTurnoCliente(texto: string): void {
    if (texto.trim() === "") return;
    // OJO: NO interrumpe aqui. En la sesion v2 `interrumpir()` solo actua si el agente aun hablaba/generaba; el corredor llama a `alInterrumpir()` cuando eso ocurre (barge-in).
    const e = this.estado;
    e.pendiente = false; // el cliente respondio: ya puede crearse el pedido
    this.turnoCliente += 1;
    e.cotizoEnTurno = false;
    e.huellaCotizada = null;
    e.totalCotizado = null;
    e.habladoTrasCotizar = "";
    e.afirmacion = esAfirmacion(texto);
    this.rechazoTurno = !e.afirmacion && esRechazo(texto);
    this.habladoTurno = "";
    this.cortada = false; // empieza una generacion nueva
    this.generacion += 1;
  }

  /** Una frase que el agente dijo en voz alta (o su texto si el proveedor solo entrega transcripcion). */
  alAgenteDijo(frase: string): void {
    if (frase.trim() === "") return;
    this.habladoTurno += ` ${frase}`;
    if (this.estado.cotizoEnTurno === true) this.estado.habladoTrasCotizar = `${this.estado.habladoTrasCotizar ?? ""} ${frase}`;
  }

  /** El cliente interrumpio al agente a media lectura: puede no haber oido el resumen completo. */
  alInterrumpir(): void {
    this.estado.huellaOida = null;
    this.cortada = true;
    this.generacion += 1; // las herramientas pendientes de la generacion cortada ya no son vigentes
  }

  /** Veredicto del ultimo `crear` procesado para ESTA llamada (el mismo objeto que se paso a `decorar`); undefined si no fue un `crear` o aun no se evaluo. */
  veredictoDe(llamada: ToolCallPedida): VeredictoCrear | undefined {
    return this.veredictos.get(llamada);
  }

  /** El agente termino de hablar sin ser interrumpido: decide si el resumen vigente quedo LEIDO (con su total). Copia fiel de la rama de cierre de `turno()` en la sesion v2. */
  alAgenteTermino(): void {
    if (this.cortada) { this.cortada = false; return; }
    const e = this.estado;
    const total = e.totalCotizado ?? null;
    const hablado = e.habladoTrasCotizar ?? "";
    if (e.cotizoEnTurno === true && e.huellaCotizada && hablado.trim() !== "") {
      if (total !== null && contieneTotal(hablado, total)) {
        e.huellaOida = e.huellaCotizada;
        e.totalOido = total;
      } else this.registrar("v2_resumen_sin_total");
    } else if (this.rechazoTurno && e.cotizoEnTurno !== true) {
      e.huellaOida = null;
      e.huellaUltima = null;
      e.totalOido = null;
      e.totalUltimo = null;
    } else if (e.cotizoEnTurno !== true && this.habladoTurno.trim() !== "" && (e.huellaUltima ?? null) !== null) {
      const relee = e.totalUltimo !== null && e.totalUltimo !== undefined && contieneTotal(this.habladoTurno, e.totalUltimo);
      if (relee) {
        e.huellaOida = e.huellaUltima ?? null;
        e.totalOido = e.totalUltimo ?? null;
      } else if ((e.huellaOida ?? null) !== null) e.huellaOida = null;
    }
  }

  private registrar(evento: string, campos?: Record<string, unknown>): void {
    this.eventos.push({ evento, campos });
  }

  /** Cola para que dos herramientas pedidas a la vez (OpenAI Realtime puede emitir varias en una respuesta) pasen de a una y en orden, como en produccion. */
  private cola: Promise<unknown> = Promise.resolve();

  /** Envuelve el ejecutor real. El resultado devuelto al proveedor es el mismo que en produccion (`{error:"espera_confirmacion_del_cliente", mensaje}` al bloquear). */
  decorar(ejecutar: EjecutarTool): EjecutarTool {
    const regla = this.regla;
    const una = async (llamada: ToolCallPedida, gen: number): Promise<unknown> => {
      const ctx = (): { turno: number } => ({ turno: this.turnoCliente });
      const tc: ToolCallLlmVoz = { id: llamada.id, nombre: llamada.nombre, argsJson: JSON.stringify(llamada.args ?? {}) };
      const vigente = (): boolean => this.generacion === gen;
      const esCrear = llamada.nombre === regla.crear;
      // Veredicto «como lo habria decidido la compuerta», sobre una COPIA del estado y sin ejecutar nada; en `on` coincide con lo que de verdad ocurre a continuacion.
      if (esCrear) this.veredictos.set(llamada, await this.evaluarCrear(tc, vigente));
      const real = (l: ToolCallPedida): Promise<unknown> => ejecutar(l, ctx());
      if (this.modo === "on") {
        const [r] = await ejecutarHerramientas([tc], real, { confirmacionAntesDeCrear: regla, esperandoAlCliente: this.estado, continuar: vigente, log: (evento, campos) => this.registrar(evento, campos) });
        return r?.salida;
      }
      // off / servidor: nada se bloquea, pero el estado se sigue alimentando con las mismas funciones de produccion (cotizar/confirmar) para que los veredictos sean fieles.
      if (esCrear) {
        const salida = await real(llamada).catch(() => ({ error: "herramienta_fallo" }));
        if (regla.cotizar !== undefined && !conError(salida)) {
          this.estado.huellaOida = null;
          this.estado.huellaUltima = null;
          this.estado.totalUltimo = null;
        }
        return salida;
      }
      const [r] = await ejecutarHerramientas([tc], real, { confirmacionAntesDeCrear: regla, esperandoAlCliente: this.estado, log: (evento, campos) => this.registrar(evento, campos) });
      return r?.salida;
    };
    return (llamada) => {
      const gen = this.generacion; // se captura al LLEGAR, no al tocarle el turno en la cola
      const p = this.cola.then(() => una(llamada, gen));
      this.cola = p.catch(() => undefined);
      return p;
    };
  }

  private async evaluarCrear(tc: ToolCallLlmVoz, vigente: () => boolean): Promise<VeredictoCrear> {
    if (!vigente()) return { bloquearia: true, motivo: "interrumpido_por_el_cliente" };
    const sombra: EstadoEspera = { ...this.estado };
    const [r] = await ejecutarHerramientas([tc], async () => CENTINELA, { confirmacionAntesDeCrear: this.regla, esperandoAlCliente: sombra, continuar: vigente });
    const salida = r?.salida;
    const error = salida && typeof salida === "object" ? (salida as Record<string, unknown>)["error"] : undefined;
    return typeof error === "string" && ERRORES_COMPUERTA.has(error) ? { bloquearia: true, motivo: error } : { bloquearia: false, motivo: null };
  }
}

/** Atajo: `conCompuerta(ejecutor, {modo})` devuelve el ejecutor decorado y la compuerta (el corredor la usa para alimentarla). */
export function conCompuerta(ejecutar: EjecutarTool, opciones: { modo: ModoCompuerta; regla?: ReglaPedidos }): { ejecutar: EjecutarTool; compuerta: CompuertaPedidos } {
  const compuerta = new CompuertaPedidos(opciones.modo, opciones.regla);
  return { ejecutar: compuerta.decorar(ejecutar), compuerta };
}
