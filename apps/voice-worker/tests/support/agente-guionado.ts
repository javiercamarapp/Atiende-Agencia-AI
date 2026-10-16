// Escalon de voz GUIONADO para las pruebas del worker: una "sesion de proveedor" que escucha AUDIO (no texto) y, cuando el cliente termina de hablar
// (voz y despues silencio), contesta con los pasos del guion: dice algo (audio de 24 kHz) y/o llama herramientas REALES por el controlador. Sirve para
// probar la plomeria del worker (puente, controlador, API); no prueba que un modelo entienda es-MX.
import { bytesAMuestras, muestrasABytes } from "../../src/audio/pcm.ts";
import type { AbrirSesionLlamada, AperturaLlamada, EscalonLlamada, ManejadoresSesion, VozSesionLlamada } from "@atiende/voice-core";
import { crearMemoriaPm } from "../../../../packages/domain-restaurantes/src/voz/simulador/memoria-pm.ts";
import type { MemoriaTools } from "../../../../packages/domain-restaurantes/src/voz/simulador/tipos.ts";
import { rms, tono } from "./audio.ts";

export type PasoGuion = { readonly dice: string } | { readonly tool: string; readonly args: Readonly<Record<string, unknown>> | ((m: MemoriaTools) => Record<string, unknown>) };
export interface TurnoGuion {
  /** Lo que el reconocedor del proveedor transcribe de la voz del cliente. */
  readonly cliente: string;
  readonly agente: readonly PasoGuion[];
}

/** Chunks de 20 ms en silencio que el proveedor falso espera para dar por terminado el turno del cliente (mas que los 500 ms del puente). */
const SILENCIO_FIN_TURNO_CHUNKS = 30;
const UMBRAL = 0.015;

class SesionGuionada implements VozSesionLlamada {
  private hablando = false;
  private silencioChunks = 0;
  private cerrada = false;
  private cola: Promise<void> = Promise.resolve();
  constructor(
    private readonly agente: AgenteGuionado,
    private readonly h: ManejadoresSesion,
  ) {}

  enviarTexto(texto: string): void {
    this.agente.textosRecibidos.push(texto);
    if (this.cerrada) return;
    if (texto.startsWith("(La llamada acaba de conectarse")) {
      this.agente.saludos += 1;
      this.encolar(async () => {
        this.h.agenteDijo(this.agente.saludo);
        this.h.audioAgente?.(muestrasABytes(tono(24_000, 300, 500)));
        this.h.agenteTermino();
      });
    }
  }

  enviarAudio(pcm16: Uint8Array): void {
    if (this.cerrada) return;
    this.agente.bytesAudioRecibidos += pcm16.byteLength;
    const e = rms(bytesAMuestras(pcm16));
    if (e >= UMBRAL) {
      this.hablando = true;
      this.silencioChunks = 0;
    } else if (this.hablando) {
      this.silencioChunks += 1;
      if (this.silencioChunks >= SILENCIO_FIN_TURNO_CHUNKS) {
        this.hablando = false;
        this.silencioChunks = 0;
        this.encolar(() => this.turno());
      }
    }
  }

  interrumpir(): void {
    this.h.interrumpido();
  }

  async cerrar(): Promise<void> {
    this.cerrada = true;
  }

  caer(razon: string): void {
    if (this.cerrada) return;
    this.cerrada = true;
    this.h.caido(razon, `handle-${razon}`);
  }

  private encolar(fn: () => Promise<void>): void {
    this.cola = this.cola.then(fn).catch((e) => { console.error("GUIONADO_ERR", e); });
    this.agente.pendientes.add(this.cola);
    void this.cola.finally(() => this.agente.pendientes.delete(this.cola));
  }

  private async turno(): Promise<void> {
    const t = this.agente.turnos[this.agente.indiceTurno++];
    if (!t) return;
    this.h.usuarioDijo?.(t.cliente);
    for (const paso of t.agente) {
      if ("dice" in paso) {
        this.h.agenteDijo(paso.dice);
        this.h.audioAgente?.(muestrasABytes(tono(24_000, 300, 500)));
        continue;
      }
      const args = typeof paso.args === "function" ? paso.args(this.agente.memoria) : paso.args;
      const resultado = await this.h.ejecutarTool({ id: `g-${++this.agente.nTools}`, nombre: paso.tool, args });
      this.agente.resultados.push({ nombre: paso.tool, resultado });
      // El transporte HTTP devuelve `{ productos: [...] }`; la memoria del simulador espera la lista directa (como el transporte en proceso).
      const lista = paso.tool === "buscar_producto" && resultado && typeof resultado === "object" && Array.isArray((resultado as { productos?: unknown }).productos) ? (resultado as { productos: unknown[] }).productos : resultado;
      this.agente.memoria.observar(paso.tool, lista);
    }
    // Costo REAL que informaria Gemini (`usageMetadata`) tras cada respuesta: solo si el guion lo pidio.
    if (this.agente.costoRealPorRespuestaMicroUsd > 0) this.h.costo?.(this.agente.costoRealPorRespuestaMicroUsd, true);
    this.agente.respondidos += 1;
    this.h.agenteTermino();
  }
}

export class AgenteGuionado {
  readonly aperturas: AperturaLlamada[] = [];
  readonly textosRecibidos: string[] = [];
  readonly memoria: MemoriaTools = crearMemoriaPm();
  readonly pendientes = new Set<Promise<void>>();
  readonly sesiones: SesionGuionada[] = [];
  /** Lo que devolvio cada herramienta que pidio el guion (para afirmar errores honestos como `telefono_pendiente`). */
  readonly resultados: { nombre: string; resultado: unknown }[] = [];
  saludos = 0;
  respondidos = 0;
  indiceTurno = 0;
  nTools = 0;
  bytesAudioRecibidos = 0;
  /** Cuantas veces se pidio abrir sesion (la primera y cada reconexion). */
  aperturasPedidas = 0;
  /** Costo real (micro-USD) que el proveedor guionado reporta con cada respuesta, como el `usageMetadata` de Gemini Live. 0 = no reporta. */
  costoRealPorRespuestaMicroUsd = 0;
  /** Aperturas que fallan antes de lograr una (simula el proveedor caido al abrir). */
  fallasAlAbrir = 0;

  constructor(
    readonly turnos: readonly TurnoGuion[],
    readonly saludo = "Gracias por llamar a Los Taquitos de PM.",
  ) {}

  readonly abrirSesion: AbrirSesionLlamada = async (apertura, h) => {
    this.aperturasPedidas += 1;
    if (this.fallasAlAbrir > 0) {
      this.fallasAlAbrir -= 1;
      throw new Error("el proveedor guionado no abre");
    }
    this.aperturas.push(apertura);
    const s = new SesionGuionada(this, h);
    this.sesiones.push(s);
    return s;
  };

  escalon(id: EscalonLlamada["id"] = "gemini-3.8-live"): EscalonLlamada {
    return { id, abrirSesion: this.abrirSesion };
  }

  /** Simula que el proveedor se cae en la sesion abierta mas reciente. */
  caer(razon = "ws_cerrado"): void {
    this.sesiones.at(-1)?.caer(razon);
  }

  async inactivo(): Promise<void> {
    while (this.pendientes.size > 0) await Promise.all([...this.pendientes]);
  }
}
