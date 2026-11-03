// Cliente del endpoint `voz-turno` (Edge Function del repo suelto atiende-restaurantes): el CEREBRO de la llamada cuando `VOZ_CEREBRO=suelto`.
// El worker NO piensa ni corre herramientas: manda lo que dijo el cliente y habla lo que regresa el servidor. Contrato: CONTRATO-HERRAMIENTAS.md y RUNBOOK-VOZ.md del repo suelto.
//
//   POST {call_id, telefono, texto, seq, aviso_dado?}  +  header x-voz-turno-secret   (`aviso_dado: true` solo en la apertura con numero oculto: el worker ya dijo el aviso)
//   apertura = seq 0 con texto vacio; turnos = seq 1..n; `[silencio]` cuando el cliente no habla; respuesta {texto, pedido_id, fin, turno, seq_ultimo?}
//
// Reglas que implementa este modulo (todo con fetch, reloj y esperas INYECTADOS para probarlo sin red ni tiempo real):
//  - `seq` por llamada: se asigna al EMPEZAR cada turno y se mantiene en todos sus reintentos. Un barge-in NO aborta la peticion HTTP en vuelo (el servidor la sigue procesando
//    y puede haber creado el pedido): solo se deja de ESPERARLA. El texto nuevo espera la respuesta del turno k, la habla (`alRespuestaPrevia`) y recien despues se manda como
//    k + 1; asi no hay un 409 por turno en proceso ni se pierde el total/la confirmacion. Una apertura repetida (`seq_ultimo`) reanuda desde seq_ultimo + 1.
//    Con varios barge-ins seguidos las respuestas sin oir se acumulan en una cola y las habla, en orden, el primer turno NO abortado; los turnos abortados que no llegaron a
//    enviarse se fusionan con el siguiente (tope de 3 en cola) y al colgar lo no enviado se cancela. `seq` se asigna al enviar.
//  - 5xx / red / tiempo agotado: UN reintento del MISMO seq (idempotente en el servidor; tras un tiempo agotado el 2.o intento espera solo 20 s); si falla otra vez, frase tecnica y colgar.
//  - 409 "en proceso" / "se adelanto": el primero espera 0.7 s y reintenta SIN frase (suele ser el turno anterior terminando); despues frase de espera y reintento del MISMO seq cada 2 s
//    hasta 65 s REALES; agotado: "una persona le devolvera la llamada" y colgar.
//    Cualquier otro 409 (otro telefono, seq fuera de orden) es bug del worker: no se reintenta a ciegas.
//  - 429: Retry-After <= 5 s = rafaga, se espera y se repite el mismo seq; > 5 s = tope: frase y colgar, SIN reintentar.
//  - 503: con `fin: true` es el interruptor de emergencia (hablar y colgar); sin el, contador caido: reintento del mismo seq tras Retry-After.
//  - Frase de relleno si pasan ~4 s sin respuesta y, en esperas largas, otra cada ~15 s (maximo 3 en total). `fin: true` = hablar y colgar. Con `pedido_id` y una despedida del modelo, el worker cuelga el mismo.
//  - Logs solo con codigos, conteos y ms: nunca texto del cliente, telefono ni respuesta del servidor.

export const TEXTO_SILENCIO = "[silencio]";
export const FRASE_ESPERA = "Un momento, por favor.";
/** Frases de espera sucesivas en esperas largas (la 1.a es FRASE_ESPERA; maximo 3 por turno). */
export const FRASES_ESPERA: readonly string[] = [FRASE_ESPERA, "Sigo con eso, gracias por esperar.", "Ya casi, un momento más, por favor."];
export const FRASE_DEVOLVER_LLAMADA = "Una persona le devolverá la llamada. Hasta luego.";
export const FRASE_PROBLEMA_TECNICO = "Tuvimos un problema técnico. Una persona le devolverá la llamada. Hasta luego.";
export const FRASE_TOPE = "Por ahora no puedo atenderle; una persona le devolverá la llamada. Hasta luego.";
export const FRASE_APAGADO = "Por ahora no podemos atenderle por teléfono. Intente más tarde, por favor. Hasta luego.";

export const MAX_TEXTO_CLIENTE = 2000;
const TELEFONO_RE = /^\d{10}$/;
const CALL_ID_RE = /^[A-Za-z0-9_.:-]{6,128}$/;

/** Id valido para `voz-turno` (`[A-Za-z0-9_.:-]{6,128}`) a partir de cualquier id de llamada: sustituye caracteres raros, rellena los cortos y recorta los largos. Mismo id => mismo resultado. */
export function normalizarCallId(id: string): string {
  const limpio = id.replace(/[^A-Za-z0-9_.:-]/g, "_");
  return (limpio.length < 6 ? `llamada_${limpio}` : limpio).slice(0, 128);
}

export type MotivoCierre = "fin_servidor" | "despedida_con_pedido" | "error_tecnico" | "tope" | "apagado" | "en_proceso_agotado" | "telefono_no_obtenido" | "silencio";

export interface ResultadoTurno {
  /** Lo que hay que sintetizar. Nunca vacio. */
  readonly texto: string;
  /** Hay que colgar tras hablar `texto`. */
  readonly colgar: boolean;
  /** Por que se cuelga (solo con `colgar`). */
  readonly motivo: MotivoCierre | null;
  readonly pedidoId: string | null;
  /** Numero de turno que reporta el servidor (0 = apertura); null si el turno no llego a un 200. */
  readonly turno: number | null;
}

/** Una falla dejo al cliente con «una persona le devolvera la llamada»: nadie esta avisado salvo que el worker lo registre. */
export interface AvisoPerdido {
  readonly motivo: MotivoCierre;
  /** Codigo corto de la causa (`http_401`, `http_400`, `http_409`, `http_502`, `red`, `tiempo_agotado`, `en_proceso`...). Nunca texto del cliente. */
  readonly causa: string;
  readonly telefono: string | null;
}

export interface OpcionesTurno {
  readonly senal?: AbortSignal;
  /** Frase que hay que decir YA mientras se espera al servidor (relleno a los ~3 s o 409 "en proceso"). Una vez por turno. */
  readonly alEspera?: (frase: string) => void;
  /** Respuesta de un turno anterior que el cliente no alcanzo a oir (se interrumpio mientras el servidor aun procesaba): hay que hablarla ANTES de la respuesta de este turno. */
  readonly alRespuestaPrevia?: (texto: string) => void;
  /** Solo en la apertura: el worker YA dijo el aviso de grabacion (numero oculto). Manda `aviso_dado: true` y el servidor responde un saludo corto sin preambulo ni aviso. */
  readonly avisoDado?: boolean;
}

export interface OpcionesCerebroVozTurno {
  /** URL completa de la funcion (`${SUPABASE_URL}/functions/v1/voz-turno`). */
  readonly url: string;
  /** Valor de `${VOZ_TURNO_SECRET}`: viaja solo en el header, nunca se registra. */
  readonly secreto: string;
  /** Id de la llamada: `[A-Za-z0-9_.:-]{6,128}`. */
  readonly callId: string;
  /** Telefono confirmado (10 digitos) o null si aun hay que pedirlo (`fijarTelefono` antes de la apertura). */
  readonly telefono: string | null;
  readonly fetchFn?: typeof fetch;
  /** Espera `ms`; se aborta con `senal`. Por omision `setTimeout`. */
  readonly esperar?: (ms: number, senal?: AbortSignal) => Promise<void>;
  /** Programa `fn` a los `ms` y devuelve como cancelarla (relleno de 3 s). Por omision `setTimeout`. */
  readonly temporizador?: (fn: () => void, ms: number) => () => void;
  readonly ahora?: () => number;
  readonly log?: (evento: string, campos?: Readonly<Record<string, unknown>>) => void;
  /** Tiempo maximo de UNA peticion (el contrato pide >= 30 s). Por omision 35 s. */
  readonly timeoutMs?: number;
  /** Cuando decir la frase de relleno si el servidor no responde (ms). Por omision 4000. */
  readonly rellenoMs?: number;
  /** Cada cuanto repetir una frase de espera en esperas largas (ms; maximo 3 frases por turno). Por omision 15000. */
  readonly repiteRellenoMs?: number;
  /** Tiempo maximo del 2.o intento tras un tiempo agotado (ms). Por omision 20000. */
  readonly timeoutReintentoMs?: number;
  /** Presupuesto REAL (medido con el reloj) y cadencia de reintento ante un 409 "en proceso". Por omision 65 s y 2 s. */
  readonly presupuestoEnProcesoMs?: number;
  readonly intervaloEnProcesoMs?: number;
  /** Reintentos del mismo seq ante 5xx/red/tiempo agotado. Por omision 1. */
  readonly reintentosTecnicos?: number;
  /** Reintentos del mismo seq ante 429 (<= 5 s) o 503 sin `fin`. Por omision 3. */
  readonly reintentosRafaga?: number;
  /** Se llama (sin esperar el resultado) cuando se cierra con error tecnico o presupuesto 409 agotado: que alguien registre el aviso de devolver la llamada. */
  readonly alAvisoPerdido?: (aviso: AvisoPerdido) => void;
}

export class ErrorTurnoAbortado extends Error {
  constructor() {
    super("turno_abortado");
    this.name = "AbortError";
  }
}

const esperarPorOmision = (ms: number, senal?: AbortSignal): Promise<void> =>
  new Promise<void>((resolver, rechazar) => {
    if (senal?.aborted) return rechazar(new ErrorTurnoAbortado());
    const id = setTimeout(() => {
      senal?.removeEventListener("abort", alAbortar);
      resolver();
    }, ms);
    const alAbortar = (): void => {
      clearTimeout(id);
      rechazar(new ErrorTurnoAbortado());
    };
    senal?.addEventListener("abort", alAbortar, { once: true });
  });

const temporizadorPorOmision = (fn: () => void, ms: number): (() => void) => {
  const id = setTimeout(fn, ms);
  return () => clearTimeout(id);
};

/** Despedida del modelo (sin pregunta): con un pedido ya creado el worker cuelga el mismo tras hablarla (el servidor nunca manda `fin` en una respuesta del modelo). */
const DESPEDIDA_RE = /\b(hasta luego|hasta pronto|buen(?:a|as|os)?\s+(?:d[ií]a|d[ií]as|tarde|tardes|noche|noches|provecho)|que (?:tenga|le vaya)|gracias por (?:llamar|su preferencia|comunicarse|su llamada)|adi[oó]s|nos vemos)\b/i;

export function esDespedida(texto: string): boolean {
  return !/[?¿]/.test(texto) && DESPEDIDA_RE.test(texto);
}

type Intento =
  | { readonly tipo: "ok"; readonly cuerpo: Record<string, unknown> }
  | { readonly tipo: "http"; readonly estado: number; readonly cuerpo: Record<string, unknown>; readonly retryAfterS: number | null }
  | { readonly tipo: "red"; readonly codigo: string };

function esObjeto(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parsearRetryAfter(valor: string | null): number | null {
  if (valor === null) return null;
  const n = Number(valor.trim());
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Turnos que pueden esperar detras de uno en vuelo; los mas viejos se fusionan en el siguiente. */
export const MAX_COLA_TURNOS = 3;

interface TurnoEnVuelo {
  readonly id: number;
  promesa: Promise<ResultadoTurno>;
  /** La respuesta ya llego a un turno vivo (se hablo) o quedo en la cola de pendientes. */
  entregado: boolean;
  /** Se paso del tope de la cola: no se envia aparte. */
  descartar: boolean;
}

/** Junta lo que dijo el cliente en turnos abortados con lo del siguiente (en orden); conserva lo ultimo si pasa del tope. */
function unirTextos(antes: string, ahora: string): string {
  const t = [antes, ahora].filter((x) => x.trim() !== "").join(" ");
  return t.length > MAX_TEXTO_CLIENTE ? t.slice(t.length - MAX_TEXTO_CLIENTE) : t;
}

export class CerebroVozTurno {
  private telefono: string | null;
  private readonly callId: string;
  private proximoSeq = 1;
  private abierta = false;
  private cierre: ResultadoTurno | null = null;
  private pedido: string | null = null;
  /** Turnos que esperan al servidor (propios o encolados detras de uno en vuelo); `ocupado` = hay alguno. */
  private turnosActivos = 0;
  private idTurno = 0;
  /** Ultimo turno lanzado: su peticion sigue aunque el cliente se haya interrumpido. */
  private vuelo: TurnoEnVuelo | null = null;
  /** Respuestas de turnos anteriores que el cliente no alcanzo a oir: las habla, en orden, el primer turno no abortado. */
  private readonly pendientePorHablar: string[] = [];
  /** Texto de turnos abortados que no llegaron a enviarse: viaja junto con el del siguiente. */
  private textoDiferido = "";
  /** Turnos esperando detras de uno en vuelo y aun sin enviar (maximo `MAX_COLA_TURNOS`). */
  private readonly enCola: TurnoEnVuelo[] = [];
  private cancelado = false;
  private cierreEntregado = false;
  private readonly fetchFn: typeof fetch;
  private readonly esperar: NonNullable<OpcionesCerebroVozTurno["esperar"]>;
  private readonly temporizador: NonNullable<OpcionesCerebroVozTurno["temporizador"]>;
  private readonly ahora: () => number;

  constructor(private readonly o: OpcionesCerebroVozTurno) {
    // Un id de proveedor corto o con caracteres raros se rellena/sustituye (siempre igual para la misma llamada) en vez de tumbar la llamada.
    this.callId = CALL_ID_RE.test(o.callId) ? o.callId : normalizarCallId(o.callId);
    this.telefono = o.telefono;
    this.fetchFn = o.fetchFn ?? fetch;
    this.esperar = o.esperar ?? esperarPorOmision;
    this.temporizador = o.temporizador ?? temporizadorPorOmision;
    this.ahora = o.ahora ?? (() => Date.now());
  }

  get pedidoId(): string | null {
    return this.pedido;
  }
  /** Hay un turno esperando al servidor (la vigilancia de silencio no debe mandar `[silencio]` mientras tanto). */
  get ocupado(): boolean {
    return this.turnosActivos > 0;
  }
  get cerrada(): boolean {
    return this.cierre !== null;
  }
  get telefonoFijado(): boolean {
    return this.telefono !== null;
  }

  /** Fija el telefono confirmado con el cliente (numero oculto). Solo una vez y solo antes de la apertura. */
  fijarTelefono(telefono: string): boolean {
    if (this.telefono !== null || this.abierta || !TELEFONO_RE.test(telefono)) return false;
    this.telefono = telefono;
    return true;
  }

  private log(evento: string, campos: Readonly<Record<string, unknown>> = {}): void {
    this.o.log?.(evento, campos);
  }

  private cerrarConFrase(texto: string, motivo: MotivoCierre, turno: number | null = null, causa: string | null = null): ResultadoTurno {
    const r: ResultadoTurno = { texto, colgar: true, motivo, pedidoId: this.pedido, turno };
    this.cierre = r;
    this.log("voz_turno_cierre", { motivo });
    if (causa !== null && (motivo === "error_tecnico" || motivo === "en_proceso_agotado")) {
      try {
        this.o.alAvisoPerdido?.({ motivo, causa, telefono: this.telefono });
      } catch {
        // el aviso nunca debe impedir el colgado
      }
    }
    return r;
  }

  /** Apertura (seq 0, texto vacio): saludo con el aviso de privacidad. Si la llamada ya empezo (reconexion) el servidor trae `seq_ultimo` y se continua desde ahi. */
  apertura(opciones: OpcionesTurno = {}): Promise<ResultadoTurno> {
    return this.lanzar(0, "", opciones);
  }

  /** Un turno con lo que dijo el cliente (o `[silencio]`). */
  turno(texto: string, opciones: OpcionesTurno = {}): Promise<ResultadoTurno> {
    return this.lanzar(null, texto.slice(0, MAX_TEXTO_CLIENTE), opciones);
  }

  /**
   * Lanza el turno y devuelve su resultado. La peticion corre DESACOPLADA de `opciones.senal`: si el cliente interrumpe, esta promesa rechaza con AbortError pero la
   * peticion sigue y su respuesta queda guardada.
   *
   * Respuestas que el cliente no oyo: la de un turno abortado o ya sin dueno vive en `pendientePorHablar`. Solo el primer turno NO abortado que llega a enviar las habla (todas,
   * en orden, `alRespuestaPrevia`) antes de la suya, y las da por habladas cuando el mismo termina sin abortarse; un turno abortado no las consume (la sesion descarta su texto).
   *
   * Turnos obsoletos: `seq` se asigna al ENVIAR. Un turno en cola abortado antes de enviarse, con otro mas reciente detras, no viaja aparte: su texto se junta con el del siguiente.
   * La cola de espera tiene tope (`MAX_COLA_TURNOS`); `cancelarPendientes()` (al colgar) suelta lo que no se envio.
   */
  private lanzar(seq: number | null, texto: string, opciones: OpcionesTurno): Promise<ResultadoTurno> {
    if (this.cierre) return this.devolverCierre(opciones);
    if (this.cancelado) return Promise.reject(new ErrorTurnoAbortado());
    if (this.telefono === null) return Promise.reject(new Error("voz-turno: falta el telefono confirmado"));
    const previo = this.vuelo;
    const mio: TurnoEnVuelo = { id: (this.idTurno += 1), promesa: Promise.resolve(null as never), entregado: false, descartar: false };
    this.vuelo = mio;
    this.turnosActivos += 1;
    if (previo) {
      this.enCola.push(mio);
      while (this.enCola.length > MAX_COLA_TURNOS) this.enCola.shift()!.descartar = true;
    }
    const trabajo = (async (): Promise<ResultadoTurno> => {
      if (previo) {
        const anterior = await previo.promesa.catch(() => null);
        // El cierre del servidor no se encola: vive en `this.cierre`. Lo demas que el cliente no alcanzo a oir (p. ej. el total o la confirmacion del pedido) queda en la cola.
        if (anterior && !anterior.colgar && !previo.entregado) {
          previo.entregado = true;
          this.pendientePorHablar.push(anterior.texto);
        }
        this.enCola.splice(this.enCola.indexOf(mio) >>> 0, 1);
        if (this.cierre) return this.devolverCierre(opciones);
        if (this.cancelado) throw new ErrorTurnoAbortado();
        const obsoleto = opciones.senal?.aborted === true && this.vuelo !== mio;
        if (mio.descartar || obsoleto) {
          if (texto !== TEXTO_SILENCIO) this.textoDiferido = unirTextos(this.textoDiferido, texto);
          throw new ErrorTurnoAbortado();
        }
      }
      const vivo = (): boolean => opciones.senal?.aborted !== true;
      const hablar = vivo() ? [...this.pendientePorHablar] : [];
      for (const previa of hablar) opciones.alRespuestaPrevia?.(previa);
      const diferido = this.textoDiferido;
      this.textoDiferido = "";
      const total = diferido !== "" && texto === TEXTO_SILENCIO ? diferido : unirTextos(diferido, texto);
      const r = await this.pedir(seq ?? this.asignarSeq(), total, opciones);
      if (vivo()) {
        this.pendientePorHablar.splice(0, hablar.length);
        mio.entregado = true;
        if (r.colgar) this.cierreEntregado = true;
      }
      return r;
    })().finally(() => {
      this.turnosActivos -= 1;
    });
    mio.promesa = trabajo;
    return this.esperarConSenal(trabajo, opciones.senal);
  }

  private asignarSeq(): number {
    const seq = this.proximoSeq;
    this.proximoSeq += 1;
    return seq;
  }

  /** Hay un cierre: se habla (si nadie lo oyo) y no se manda nada mas. Antes se hablan las respuestas pendientes. */
  private devolverCierre(opciones: OpcionesTurno): Promise<ResultadoTurno> {
    const cierre = this.cierre!;
    const vivo = opciones.senal?.aborted !== true;
    if (vivo) {
      for (const previa of this.pendientePorHablar) opciones.alRespuestaPrevia?.(previa);
      this.pendientePorHablar.length = 0;
    }
    return Promise.resolve({ ...cierre, turno: null });
  }

  /** El worker cuelga: lo que esta en cola y no se envio ya no se manda (el turno ya enviado puede terminar). */
  cancelarPendientes(): void {
    this.cancelado = true;
    this.textoDiferido = "";
    this.pendientePorHablar.length = 0;
    for (const t of this.enCola) t.descartar = true;
  }

  /** Espera `p` pero se suelta (AbortError) si `senal` se aborta; `p` NO se cancela. */
  private esperarConSenal(p: Promise<ResultadoTurno>, senal: AbortSignal | undefined): Promise<ResultadoTurno> {
    if (!senal) return p;
    if (senal.aborted) {
      p.catch(() => undefined);
      return Promise.reject(new ErrorTurnoAbortado());
    }
    return new Promise<ResultadoTurno>((resolver, rechazar) => {
      const alAbortar = (): void => rechazar(new ErrorTurnoAbortado());
      senal.addEventListener("abort", alAbortar, { once: true });
      p.then(resolver, rechazar).finally(() => senal.removeEventListener("abort", alAbortar));
    });
  }

  private async pedir(seq: number, texto: string, opciones: OpcionesTurno): Promise<ResultadoTurno> {
    let dichas = 0;
    const decirEspera = (): void => {
      if (dichas >= FRASES_ESPERA.length || opciones.senal?.aborted) return;
      opciones.alEspera?.(FRASES_ESPERA[dichas]!);
      dichas += 1;
    };
    // Primer relleno a los 4 s y repeticiones cada ~15 s (maximo 3 frases). Un 409 «en proceso» tambien dice la frase pero solo si aun no se dijo ninguna.
    let cancelar: () => void = () => undefined;
    const programar = (ms: number): void => {
      cancelar = this.temporizador(() => {
        decirEspera();
        if (dichas < FRASES_ESPERA.length) programar(this.o.repiteRellenoMs ?? 15_000);
      }, ms);
    };
    programar(this.o.rellenoMs ?? 4000);
    try {
      return await this.reintentar(seq, texto, seq === 0 && opciones.avisoDado === true, () => (dichas === 0 ? decirEspera() : undefined));
    } finally {
      cancelar();
    }
  }

  /** UNA peticion. Solo la corta su propio tiempo maximo: un barge-in del cliente NO la aborta (el servidor la procesa igual). */
  private async intentar(seq: number, texto: string, timeoutMs: number, avisoDado: boolean): Promise<Intento> {
    const limite = new AbortController();
    const id = setTimeout(() => limite.abort(), timeoutMs);
    try {
      const res = await this.fetchFn(this.o.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-voz-turno-secret": this.o.secreto },
        body: JSON.stringify({ call_id: this.callId, telefono: this.telefono, seq, texto, ...(avisoDado ? { aviso_dado: true } : {}) }),
        signal: limite.signal,
      });
      let cuerpo: Record<string, unknown> = {};
      try {
        const crudo: unknown = await res.json();
        if (esObjeto(crudo)) cuerpo = crudo;
      } catch {
        // cuerpo no JSON: se trata por su estado
      }
      if (res.status === 200) {
        if (typeof cuerpo.texto !== "string") return { tipo: "red", codigo: "cuerpo_invalido" };
        return { tipo: "ok", cuerpo };
      }
      return { tipo: "http", estado: res.status, cuerpo, retryAfterS: parsearRetryAfter(res.headers.get("retry-after")) };
    } catch {
      return { tipo: "red", codigo: limite.signal.aborted ? "tiempo_agotado" : "red" };
    } finally {
      clearTimeout(id);
    }
  }

  private async reintentar(seq: number, texto: string, avisoDado: boolean, decirEspera: () => void): Promise<ResultadoTurno> {
    const reintentosTecnicos = this.o.reintentosTecnicos ?? 1;
    const reintentosRafaga = this.o.reintentosRafaga ?? 3;
    const presupuesto = this.o.presupuestoEnProcesoMs ?? 65_000;
    const intervalo = this.o.intervaloEnProcesoMs ?? 2000;
    let tecnicos = 0;
    let rafagas = 0;
    let inicioEnProceso: number | null = null;
    let timeoutProximo = this.o.timeoutMs ?? 35_000;
    for (let intento = 1; ; intento += 1) {
      const r = await this.intentar(seq, texto, timeoutProximo, avisoDado);
      if (r.tipo === "ok") return this.aceptar(seq, r.cuerpo);

      if (r.tipo === "red") {
        this.log("voz_turno_fallo", { codigo: r.codigo, intento });
        if (tecnicos >= reintentosTecnicos) return this.cerrarConFrase(FRASE_PROBLEMA_TECNICO, "error_tecnico", null, r.codigo);
        tecnicos += 1;
        // Tras un tiempo agotado el servidor puede haber terminado el turno: el 2.o intento (mismo seq) recupera la respuesta guardada, pero ya no se esperan 35 s mas.
        if (r.codigo === "tiempo_agotado") timeoutProximo = this.o.timeoutReintentoMs ?? 20_000;
        await this.esperar(500);
        continue;
      }

      const { estado, cuerpo, retryAfterS } = r;
      this.log("voz_turno_http", { codigo: String(estado), intento });
      if (estado === 429) {
        const espera = retryAfterS ?? 3;
        if (espera > 5) return this.cerrarConFrase(FRASE_TOPE, "tope");
        if (rafagas >= reintentosRafaga) return this.cerrarConFrase(FRASE_PROBLEMA_TECNICO, "error_tecnico", null, `http_${estado}`);
        rafagas += 1;
        await this.esperar(Math.max(espera, 1) * 1000);
        continue;
      }
      if (estado === 503) {
        if (cuerpo.fin === true && typeof cuerpo.texto === "string" && cuerpo.texto.trim() !== "") return this.cerrarConFrase(cuerpo.texto, "apagado");
        if (cuerpo.fin === true) return this.cerrarConFrase(FRASE_APAGADO, "apagado");
        if (rafagas >= reintentosRafaga) return this.cerrarConFrase(FRASE_PROBLEMA_TECNICO, "error_tecnico", null, `http_${estado}`);
        rafagas += 1;
        await this.esperar(Math.max(retryAfterS ?? 3, 1) * 1000);
        continue;
      }
      if (estado === 409) {
        const mensaje = typeof cuerpo.error === "string" ? cuerpo.error : "";
        if (!/en proceso|se adelant/i.test(mensaje)) {
          // otro telefono o seq fuera de orden: bug del worker, no se reintenta a ciegas
          return this.cerrarConFrase(FRASE_PROBLEMA_TECNICO, "error_tecnico", null, "http_409");
        }
        if (inicioEnProceso === null) {
          // Primer 409: casi siempre es el turno anterior terminando; se espera un instante y se reintenta SIN decir nada.
          inicioEnProceso = this.ahora();
          await this.esperar(700);
          continue;
        }
        decirEspera();
        // Presupuesto REAL: se cierra cuando ya transcurrio (reloj) el presupuesto completo, no antes.
        if (this.ahora() - inicioEnProceso >= presupuesto) return this.cerrarConFrase(FRASE_DEVOLVER_LLAMADA, "en_proceso_agotado", null, "en_proceso");
        await this.esperar(intervalo);
        continue;
      }
      if (estado >= 500) {
        if (tecnicos >= reintentosTecnicos) return this.cerrarConFrase(FRASE_PROBLEMA_TECNICO, "error_tecnico", null, `http_${estado}`);
        tecnicos += 1;
        await this.esperar(500);
        continue;
      }
      // 400, 401 y cualquier otro: entrada invalida o secreto incorrecto. No se reintenta.
      return this.cerrarConFrase(FRASE_PROBLEMA_TECNICO, "error_tecnico", null, `http_${estado}`);
    }
  }

  private aceptar(seq: number, cuerpo: Record<string, unknown>): ResultadoTurno {
    if (seq === 0) {
      this.abierta = true;
      // Apertura repetida (reconexion del worker): se continua desde el ultimo seq que proceso el servidor.
      if (typeof cuerpo.seq_ultimo === "number" && Number.isInteger(cuerpo.seq_ultimo) && cuerpo.seq_ultimo >= 0) this.proximoSeq = cuerpo.seq_ultimo + 1;
    }
    this.abierta = true;
    const texto = typeof cuerpo.texto === "string" && cuerpo.texto.trim() !== "" ? cuerpo.texto : "Disculpe, ¿me lo puede repetir?";
    const pedidoId = typeof cuerpo.pedido_id === "string" && cuerpo.pedido_id !== "" ? cuerpo.pedido_id : null;
    if (pedidoId !== null) this.pedido = pedidoId;
    const turno = typeof cuerpo.turno === "number" && Number.isFinite(cuerpo.turno) ? cuerpo.turno : null;
    if (cuerpo.fin === true) return this.cerrarConFrase(texto, "fin_servidor", turno);
    if (this.pedido !== null && esDespedida(texto)) return this.cerrarConFrase(texto, "despedida_con_pedido", turno);
    return { texto, colgar: false, motivo: null, pedidoId: this.pedido, turno };
  }
}
