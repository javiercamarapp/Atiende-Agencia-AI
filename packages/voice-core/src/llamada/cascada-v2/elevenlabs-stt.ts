// STT de la cascada v2: ElevenLabs Scribe v2 Realtime por WebSocket (`wss://api.elevenlabs.io/v1/speech-to-text/realtime`).
//
// Protocolo (https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime, leido el 6-nov-2026): la llave va en la cabecera `xi-api-key`;
// el cliente manda `{"message_type":"input_audio_chunk","audio_base_64":...,"commit":false,"sample_rate":16000}`; el servidor responde `session_started`,
// `partial_transcript` (cambia) y `committed_transcript` (estable). Cualquier otro `message_type` con campo `error` (auth_error, quota_exceeded, rate_limited...) es falla.
// Verificado contra la API real el 6-nov-2026 con los 100 clips con ruido de cocina (ver el PR): `keyterms` se manda como parametro repetido.
//
// Fin de turno (equivalente a min/max endpointing de LiveKit):
//   - El VAD del servidor (`commit_strategy=vad`, `vad_silence_threshold_secs`) confirma el segmento tras ese silencio (0.55 s, el `min_silence_duration` de Silero).
//   - Tras el commit se espera `finTurnoMinMs` (0.4 s): si el cliente vuelve a hablar (llega un parcial nuevo) el turno sigue y se junta con el siguiente segmento.
//   - Si hay texto parcial que no cambia y no se confirma en `finTurnoMaxMs` (3 s), se fuerza el commit (`commit: true`).
import type { ConfigElevenLabs } from "../../config-plataforma.ts";
import { VozProveedorError } from "../../provider.ts";
import { keytermsDe } from "./deepgram-stt.ts";
import type { EventosStt, OpcionesStt, ProveedorStt, PuertoSttVoz, SesionStt } from "./puertos.ts";
import { crearLectorMensajes, crearSocketDeepgramGlobal } from "./socket.ts";
import type { CrearSocketDeepgram, SocketDeepgram } from "./socket.ts";

export const ELEVENLABS_STT_URL = "wss://api.elevenlabs.io/v1/speech-to-text/realtime";

/** Limites de `keyterms` de Scribe v2 Realtime (respuesta `invalid_request` de la API, verificado el 6-nov-2026): hasta 50 terminos de hasta 20 caracteres.
 * Con uno solo fuera de limite la sesion NO abre (y todo cae al respaldo). */
export const ELEVENLABS_KEYTERM_MAX_CHARS = 20;
export const ELEVENLABS_KEYTERMS_MAX = 50;

/** Terminos del menu para Scribe RT: sin parentesis de presentacion («(orden de 5)»); si un nombre pasa de 20 caracteres se queda con sus ULTIMAS palabras que
 * quepan («Orden de tacos de cochinita pibil» -> «cochinita pibil»: lo distintivo va al final); sin repetir y hasta `max` (tope 50). */
export function keytermsElevenLabs(vocabulario: readonly string[] | undefined, max: number): string[] {
  const out = new Map<string, string>();
  for (const t of keytermsDe(vocabulario, 500)) {
    if (out.size >= Math.min(max, ELEVENLABS_KEYTERMS_MAX)) break;
    let limpio = t.replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
    if (limpio.length > ELEVENLABS_KEYTERM_MAX_CHARS) {
      const palabras = limpio.split(" ");
      let cola = "";
      for (let i = palabras.length - 1; i >= 0; i -= 1) {
        const cand = cola === "" ? palabras[i]! : `${palabras[i]} ${cola}`;
        if (cand.length > ELEVENLABS_KEYTERM_MAX_CHARS) break;
        cola = cand;
      }
      // Sin articulo o preposicion suelta al inicio («de cochinita pibil» -> «cochinita pibil»).
      limpio = cola.replace(/^(?:(?:de|del|con|la|el|los|las|y|a)\s+)+/i, "");
    }
    if (limpio.length < 3 || out.has(limpio.toLowerCase())) continue;
    out.set(limpio.toLowerCase(), limpio);
  }
  return [...out.values()];
}

/** Tasas que admite `audio_format=pcm_<hz>`. */
const TASAS_PCM = [8_000, 16_000, 22_050, 24_000, 44_100, 48_000];

export function urlSttElevenLabs(c: ConfigElevenLabs["stt"], opciones: OpcionesStt): string {
  if (!TASAS_PCM.includes(opciones.hzEntrada)) throw new VozProveedorError(`ElevenLabs (STT) no admite PCM a ${opciones.hzEntrada} Hz.`);
  const q = new URLSearchParams({
    model_id: c.modelo,
    audio_format: `pcm_${opciones.hzEntrada}`,
    language_code: c.idioma,
    commit_strategy: "vad",
    vad_silence_threshold_secs: String(c.vadSilencioS),
  });
  // Tiempos y logprob por palabra: los usa la compuerta de voz de fondo (`compuertaFondo`).
  if (c.compuertaFondo) q.set("include_timestamps", "true");
  for (const t of keytermsElevenLabs(opciones.vocabulario, c.keytermsMax)) q.append("keyterms", t);
  return `${ELEVENLABS_STT_URL}?${q.toString()}`;
}

export interface ElevenLabsSttOpciones {
  readonly apiKey: string;
  readonly config: ConfigElevenLabs["stt"];
  readonly crearSocket?: CrearSocketDeepgram;
  /** Tope de espera de `session_started` (la sesion no esta lista hasta entonces: valida la llave y la cuota). */
  readonly aperturaTimeoutMs?: number;
  /** Temporizador inyectable (pruebas). */
  readonly temporizador?: { readonly poner: (fn: () => void, ms: number) => unknown; readonly quitar: (id: unknown) => void };
  /** Sin audio por este tiempo (ms) se manda una trama de silencio: Scribe cierra la sesion inactiva (codigo 1000) y la llamada caeria al respaldo. */
  readonly keepAliveMs?: number;
  readonly ahora?: () => number;
}

const TEMPORIZADOR_REAL = {
  poner: (fn: () => void, ms: number): unknown => {
    const id = setTimeout(fn, ms);
    (id as { unref?: () => void }).unref?.();
    return id;
  },
  quitar: (id: unknown): void => clearTimeout(id as ReturnType<typeof setTimeout>),
};

/** Espera de la confirmacion del commit forzado antes de cerrar el turno con el parcial. */
const COMMIT_FORZADO_MS = 1_000;

/** Mensajes del servidor que solo informan y no cambian el turno. */
const INFORMATIVOS = new Set(["session_started", "partial_transcript", "committed_transcript", "committed_transcript_with_timestamps", "committed_transcript_entities", "warning"]);

/** base64 de un PCM16 sin depender de `Buffer` (el paquete es isomorfo). */
function aBase64(bytes: Uint8Array): string {
  const B = (globalThis as { Buffer?: { from(b: Uint8Array): { toString(enc: string): string } } }).Buffer;
  if (B) return B.from(bytes).toString("base64");
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s);
}

const codigoCorto = (tipo: string): string => `stt_el_${tipo.replace(/[^a-z0-9_]/gi, "").toLowerCase().slice(0, 28) || "error"}`;

class SesionElevenLabsStt implements SesionStt {
  private cerradaPorNosotros = false;
  private caidaAvisada = false;
  private lista = false;
  /** Segmentos confirmados del turno en curso. */
  private confirmado = "";
  /** Parcial vigente (aun no confirmado). */
  private parcial = "";
  private tFinMin: unknown = null;
  private tKeepAlive: unknown = null;
  private ultimoAudio = 0;
  private tFinMax: unknown = null;
  private readonly t: NonNullable<ElevenLabsSttOpciones["temporizador"]>;

  constructor(
    private readonly socket: SocketDeepgram,
    private readonly eventos: EventosStt,
    private readonly o: ElevenLabsSttOpciones,
    private readonly hz: number,
    private readonly keyterms: boolean,
  ) {
    this.t = o.temporizador ?? TEMPORIZADOR_REAL;
  }

  proveedor(): ProveedorStt {
    return "elevenlabs";
  }

  conKeyterms(): boolean {
    return this.keyterms;
  }

  conectar(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let resuelta = false;
      const fallarApertura = (motivo: string, codigo?: number): void => {
        if (resuelta) return;
        resuelta = true;
        this.t.quitar(limite);
        this.cerradaPorNosotros = true;
        try {
          this.socket.close(1000, "apertura_fallida");
        } catch {
          /* ya cerrado */
        }
        reject(new VozProveedorError(`ElevenLabs (STT): ${motivo}`, codigo));
      };
      const limite = this.t.poner(() => fallarApertura("no confirmo la sesion (tiempo agotado)."), this.o.aperturaTimeoutMs ?? 8_000);
      try {
        this.socket.binaryType = "arraybuffer";
      } catch {
        /* doble sin binaryType */
      }
      this.socket.onerror = () => {
        if (!this.lista) fallarApertura("no se pudo abrir la conexion.");
        else this.avisarCaida("stt_el_ws_error");
      };
      this.socket.onclose = (ev) => {
        if (!this.lista) {
          fallarApertura(`cerro la conexion al abrir (codigo ${ev.code ?? "?"}).`, ev.code);
          return;
        }
        if (!this.cerradaPorNosotros) this.avisarCaida(`stt_el_ws_${ev.code ?? "cerrado"}`);
      };
      this.socket.onmessage = crearLectorMensajes((m) => {
        if (m.tipo !== "texto") return;
        let msg: { message_type?: unknown; text?: unknown; error?: unknown };
        try {
          msg = JSON.parse(m.texto) as { message_type?: unknown; text?: unknown; error?: unknown };
        } catch {
          return;
        }
        const tipo = typeof msg?.message_type === "string" ? msg.message_type : "";
        if (tipo === "session_started" && !resuelta) {
          resuelta = true;
          this.lista = true;
          this.t.quitar(limite);
          this.ultimoAudio = (this.o.ahora ?? Date.now)();
          this.programarKeepAlive();
          resolve();
          return;
        }
        // Error = un tipo con campo `error` o con nombre de error/limite (auth_error, quota_exceeded, rate_limited...). Un tipo informativo NUEVO que no conocemos se ignora
        // (tumbar la sesion por el pasaria todas las llamadas a Deepgram en silencio).
        if (!INFORMATIVOS.has(tipo) && (typeof msg.error === "string" || /error|exceeded|limit|throttl|invalid|unaccepted|overflow|exhausted/i.test(tipo) || tipo === "")) {
          // Errores (auth_error, quota_exceeded, rate_limited, transcriber_error...): solo el TIPO, nunca el texto del proveedor.
          if (!this.lista) fallarApertura(`rechazo la sesion (${tipo || "desconocido"}).`);
          else this.avisarCaida(codigoCorto(tipo || "error"));
          return;
        }
        if (!INFORMATIVOS.has(tipo)) return;
        const texto = typeof msg.text === "string" ? msg.text.trim() : "";
        if (tipo === "partial_transcript") this.alParcial(texto);
        else if (tipo === "committed_transcript") this.alCommitNormal(texto);
        else if (tipo === "committed_transcript_with_timestamps") this.alCommitConTiempos(texto, (msg as { words?: unknown }).words);
      });
    });
  }

  /** RMS por trama de 20 ms de TODO el audio enviado (indice = trama desde el inicio de la sesion; los tiempos de Scribe cuentan desde ahi). */
  private readonly niveles: number[] = [];
  private acumE = 0;
  private acumN = 0;
  /** Nivel (dB) de los ultimos segmentos aceptados del cliente. */
  private readonly nivelesCliente: number[] = [];

  // ---- compuerta por NIVEL (`compuertaNivel`): sin timestamps, sobre el audio que se envia ----
  /** dB por trama de 20 ms (ultimos 300 ms bastan para la ventana). */
  private readonly tramasDb: number[] = [];
  /** Nivel de ventana (p80 de 300 ms) por trama (ultimos 10 s): el piso es su p20 (las pausas del cliente y los silencios entre turnos). */
  private readonly ventanasDb: number[] = [];
  private nivE = 0;
  private nivN = 0;
  /** Nivel maximo de ventana desde el ultimo segmento confirmado. */
  private picoSegmento = -Infinity;
  private tramasEnSegmento = 0;
  /** Hubo un parcial de VOZ (no fondo) desde el ultimo segmento confirmado. */
  private vozEnSegmento = false;
  private fondoAvisadoEnSegmento = false;
  /** Pico (dB) de los ultimos segmentos aceptados del cliente: su mediana es la voz del cliente. */
  private readonly picosCliente: number[] = [];
  private descartesSeguidos = 0;
  private nivelApagada = false;

  private medirNivel(pcm16: Uint8Array): void {
    if (!this.o.config.compuertaNivel || this.nivelApagada) return;
    const v = new DataView(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength);
    const porTrama = this.hz / 50;
    for (let i = 0; i + 1 < pcm16.byteLength; i += 2) {
      const x = v.getInt16(i, true);
      this.nivE += x * x;
      this.nivN += 1;
      if (this.nivN >= porTrama) {
        this.tramasDb.push(20 * Math.log10(Math.max(1, Math.sqrt(this.nivE / this.nivN))));
        this.nivE = 0;
        this.nivN = 0;
        if (this.tramasDb.length > 15) this.tramasDb.shift();
        const ult = this.tramasDb.slice(-15).sort((a, b) => a - b);
        const ventana = ult[Math.floor(0.8 * (ult.length - 1))]!;
        this.ventanasDb.push(ventana);
        if (this.ventanasDb.length > 500) this.ventanasDb.shift();
        // El pico del segmento solo cuenta ventanas enteras posteriores al segmento anterior (no arrastra la voz ya confirmada).
        this.tramasEnSegmento += 1;
        if (this.tramasEnSegmento >= 15 && ventana > this.picoSegmento) this.picoSegmento = ventana;
      }
    }
  }

  /** `nivel` (dB) es platica de fondo: cerca del piso de ruido y, con referencia, por debajo de la voz del cliente. Sin 1 s de audio medido no decide (false). */
  private esFondo(nivel: number): boolean {
    const g = this.o.config.compuertaNivel;
    if (!g || this.nivelApagada || this.ventanasDb.length < 50) return false;
    const orden = [...this.ventanasDb].sort((a, b) => a - b);
    const piso = orden[Math.floor(0.2 * (orden.length - 1))]!;
    if (nivel >= piso + g.dbSobrePiso) return false;
    if (this.picosCliente.length === 0) return true;
    const refs = [...this.picosCliente].sort((a, b) => a - b);
    return nivel < refs[Math.floor(refs.length / 2)]! - g.dbBajoCliente;
  }

  /** Nivel del audio que origino el parcial: el MAXIMO de ventana de los ultimos 500 ms (los parciales llegan con retraso; E2E r3: un parcial tardio en linea
   * limpia caia sobre el silencio posterior y se tomaba como fondo). */
  private nivelReciente(): number {
    const ult = this.ventanasDb.slice(-25);
    return ult.length ? Math.max(...ult) : -Infinity;
  }

  /** Un segmento confirmado: `true` = era fondo (se descarta). Reinicia la medicion del segmento. */
  private segmentoEsFondo(): boolean {
    const g = this.o.config.compuertaNivel;
    const pico = this.picoSegmento;
    const voz = this.vozEnSegmento;
    this.picoSegmento = -Infinity;
    this.tramasEnSegmento = 0;
    this.vozEnSegmento = false;
    this.fondoAvisadoEnSegmento = false;
    if (!g || this.nivelApagada) return false;
    // Sin referencia de la voz del cliente (ningun segmento aceptado aun) nunca se descarta un segmento: solo se frenan los parciales.
    // Sin audio medido desde el segmento anterior no hay evidencia: no se descarta.
    if (!voz && this.picosCliente.length > 0 && Number.isFinite(pico) && this.esFondo(pico)) {
      this.descartesSeguidos += 1;
      this.eventos.descartado?.("nivel_fondo");
      if (this.descartesSeguidos >= g.descartesMax) {
        // Nunca sorda: demasiados descartes seguidos (el cliente habla bajito con mucho ruido) apagan la compuerta en esta llamada.
        this.nivelApagada = true;
        this.eventos.descartado?.("compuerta_nivel_apagada");
      }
      return true;
    }
    this.descartesSeguidos = 0;
    if (Number.isFinite(pico)) {
      this.picosCliente.push(pico);
      if (this.picosCliente.length > 5) this.picosCliente.shift();
    }
    return false;
  }

  private medirAudio(pcm16: Uint8Array): void {
    if (!this.o.config.compuertaFondo) return;
    const v = new DataView(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength);
    const porTrama = this.hz / 50;
    for (let i = 0; i + 1 < pcm16.byteLength; i += 2) {
      const x = v.getInt16(i, true);
      this.acumE += x * x;
      this.acumN += 1;
      if (this.acumN >= porTrama) {
        this.niveles.push(Math.sqrt(this.acumE / this.acumN));
        this.acumE = 0;
        this.acumN = 0;
      }
    }
  }

  /** Con `include_timestamps` el servidor puede mandar el commit normal, la copia con tiempos o las dos, en cualquier orden (no esta documentado; revision #752 P1-4).
   * Se empareja por conteo: la copia que llega sin su par cuenta como el commit (la llamada nunca queda sorda) y la otra, cuando llegue, no se suma dos veces. */
  private commitsSinTiempos = 0;
  private tiemposSinCommit = 0;

  private alCommitNormal(texto: string): void {
    if (this.o.config.compuertaFondo && this.tiemposSinCommit > 0) {
      this.tiemposSinCommit -= 1;
      return;
    }
    if (this.o.config.compuertaFondo) this.commitsSinTiempos += 1;
    this.alConfirmado(texto);
  }

  private alCommitConTiempos(texto: string, words: unknown): void {
    if (this.commitsSinTiempos > 0) this.commitsSinTiempos -= 1;
    else {
      // Llego la copia con tiempos sin el commit normal: ella ES el commit.
      this.tiemposSinCommit += 1;
      this.alConfirmado(texto);
    }
    this.alConfirmadoConTiempos(texto, words);
  }

  /** Segunda copia del commit, con tiempos y logprob: decide si el segmento era voz de fondo y, si lo era, lo quita del turno antes de que cierre. */
  private alConfirmadoConTiempos(texto: string, words: unknown): void {
    const g = this.o.config.compuertaFondo;
    if (!g || texto === "" || !Array.isArray(words)) return;
    const ps = (words as { type?: unknown; start?: unknown; end?: unknown; logprob?: unknown }[]).filter((w) => w?.type !== "spacing" && typeof w?.start === "number" && typeof w?.end === "number");
    if (ps.length === 0) return;
    const tramas: number[] = [];
    for (const w of ps) for (let k = Math.floor((w.start as number) * 50); k <= Math.floor((w.end as number) * 50) && k < this.niveles.length; k++) tramas.push(this.niveles[k]!);
    if (tramas.length === 0) return;
    tramas.sort((a, b) => b - a);
    const alto = tramas.slice(0, Math.max(1, Math.ceil(tramas.length / 2)));
    const nivelDb = 20 * Math.log10(Math.max(1, alto.reduce((a, b) => a + b, 0) / alto.length));
    const lps = ps.map((w) => w.logprob).filter((x): x is number => typeof x === "number");
    const logprob = lps.length ? lps.reduce((a, b) => a + b, 0) / lps.length : 0;
    const ref = [...this.nivelesCliente].sort((a, b) => a - b)[Math.floor(this.nivelesCliente.length / 2)];
    const fondo = this.nivelesCliente.length >= g.segmentosMin && ref !== undefined && nivelDb < ref - g.dbBajoVoz && logprob < g.logprobMax;
    if (!fondo) {
      this.nivelesCliente.push(nivelDb);
      if (this.nivelesCliente.length > 5) this.nivelesCliente.shift();
      return;
    }
    // Se quita del turno en curso (el commit sin tiempos ya lo habia sumado).
    const c = this.confirmado;
    if (c.endsWith(texto)) this.confirmado = c.slice(0, c.length - texto.length).trim();
    if (this.confirmado === "" && this.parcial === "") this.quitarFinMin();
    this.eventos.descartado?.("voz_de_fondo");
  }

  private unir(a: string, b: string): string {
    return a === "" ? b : b === "" ? a : `${a} ${b}`;
  }

  private alParcial(texto: string): void {
    if (texto === "" || texto === this.parcial) return;
    if (!this.vozEnSegmento && this.esFondo(this.nivelReciente())) {
      // Platica de fondo: no corta al agente ni reprograma el cierre del turno (el turno del cliente cierra con lo suyo).
      if (!this.fondoAvisadoEnSegmento) this.eventos.descartado?.("parcial_fondo");
      this.fondoAvisadoEnSegmento = true;
      return;
    }
    if (this.o.config.compuertaNivel && !this.nivelApagada && this.esFondo(this.nivelReciente())) return;
    this.vozEnSegmento = true;
    if (this.confirmado === "" && this.parcial === "") this.eventos.hablaIniciada();
    this.parcial = texto;
    // El cliente sigue hablando: el cierre pendiente (ventana minima) se cancela y el turno continua.
    this.quitarFinMin();
    this.eventos.parcial(this.unir(this.confirmado, texto));
    this.reprogramarFinMax();
  }

  private alConfirmado(texto: string): void {
    if (texto !== "" && this.segmentoEsFondo()) {
      // Segmento de platica de fondo sin un solo parcial de voz: no entra al turno. Si el cliente ya tenia algo, su turno sigue su cierre normal.
      if (this.confirmado === "" && this.parcial === "") this.quitarFinMax();
      return;
    }
    this.parcial = "";
    this.quitarFinMax();
    if (texto !== "") this.confirmado = this.unir(this.confirmado, texto);
    if (this.confirmado === "") return;
    this.quitarFinMin();
    this.tFinMin = this.t.poner(() => this.cerrarTurno(), this.o.config.finTurnoMinMs);
  }

  /** Trama de 20 ms de silencio si no se mando audio en `keepAliveMs` (por omision 4 s); se reprograma sola hasta cerrar. */
  private programarKeepAlive(): void {
    const cada = this.o.keepAliveMs ?? 4_000;
    this.tKeepAlive = this.t.poner(() => {
      if (this.cerradaPorNosotros || this.caidaAvisada) return;
      if ((this.o.ahora ?? Date.now)() - this.ultimoAudio >= cada) this.enviar(new Uint8Array((this.hz / 50) * 2), false);
      this.programarKeepAlive();
    }, cada);
  }

  private reprogramarFinMax(): void {
    this.quitarFinMax();
    this.tFinMax = this.t.poner(() => {
      this.tFinMax = null;
      // Texto parcial congelado: el VAD no cerro (ruido de fondo constante). Se fuerza el commit; el `committed_transcript` cierra el turno. Si el servidor no lo
      // confirma en `COMMIT_FORZADO_MS`, se cierra con lo que hay (confirmado + parcial): el turno nunca queda abierto.
      this.enviar(new Uint8Array(0), true);
      const parcialForzado = this.parcial;
      this.tFinMax = this.t.poner(() => {
        this.tFinMax = null;
        if (this.parcial !== parcialForzado || this.parcial === "") return;
        this.confirmado = this.unir(this.confirmado, this.parcial);
        this.parcial = "";
        this.cerrarTurno();
      }, COMMIT_FORZADO_MS);
    }, this.o.config.finTurnoMaxMs);
  }

  private quitarFinMin(): void {
    if (this.tFinMin !== null) this.t.quitar(this.tFinMin);
    this.tFinMin = null;
  }

  private quitarFinMax(): void {
    if (this.tFinMax !== null) this.t.quitar(this.tFinMax);
    this.tFinMax = null;
  }

  private cerrarTurno(): void {
    this.tFinMin = null;
    const texto = this.confirmado.trim();
    this.confirmado = "";
    if (texto !== "") this.eventos.turnoFinal(texto);
  }

  private avisarCaida(codigo: string): void {
    if (this.caidaAvisada || this.cerradaPorNosotros) return;
    this.caidaAvisada = true;
    this.quitarFinMin();
    this.quitarFinMax();
    this.eventos.caido(codigo);
  }

  private enviar(pcm16: Uint8Array, commit: boolean): void {
    this.medirAudio(pcm16);
    this.medirNivel(pcm16);
    try {
      this.socket.send(JSON.stringify({ message_type: "input_audio_chunk", audio_base_64: aBase64(pcm16), commit, sample_rate: this.hz }));
    } catch {
      this.avisarCaida("stt_el_send");
    }
  }

  enviarAudio(pcm16: Uint8Array): void {
    if (this.cerradaPorNosotros || this.caidaAvisada || pcm16.byteLength === 0) return;
    this.ultimoAudio = (this.o.ahora ?? Date.now)();
    this.enviar(pcm16, false);
  }

  async cerrar(): Promise<void> {
    if (this.cerradaPorNosotros) return;
    this.cerradaPorNosotros = true;
    this.quitarFinMin();
    this.quitarFinMax();
    if (this.tKeepAlive !== null) this.t.quitar(this.tKeepAlive);
    try {
      this.socket.close(1000, "fin_de_llamada");
    } catch {
      /* ya cerrado */
    }
  }
}

/** Puerto de STT sobre ElevenLabs Scribe v2 Realtime. La llave va SOLO en la cabecera `xi-api-key` (nunca en la URL ni en logs). */
export function crearSttElevenLabs(opts: ElevenLabsSttOpciones): PuertoSttVoz {
  return {
    async abrir(opciones, eventos) {
      const crear = opts.crearSocket ?? crearSocketDeepgramGlobal;
      const socket = crear(urlSttElevenLabs(opts.config, opciones), { headers: { "xi-api-key": opts.apiKey } });
      const sesion = new SesionElevenLabsStt(socket, eventos, opts, opciones.hzEntrada, keytermsElevenLabs(opciones.vocabulario, opts.config.keytermsMax).length > 0);
      await sesion.conectar();
      return sesion;
    },
  };
}
