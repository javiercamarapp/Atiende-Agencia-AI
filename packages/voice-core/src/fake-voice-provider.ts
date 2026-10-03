// Adaptador FALSO para pruebas: sin red, sin credenciales, determinista. Permite probar rutas,
// degradacion (proveedor sin configurar / caido) y el contrato sin tocar Gemini.
import { CATALOGO_VOCES_GEMINI, esVozDeGemini } from "./catalogo-voces.ts";
import type { VozCatalogoItem } from "./catalogo-voces.ts";
import { VozNoConfiguradaError, VozProveedorError } from "./provider.ts";
import type { VoiceAgentProvider, VozSalud, VozSesionPreviewEntrada, VozSesionPreviewProveedor } from "./provider.ts";
import type { AperturaLlamada, ManejadoresSesion, VozSesionLlamada } from "./llamada/sesion.ts";

/** Quien "piensa" por el proveedor falso en una llamada simulada (el simulador pasa un agente guionado). */
export interface CerebroFalso {
  responder(h: ManejadoresSesion, interrumpida: () => boolean): Promise<void>;
}

export interface FakeVoiceProviderOptions {
  /** `false` = simula "sin credencial" (salud no ok, emitir lanza VozNoConfiguradaError). */
  readonly configurado?: boolean;
  /** `true` = simula que el proveedor falla al emitir. */
  readonly fallaAlEmitir?: boolean;
  /** Cerebro de las llamadas simuladas (`abrirLlamada`). Sin cerebro, `abrirLlamada` lanza. */
  readonly cerebro?: CerebroFalso;
  /** Cuantas aperturas de llamada fallan antes de lograr una (simula un proveedor caido al reconectar). */
  readonly fallasAlAbrir?: number;
}

export class FakeVoiceProvider implements VoiceAgentProvider {
  readonly id = "fake" as const;
  readonly emitidas: VozSesionPreviewEntrada[] = [];
  configurado: boolean;
  fallaAlEmitir: boolean;
  /** Aperturas de llamada que se hicieron (la primera y cada reconexion), con su handle de reanudacion. */
  readonly aperturas: AperturaLlamada[] = [];
  private fallasAlAbrir: number;
  private readonly cerebro: CerebroFalso | null;
  private readonly pendientes = new Set<Promise<void>>();
  private readonly abiertas: SesionFalsa[] = [];

  constructor(opts: FakeVoiceProviderOptions = {}) {
    this.configurado = opts.configurado ?? true;
    this.fallaAlEmitir = opts.fallaAlEmitir ?? false;
    this.cerebro = opts.cerebro ?? null;
    this.fallasAlAbrir = opts.fallasAlAbrir ?? 0;
  }

  /** Abre una sesion de llamada simulada (texto): el cerebro responde a cada `enviarTexto`. */
  abrirLlamada = async (apertura: AperturaLlamada, manejadores: ManejadoresSesion): Promise<VozSesionLlamada> => {
    if (!this.configurado) throw new VozNoConfiguradaError("Voz no configurada (adaptador falso).");
    if (this.fallasAlAbrir > 0) {
      this.fallasAlAbrir -= 1;
      throw new VozProveedorError("El proveedor falso no pudo abrir la sesión.", 503);
    }
    if (!this.cerebro) throw new Error("FakeVoiceProvider sin cerebro: no puede conducir una llamada simulada.");
    this.aperturas.push(apertura);
    const sesion = new SesionFalsa(this.cerebro, manejadores, this.pendientes);
    this.abiertas.push(sesion);
    return sesion;
  };

  /** Espera a que el cerebro termine de responder lo que se le envio (para sincronizar el simulador). */
  async inactivo(): Promise<void> {
    while (this.pendientes.size > 0) await Promise.all([...this.pendientes]);
  }

  /** Simula que el proveedor se cae en la sesion abierta mas reciente (cierre inesperado con handle de reanudacion). */
  caer(razon = "ws_cerrado"): void {
    const ultima = this.abiertas.at(-1);
    ultima?.caer(razon);
  }

  catalogoVoces(): readonly VozCatalogoItem[] {
    return CATALOGO_VOCES_GEMINI;
  }

  async salud(): Promise<VozSalud> {
    return this.configurado ? { ok: true, detalle: "Adaptador falso listo." } : { ok: false, detalle: "Voz no configurada (adaptador falso)." };
  }

  async emitirSesionPreview(entrada: VozSesionPreviewEntrada): Promise<VozSesionPreviewProveedor> {
    if (!this.configurado) throw new VozNoConfiguradaError("Voz no configurada (adaptador falso).");
    if (this.fallaAlEmitir) throw new VozProveedorError("El proveedor falso falló al emitir la sesión.", 500);
    if (!esVozDeGemini(entrada.voiceId)) throw new VozProveedorError(`La voz "${entrada.voiceId}" no está en el catálogo.`);
    this.emitidas.push(entrada);
    return {
      proveedor: this.id,
      modelo: "fake-live",
      websocketUrl: "wss://fake.invalid/live",
      tokenProveedor: `fake-token-${entrada.sessionId}`,
      expiraEn: new Date(Date.now() + entrada.ttlSegundos * 1000).toISOString(),
    };
  }
}

class SesionFalsa implements VozSesionLlamada {
  private interrumpida = false;
  private cerrada = false;
  private caidaEnviada = false;
  constructor(
    private readonly cerebro: CerebroFalso,
    private readonly h: ManejadoresSesion,
    private readonly pendientes: Set<Promise<void>>,
  ) {}

  enviarTexto(_texto: string): void {
    if (this.cerrada) return;
    this.interrumpida = false;
    const p: Promise<void> = this.cerebro.responder(this.h, () => this.interrumpida || this.cerrada).finally(() => this.pendientes.delete(p));
    this.pendientes.add(p);
  }

  interrumpir(): void {
    if (this.cerrada || this.interrumpida) return;
    this.interrumpida = true;
    this.h.interrumpido();
  }

  async cerrar(): Promise<void> {
    this.cerrada = true;
  }

  caer(razon: string): void {
    if (this.cerrada || this.caidaEnviada) return;
    this.caidaEnviada = true;
    this.cerrada = true;
    this.h.caido(razon, `handle-${razon}`);
  }
}
