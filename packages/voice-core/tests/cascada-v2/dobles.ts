// Dobles de prueba de la cascada v2: WebSocket falso (Deepgram STT y TTS), puertos STT/TTS falsos y LLM falso con streaming. Nada toca la red.
import type { ManejadoresSesion, PeticionLlmVoz, PuertoLlmVoz, RespuestaLlmVoz } from "../../src/index.ts";
import type { CrearSocketDeepgram, EventosStt, OpcionesStt, OpcionesTts, PuertoSttVoz, PuertoTtsVoz, SesionStt, SesionTts, SocketDeepgram } from "../../src/index.ts";

export class SocketFalso implements SocketDeepgram {
  enviados: (string | Uint8Array)[] = [];
  cerrado: { code?: number; reason?: string } | null = null;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code?: number }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  binaryType?: string;
  constructor(readonly url: string, readonly headers: Readonly<Record<string, string>>) {}
  send(data: string | Uint8Array): void {
    this.enviados.push(data);
  }
  close(code?: number, reason?: string): void {
    this.cerrado = { ...(code !== undefined ? { code } : {}), ...(reason !== undefined ? { reason } : {}) };
  }
  /** Mensajes de texto (JSON) que el cliente envio. */
  get json(): Record<string, unknown>[] {
    return this.enviados.filter((d): d is string => typeof d === "string").map((d) => JSON.parse(d) as Record<string, unknown>);
  }
  get binarios(): Uint8Array[] {
    return this.enviados.filter((d): d is Uint8Array => typeof d !== "string");
  }
  abrir(): void {
    this.onopen?.({});
  }
  texto(msg: unknown): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  audio(bytes: number[] | Uint8Array): void {
    const b = Uint8Array.from(bytes);
    this.onmessage?.({ data: b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) });
  }
  caer(code?: number): void {
    this.onclose?.({ ...(code !== undefined ? { code } : {}) });
  }
}

export function fabricaSockets(opciones: { autoAbrir?: boolean } = {}) {
  const sockets: SocketFalso[] = [];
  const crear: CrearSocketDeepgram = (url, o) => {
    const s = new SocketFalso(url, o.headers);
    sockets.push(s);
    if (opciones.autoAbrir !== false) queueMicrotask(() => s.abrir());
    return s;
  };
  return { sockets, crear };
}

export const turnoMicrotareas = async (n = 20): Promise<void> => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};

export function resultadoStt(transcript: string, o: { final?: boolean; speechFinal?: boolean } = {}) {
  return { type: "Results", is_final: o.final ?? true, speech_final: o.speechFinal ?? false, channel: { alternatives: [{ transcript }] } };
}

export interface Compuerta {
  readonly promesa: Promise<void>;
  abrir(): void;
}
export function compuerta(): Compuerta {
  let abrir!: () => void;
  const promesa = new Promise<void>((r) => {
    abrir = r;
  });
  return { promesa, abrir };
}

// ---- puertos falsos del nucleo ----

export class SttFalso implements PuertoSttVoz {
  eventos: EventosStt | null = null;
  opciones: OpcionesStt | null = null;
  audio: Uint8Array[] = [];
  cerrada = false;
  constructor(private readonly falloAlAbrir = false) {}
  async abrir(opciones: OpcionesStt, eventos: EventosStt): Promise<SesionStt> {
    if (this.falloAlAbrir) throw new Error("apertura");
    this.opciones = opciones;
    this.eventos = eventos;
    return {
      enviarAudio: (pcm) => void this.audio.push(pcm),
      cerrar: async () => {
        this.cerrada = true;
      },
    };
  }
}

export type GuionTts = (frase: string, senal: AbortSignal) => AsyncGenerator<Uint8Array>;

export const audioDe = (n: number): Uint8Array => Uint8Array.from([n, 0, n, 0]);

export class TtsFalso implements PuertoTtsVoz {
  opciones: OpcionesTts | null = null;
  frases: string[] = [];
  senales: AbortSignal[] = [];
  cerrada = false;
  /** Flush que el proveedor falso dice tener disponibles; undefined = el puerto no lo expone. */
  flushes: number | undefined = undefined;
  constructor(
    private readonly guion: GuionTts = async function* () {
      yield audioDe(1);
      yield audioDe(2);
    },
    private readonly falloAlAbrir = false,
  ) {}
  async abrir(opciones: OpcionesTts): Promise<SesionTts> {
    if (this.falloAlAbrir) throw new Error("apertura");
    this.opciones = opciones;
    return {
      sintetizar: (texto, senal) => {
        this.frases.push(texto);
        this.senales.push(senal);
        return this.guion(texto, senal);
      },
      ...(this.flushes !== undefined ? { flushesDisponibles: () => this.flushes as number } : {}),
      cerrar: async () => {
        this.cerrada = true;
      },
    };
  }
}

// ---- LLM falso con streaming ----

export type TurnoLlm = (p: PeticionLlmVoz, texto: (delta: string) => void) => Promise<Partial<RespuestaLlmVoz> & { texto?: string }>;

export function llmFalso(guion: TurnoLlm[]): PuertoLlmVoz & { peticiones: PeticionLlmVoz[]; senales: AbortSignal[] } {
  const peticiones: PeticionLlmVoz[] = [];
  const senales: AbortSignal[] = [];
  let i = 0;
  return {
    peticiones,
    senales,
    completar: async (p) => {
      peticiones.push({ ...p, mensajes: [...p.mensajes] });
      if (p.senal) senales.push(p.senal);
      const turno = guion[Math.min(i, guion.length - 1)] as TurnoLlm;
      i += 1;
      const r = await turno(p, (d) => p.onTextDelta?.(d));
      return { texto: "", toolCalls: [], costoMicroUsd: 0, ...r };
    },
  };
}

/** Un turno del LLM que escribe `trozos` y devuelve el texto completo. */
export const escribe = (trozos: string[], extra: Partial<RespuestaLlmVoz> = {}): TurnoLlm => async (_p, texto) => {
  for (const t of trozos) texto(t);
  return { texto: trozos.join(""), ...extra };
};

export function manejadoresFalsos(sobreescribir: Partial<ManejadoresSesion> = {}) {
  const eventos: string[] = [];
  const audio: Uint8Array[] = [];
  const costos: { micro: number; real: boolean | undefined; proveedor: string | undefined; unidad: string | undefined; cantidad: number | undefined }[] = [];
  const herramientas: string[] = [];
  const h: ManejadoresSesion = {
    agenteDijo: (t) => eventos.push(`agente:${t}`),
    agenteTermino: () => eventos.push("fin"),
    interrumpido: () => eventos.push("interrumpido"),
    usuarioDijo: (t) => eventos.push(`cliente:${t}`),
    ejecutarTool: async (l) => {
      herramientas.push(l.nombre);
      return { ok: true };
    },
    audioAgente: (a) => audio.push(a),
    costo: (micro, real, c) => costos.push({ micro, real, proveedor: c?.proveedor, unidad: c?.unidad, cantidad: c?.cantidad }),
    caido: (razon) => eventos.push(`caido:${razon}`),
    ...sobreescribir,
  };
  return { h, eventos, audio, costos, herramientas };
}
