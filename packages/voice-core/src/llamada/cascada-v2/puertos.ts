// Puertos por etapa de la cascada v2 (STT, LLM y TTS). El nucleo (`sesion.ts`) solo conoce estas interfaces: cambiar de proveedor
// (Deepgram -> otro STT, Aura-2 -> HeyGen/otro TTS) es escribir otro adaptador, sin tocar el nucleo. El puerto del LLM es el mismo
// `PuertoLlmVoz` de la cascada actual (`../cascada-openrouter.ts`), ampliado con streaming (`onTextDelta`).
//
// Convencion de errores: un adaptador que se cae lanza (o avisa por `caido`) un codigo CORTO y sin PII (`stt_ws_1006`, `tts_ws_1011`);
// el nucleo lo prefija con `v2_` y lo sube a `h.caido(codigo)` para que la escalera pase al siguiente escalon.

/** Lo que el STT le cuenta al nucleo. */
export interface EventosStt {
  /** Deepgram detecto el inicio de voz del cliente (`SpeechStarted`): sirve para el barge-in. */
  hablaIniciada(): void;
  /** Transcripcion intermedia del turno en curso (puede cambiar). */
  parcial(texto: string): void;
  /** Fin de turno decidido por el endpointing del proveedor (`speech_final` o `UtteranceEnd`): texto final del turno. */
  turnoFinal(texto: string): void;
  /** El STT se cayo despues de abrir (cierre inesperado o error de red). Codigo corto sin PII. */
  caido(codigo: string): void;
}

export interface OpcionesStt {
  /** Nombres y apodos del menu (`AperturaLlamada.vocabulario`) como terminos clave. */
  readonly vocabulario?: readonly string[];
  /** Tasa (Hz) del PCM16 mono que recibira `enviarAudio`. */
  readonly hzEntrada: number;
}

export interface SesionStt {
  enviarAudio(pcm16: Uint8Array): void;
  cerrar(): Promise<void>;
}

export interface PuertoSttVoz {
  /** Abre la conexion y resuelve cuando esta lista; si no puede, lanza (el escalon se salta). */
  abrir(opciones: OpcionesStt, eventos: EventosStt): Promise<SesionStt>;
}

export interface OpcionesTts {
  /** Identificador de voz del proveedor (Aura-2: `aura-2-estrella-es`). */
  readonly voz: string;
  /** Tasa (Hz) del PCM16 mono que debe entregar `sintetizar` (la de salida de la sala). */
  readonly hzSalida: number;
}

export interface SesionTts {
  /**
   * Sintetiza UNA frase y entrega su audio PCM16 mono (little-endian, a `hzSalida`) en trozos conforme el proveedor los genera.
   * Las frases se atienden de una en una. Si `senal` se aborta o el consumidor deja de iterar, el adaptador cancela la sintesis en
   * curso en el proveedor y el audio pendiente se descarta. Un fallo lanza un `Error` con codigo corto en `message`.
   */
  sintetizar(texto: string, senal: AbortSignal): AsyncIterable<Uint8Array>;
  /** Cuantas sintesis mas admite el proveedor ahora sin agotar su limite de peticiones (Deepgram: 20 `Flush` por 60 s). Con pocas disponibles el nucleo junta frases en una sola. */
  flushesDisponibles?(): number;
  cerrar(): Promise<void>;
}

export interface PuertoTtsVoz {
  /** Abre la conexion (y valida la credencial) antes de que el cliente hable; si no puede, lanza. */
  abrir(opciones: OpcionesTts): Promise<SesionTts>;
}

/** Contexto que el nucleo le da al selector de modelo por turno (P3 lo usara para escalar entre modelos; aqui solo queda el gancho). */
export interface ContextoTurnoLlm {
  /** Numero de turno de la sesion (1 = el primero; el saludo inicial cuenta como turno). */
  readonly turno: number;
  /** Vuelta modelo -> herramienta -> modelo dentro del turno (0 = primera). */
  readonly vuelta: number;
  /** Modelo por omision del motor. */
  readonly modeloPorDefecto: string;
}

/** Cola asincrona de un productor y un consumidor (frases del LLM -> TTS, audio del socket -> iterador). */
export class ColaAsync<T> {
  private readonly items: T[] = [];
  private esperando: { resolve: (v: T | null) => void; reject: (e: unknown) => void } | null = null;
  private fin = false;
  private error: { causa: unknown } | null = null;

  push(item: T): void {
    if (this.fin) return;
    if (this.esperando) {
      const e = this.esperando;
      this.esperando = null;
      e.resolve(item);
      return;
    }
    this.items.push(item);
  }

  /** Saca de golpe lo que ya esta en la cola, sin esperar. */
  tomarDisponibles(): T[] {
    return this.items.splice(0, this.items.length);
  }

  /** Cierra la cola: el consumidor recibe lo pendiente y luego `null`. */
  cerrar(): void {
    this.fin = true;
    if (this.esperando && this.items.length === 0) {
      const e = this.esperando;
      this.esperando = null;
      e.resolve(null);
    }
  }

  /** Cierra con error: el consumidor lo recibe tras lo pendiente. */
  fallar(causa: unknown): void {
    if (this.fin) return;
    this.fin = true;
    this.error = { causa };
    if (this.esperando && this.items.length === 0) {
      const e = this.esperando;
      this.esperando = null;
      e.reject(causa);
    }
  }

  /** Siguiente elemento; `null` = cola cerrada y vacia. */
  siguiente(): Promise<T | null> {
    if (this.items.length > 0) return Promise.resolve(this.items.shift() as T);
    if (this.error) return Promise.reject(this.error.causa);
    if (this.fin) return Promise.resolve(null);
    return new Promise<T | null>((resolve, reject) => {
      this.esperando = { resolve, reject };
    });
  }
}
