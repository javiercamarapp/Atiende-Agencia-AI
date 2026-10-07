// Puerto de TELEFONIA del worker: lo unico que el resto del worker sabe de la linea. Dos implementaciones: `LiveKitTelefonia` (SIP real, sala por
// llamada) y `TelefoniaFalsa` (PCM de archivos o de los guiones del simulador; pruebas y verify, sin red).
//
// El audio entra y sale como PCM16 mono en la tasa que entregue la linea: el puente (`puente-audio.ts`) remuestrea a lo que pide cada escalon.

export interface LlamadaTelefonica {
  /** Identificador opaco de la llamada (en LiveKit, el nombre de la sala). Se usa como `call_id` y `externalId`. */
  readonly id: string;
  /** Numero marcado (DNIS), tal como lo reporta la telefonia; null si no lo reporta. */
  readonly dnis: string | null;
  /** Origen en forma de URI SIP (`<sip:+521...@host;user=phone>`), apta para `extraerTelefonoSipFrom`; null si la linea no lo trae. */
  readonly sipFrom: string | null;
  /** Cabecera de desvio (`Diversion` / `History-Info`) si la llamada llega por desvio condicional del conmutador; null si es directa. */
  readonly desviadaDesde: string | null;
  /** Suscribe el audio del llamante. Un solo suscriptor. */
  alAudio(cb: (pcm: Int16Array, hz: number) => void): void;
  alDtmf(cb: (digito: string) => void): void;
  /** El llamante colgo (o la sala se cerro). Se llama una sola vez. */
  alColgar(cb: () => void): void;
  /** Encola audio hacia el llamante; resuelve cuando termino de sonar o se interrumpio. */
  reproducir(pcm: Int16Array, hz: number): Promise<void>;
  /** Corta lo que suena y lo encolado (barge-in). */
  detenerReproduccion(): void;
  /** Cuelga por el lado del sistema. Idempotente. */
  colgar(): Promise<void>;
}

export interface TelefoniaPort {
  /** Empieza a recibir llamadas; `alLlegar` se invoca una vez por llamada nueva. */
  escuchar(alLlegar: (llamada: LlamadaTelefonica) => void): Promise<void>;
  detener(): Promise<void>;
  /** Epoch (ms) del ultimo sondeo EXITOSO de la telefonia (LiveKit: ultimo `listRooms` que respondio). null = nunca / la telefonia no sondea (la falsa). Alimenta el latido de /salud. */
  latidoMs?(): number | null;
}
