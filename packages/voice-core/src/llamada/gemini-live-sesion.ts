// Sesion de LLAMADA con Gemini Live (servidor): WebSocket bidireccional con la API de Gemini, con las herramientas del registro de la vertical, transcripciones, barge-in nativo, reanudacion de sesion y deteccion de caidas. Implementa `VozSesionLlamada` para
// que el ControladorLlamada (maquina de estados, limites, escalada) la conduzca igual que al proveedor falso.
//
// ESTADO DE VERIFICACION (honesto): el protocolo de mensajes (setup, realtimeInput, serverContent, toolCall, goAway,
// sessionResumptionUpdate) se escribio segun la documentacion publica de la Live API
// (https://ai.google.dev/gemini-api/docs/live) y se prueba aqui contra un WebSocket FALSO. NO se ha probado contra la API real
// (no hay credencial en este entorno): la primera corrida con GEMINI_API_KEY (docs/VOZ-PM.md, "Prueba ciega") es la que lo
// confirma, y el nombre del modelo (`gemini-3.8-live`) sale del ADR, no de un listado de la API.
//
// Seguridad: la API key va en la URL del WebSocket (asi lo pide el endpoint de servidor); la URL NUNCA se loguea. Los errores
// que suben al controlador llevan un codigo corto, nunca el cuerpo del mensaje del proveedor.
import { VOZ_PLATAFORMA, costoDeUsoGeminiMicroUsd } from "../config-plataforma.ts";
import type { ConfigPlataformaVoz, UsoGemini } from "../config-plataforma.ts";
import { VozNoConfiguradaError, VozProveedorError } from "../provider.ts";
import type { ToolDefinicion } from "./ejecutor-tools.ts";
import type { AbrirSesionLlamada, AperturaLlamada, ManejadoresSesion, VozSesionLlamada } from "./sesion.ts";

/** Subconjunto del `WebSocket` estandar (el global de Node >= 22 o un doble en pruebas). */
export interface SocketLive {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code?: number }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  /** Node >= 26 entrega los mensajes binarios como `Blob` por defecto; con "arraybuffer" llegan ya decodificables. */
  binaryType?: string;
}
/** Opciones del socket: el WebSocket global de Node (undici) acepta `headers`; el endpoint de Vertex pide `Authorization: Bearer`. */
export interface OpcionesSocketLive {
  readonly headers?: Readonly<Record<string, string>>;
}
export type CrearSocketLive = (url: string, opciones?: OpcionesSocketLive) => SocketLive;

export const GEMINI_LIVE_WS_URL = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
const MIME_AUDIO_ENTRADA = "audio/pcm;rate=16000";

/** Adaptador de Vertex AI (listo y configurable, NO activado: hoy la llamada va por la Gemini API de pago). Se activa con `GEMINI_BACKEND=vertex` en el worker.
 * Sin verificar contra Vertex real (no hay proyecto de GCP): URL, nombre de recurso del modelo y cabecera salen de la documentacion publica. */
export interface VertexLiveOpciones {
  readonly project: string;
  readonly location: string;
  /** Token de acceso OAuth vigente (cuenta de servicio / ADC); se pide al abrir CADA sesion para no usar uno vencido. */
  readonly accessToken: () => Promise<string> | string;
}

export function vertexLiveWsUrl(location: string): string {
  return `wss://${location}-aiplatform.googleapis.com/ws/google.cloud.aiplatform.v1.LlmBidiService/BidiGenerateContent`;
}

export function vertexModelPath(v: Pick<VertexLiveOpciones, "project" | "location">, model: string): string {
  return `projects/${v.project}/locations/${v.location}/publishers/google/models/${model}`;
}

export interface GeminiLiveSesionOpciones {
  readonly apiKey: string | null;
  readonly model: string;
  /** Nombres de herramientas de SOLO LECTURA que pueden correr en paralelo cuando el modelo las pide juntas al inicio de un turno (el resto sigue en serie). */
  readonly herramientasEnParalelo?: ReadonlySet<string>;
  /** Sobreescribe el VAD de `VOZ_PLATAFORMA.gemini.vad` (campos sueltos; los demas conservan el valor de la plataforma). */
  readonly vad?: Partial<ConfigPlataformaVoz["gemini"]["vad"]>;
  /** Sobreescribe `VOZ_PLATAFORMA.gemini.usoReportado` (como se lee `usageMetadata`); por omision el de la plataforma. */
  readonly usoReportado?: "por_turno" | "acumulado";
  /** Presente = Vertex AI en lugar de la Gemini API (la `apiKey` no se usa). */
  readonly vertex?: VertexLiveOpciones;
  readonly crearSocket?: CrearSocketLive;
  /** Tope de espera del `setupComplete`. */
  readonly setupTimeoutMs?: number;
}

export function declaracionesDeHerramientas(defs: readonly ToolDefinicion[]) {
  return defs.map((d) => {
    const conParametros = Object.keys(d.parameters.properties).length > 0;
    // Gemini rechaza un objeto sin propiedades: las tools sin parametros van sin `parameters`.
    return { name: d.name, description: d.description, ...(conParametros ? { parameters: d.parameters } : {}) };
  });
}

/** Ruta de recurso del modelo en el setup: `models/<id>` en la Gemini API; `projects/.../publishers/google/models/<id>` en Vertex. */
export function mensajeSetup(model: string, apertura: AperturaLlamada, vertex?: Pick<VertexLiveOpciones, "project" | "location">, vadOverride?: Partial<ConfigPlataformaVoz["gemini"]["vad"]>) {
  const g = VOZ_PLATAFORMA.gemini;
  // Gemini API: los modelos de audio nativo eligen el idioma solos y NO admiten `languageCode` (idioma = null, no se manda): el espanol de Mexico se fija
  // en la instruccion. Vertex si lo admite (`idiomaVertex`, se manda). `languageCode` solo se incluye si la plataforma lo fija. `thinkingConfig` NUNCA se manda: `gemini-3.8-live` no admite `thinkingLevel` (solo la variante extended-thinking).
  const languageCode = vertex ? g.idiomaVertex : g.idioma;
  const vad = { ...g.vad, ...vadOverride };
  return {
    setup: {
      model: vertex ? vertexModelPath(vertex, model) : `models/${model}`,
      generationConfig: {
        responseModalities: ["AUDIO"],
        // Temperatura de la organizacion (ajustes del agente); sin ajuste, 0 (VOZ_PLATAFORMA): el agente vivo de PM corre determinista.
        temperature: typeof apertura.temperatura === "number" ? apertura.temperatura : g.temperatura,
        speechConfig: {
          ...(languageCode ? { languageCode } : {}),
          voiceConfig: { prebuiltVoiceConfig: { voiceName: apertura.voiceId } },
        },
      },
      systemInstruction: { parts: [{ text: `${g.instruccionIdioma}\n\n${apertura.instruccion}` }] },
      // VAD del servidor afinado para latencia: cierra el turno del cliente antes (`silenceDurationMs`) sin tocar el inicio de habla (barge-in).
      realtimeInputConfig: {
        automaticActivityDetection: {
          disabled: false,
          ...(vad.sensibilidadInicio ? { startOfSpeechSensitivity: vad.sensibilidadInicio } : {}),
          ...(vad.sensibilidadFin ? { endOfSpeechSensitivity: vad.sensibilidadFin } : {}),
          prefixPaddingMs: vad.prefijoMs,
          silenceDurationMs: vad.silencioFinMs,
        },
      },
      tools: [{ functionDeclarations: declaracionesDeHerramientas(apertura.herramientas) }],
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      sessionResumption: apertura.reanudarHandle ? { handle: apertura.reanudarHandle } : {},
      contextWindowCompression: { slidingWindow: {} },
    },
  };
}

const esBlob = (data: unknown): data is Blob => typeof Blob !== "undefined" && data instanceof Blob;

function textoDe(data: unknown): string | null {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data as Uint8Array);
  return null;
}

class SesionGemini implements VozSesionLlamada {
  private handle: string | null;
  private cerradaPorNosotros = false;
  private caidaAvisada = false;
  private ultimoCostoAcumulado = 0;
  private esperando: (() => void)[] = [];
  private pendiente = false;
  private salidaAgente = "";

  constructor(
    private readonly socket: SocketLive,
    private readonly h: ManejadoresSesion,
    private readonly opts: GeminiLiveSesionOpciones,
    reanudarHandle: string | null,
  ) {
    this.handle = reanudarHandle;
  }

  /** Conecta y espera `setupComplete`. */
  conectar(apertura: AperturaLlamada): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let listo = false;
      const t = setTimeout(() => {
        if (!listo) {
          this.cerradaPorNosotros = true;
          this.socket.close(1000, "setup_timeout");
          reject(new VozProveedorError("Gemini no respondió al abrir la sesión (tiempo agotado)."));
        }
      }, this.opts.setupTimeoutMs ?? 10_000);
      this.socket.onopen = () => this.socket.send(JSON.stringify(mensajeSetup(this.opts.model, apertura, this.opts.vertex, this.opts.vad)));
      this.socket.onerror = () => {
        if (!listo) {
          clearTimeout(t);
          reject(new VozProveedorError("No se pudo abrir la conexión con Gemini."));
        }
      };
      this.socket.onclose = (ev) => {
        if (!listo) {
          clearTimeout(t);
          reject(new VozProveedorError(`Gemini cerró la conexión al abrir (código ${ev.code ?? "?"}).`, ev.code));
          return;
        }
        this.alCerrar(ev.code);
      };
      // Node >= 26 entrega los mensajes como Blob (lectura asincrona): se pide "arraybuffer" y, si aun asi llega un Blob, se
      // decodifica encadenando las lecturas para conservar el orden de llegada (setupComplete antes que el resto).
      try {
        this.socket.binaryType = "arraybuffer";
      } catch {
        /* un doble o socket sin binaryType: se ignora */
      }
      let cola: Promise<void> = Promise.resolve();
      let blobsEnVuelo = 0;
      const procesar = (texto: string | null): void => {
        if (texto === null) return;
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(texto) as Record<string, unknown>;
        } catch {
          return;
        }
        if (!listo) {
          if (msg.setupComplete !== undefined) {
            listo = true;
            clearTimeout(t);
            // Reconexion sin handle: se siembra el contexto de la conversacion (turnos de historial, sin pedir respuesta todavia).
            if (apertura.historial && apertura.historial.length > 0) {
              const turns = apertura.historial.map((h) => ({ role: h.rol === "cliente" ? "user" : "model", parts: [{ text: h.texto }] }));
              this.socket.send(JSON.stringify({ clientContent: { turns, turnComplete: false } }));
            }
            resolve();
          }
          return;
        }
        this.recibir(msg);
      };
      this.socket.onmessage = (ev) => {
        const data = ev.data;
        if (esBlob(data)) {
          blobsEnVuelo++;
          cola = cola
            .then(() => data.arrayBuffer())
            .then((buf) => procesar(new TextDecoder().decode(buf)))
            .catch(() => undefined)
            .finally(() => {
              blobsEnVuelo--;
            });
          return;
        }
        // Un mensaje de texto que llega con un Blob aun en lectura espera su turno para no adelantarse.
        if (blobsEnVuelo > 0) {
          cola = cola.then(() => procesar(textoDe(data)));
          return;
        }
        procesar(textoDe(data));
      };
    });
  }

  private alCerrar(code: number | undefined): void {
    this.liberar();
    if (this.cerradaPorNosotros || this.caidaAvisada) return;
    this.caidaAvisada = true;
    this.h.caido(`ws_${code ?? "cerrado"}`, this.handle);
  }

  private liberar(): void {
    this.pendiente = false;
    const esp = this.esperando;
    this.esperando = [];
    for (const r of esp) r();
  }

  /** Se resuelve cuando Gemini termina el turno en curso (turnComplete) o ya no hay nada pendiente. */
  inactivo(timeoutMs = 60_000): Promise<void> {
    if (!this.pendiente) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const t = setTimeout(resolve, timeoutMs);
      this.esperando.push(() => {
        clearTimeout(t);
        resolve();
      });
    });
  }

  private recibir(msg: Record<string, unknown>): void {
    const contenido = msg.serverContent as
      | { modelTurn?: { parts?: { text?: string; inlineData?: { data?: string } }[] }; interrupted?: boolean; turnComplete?: boolean; inputTranscription?: { text?: string }; outputTranscription?: { text?: string } }
      | undefined;
    if (contenido) {
      for (const parte of contenido.modelTurn?.parts ?? []) {
        if (typeof parte.text === "string" && parte.text) this.agenteDice(parte.text);
        const audio = parte.inlineData?.data;
        if (typeof audio === "string" && this.h.audioAgente) this.h.audioAgente(Uint8Array.from(Buffer.from(audio, "base64")));
      }
      if (contenido.outputTranscription?.text) this.agenteDice(contenido.outputTranscription.text);
      if (contenido.inputTranscription?.text) this.h.usuarioDijo?.(contenido.inputTranscription.text);
      if (contenido.interrupted) {
        this.salidaAgente = "";
        this.h.interrumpido();
      }
      if (contenido.turnComplete) {
        this.salidaAgente = "";
        this.h.agenteTermino();
        this.liberar();
      }
    }
    const llamadas = (msg.toolCall as { functionCalls?: { id?: string; name?: string; args?: Record<string, unknown> }[] } | undefined)?.functionCalls;
    if (llamadas && llamadas.length > 0) void this.herramientas(llamadas);
    const goAway = msg.goAway;
    if (goAway !== undefined && !this.caidaAvisada && !this.cerradaPorNosotros) {
      this.caidaAvisada = true;
      this.h.caido("go_away", this.handle);
    }
    const reanudacion = msg.sessionResumptionUpdate as { newHandle?: string; resumable?: boolean } | undefined;
    if (reanudacion?.newHandle && reanudacion.resumable !== false) this.handle = reanudacion.newHandle;
    const uso = msg.usageMetadata as UsoGemini | undefined;
    if (uso && typeof uso === "object") this.registrarUso(uso);
  }

  /** Costo REAL del turno desde `usageMetadata` (tokens que el proveedor informo; ver `VOZ_PLATAFORMA.gemini.usoReportado`). */
  private registrarUso(uso: UsoGemini): void {
    const config = VOZ_PLATAFORMA;
    const costo = costoDeUsoGeminiMicroUsd(uso, config);
    let delta = costo;
    if ((this.opts.usoReportado ?? config.gemini.usoReportado) === "acumulado") {
      delta = Math.max(0, costo - this.ultimoCostoAcumulado);
      this.ultimoCostoAcumulado = Math.max(this.ultimoCostoAcumulado, costo);
    }
    if (delta > 0) this.h.costo?.(delta, true);
  }

  private agenteDice(texto: string): void {
    this.salidaAgente += texto;
    this.h.agenteDijo(texto);
  }

  private async herramientas(llamadas: { id?: string; name?: string; args?: Record<string, unknown> }[]): Promise<void> {
    this.pendiente = true;
    const ejecutarUna = async (c: { id?: string; name?: string; args?: Record<string, unknown> }, i: number): Promise<{ id: string; name: string; response: { output: unknown } | { error: string } }> => {
      const id = c.id ?? `call-${i}`;
      const nombre = c.name ?? "";
      try {
        const salida = await this.h.ejecutarTool({ id, nombre, args: c.args ?? {} });
        return { id, name: nombre, response: { output: salida } };
      } catch {
        return { id, name: nombre, response: { error: "Error interno al ejecutar la herramienta" } };
      }
    };
    // En SERIE y en el orden que pidio el modelo (equivale a `parallel_tool_calls: false` del agente vivo): una cotizacion y un crear_pedido pedidos juntos nunca
    // corren a la vez ni compiten por el mismo estado del pedido. UNICA excepcion (latencia): la racha INICIAL de herramientas de solo lectura declaradas en
    // `herramientasEnParalelo` (buscar cliente / sucursal / producto, sin estado compartido ni dependencia entre si) corre en paralelo; las respuestas conservan el orden pedido.
    const paralelas = this.opts.herramientasEnParalelo;
    let racha = 0;
    while (paralelas && racha < llamadas.length && paralelas.has(llamadas[racha]?.name ?? "")) racha++;
    const respuestas = racha > 1 ? await Promise.all(llamadas.slice(0, racha).map((c, i) => ejecutarUna(c, i))) : [];
    for (let i = respuestas.length; i < llamadas.length; i++) respuestas.push(await ejecutarUna(llamadas[i] as { id?: string; name?: string; args?: Record<string, unknown> }, i));
    if (this.cerradaPorNosotros) return;
    this.socket.send(JSON.stringify({ toolResponse: { functionResponses: respuestas } }));
  }

  enviarTexto(texto: string): void {
    this.pendiente = true;
    this.socket.send(JSON.stringify({ realtimeInput: { text: texto } }));
  }

  enviarAudio(pcm16: Uint8Array): void {
    this.socket.send(JSON.stringify({ realtimeInput: { audio: { data: Buffer.from(pcm16).toString("base64"), mimeType: MIME_AUDIO_ENTRADA } } }));
  }

  /** El barge-in lo resuelve Gemini (`interrupted`) y la reproduccion la corta el worker: no hay mensaje que enviar. */
  interrumpir(): void {
    return;
  }

  async cerrar(): Promise<void> {
    this.cerradaPorNosotros = true;
    this.liberar();
    try {
      this.socket.close(1000, "fin_de_llamada");
    } catch {
      /* ya cerrado */
    }
  }
}

export interface ProveedorGeminiLlamada {
  readonly abrirSesion: AbrirSesionLlamada;
  inactivo(): Promise<void>;
}

/** Fabrica de sesiones de llamada con Gemini Live. Sin `apiKey` lanza `VozNoConfiguradaError`. */
export function crearProveedorGeminiLlamada(opts: GeminiLiveSesionOpciones): ProveedorGeminiLlamada {
  let actual: SesionGemini | null = null;
  const abrirSesion: AbrirSesionLlamada = async (apertura, manejadores) => {
    const crear = opts.crearSocket ?? crearSocketGlobal;
    let socket: SocketLive;
    if (opts.vertex) {
      let token: string;
      try {
        token = await opts.vertex.accessToken();
      } catch {
        throw new VozNoConfiguradaError("Voz no configurada: no se pudo obtener el token de acceso de Vertex AI.");
      }
      if (!token) throw new VozNoConfiguradaError("Voz no configurada: falta el token de acceso de Vertex AI.");
      socket = crear(vertexLiveWsUrl(opts.vertex.location), { headers: { Authorization: `Bearer ${token}` } });
    } else {
      if (!opts.apiKey) throw new VozNoConfiguradaError("Voz no configurada: falta GEMINI_API_KEY.");
      socket = crear(`${GEMINI_LIVE_WS_URL}?key=${encodeURIComponent(opts.apiKey)}`);
    }
    const sesion = new SesionGemini(socket, manejadores, opts, apertura.reanudarHandle ?? null);
    await sesion.conectar(apertura);
    actual = sesion;
    return sesion;
  };
  return { abrirSesion, inactivo: () => actual?.inactivo() ?? Promise.resolve() };
}

function crearSocketGlobal(url: string, opciones?: OpcionesSocketLive): SocketLive {
  const WS = (globalThis as { WebSocket?: new (url: string, init?: unknown) => SocketLive }).WebSocket;
  if (!WS) throw new VozProveedorError("Este entorno no trae WebSocket (se requiere Node 22 o superior).");
  // `headers` es la extension de undici (Node >= 22): sin cabeceras se usa la firma estandar.
  return opciones?.headers ? new WS(url, { headers: opciones.headers }) : new WS(url);
}
