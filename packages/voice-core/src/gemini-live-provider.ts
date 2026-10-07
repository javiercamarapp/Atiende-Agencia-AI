// Adaptador de Gemini 3.8 Live (motor principal). Solo emite la sesion de preview cuando existe la
// credencial `GEMINI_API_KEY`: sin ella `emitirSesionPreview` lanza `VozNoConfiguradaError` (503
// honesto en la ruta), NUNCA un falso exito. La llave de plataforma no sale del servidor: al
// navegador solo viaja un token efimero de Gemini (`auth_tokens`, un solo uso, ventana de 1 minuto
// para abrir sesion), con la voz y el comportamiento bloqueados en el servidor.
//
// Referencia: https://ai.google.dev/gemini-api/docs/ephemeral-tokens (leida el 30-sep-2026). El
// endpoint REST y el modelo `gemini-3.8-live` NO se probaron contra la API real (no hay credencial
// en este entorno); `fetchFn` es inyectable y las pruebas usan uno falso.
import { CATALOGO_VOCES_GEMINI, esVozDeGemini } from "./catalogo-voces.ts";
import type { VozCatalogoItem } from "./catalogo-voces.ts";
import { VozNoConfiguradaError, VozProveedorError } from "./provider.ts";
import type { VoiceAgentProvider, VozSalud, VozSesionPreviewEntrada, VozSesionPreviewProveedor } from "./provider.ts";

export const GEMINI_LIVE_MODELO = "gemini-3.8-live";
const BASE_URL = "https://generativelanguage.googleapis.com";
const WS_URL = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained";

export interface GeminiLiveProviderOptions {
  readonly apiKey: string | null;
  readonly model?: string;
  readonly fetchFn?: typeof fetch;
  readonly ahora?: () => Date;
}

export class GeminiLiveProvider implements VoiceAgentProvider {
  readonly id = "gemini-3.8-live" as const;
  private readonly apiKey: string | null;
  private readonly model: string;
  private readonly fetchFn: typeof fetch;
  private readonly ahora: () => Date;

  constructor(opts: GeminiLiveProviderOptions) {
    this.apiKey = opts.apiKey && opts.apiKey.trim() !== "" ? opts.apiKey : null;
    this.model = opts.model ?? GEMINI_LIVE_MODELO;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.ahora = opts.ahora ?? (() => new Date());
  }

  catalogoVoces(): readonly VozCatalogoItem[] {
    return CATALOGO_VOCES_GEMINI;
  }

  async salud(): Promise<VozSalud> {
    return this.apiKey
      ? { ok: true, detalle: "Credencial presente (no se abrió ninguna sesión ni se probó la red)." }
      : { ok: false, detalle: "Voz no configurada: falta GEMINI_API_KEY." };
  }

  async emitirSesionPreview(entrada: VozSesionPreviewEntrada): Promise<VozSesionPreviewProveedor> {
    if (!this.apiKey) throw new VozNoConfiguradaError("Voz no configurada: falta GEMINI_API_KEY.");
    if (!esVozDeGemini(entrada.voiceId)) throw new VozProveedorError(`La voz "${entrada.voiceId}" no está en el catálogo de Gemini.`);

    const ahora = this.ahora();
    const expira = new Date(ahora.getTime() + entrada.ttlSegundos * 1000);
    const nuevaSesionHasta = new Date(ahora.getTime() + 60 * 1000);
    const instruccion = [entrada.comportamiento, entrada.mensajeInicial ? `Saluda al iniciar diciendo: ${entrada.mensajeInicial}` : ""].filter((s) => s.trim() !== "").join("\n\n");

    let respuesta: Response;
    try {
      respuesta = await this.fetchFn(`${BASE_URL}/v1alpha/auth_tokens`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": this.apiKey },
        body: JSON.stringify({
          uses: 1,
          expireTime: expira.toISOString(),
          newSessionExpireTime: nuevaSesionHasta.toISOString(),
          bidiGenerateContentSetup: {
            model: `models/${this.model}`,
            generationConfig: {
              responseModalities: ["AUDIO"],
              ...(typeof entrada.temperatura === "number" ? { temperature: entrada.temperatura } : {}),
              speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: entrada.voiceId } } },
            },
            ...(instruccion ? { systemInstruction: { parts: [{ text: instruccion }] } } : {}),
            // Herramientas fijadas en el token: el navegador no puede agregar otras. Las ejecuta SIEMPRE el servidor.
            ...(entrada.herramientas && entrada.herramientas.length > 0
              ? { tools: [{ functionDeclarations: entrada.herramientas.map((h) => ({ name: h.name, description: h.description, parameters: h.parameters })) }] }
              : {}),
          },
        }),
      });
    } catch (err) {
      throw new VozProveedorError(`No se pudo contactar a Gemini: ${(err as Error)?.message ?? "error de red"}`);
    }
    if (!respuesta.ok) throw new VozProveedorError(`Gemini rechazó la emisión del token efímero (HTTP ${respuesta.status}).`, respuesta.status);

    let cuerpo: { name?: unknown };
    try {
      cuerpo = (await respuesta.json()) as { name?: unknown };
    } catch {
      throw new VozProveedorError("Gemini devolvió una respuesta ilegible al emitir el token efímero.");
    }
    if (typeof cuerpo.name !== "string" || cuerpo.name === "") throw new VozProveedorError("Gemini no devolvió un token efímero.");

    return { proveedor: this.id, modelo: this.model, websocketUrl: WS_URL, tokenProveedor: cuerpo.name, expiraEn: expira.toISOString() };
  }
}
