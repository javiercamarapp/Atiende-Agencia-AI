// Cascada v2 en STREAMING (escalon `cascada-v2`): Deepgram STT (Nova-3) -> LLM por OpenRouter (streaming) -> Deepgram Aura-2 TTS, todo por PUERTOS (`puertos.ts`).
// Implementa `VozSesionLlamada`, asi que el `ControladorLlamada` la conduce igual que a Gemini Live o a la cascada actual.
//
//   audio del cliente --> STT (WebSocket, endpointing de Deepgram) --turnoFinal--> LLM (stream de texto) --frase cerrada--> TTS (WebSocket) --> audio al cliente
//
// - Fin de turno: lo decide el endpointing del STT (ya no hay corte por energia RMS).
// - Por frase: en cuanto el LLM cierra la primera oracion se manda al TTS; el primer audio sale ANTES de que el LLM termine de escribir.
// - Barge-in: si el STT detecta voz (o texto) del cliente mientras el agente habla o piensa, se aborta el LLM y el TTS en curso con un `AbortController`.
// - Herramientas: mismo registro y misma regla de la sesion de Gemini (`herramientas.ts`).
// - Errores: cualquier etapa que se cae sube `h.caido("v2_<etapa>[_<estado>]")` (codigo corto, sin PII); la escalera pasa al siguiente escalon con el resumen redactado.
// - Costo por COMPONENTE: `deepgram` (segundos de audio), `deepgram-aura-2` (caracteres), `openrouter:<modelo>` (costo real de OpenRouter).
//
// ESTADO DE VERIFICACION (honesto): se prueba contra WebSockets y un LLM FALSOS; no hay llave de Deepgram en este entorno. Ver `scripts/voz-cascada-v2-smoke/`.
import { VOZ_PLATAFORMA, costoDeepgramAura2MicroUsd, costoDeepgramMicroUsd } from "../../config-plataforma.ts";
import type { ConfigPlataformaVoz } from "../../config-plataforma.ts";
import { VozNoConfiguradaError, VozProveedorError } from "../../provider.ts";
import type { MensajeLlmVoz, PuertoLlmVoz, RespuestaLlmVoz } from "../cascada-openrouter.ts";
import { eventoSinPII } from "../log-sin-pii.ts";
import type { SumideroLog } from "../log-sin-pii.ts";
import type { AbrirSesionLlamada, AperturaLlamada, ManejadoresSesion, VozSesionLlamada } from "../sesion.ts";
import { crearSegmentadorFrases } from "./frases.ts";
import { ejecutarHerramientas } from "./herramientas.ts";
import { ColaAsync } from "./puertos.ts";
import type { ContextoTurnoLlm, PuertoSttVoz, PuertoTtsVoz, SesionStt, SesionTts } from "./puertos.ts";
import { crearSttDeepgram, keytermsDe } from "./deepgram-stt.ts";
import { crearTtsDeepgram, resolverVozAura2 } from "./deepgram-tts.ts";
import type { CrearSocketDeepgram } from "./socket.ts";

export interface CascadaV2Opciones {
  /** `DEEPGRAM_API_KEY`: UNA sola llave para STT y TTS. Sin ella (y sin puertos inyectados) el escalon se salta con `VozNoConfiguradaError`. */
  readonly deepgramApiKey: string | null;
  /** Puerto del LLM en streaming (en produccion `crearPuertoLlmVozV2` del worker, sobre OpenRouter). */
  readonly llm: PuertoLlmVoz;
  readonly config?: ConfigPlataformaVoz;
  /** Puertos alternativos (pruebas, o otro proveedor): por omision Deepgram. */
  readonly stt?: PuertoSttVoz;
  readonly tts?: PuertoTtsVoz;
  readonly crearSocket?: CrearSocketDeepgram;
  /** Herramientas de solo lectura que pueden correr en paralelo al inicio de un turno (el resto, en serie). */
  readonly herramientasEnParalelo?: ReadonlySet<string>;
  /** Tope de vueltas modelo -> herramienta -> modelo dentro de un turno. */
  readonly vueltasToolMax?: number;
  /** Modelo del LLM por omision (de lo contrario `config.cascadaV2.llm.modelo`). */
  readonly modeloLlm?: string;
  /** Gancho para elegir el modelo POR TURNO (P3 lo usara para escalar entre modelos). Devuelve `undefined` para usar el modelo por omision. */
  readonly elegirModelo?: (contexto: ContextoTurnoLlm) => string | undefined;
  readonly log?: SumideroLog;
  /** Reloj (ms) para medir latencias; por omision `Date.now`. */
  readonly ahora?: () => number;
}

class ErrorEtapa extends Error {
  constructor(readonly etapa: "stt" | "llm" | "tts", readonly detalle?: string | number) {
    super(`v2_${etapa}${detalle !== undefined ? `_${detalle}` : ""}`);
  }
}

const CODIGO_RE = /^[a-z0-9_]{1,40}$/;

/** Codigo corto y sin PII para `h.caido`: nunca el mensaje del proveedor. */
function codigoDeError(err: unknown, etapa: "stt" | "llm" | "tts"): string {
  if (err instanceof ErrorEtapa) return err.message;
  const status = (err as { status?: unknown } | null)?.status;
  if (typeof status === "number" && Number.isInteger(status)) return `v2_${etapa}_${status}`;
  const mensaje = err instanceof Error ? err.message : "";
  // Los adaptadores de Deepgram lanzan codigos cortos (`tts_ws_1006`, `tts_flush_limite`): se conservan si tienen la forma esperada.
  if (CODIGO_RE.test(mensaje)) return `v2_${mensaje.startsWith(`${etapa}_`) || mensaje === etapa ? mensaje : `${etapa}_${mensaje}`}`.slice(0, 48);
  return `v2_${etapa}`;
}

const cuentaDeCaracteres = (texto: string): number => Array.from(texto).length;

class SesionCascadaV2 implements VozSesionLlamada {
  private readonly mensajes: MensajeLlmVoz[] = [];
  private stt: SesionStt | null = null;
  private tts: SesionTts | null = null;
  private cerrada = false;
  private ocupada = false;
  /** El agente esta emitiendo audio (ya salio el primer trozo y el turno sigue vigente). */
  private hablando = false;
  private generacion = 0;
  private control: AbortController | null = null;
  private cadena: Promise<void> = Promise.resolve();
  private bytesSttPendientes = 0;
  private turnosCliente = 0;
  /** Frases del turno en curso cuyo audio ya empezo a sonar (lo que el cliente oyo). */
  private oidas: string[] = [];
  /** Posicion en `mensajes` del mensaje de texto final del turno en curso (para corregirlo si se interrumpe). */
  private indiceRespuestaFinal: number | null = null;
  private readonly ahora: () => number;
  /** El STT recibio `keyterm` (vocabulario del menu): Deepgram cobra el add-on Keyterm Prompting por minuto. */
  private readonly conKeyterms: boolean;

  constructor(
    private readonly apertura: AperturaLlamada,
    private readonly h: ManejadoresSesion,
    private readonly o: Required<Pick<CascadaV2Opciones, "llm" | "config" | "vueltasToolMax">> & Pick<CascadaV2Opciones, "herramientasEnParalelo" | "modeloLlm" | "elegirModelo" | "log" | "ahora">,
    readonly vozTts: string,
  ) {
    this.ahora = o.ahora ?? Date.now;
    this.conKeyterms = keytermsDe(apertura.vocabulario, o.config.cascadaV2.deepgram.keytermsMax).length > 0;
  }

  /** Abre STT y TTS en paralelo; si uno falla cierra el otro y propaga el error (el escalon se salta o la escalera pasa al siguiente). */
  async iniciar(stt: PuertoSttVoz, tts: PuertoTtsVoz): Promise<void> {
    const c = this.o.config.cascadaV2;
    const [rs, rt] = await Promise.allSettled([
      stt.abrir(
        { hzEntrada: c.deepgram.hzEntrada, ...(this.apertura.vocabulario ? { vocabulario: this.apertura.vocabulario } : {}) },
        {
          hablaIniciada: () => this.alHablaCliente(),
          parcial: (texto) => this.alParcial(texto),
          turnoFinal: (texto) => this.alTurnoFinal(texto),
          caido: (codigo) => this.falla(new ErrorEtapa("stt", codigo.replace(/^stt_/, ""))),
        },
      ),
      tts.abrir({ voz: this.vozTts, hzSalida: c.deepgramAura2.hzSalida }),
    ]);
    if (rs.status === "fulfilled") this.stt = rs.value;
    if (rt.status === "fulfilled") this.tts = rt.value;
    const rechazo = rs.status === "rejected" ? rs.reason : rt.status === "rejected" ? rt.reason : null;
    if (rechazo !== null) {
      await this.liberar();
      if (rechazo instanceof VozNoConfiguradaError || rechazo instanceof VozProveedorError) throw rechazo;
      throw new VozProveedorError("No se pudo abrir la cascada v2.");
    }
  }

  // ---- entrada ----

  enviarTexto(texto: string): void {
    if (this.cerrada) return;
    this.encolar(() => this.turno(texto));
  }

  enviarAudio(pcm16: Uint8Array): void {
    if (this.cerrada || pcm16.byteLength === 0 || !this.stt) return;
    this.bytesSttPendientes += pcm16.byteLength;
    this.stt.enviarAudio(pcm16);
  }

  interrumpir(): void {
    if (this.cerrada) return;
    const estaba = this.ocupada;
    this.generacion += 1;
    this.control?.abort();
    this.hablando = false;
    this.ocupada = false;
    if (estaba) this.h.interrumpido();
  }

  async cerrar(): Promise<void> {
    if (this.cerrada) return;
    this.cerrada = true;
    this.generacion += 1;
    this.control?.abort();
    this.reportarSegundosStt();
    await this.liberar();
  }

  /** Espera a que termine lo que esta en curso (pruebas y simulador). */
  inactivo(): Promise<void> {
    return this.cadena;
  }

  // ---- eventos del STT ----

  private alHablaCliente(): void {
    // El cliente empezo a hablar encima del agente: se calla de inmediato. Si el agente solo estaba pensando, se espera al texto (un ruido no debe dejarlo mudo).
    if (this.hablando) this.interrumpir();
  }

  private alParcial(texto: string): void {
    if (this.ocupada && texto.trim() !== "") this.interrumpir();
  }

  private alTurnoFinal(texto: string): void {
    if (this.cerrada || texto.trim() === "") return;
    if (this.ocupada) this.interrumpir();
    this.reportarSegundosStt();
    this.h.usuarioDijo?.(texto);
    this.encolar(() => this.turno(texto));
  }

  // ---- costo ----

  private reportarSegundosStt(): void {
    const bytes = this.bytesSttPendientes;
    if (bytes <= 0) return;
    this.bytesSttPendientes = 0;
    const c = this.o.config.cascadaV2;
    const segundos = bytes / 2 / c.deepgram.hzEntrada;
    this.h.costo?.(costoDeepgramMicroUsd(segundos, this.o.config, this.conKeyterms), false, { proveedor: "deepgram", unidad: "segundo", cantidad: segundos });
  }

  // ---- internos ----

  private encolar(fn: () => Promise<void>): void {
    this.cadena = this.cadena.then(fn).catch(() => undefined);
  }

  private log(evento: string, campos: Record<string, unknown> = {}): void {
    if (this.o.log) eventoSinPII(this.o.log, evento, campos);
  }

  private async liberar(): Promise<void> {
    const stt = this.stt;
    const tts = this.tts;
    this.stt = null;
    this.tts = null;
    await Promise.allSettled([stt?.cerrar(), tts?.cerrar()]);
  }

  private falla(err: unknown, etapa: "stt" | "llm" | "tts" = "stt"): void {
    if (this.cerrada) return;
    const codigo = codigoDeError(err, etapa);
    this.cerrada = true;
    this.generacion += 1;
    this.control?.abort();
    this.reportarSegundosStt();
    this.log("v2_caida", { codigo });
    // Se cierran los sockets: el STT factura por segundo de audio enviado y no debe quedar abierto tras la caida.
    void this.liberar();
    this.h.caido(codigo, null);
  }

  private modeloDelTurno(vuelta: number): string {
    const porDefecto = this.o.modeloLlm ?? this.o.config.cascadaV2.llm.modelo;
    const elegido = this.o.elegirModelo?.({ turno: this.turnosCliente, vuelta, modeloPorDefecto: porDefecto });
    return typeof elegido === "string" && elegido.trim() !== "" ? elegido : porDefecto;
  }

  private async completar(modelo: string, senal: AbortSignal, alTexto: (delta: string) => void): Promise<RespuestaLlmVoz> {
    try {
      return await this.o.llm.completar({
        system: this.apertura.instruccion,
        mensajes: this.mensajes,
        herramientas: this.apertura.herramientas,
        modeloPreferido: modelo,
        esfuerzo: this.o.config.cascadaV2.llm.esfuerzo,
        onTextDelta: alTexto,
        senal,
      });
    } catch (err) {
      if (senal.aborted) throw err;
      const status = (err as { status?: unknown } | null)?.status;
      // Con `provider.zdr = true`, un 404 de OpenRouter ("No endpoints found") significa que no hay endpoint con retencion cero para el modelo: falla claro, nunca cae a uno que retenga.
      const detalle = status === 404 ? "sin_zdr" : typeof status === "number" && Number.isInteger(status) ? status : undefined;
      throw new ErrorEtapa("llm", detalle);
    }
  }

  /** Un turno completo: LLM en streaming (con herramientas) -> frases -> TTS. `texto` = lo que dijo el cliente (ya transcrito) o el disparador del saludo. */
  private async turno(texto: string): Promise<void> {
    if (this.cerrada) return;
    const mia = ++this.generacion;
    const vigente = (): boolean => !this.cerrada && this.generacion === mia;
    const control = new AbortController();
    this.control = control;
    const senal = control.signal;
    this.ocupada = true;
    this.hablando = false;
    this.oidas = [];
    this.indiceRespuestaFinal = null;
    this.turnosCliente += 1;
    this.mensajes.push({ role: "user", content: texto });

    const cola = new ColaAsync<string>();
    let fallaTts: unknown = null;
    const bombeo = this.bombearFrases(cola, senal, vigente).catch((err: unknown) => {
      // El TTS se cayo: se detiene tambien el LLM (no tiene caso seguir escribiendo una respuesta que nadie puede decir).
      fallaTts = err;
      control.abort();
    });
    let errorLlm: unknown = null;
    try {
      for (let vuelta = 0; vuelta <= this.o.vueltasToolMax; vuelta++) {
        const segmentador = crearSegmentadorFrases(this.o.config.cascadaV2.frase);
        const modelo = this.modeloDelTurno(vuelta);
        const t0 = this.ahora();
        let ttft: number | null = null;
        const r = await this.completar(modelo, senal, (delta) => {
          if (ttft === null) ttft = this.ahora() - t0;
          for (const f of segmentador.agregar(delta)) cola.push(f);
        });
        if (!vigente()) break;
        const resto = segmentador.vaciar();
        if (resto !== null) cola.push(resto);
        this.registrarLlm(r, modelo, ttft, this.ahora() - t0);
        this.mensajes.push({ role: "assistant", content: r.texto, ...(r.toolCalls.length ? { toolCalls: r.toolCalls } : {}) });
        if (r.toolCalls.length === 0) {
          this.indiceRespuestaFinal = this.mensajes.length - 1;
          break;
        }
        // El historial queda consistente aunque el cliente interrumpa a media herramienta: SIEMPRE se anotan las respuestas de las herramientas pedidas.
        const resultados = await ejecutarHerramientas(r.toolCalls, (l) => this.h.ejecutarTool(l), this.o.herramientasEnParalelo);
        for (const res of resultados) this.mensajes.push({ role: "tool", toolCallId: res.llamada.id, content: JSON.stringify(res.salida ?? null) });
        if (!vigente()) break;
      }
    } catch (err) {
      errorLlm = err;
    }
    cola.cerrar();
    await bombeo;

    try {
      if (!vigente()) {
        this.registrarInterrupcion();
        return;
      }
      if (fallaTts !== null) {
        this.falla(fallaTts, "tts");
        return;
      }
      if (errorLlm !== null) {
        if (senal.aborted) {
          this.registrarInterrupcion();
          return;
        }
        this.falla(errorLlm, "llm");
        return;
      }
      this.hablando = false;
      this.h.agenteTermino();
    } finally {
      if (this.generacion === mia) {
        this.ocupada = false;
        this.hablando = false;
      }
    }
  }

  /** Registra el uso del turno del LLM: costo por componente y, sin texto, el modelo, los tokens y la lectura de cache (para verificar el cache del system prompt). */
  private registrarLlm(r: RespuestaLlmVoz, modelo: string, ttftMs: number | null, ms: number): void {
    this.h.costo?.(r.costoMicroUsd, r.costoReal === true, { proveedor: `openrouter:${modelo}`, unidad: "unidad", cantidad: 1 });
    this.log("v2_llm", {
      proveedor: modelo,
      ms,
      ...(ttftMs !== null ? { ttftMs: Math.round(ttftMs) } : {}),
      ...(typeof r.tokensEntrada === "number" ? { tokensEntrada: r.tokensEntrada } : {}),
      ...(typeof r.tokensSalida === "number" ? { tokensSalida: r.tokensSalida } : {}),
      ...(typeof r.tokensCache === "number" ? { tokensCache: r.tokensCache } : {}),
    });
  }

  /** El turno se interrumpio: el historial debe reflejar lo que el cliente SI oyo, no lo que el modelo alcanzo a escribir. */
  private registrarInterrupcion(): void {
    const dicho = this.oidas.join(" ").trim();
    const i = this.indiceRespuestaFinal;
    if (i !== null && this.mensajes[i]?.role === "assistant") {
      if (dicho === "") this.mensajes.splice(i, 1);
      else this.mensajes[i] = { role: "assistant", content: dicho };
    } else if (dicho !== "") {
      // El LLM no alcanzo a terminar: queda lo que ya se dijo en voz alta.
      this.mensajes.push({ role: "assistant", content: dicho });
    }
    this.indiceRespuestaFinal = null;
  }

  /** Consume las frases del LLM y las sintetiza de una en una, entregando el audio conforme llega. Lanza si el TTS falla. */
  private async bombearFrases(cola: ColaAsync<string>, senal: AbortSignal, vigente: () => boolean): Promise<void> {
    const tts = this.tts;
    let primera = true;
    const t0 = this.ahora();
    for (;;) {
      const frase = await cola.siguiente();
      if (frase === null || !vigente() || senal.aborted || !tts) return;
      // Deepgram factura por caracteres enviados: se anota al mandar la frase.
      const caracteres = cuentaDeCaracteres(frase);
      this.h.costo?.(costoDeepgramAura2MicroUsd(caracteres, this.o.config), false, { proveedor: "deepgram-aura-2", unidad: "unidad", cantidad: caracteres });
      let empezo = false;
      try {
        for await (const pcm of tts.sintetizar(frase, senal)) {
          if (!vigente() || senal.aborted) return;
          if (!empezo) {
            empezo = true;
            this.hablando = true;
            this.oidas.push(frase);
            if (primera) {
              primera = false;
              this.log("v2_primer_audio", { ms: this.ahora() - t0 });
            }
            this.h.agenteDijo(`${frase} `);
          }
          this.h.audioAgente?.(pcm);
        }
      } catch (err) {
        if (senal.aborted || !vigente()) return;
        throw new ErrorEtapa("tts", err instanceof Error && CODIGO_RE.test(err.message) ? err.message.replace(/^tts_/, "") : undefined);
      }
    }
  }
}

export interface ProveedorCascadaV2Llamada {
  readonly abrirSesion: AbrirSesionLlamada;
  inactivo(): Promise<void>;
}

/** Fabrica de sesiones de la cascada v2. Sin `DEEPGRAM_API_KEY` (y sin puertos inyectados) lanza `VozNoConfiguradaError`: el escalon se salta, nunca finge. */
export function crearProveedorCascadaV2(opts: CascadaV2Opciones): ProveedorCascadaV2Llamada {
  let ultima: SesionCascadaV2 | null = null;
  const abrirSesion: AbrirSesionLlamada = async (apertura, manejadores) => {
    const config = opts.config ?? VOZ_PLATAFORMA;
    const llave = opts.deepgramApiKey?.trim() ?? "";
    let stt = opts.stt;
    let tts = opts.tts;
    if (!stt || !tts) {
      if (llave === "") throw new VozNoConfiguradaError("Voz no configurada: falta DEEPGRAM_API_KEY para la cascada v2.");
      const comunes = { apiKey: llave, ...(opts.crearSocket ? { crearSocket: opts.crearSocket } : {}), ...(opts.ahora ? { ahora: opts.ahora } : {}) };
      stt ??= crearSttDeepgram({ ...comunes, config: config.cascadaV2.deepgram });
      tts ??= crearTtsDeepgram({ ...comunes, config: config.cascadaV2.deepgramAura2 });
    }
    const voz = resolverVozAura2(apertura.voiceId, config.cascadaV2.deepgramAura2.voz);
    const sesion = new SesionCascadaV2(
      apertura,
      manejadores,
      { llm: opts.llm, config, vueltasToolMax: opts.vueltasToolMax ?? 4, ...(opts.herramientasEnParalelo ? { herramientasEnParalelo: opts.herramientasEnParalelo } : {}), ...(opts.modeloLlm ? { modeloLlm: opts.modeloLlm } : {}), ...(opts.elegirModelo ? { elegirModelo: opts.elegirModelo } : {}), ...(opts.log ? { log: opts.log } : {}), ...(opts.ahora ? { ahora: opts.ahora } : {}) },
      voz,
    );
    await sesion.iniciar(stt, tts);
    ultima = sesion;
    return sesion;
  };
  return { abrirSesion, inactivo: () => ultima?.inactivo() ?? Promise.resolve() };
}
