// Adaptador FALSO para pruebas: sin red, sin credenciales, determinista. Permite probar rutas,
// degradacion (proveedor sin configurar / caido) y el contrato sin tocar Gemini.
import { CATALOGO_VOCES_GEMINI, esVozDeGemini } from "./catalogo-voces.ts";
import type { VozCatalogoItem } from "./catalogo-voces.ts";
import { VozNoConfiguradaError, VozProveedorError } from "./provider.ts";
import type { VoiceAgentProvider, VozSalud, VozSesionPreviewEntrada, VozSesionPreviewProveedor } from "./provider.ts";

export interface FakeVoiceProviderOptions {
  /** `false` = simula "sin credencial" (salud no ok, emitir lanza VozNoConfiguradaError). */
  readonly configurado?: boolean;
  /** `true` = simula que el proveedor falla al emitir. */
  readonly fallaAlEmitir?: boolean;
}

export class FakeVoiceProvider implements VoiceAgentProvider {
  readonly id = "fake" as const;
  readonly emitidas: VozSesionPreviewEntrada[] = [];
  configurado: boolean;
  fallaAlEmitir: boolean;

  constructor(opts: FakeVoiceProviderOptions = {}) {
    this.configurado = opts.configurado ?? true;
    this.fallaAlEmitir = opts.fallaAlEmitir ?? false;
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
