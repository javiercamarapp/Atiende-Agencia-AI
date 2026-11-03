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
//  - Frase de relleno si pasan ~4 s sin respuesta y, en esperas largas, otra cada ~15 s (maximo 3 en total). `fin: true` = hablar y colgar. Con `pedido_id` y una despedida del modelo, el worker cuelga el mismo, salvo que el cliente haya agregado o corregido algo tras la confirmacion (solo si el cliente tambien se despide).
//  - Logs solo con codigos, conteos y ms: nunca texto del cliente, telefono ni respuesta del servidor.

export const TEXTO_SILENCIO = "[silencio]";
/** Texto interno (nunca viaja al servidor) con el que el worker pide hablar una respuesta retenida tras un aborto sin texto final. */
export const TEXTO_PENDIENTE = "[pendiente]";
export const FRASE_ESPERA = "Un momento, por favor.";
/** Frases de espera sucesivas en esperas largas (la 1.a es FRASE_ESPERA; maximo 3 por turno). */
export const FRASES_ESPERA: readonly string[] = [FRASE_ESPERA, "Sigo con eso, gracias por esperar.", "Ya casi, un momento más, por favor."];
export const FRASE_DEVOLVER_LLAMADA = "Una persona le devolverá la llamada. Hasta luego.";
/** Cierre cuando aun NO hay telefono confirmado (numero oculto): no hay a donde devolver la llamada, asi que no se promete. */
export const FRASE_VUELVA_A_LLAMAR = "No logré registrar su número. Por favor vuelva a llamar o escríbanos por WhatsApp. Hasta luego.";
export const FRASE_PROBLEMA_TECNICO = "Tuvimos un problema técnico. Una persona le devolverá la llamada. Hasta luego.";
export const FRASE_TOPE = "Por ahora no puedo atenderle; una persona le devolverá la llamada. Hasta luego.";
/** Segunda vez que se dice un cierre (el cliente interrumpio la despedida): basta lo corto. */
export const FRASE_CIERRE_CORTA = "Hasta luego.";
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
  /** Se llama cuando un cierre blando (`despedida_con_pedido`) se retira porque el cliente siguio hablando: el worker debe cancelar el colgado programado. */
  readonly alReabrir?: () => void;
  /**
   * Un turno se aborto (p. ej. por ruido: parcial sin texto final) y pasado `huerfanoMs` nadie lo reemplazo, pero el servidor SI respondio: esa respuesta (total, confirmacion) esta
   * retenida y nadie la hablaria hasta el siguiente turno. El worker debe disparar un turno interno (`TEXTO_PENDIENTE`) para hablarla.
   */
  readonly alPendienteHuerfano?: () => void;
  /** Espera tras un aborto antes de hablar lo retenido (ms). Por omision 1500. */
  readonly huerfanoMs?: number;
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

const PALABRAS_CIERRE_CLIENTE = new Set(
  ("gracias muchas muchisimas mil no si ok okey okay vale listo perfecto excelente genial muy bien es eso todo nada mas ya hasta luego pronto adios bye chao bueno buenas buenos dias tardes noches buen dia tarde noche " +
    "igualmente igual de por favor gusto amable entonces correcto asi esta estamos sale claro entendido que le vaya tenga provecho su atencion servicio gran").split(" "),
);

/** El ultimo mensaje del cliente es solo cierre o agradecimiento («no, es todo, gracias»), o ni siquiera hablo (`[silencio]`): ninguna palabra pide, agrega ni corrige algo. */
export function esCierreCliente(texto: string): boolean {
  if (texto.trim() === TEXTO_SILENCIO) return true;
  const palabras = texto.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((p) => p !== "");
  return palabras.length > 0 && palabras.length <= 10 && palabras.every((p) => PALABRAS_CIERRE_CLIENTE.has(p));
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
  /** Ya se aviso (`alPendienteHuerfano`) de que su respuesta quedo retenida. */
  huerfanoAvisado?: boolean;
}

/** Junta lo que dijo el cliente en turnos abortados con lo del siguiente (en orden); conserva lo ultimo si pasa del tope. */
function unirTextos(antes: string, ahora: string): string {
  const a = antes.trim();
  const b = ahora.trim();
  // Sin puntuacion final los dos pedazos se leerian como una sola frase corrida («dos tacos de bistec»): se separan con «. ».
  const t = a === "" || b === "" ? `${a}${b}` : `${a}${/[.!?…;:,]$/.test(a) ? " " : ". "}${b}`;
  return t.length > MAX_TEXTO_CLIENTE ? t.slice(t.length - MAX_TEXTO_CLIENTE) : t;
}

/** Oracion con datos que el cliente no debe perder: cifras, total, pesos, folio, pedido o numero. */
const DATO_CLAVE = /\d|\$|total|pesos?\b|folio|pedido|n[uú]mero/i;

/**
 * Repeticion breve de algo que el cliente ya empezo a oir («como le decia, su total es 100 pesos»). Conserva las oraciones con datos (cifras, total, pesos, folio, pedido, numero);
 * si el pendiente tiene tres oraciones o menos sin pregunta las conserva todas; si solo habia una pregunta, devuelve el pendiente completo (nunca una despedida a media llamada).
 */
export function versionCortaDePendiente(texto: string): string {
  const oraciones = texto.split(/(?<=[.!?])\s+/).map((o) => o.trim()).filter((o) => o !== "" && !/[?¿]/.test(o));
  const clave = oraciones.filter((o) => DATO_CLAVE.test(o));
  const elegidas = oraciones.length <= 3 ? oraciones : clave.length > 0 ? clave : oraciones.slice(0, 1);
  const cuerpo = elegidas.join(" ");
  if (cuerpo === "") return texto.trim();
  return `Como le decía, ${cuerpo.charAt(0).toLowerCase()}${cuerpo.slice(1)}`;
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
  /** Pendientes que ya se hablaron (o se empezaron a hablar) en un turno que luego se aborto: la segunda vez van en version corta, no completos. */
  private readonly yaDichas = new Set<string>();
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
    if (this.cierre && !this.reabrirSiBlando(seq, texto)) return this.devolverCierre(opciones);
    if (this.cancelado) return Promise.reject(new ErrorTurnoAbortado());
    if (this.telefono === null) return Promise.reject(new Error("voz-turno: falta el telefono confirmado"));
    const previo = this.vuelo;
    const mio: TurnoEnVuelo = { id: (this.idTurno += 1), promesa: Promise.resolve(null as never), entregado: false, descartar: false };
    this.vuelo = mio;
    this.turnosActivos += 1;
    const espera = this.iniciarEspera(opciones);
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
        if (this.cierre && !this.reabrirSiBlando(seq, texto)) return this.devolverCierre(opciones);
        if (this.cancelado) throw new ErrorTurnoAbortado();
        const obsoleto = opciones.senal?.aborted === true && this.vuelo !== mio;
        if (mio.descartar || obsoleto) {
          if (texto !== TEXTO_SILENCIO) this.textoDiferido = unirTextos(this.textoDiferido, texto);
          throw new ErrorTurnoAbortado();
        }
      }
      const vivo = (): boolean => opciones.senal?.aborted !== true;
      const hablar = vivo() ? [...this.pendientePorHablar] : [];
      this.hablarPendientes(hablar, opciones);
      const diferido = this.textoDiferido;
      this.textoDiferido = "";
      const total = diferido !== "" && texto === TEXTO_SILENCIO ? diferido : unirTextos(diferido, texto);
      const r = await this.pedir(seq ?? this.asignarSeq(), total, opciones, espera.alEnProceso);
      if (vivo()) {
        this.pendientePorHablar.splice(0, hablar.length);
        for (const h of hablar) this.yaDichas.delete(h);
        mio.entregado = true;
        if (r.colgar) this.cierreEntregado = true;
      }
      return r;
    })().finally(() => {
      espera.cancelar();
      this.turnosActivos -= 1;
    });
    mio.promesa = trabajo;
    if (opciones.senal && this.o.alPendienteHuerfano) {
      if (opciones.senal.aborted) this.vigilarHuerfano(mio);
      else opciones.senal.addEventListener("abort", () => this.vigilarHuerfano(mio), { once: true });
    }
    return this.esperarConSenal(trabajo, opciones.senal);
  }

  private asignarSeq(): number {
    const seq = this.proximoSeq;
    this.proximoSeq += 1;
    return seq;
  }

  /**
   * Solo `fin_servidor`, `error_tecnico`, `tope`, `apagado` (y los demas cierres por falla) son pegajosos. `despedida_con_pedido` es una HEURISTICA del worker (el servidor nunca manda
   * `fin` en una respuesta del modelo): si el cliente dice algo que no es cierre («ah, y agrega una coca», «espera, falta algo») mientras el servidor creaba el pedido o mientras
   * sonaba la despedida, el cierre se retira, se habla lo que el cliente no oyo y el texto se envia como el seq siguiente.
   */
  private reabrirSiBlando(seq: number | null, texto: string): boolean {
    const c = this.cierre;
    if (c === null || c.motivo !== "despedida_con_pedido" || seq !== null) return false;
    const total = this.textoDiferido !== "" && texto === TEXTO_SILENCIO ? this.textoDiferido : unirTextos(this.textoDiferido, texto);
    if (esCierreCliente(total)) return false;
    this.cierre = null;
    this.cancelado = false;
    // Si nadie oyo la despedida (turno abortado), su texto (que puede traer el total) se habla antes de la respuesta nueva.
    if (!this.cierreEntregado) this.pendientePorHablar.push(c.texto);
    this.cierreEntregado = false;
    this.log("voz_turno_cierre_retirado", { motivo: c.motivo });
    try {
      this.o.alReabrir?.();
    } catch {
      // el aviso al worker nunca debe impedir seguir la llamada
    }
    return true;
  }

  /** Tras un aborto, si en `huerfanoMs` no llego un turno nuevo y la respuesta del abortado quedo sin oir, se avisa al worker para que la hable. */
  private vigilarHuerfano(mio: TurnoEnVuelo): void {
    this.temporizador(() => {
      void (async () => {
        if (this.vuelo !== mio || this.cancelado) return;
        const r = await mio.promesa.catch(() => null);
        if (r === null || this.vuelo !== mio || this.cancelado || this.turnosActivos > 0 || mio.entregado || mio.huerfanoAvisado === true) return;
        mio.huerfanoAvisado = true;
        this.log("voz_turno_pendiente_huerfano");
        try {
          this.o.alPendienteHuerfano?.();
        } catch {
          // el aviso al worker nunca debe tumbar la llamada
        }
      })();
    }, this.o.huerfanoMs ?? 1500);
  }

  /** Habla lo retenido (respuesta de un turno abortado sin reemplazo) o el cierre. `null` si ya no hay nada. No manda nada al servidor. */
  /** Hay algo retenido que `hablarPendiente` diria (respuesta sin oir, cierre o turno en vuelo sin entregar). */
  get hayPendiente(): boolean {
    const v = this.vuelo;
    return (v !== null && v !== undefined && !v.entregado) || this.cierre !== null || this.pendientePorHablar.length > 0;
  }

  async hablarPendiente(opciones: OpcionesTurno = {}): Promise<ResultadoTurno | null> {
    const v = this.vuelo;
    if (v && !v.entregado) {
      const r = await v.promesa.catch(() => null);
      if (r && !v.entregado) {
        v.entregado = true;
        if (!r.colgar) this.pendientePorHablar.push(r.texto);
      }
    }
    if (this.cierre) return this.devolverCierre(opciones);
    if (this.pendientePorHablar.length === 0 || opciones.senal?.aborted === true) return null;
    const lista = [...this.pendientePorHablar];
    const partes: string[] = [];
    this.hablarPendientes(lista, { ...opciones, alRespuestaPrevia: (t) => partes.push(t) });
    // Solo se consume si la senal sigue viva al terminar (igual que `turno`): si se aborto, nadie lo oyo y sigue en la cola (ya marcado como empezado a decir).
    const sigueViva = (): boolean => opciones.senal?.aborted !== true;
    if (sigueViva()) {
      this.pendientePorHablar.splice(0, lista.length);
      for (const h of lista) this.yaDichas.delete(h);
    }
    return { texto: partes.join(" "), colgar: false, motivo: null, pedidoId: this.pedido, turno: null };
  }

  /** Habla las respuestas pendientes (si el turno sigue vivo). Una que ya se empezo a hablar en un turno abortado se repite solo como «como le decia, su total es ...». */
  private hablarPendientes(lista: readonly string[], opciones: OpcionesTurno): void {
    if (opciones.senal?.aborted === true) return;
    for (const previa of lista) {
      if (this.yaDichas.has(previa)) opciones.alRespuestaPrevia?.(versionCortaDePendiente(previa));
      else {
        this.yaDichas.add(previa);
        opciones.alRespuestaPrevia?.(previa);
      }
    }
  }

  /** Hay un cierre: se habla (si nadie lo oyo) y no se manda nada mas. Antes se hablan las respuestas pendientes. */
  private devolverCierre(opciones: OpcionesTurno): Promise<ResultadoTurno> {
    const cierre = this.cierre!;
    const vivo = opciones.senal?.aborted !== true;
    if (vivo) {
      this.hablarPendientes([...this.pendientePorHablar], opciones);
      this.pendientePorHablar.length = 0;
      this.yaDichas.clear();
    }
    // La despedida completa se dice una sola vez; si el cliente la interrumpio, la segunda vez solo la version corta. Si nadie la oyo (turno abortado), aun va completa.
    const texto = this.cierreEntregado ? FRASE_CIERRE_CORTA : cierre.texto;
    if (vivo) this.cierreEntregado = true;
    return Promise.resolve({ ...cierre, texto, turno: null });
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

  /**
   * Frases de espera de un turno. El reloj arranca cuando el cliente TERMINO de hablar (al lanzar el turno), no cuando el turno por fin se envia: si antes hay que esperar la
   * respuesta de un turno anterior (barge-in), el cliente oye el «un momento» a los ~4 s igual. Primer relleno a los 4 s y repeticiones cada ~15 s (maximo 3 frases); un 409
   * «en proceso» tambien dice la frase pero solo si aun no se dijo ninguna.
   */
  private iniciarEspera(opciones: OpcionesTurno): { readonly alEnProceso: () => void; readonly cancelar: () => void } {
    let dichas = 0;
    const decirEspera = (): void => {
      if (dichas >= FRASES_ESPERA.length || opciones.senal?.aborted) return;
      opciones.alEspera?.(FRASES_ESPERA[dichas]!);
      dichas += 1;
    };
    let cancelar: () => void = () => undefined;
    const programar = (ms: number): void => {
      cancelar = this.temporizador(() => {
        decirEspera();
        if (dichas < FRASES_ESPERA.length) programar(this.o.repiteRellenoMs ?? 15_000);
      }, ms);
    };
    programar(this.o.rellenoMs ?? 4000);
    return { alEnProceso: () => (dichas === 0 ? decirEspera() : undefined), cancelar: () => cancelar() };
  }

  private async pedir(seq: number, texto: string, opciones: OpcionesTurno, alEnProceso: () => void): Promise<ResultadoTurno> {
    return this.reintentar(seq, texto, seq === 0 && opciones.avisoDado === true, alEnProceso);
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
      if (r.tipo === "ok") return this.aceptar(seq, r.cuerpo, texto);

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

  private aceptar(seq: number, cuerpo: Record<string, unknown>, textoCliente: string): ResultadoTurno {
    if (seq === 0) {
      this.abierta = true;
      // Apertura repetida (reconexion del worker): se continua desde el ultimo seq que proceso el servidor.
      if (typeof cuerpo.seq_ultimo === "number" && Number.isInteger(cuerpo.seq_ultimo) && cuerpo.seq_ultimo >= 0) this.proximoSeq = cuerpo.seq_ultimo + 1;
    }
    this.abierta = true;
    const texto = typeof cuerpo.texto === "string" && cuerpo.texto.trim() !== "" ? cuerpo.texto : "Disculpe, ¿me lo puede repetir?";
    const pedidoId = typeof cuerpo.pedido_id === "string" && cuerpo.pedido_id !== "" ? cuerpo.pedido_id : null;
    // Este turno acaba de crear (o cambiar) el pedido: la despedida es de la confirmacion misma, no una respuesta a algo nuevo que dijo el cliente.
    const confirmaAhora = pedidoId !== null && pedidoId !== this.pedido;
    if (pedidoId !== null) this.pedido = pedidoId;
    const turno = typeof cuerpo.turno === "number" && Number.isFinite(cuerpo.turno) ? cuerpo.turno : null;
    if (cuerpo.fin === true) return this.cerrarConFrase(texto, "fin_servidor", turno);
    // Con pedido y despedida del modelo se cuelga, pero solo si el cliente tambien se despide (o no dijo nada nuevo tras la confirmacion): si agrego o corrigio algo, la llamada sigue.
    if (this.pedido !== null && esDespedida(texto) && (confirmaAhora || esCierreCliente(textoCliente))) return this.cerrarConFrase(texto, "despedida_con_pedido", turno);
    return { texto, colgar: false, motivo: null, pedidoId: this.pedido, turno };
  }
}
