// Cascada v2 en STREAMING (escalon `cascada-v2`): Deepgram STT (Nova-3) -> LLM por OpenRouter (streaming) -> Deepgram Aura-2 TTS, todo por PUERTOS (`puertos.ts`).
// Implementa `VozSesionLlamada`, asi que el `ControladorLlamada` la conduce igual que a Gemini Live o a la cascada actual.
//
//   audio del cliente --> STT (WebSocket, endpointing de Deepgram) --turnoFinal--> LLM (stream de texto) --frase cerrada--> TTS (WebSocket) --> audio al cliente
//
// - Fin de turno: lo decide el endpointing del STT (ya no hay corte por energia RMS).
// - Por frase: en cuanto el LLM cierra la primera oracion se manda al TTS; el primer audio sale ANTES de que el LLM termine de escribir.
// - Barge-in: si el STT entrega texto del cliente mientras el agente piensa, habla o aun suena su audio en la linea, se aborta el LLM y el TTS en curso con un `AbortController`
//   y se avisa `interrumpido` (el worker corta la cola del puente). Un `SpeechStarted` aislado NO corta (un ruido dejaria al agente mudo): se confirma con el primer parcial no vacio.
// - Historial: lo que queda como dicho por el agente es lo que SONO (estimado por el tiempo transcurrido desde el primer audio), no todo lo generado.
// - Frases al TTS: la primera sale sola (menor latencia); las siguientes se agrupan en un solo Flush (Deepgram limita a 20 Flush por minuto); con pocos Flush disponibles todo el turno va junto.
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
import { contieneTotal, esAfirmacion } from "./afirmacion.ts";
import { ejecutarHerramientas, type EstadoEspera } from "./herramientas.ts";
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
  /** Si el modelo pide `confirmar` y `crear` en la MISMA respuesta, solo se ejecuta `confirmar`: `crear` espera la confirmacion del cliente en un turno posterior (restaurantes: confirmar_resumen / crear_pedido). */
  readonly confirmacionAntesDeCrear?: { readonly confirmar: string; readonly crear: string; readonly cotizar?: string };
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

/** Frase del LLM con la vuelta (modelo -> herramienta -> modelo) en que se escribio. */
interface FraseLlm {
  readonly frase: string;
  readonly vuelta: number;
}

/** Audio de UNA sintesis (una o varias frases agrupadas): sus frases, su peso en caracteres, cuando empieza en la linea de tiempo del turno y cuanto lleva generado. */
interface OlaAudio {
  readonly frases: string[];
  readonly chars: number[];
  readonly vuelta: number;
  readonly inicioMs: number;
  ms: number;
}

interface LineaAudio {
  /** Instante (reloj de la sesion) del primer audio entregado; null si aun no hubo. */
  t0: number | null;
  /** Duracion (ms) del audio generado del turno: hasta t0 + totalMs se asume que sigue sonando. */
  totalMs: number;
  olas: OlaAudio[];
}

/** Con tan pocos Flush disponibles el nucleo deja de mandar frases sueltas y junta el resto del turno (Deepgram: 20 por 60 s). */
const FLUSH_MINIMOS_PARA_FRASE_SUELTA = 3;

const cuentaDeCaracteres = (texto: string): number => Array.from(texto).length;

class SesionCascadaV2 implements VozSesionLlamada {
  private readonly mensajes: MensajeLlmVoz[] = [];
  private stt: SesionStt | null = null;
  private tts: SesionTts | null = null;
  private cerrada = false;
  private ocupada = false;
  private generacion = 0;
  private control: AbortController | null = null;
  private cadena: Promise<void> = Promise.resolve();
  private bytesSttPendientes = 0;
  private turnosCliente = 0;
  /** Linea de tiempo del audio del turno (la ultima respuesta): lo generado, para estimar lo que ya sono. Persiste tras terminar el turno mientras el audio siga sonando. */
  private audio: LineaAudio | null = null;
  /** Regla confirmar -> crear a nivel de sesion (ver `herramientas.ts`): se apaga cuando el cliente vuelve a hablar. */
  private readonly esperandoAlCliente: EstadoEspera = { pendiente: false, huellaOida: null, huellaCotizada: null, cotizoEnTurno: false };
  /** Vuelta (modelo -> herramienta -> modelo) en curso: solo el texto de esa vuelta se corrige al interrumpir. */
  private vueltaActual = 0;
  /** Lo que ya sono al momento de interrumpir (se fija en `interrumpir`, antes de que el reloj avance). */
  private oidasAlInterrumpir: string[] | null = null;
  /** Posicion en `mensajes` del mensaje de texto final del turno en curso (para corregirlo si se interrumpe). */
  private indiceRespuestaFinal: number | null = null;
  private readonly ahora: () => number;
  /** El STT recibio `keyterm` (vocabulario del menu): Deepgram cobra el add-on Keyterm Prompting por minuto. */
  private readonly conKeyterms: boolean;

  constructor(
    private readonly apertura: AperturaLlamada,
    private readonly h: ManejadoresSesion,
    private readonly o: Required<Pick<CascadaV2Opciones, "llm" | "config" | "vueltasToolMax">> & Pick<CascadaV2Opciones, "herramientasEnParalelo" | "confirmacionAntesDeCrear" | "modeloLlm" | "elegirModelo" | "log" | "ahora">,
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

  /** El audio del agente sigue sonando en la linea (estimado: tiempo transcurrido desde el primer audio contra la duracion de lo generado). */
  private reproduciendo(): boolean {
    const a = this.audio;
    return a !== null && a.t0 !== null && this.ahora() < a.t0 + a.totalMs;
  }

  interrumpir(): void {
    if (this.cerrada) return;
    const enCurso = this.ocupada;
    if (!enCurso && !this.reproduciendo()) return;
    // Lo que ya sono se fija AHORA: despues el reloj sigue avanzando.
    this.oidasAlInterrumpir = this.oidasAhora();
    // Interrumpir una lectura que aun suena: el cliente puede no haber oido el resumen completo; el siguiente «si» no cuenta como respuesta al resumen (se lee de nuevo).
    this.esperandoAlCliente.huellaOida = null;
    if (enCurso) {
      this.generacion += 1;
      this.control?.abort();
      this.ocupada = false;
    } else {
      // El turno ya termino pero su audio aun suena: se corrige el historial de inmediato y se corta la cola del puente (`interrumpido`).
      this.registrarInterrupcion();
    }
    if (this.audio) this.audio.totalMs = 0;
    this.h.interrumpido();
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
    // `SpeechStarted` solo avisa que hay energia de voz: un ruido (puerta, cocina) sin texto NO debe cortar al agente ni dejarlo mudo. El corte se confirma con el primer
    // parcial no vacio (`alParcial`), unos 200-300 ms despues.
  }

  private alParcial(texto: string): void {
    if (texto.trim() !== "") this.interrumpir();
  }

  private alTurnoFinal(texto: string): void {
    if (this.cerrada || texto.trim() === "") return;
    this.interrumpir();
    this.esperandoAlCliente.pendiente = false; // el cliente respondio: ya puede crearse el pedido
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
    this.audio = null;
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
      // El puerto marca `motivo: "sin_zdr"` cuando el cuerpo del 404 dice que no hay endpoint con retencion cero (falla claro, nunca cae a uno que retenga). Un 404 por otra causa
      // (parametro no admitido, modelo inexistente) sube como `v2_llm_404`.
      const motivo = (err as { motivo?: unknown } | null)?.motivo;
      const detalle = motivo === "sin_zdr" ? "sin_zdr" : typeof status === "number" && Number.isInteger(status) ? status : undefined;
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
    this.audio = { t0: null, totalMs: 0, olas: [] };
    this.oidasAlInterrumpir = null;
    this.indiceRespuestaFinal = null;
    this.vueltaActual = 0;
    this.turnosCliente += 1;
    this.mensajes.push({ role: "user", content: texto });
    this.esperandoAlCliente.cotizoEnTurno = false;
    this.esperandoAlCliente.huellaCotizada = null;
    this.esperandoAlCliente.totalCotizado = null;
    this.esperandoAlCliente.habladoTrasCotizar = "";
    // El codigo interpreta el turno del cliente: solo una afirmacion («si», «ok», «correcto»...) cuenta como confirmacion del resumen.
    this.esperandoAlCliente.afirmacion = esAfirmacion(texto);
    let habladoTurno = "";

    const cola = new ColaAsync<FraseLlm>();
    const empujar = (f: FraseLlm): void => {
      if (f.frase.trim() !== "") habladoTurno += ` ${f.frase}`;
      if (this.esperandoAlCliente.cotizoEnTurno === true && f.frase.trim() !== "") this.esperandoAlCliente.habladoTrasCotizar = `${this.esperandoAlCliente.habladoTrasCotizar ?? ""} ${f.frase}`;
      cola.push(f);
    };
    let fallaTts: unknown = null;
    const bombeo = this.bombearFrases(cola, senal, vigente).catch((err: unknown) => {
      // El TTS se cayo: se detiene tambien el LLM (no tiene caso seguir escribiendo una respuesta que nadie puede decir).
      fallaTts = err;
      control.abort();
    });
    const cfg = this.o.config.cascadaV2;
    let errorLlm: unknown = null;
    try {
      let vuelta = 0;
      let vacios = 0;
      while (vuelta <= this.o.vueltasToolMax) {
        this.vueltaActual = vuelta;
        const segmentador = crearSegmentadorFrases(cfg.frase);
        const frasesRonda: string[] = [];
        const modelo = this.modeloDelTurno(vuelta);
        const t0 = this.ahora();
        let ttft: number | null = null;
        const r = await this.completar(modelo, senal, (delta) => {
          if (ttft === null) ttft = this.ahora() - t0;
          for (const f of segmentador.agregar(delta)) {
            frasesRonda.push(f);
            empujar({ frase: f, vuelta });
          }
        });
        // El costo se registra SIEMPRE que el proveedor lo reporto, aunque el cliente haya interrumpido mientras tanto (una llamada abortada antes de terminar no trae uso).
        this.registrarLlm(r, modelo, ttft, this.ahora() - t0);
        if (!vigente()) break;
        const truncada = r.finishReason === "length" && r.toolCalls.length === 0 && r.texto.trim() !== "";
        // Una respuesta cortada por el tope de tokens termina a media oracion: ese fragmento NO se dice; se cierra con una frase de respaldo.
        const resto = truncada ? (segmentador.vaciar(), null) : segmentador.vaciar();
        if (resto !== null) empujar({ frase: resto, vuelta });
        if (truncada) {
          this.log("v2_respuesta_cortada", { proveedor: modelo, motivo: "length" });
          empujar({ frase: cfg.llm.fraseCorte, vuelta });
          this.mensajes.push({ role: "assistant", content: [...frasesRonda, cfg.llm.fraseCorte].join(" ") });
          this.indiceRespuestaFinal = this.mensajes.length - 1;
          break;
        }
        const sinTexto = r.texto.trim() === "" && resto === null;
        if (sinTexto && r.toolCalls.length === 0) {
          // Respuesta vacia (p. ej. el razonamiento agoto el tope: finish_reason "length"): un reintento; si vuelve vacia, una frase de respaldo. Nunca silencio.
          this.log("v2_respuesta_vacia", { proveedor: modelo, motivo: r.finishReason ?? "desconocido" });
          if (vacios < 1) {
            vacios += 1;
            continue;
          }
          empujar({ frase: cfg.llm.fraseRespaldo, vuelta });
          this.mensajes.push({ role: "assistant", content: cfg.llm.fraseRespaldo });
          this.indiceRespuestaFinal = this.mensajes.length - 1;
          break;
        }
        this.mensajes.push({ role: "assistant", content: r.texto, ...(r.toolCalls.length ? { toolCalls: r.toolCalls } : {}) });
        if (r.toolCalls.length === 0) {
          this.indiceRespuestaFinal = this.mensajes.length - 1;
          break;
        }
        // El historial queda consistente aunque el cliente interrumpa a media herramienta: SIEMPRE se anotan las respuestas de las herramientas pedidas
        // (las que no llegaron a correr por la interrupcion o por esperar la confirmacion del cliente llevan un error explicito).
        const resultados = await ejecutarHerramientas(r.toolCalls, (l) => this.h.ejecutarTool(l), {
          ...(this.o.herramientasEnParalelo ? { enParalelo: this.o.herramientasEnParalelo } : {}),
          ...(this.o.confirmacionAntesDeCrear ? { confirmacionAntesDeCrear: this.o.confirmacionAntesDeCrear } : {}),
          continuar: vigente,
          esperandoAlCliente: this.esperandoAlCliente,
          log: (evento, campos) => this.log(evento, campos ?? {}),
        });
        for (const res of resultados) this.mensajes.push({ role: "tool", toolCallId: res.llamada.id, content: JSON.stringify(res.salida ?? null) });
        if (!vigente()) break;
        vuelta += 1;
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
      // El agente termino de hablar tras cotizar y nadie lo interrumpio: ese resumen ya se le leyo al cliente (el «si» siguiente responde a EL).
      // «Resumen leido» exige que lo dicho DESDE la ultima cotizacion incluya el TOTAL (cifra o palabras). Sin total conocido (la herramienta no lo trajo) la compuerta NO se abre
      // (evento v2_total_desconocido): nunca se adivina con un minimo de palabras. Un «un momento, consulto» no cuenta.
      const e = this.esperandoAlCliente;
      const total = e.totalCotizado ?? null;
      const hablado = e.habladoTrasCotizar ?? "";
      if (e.cotizoEnTurno === true && e.huellaCotizada && hablado.trim() !== "") {
        if (total !== null && contieneTotal(hablado, total)) {
          e.huellaOida = e.huellaCotizada;
          e.totalOido = total;
        } else this.log("v2_resumen_sin_total", { motivo: "sin_total", ok: false });
      } else if (e.cotizoEnTurno !== true && habladoTurno.trim() !== "" && (e.huellaUltima ?? null) !== null) {
        // El agente hablo en un turno sin re-cotizar (pregunta intermedia, aclaracion): el resumen cuenta como leido SOLO si repitio el total vigente; si no, el siguiente «si»
        // ya no responde a un resumen leido. Lo hecho al reves (releer el total tras una pregunta) lo vuelve a abrir.
        const relee = e.totalUltimo !== null && e.totalUltimo !== undefined && contieneTotal(habladoTurno, e.totalUltimo);
        if (relee) {
          e.huellaOida = e.huellaUltima ?? null;
          e.totalOido = e.totalUltimo ?? null;
        } else if ((e.huellaOida ?? null) !== null) {
          e.huellaOida = null;
          this.log("v2_resumen_olvidado", { motivo: "sin_releer_total", ok: false });
        }
      }
      this.h.agenteTermino();
    } finally {
      if (this.generacion === mia) this.ocupada = false;
    }
  }

  /** Registra el uso del turno del LLM: costo por componente (real solo si el proveedor lo reporto) y, sin texto, el modelo, los tokens y la lectura de cache. */
  private registrarLlm(r: RespuestaLlmVoz, modelo: string, ttftMs: number | null, ms: number): void {
    this.h.costo?.(r.costoMicroUsd, r.costoReal === true, { proveedor: `openrouter:${modelo}`, unidad: "unidad", cantidad: 1 });
    this.log("v2_llm", {
      proveedor: modelo,
      ms,
      ...(ttftMs !== null ? { ttftMs: Math.round(ttftMs) } : {}),
      ...(typeof r.tokensEntrada === "number" ? { tokensEntrada: r.tokensEntrada } : {}),
      ...(typeof r.tokensSalida === "number" ? { tokensSalida: r.tokensSalida } : {}),
      ...(typeof r.tokensCache === "number" ? { tokensCache: r.tokensCache } : {}),
      ...(r.finishReason ? { motivo: r.finishReason } : {}),
    });
  }

  /** Frases (de la vuelta pedida) cuyo audio YA empezo a sonar, estimado por el tiempo desde el primer audio: el audio se genera mas rapido que en tiempo real y el puente lo encola. */
  private oidasAhora(vuelta: number = this.vueltaActual): string[] {
    const a = this.audio;
    if (!a || a.t0 === null) return [];
    const transcurrido = this.ahora() - a.t0;
    const oidas: string[] = [];
    for (const ola of a.olas) {
      if (ola.vuelta !== vuelta) continue;
      const total = ola.chars.reduce((n, c) => n + c, 0) || 1;
      let antes = 0;
      ola.frases.forEach((f, i) => {
        const inicio = ola.inicioMs + ola.ms * (antes / total);
        antes += ola.chars[i] ?? 0;
        if (inicio <= transcurrido) oidas.push(f);
      });
    }
    return oidas;
  }

  /** El turno se interrumpio: el historial debe reflejar lo que el cliente SI oyo, no lo que el modelo alcanzo a escribir ni lo que el TTS alcanzo a generar. */
  private registrarInterrupcion(): void {
    const dicho = (this.oidasAlInterrumpir ?? this.oidasAhora()).join(" ").trim();
    const i = this.indiceRespuestaFinal;
    if (i !== null && this.mensajes[i]?.role === "assistant") {
      if (dicho === "") this.mensajes.splice(i, 1);
      else this.mensajes[i] = { role: "assistant", content: dicho };
    } else if (dicho !== "") {
      // El LLM no alcanzo a terminar la vuelta: queda lo que ya se dijo en voz alta EN ESA vuelta (el texto de las anteriores ya esta en su mensaje).
      this.mensajes.push({ role: "assistant", content: dicho });
    }
    this.indiceRespuestaFinal = null;
    this.oidasAlInterrumpir = null;
  }

  /** Consume las frases del LLM y las sintetiza, entregando el audio conforme llega. La primera frase sale sola; las siguientes se agrupan en una sola sintesis (un Flush). Lanza si el TTS falla. */
  private async bombearFrases(cola: ColaAsync<FraseLlm>, senal: AbortSignal, vigente: () => boolean): Promise<void> {
    const tts = this.tts;
    const turnoAudio = this.audio;
    const hz = this.o.config.cascadaV2.deepgramAura2.hzSalida;
    let primera = true;
    const t0 = this.ahora();
    for (;;) {
      const primero = await cola.siguiente();
      if (primero === null || !vigente() || senal.aborted || !tts || !turnoAudio) return;
      const lote: FraseLlm[] = [primero];
      const pocosFlush = typeof tts.flushesDisponibles === "function" && tts.flushesDisponibles() <= FLUSH_MINIMOS_PARA_FRASE_SUELTA;
      if (pocosFlush) {
        // Cerca del limite de Flush: todo lo que falta del turno va en UNA sintesis (degrada la latencia, no cae el escalon).
        for (let f = await cola.siguiente(); f !== null; f = await cola.siguiente()) lote.push(f);
      } else if (!primera) {
        lote.push(...cola.tomarDisponibles());
      }
      if (!vigente() || senal.aborted) return;
      const texto = lote.map((l) => l.frase).join(" ");
      // Deepgram factura por caracteres enviados: se anota al mandar el texto.
      const caracteres = cuentaDeCaracteres(texto);
      this.h.costo?.(costoDeepgramAura2MicroUsd(caracteres, this.o.config), false, { proveedor: "deepgram-aura-2", unidad: "unidad", cantidad: caracteres });
      const ola: OlaAudio = { frases: lote.map((l) => l.frase), chars: lote.map((l) => cuentaDeCaracteres(l.frase)), vuelta: lote[lote.length - 1]!.vuelta, inicioMs: turnoAudio.totalMs, ms: 0 };
      let empezo = false;
      try {
        for await (const pcm of tts.sintetizar(texto, senal)) {
          if (!vigente() || senal.aborted) return;
          if (!empezo) {
            empezo = true;
            turnoAudio.olas.push(ola);
            turnoAudio.t0 ??= this.ahora();
            if (primera) {
              primera = false;
              this.log("v2_primer_audio", { ms: this.ahora() - t0 });
            }
            this.h.agenteDijo(`${texto} `);
          }
          ola.ms += (pcm.byteLength / 2 / hz) * 1000;
          turnoAudio.totalMs = ola.inicioMs + ola.ms;
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
      { llm: opts.llm, config, vueltasToolMax: opts.vueltasToolMax ?? 4, ...(opts.herramientasEnParalelo ? { herramientasEnParalelo: opts.herramientasEnParalelo } : {}), ...(opts.confirmacionAntesDeCrear ? { confirmacionAntesDeCrear: opts.confirmacionAntesDeCrear } : {}), ...(opts.modeloLlm ? { modeloLlm: opts.modeloLlm } : {}), ...(opts.elegirModelo ? { elegirModelo: opts.elegirModelo } : {}), ...(opts.log ? { log: opts.log } : {}), ...(opts.ahora ? { ahora: opts.ahora } : {}) },
      voz,
    );
    await sesion.iniciar(stt, tts);
    ultima = sesion;
    return sesion;
  };
  return { abrirSesion, inactivo: () => ultima?.inactivo() ?? Promise.resolve() };
}
