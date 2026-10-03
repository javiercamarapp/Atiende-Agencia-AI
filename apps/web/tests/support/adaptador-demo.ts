// SOLO PRUEBAS (los dobles no viven en produccion). Adaptador FALSO "modo demo": una sesión simulada con volumen sintético y una
// transcripción de ejemplo, para que la interfaz funcione y se pruebe sin proveedor
// ni backend. NO llama a ningún servicio, NO registra pedidos y el guion lo dice
// explícitamente en voz del agente; la interfaz además lo etiqueta como simulación.
import { suavizarConAtaque } from "@atiende/ui";
import type { LineaTranscripcion, ModoOrb } from "@atiende/ui";
import type { AdaptadorVoz, CallbacksAdaptador, FabricaAdaptador } from "../../src/lib/voz/adaptador.ts";

export const SALUDO_DEMO_POR_DEFECTO = "Hola, le atiende el asistente virtual del restaurante. ¿En qué le puedo ayudar?";
const PEDIDO_DEMO = "Quisiera pedir dos órdenes de tacos al pastor para llevar.";
const RESPUESTA_DEMO = "Con gusto. Esta es una llamada de demostración simulada: no se registra ningún pedido ni se consulta tu menú real.";

const MS_CONEXION = 700;
const MS_POR_PALABRA = 120;
const MS_TICK_VOLUMEN = 50;

/** Nivel sintético determinista (sin azar, para que sea reproducible en pruebas): 0..1. */
export function volumenSintetico(tick: number): number {
  const v = 0.42 + 0.3 * Math.sin(tick * 0.9) + 0.18 * Math.sin(tick * 2.3 + 1);
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export interface OpcionesDemo {
  /** Primer mensaje del agente (p. ej. el configurado por el negocio); por defecto un saludo de ejemplo. */
  readonly saludo?: string;
  readonly ahora?: () => number;
}

export function crearFabricaDemo(opciones: OpcionesDemo = {}): FabricaAdaptador {
  return (cb) => new AdaptadorDemo(cb, opciones);
}

class AdaptadorDemo implements AdaptadorVoz {
  private temporizadores = new Set<ReturnType<typeof setTimeout>>();
  private intervalo: ReturnType<typeof setInterval> | null = null;
  private viva = false;
  private silenciado = false;
  private modo: ModoOrb = "reposo";
  private tick = 0;
  private entrada = 0;
  private salida = 0;
  private contadorLineas = 0;

  constructor(
    private readonly cb: CallbacksAdaptador,
    private readonly opciones: OpcionesDemo,
  ) {}

  async iniciar(): Promise<void> {
    this.viva = true;
    this.modo = "conectando";
    this.cb.cambiar({ modo: "conectando", sessionId: `demo-${(this.opciones.ahora ?? Date.now)()}` });
    this.intervalo = setInterval(() => this.emitirVolumen(), MS_TICK_VOLUMEN);
    this.programar(MS_CONEXION, () => this.hablar(this.opciones.saludo?.trim() || SALUDO_DEMO_POR_DEFECTO, () => this.escucharUsuario()));
  }

  async terminar(): Promise<void> {
    this.detener();
  }

  silenciar(silenciar: boolean): void {
    this.silenciado = silenciar;
  }

  private detener(): void {
    this.viva = false;
    for (const t of this.temporizadores) clearTimeout(t);
    this.temporizadores.clear();
    if (this.intervalo) clearInterval(this.intervalo);
    this.intervalo = null;
  }

  private programar(ms: number, fn: () => void): void {
    const t = setTimeout(() => {
      this.temporizadores.delete(t);
      if (this.viva) fn();
    }, ms);
    this.temporizadores.add(t);
  }

  private poner(modo: ModoOrb): void {
    this.modo = modo;
    this.cb.cambiar({ modo });
  }

  private emitirVolumen(): void {
    this.tick += 1;
    const objetivoSalida = this.modo === "hablando" ? volumenSintetico(this.tick) : 0;
    const objetivoEntrada = this.modo === "escuchando" && !this.silenciado ? volumenSintetico(this.tick + 7) : 0;
    this.salida = suavizarConAtaque(this.salida, objetivoSalida);
    this.entrada = suavizarConAtaque(this.entrada, objetivoEntrada);
    this.cb.cambiar({ volumenSalida: this.salida, volumenEntrada: this.entrada });
  }

  /** Emite el texto palabra por palabra como línea parcial y al final como definitiva. */
  private emitirTexto(rol: LineaTranscripcion["rol"], texto: string, alTerminar: () => void): void {
    const id = `demo-${(this.contadorLineas += 1)}`;
    const palabras = texto.split(" ");
    let n = 0;
    const paso = () => {
      n += 1;
      const hecho = n >= palabras.length;
      this.cb.linea({ id, rol, texto: palabras.slice(0, n).join(" "), parcial: !hecho, ts: (this.opciones.ahora ?? Date.now)() });
      if (hecho) this.programar(350, alTerminar);
      else this.programar(MS_POR_PALABRA, paso);
    };
    this.programar(MS_POR_PALABRA, paso);
  }

  private hablar(texto: string, despues: () => void): void {
    this.poner("hablando");
    this.emitirTexto("agente", texto, despues);
  }

  private escucharUsuario(): void {
    this.poner("escuchando");
    this.programar(900, () => {
      this.emitirTexto("usuario", PEDIDO_DEMO, () => {
        this.poner("pensando");
        this.programar(900, () => this.hablar(RESPUESTA_DEMO, () => this.poner("escuchando")));
      });
    });
  }
}
