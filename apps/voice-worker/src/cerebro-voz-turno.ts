// Cliente del endpoint `voz-turno` (Edge Function del repo suelto atiende-restaurantes): el CEREBRO de la llamada cuando `VOZ_CEREBRO=suelto`.
// El worker NO piensa ni corre herramientas: manda lo que dijo el cliente y habla lo que regresa el servidor. Contrato: CONTRATO-HERRAMIENTAS.md y RUNBOOK-VOZ.md del repo suelto.
//
//   POST {call_id, telefono, texto, seq}  +  header x-voz-turno-secret
//   apertura = seq 0 con texto vacio; turnos = seq 1..n; `[silencio]` cuando el cliente no habla; respuesta {texto, pedido_id, fin, turno, seq_ultimo?}
//
// Reglas que implementa este modulo (todo con fetch, reloj y esperas INYECTADOS para probarlo sin red ni tiempo real):
//  - `seq` por llamada: se asigna al EMPEZAR cada turno y se mantiene en todos sus reintentos. Un turno que se aborta (el cliente interrumpe) ya gasto su seq: el siguiente
//    usa seq + 1 (el servidor acepta saltos; si el turno viejo sigue "en proceso" responde 409 y se espera). Una apertura repetida (`seq_ultimo`) reanuda desde seq_ultimo + 1.
//  - 5xx / red / tiempo agotado: UN reintento del MISMO seq (idempotente en el servidor); si falla otra vez, frase tecnica y colgar.
//  - 409 "en proceso" / "se adelanto": frase de espera una sola vez y reintento del MISMO seq cada 2 s hasta 60 s; agotado: "una persona le devolvera la llamada" y colgar.
//    Cualquier otro 409 (otro telefono, seq fuera de orden) es bug del worker: no se reintenta a ciegas.
//  - 429: Retry-After <= 5 s = rafaga, se espera y se repite el mismo seq; > 5 s = tope: frase y colgar, SIN reintentar.
//  - 503: con `fin: true` es el interruptor de emergencia (hablar y colgar); sin el, contador caido: reintento del mismo seq tras Retry-After.
//  - Frase de relleno si pasan ~3 s sin respuesta. `fin: true` = hablar y colgar. Con `pedido_id` y una despedida del modelo, el worker cuelga el mismo.
//  - Logs solo con codigos, conteos y ms: nunca texto del cliente, telefono ni respuesta del servidor.

export const TEXTO_SILENCIO = "[silencio]";
export const FRASE_ESPERA = "Un momento, por favor.";
export const FRASE_DEVOLVER_LLAMADA = "Una persona le devolverá la llamada. Hasta luego.";
export const FRASE_PROBLEMA_TECNICO = "Tuvimos un problema técnico. Una persona le devolverá la llamada. Hasta luego.";
export const FRASE_TOPE = "Por ahora no puedo atenderle; una persona le devolverá la llamada. Hasta luego.";
export const FRASE_APAGADO = "Por ahora no podemos atenderle por teléfono. Intente más tarde, por favor. Hasta luego.";

export const MAX_TEXTO_CLIENTE = 2000;
const TELEFONO_RE = /^\d{10}$/;
const CALL_ID_RE = /^[A-Za-z0-9_.:-]{6,128}$/;

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

export interface OpcionesTurno {
  readonly senal?: AbortSignal;
  /** Frase que hay que decir YA mientras se espera al servidor (relleno a los ~3 s o 409 "en proceso"). Una vez por turno. */
  readonly alEspera?: (frase: string) => void;
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
  /** Cuando decir la frase de relleno si el servidor no responde (ms). Por omision 3000. */
  readonly rellenoMs?: number;
  /** Presupuesto total y cadencia de reintento ante un 409 "en proceso". Por omision 60 s y 2 s. */
  readonly presupuestoEnProcesoMs?: number;
  readonly intervaloEnProcesoMs?: number;
  /** Reintentos del mismo seq ante 5xx/red/tiempo agotado. Por omision 1. */
  readonly reintentosTecnicos?: number;
  /** Reintentos del mismo seq ante 429 (<= 5 s) o 503 sin `fin`. Por omision 3. */
  readonly reintentosRafaga?: number;
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

export class CerebroVozTurno {
  private telefono: string | null;
  private proximoSeq = 1;
  private abierta = false;
  private cierre: ResultadoTurno | null = null;
  private pedido: string | null = null;
  private enCurso = false;
  private readonly fetchFn: typeof fetch;
  private readonly esperar: NonNullable<OpcionesCerebroVozTurno["esperar"]>;
  private readonly temporizador: NonNullable<OpcionesCerebroVozTurno["temporizador"]>;
  private readonly ahora: () => number;

  constructor(private readonly o: OpcionesCerebroVozTurno) {
    if (!CALL_ID_RE.test(o.callId)) throw new Error("call_id invalido para voz-turno");
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
    return this.enCurso;
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

  private cerrarConFrase(texto: string, motivo: MotivoCierre, turno: number | null = null): ResultadoTurno {
    const r: ResultadoTurno = { texto, colgar: true, motivo, pedidoId: this.pedido, turno };
    this.cierre = r;
    this.log("voz_turno_cierre", { motivo });
    return r;
  }

  /** Apertura (seq 0, texto vacio): saludo con el aviso de privacidad. Si la llamada ya empezo (reconexion) el servidor trae `seq_ultimo` y se continua desde ahi. */
  apertura(opciones: OpcionesTurno = {}): Promise<ResultadoTurno> {
    return this.ejecutar(0, "", opciones);
  }

  /** Un turno con lo que dijo el cliente (o `[silencio]`). */
  turno(texto: string, opciones: OpcionesTurno = {}): Promise<ResultadoTurno> {
    const seq = this.proximoSeq;
    this.proximoSeq += 1;
    return this.ejecutar(seq, texto.slice(0, MAX_TEXTO_CLIENTE), opciones);
  }

  private async ejecutar(seq: number, texto: string, opciones: OpcionesTurno): Promise<ResultadoTurno> {
    if (this.cierre) return { ...this.cierre, turno: null };
    if (this.telefono === null) throw new Error("voz-turno: falta el telefono confirmado");
    this.enCurso = true;
    let dichaEspera = false;
    const decirEspera = (): void => {
      if (dichaEspera) return;
      dichaEspera = true;
      opciones.alEspera?.(FRASE_ESPERA);
    };
    const cancelarRelleno = this.temporizador(decirEspera, this.o.rellenoMs ?? 3000);
    try {
      return await this.pedir(seq, texto, opciones.senal, decirEspera);
    } finally {
      cancelarRelleno();
      this.enCurso = false;
    }
  }

  private async intentar(seq: number, texto: string, senal: AbortSignal | undefined): Promise<Intento> {
    const limite = new AbortController();
    const alAbortar = (): void => limite.abort();
    senal?.addEventListener("abort", alAbortar, { once: true });
    if (senal?.aborted) limite.abort();
    const id = setTimeout(() => limite.abort(), this.o.timeoutMs ?? 35_000);
    try {
      const res = await this.fetchFn(this.o.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-voz-turno-secret": this.o.secreto },
        body: JSON.stringify({ call_id: this.o.callId, telefono: this.telefono, seq, texto }),
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
      if (senal?.aborted) throw new ErrorTurnoAbortado();
      return { tipo: "red", codigo: limite.signal.aborted ? "tiempo_agotado" : "red" };
    } finally {
      clearTimeout(id);
      senal?.removeEventListener("abort", alAbortar);
    }
  }

  private async pedir(seq: number, texto: string, senal: AbortSignal | undefined, decirEspera: () => void): Promise<ResultadoTurno> {
    const reintentosTecnicos = this.o.reintentosTecnicos ?? 1;
    const reintentosRafaga = this.o.reintentosRafaga ?? 3;
    const presupuesto = this.o.presupuestoEnProcesoMs ?? 60_000;
    const intervalo = this.o.intervaloEnProcesoMs ?? 2000;
    let tecnicos = 0;
    let rafagas = 0;
    let inicioEnProceso: number | null = null;
    for (let intento = 1; ; intento += 1) {
      if (senal?.aborted) throw new ErrorTurnoAbortado();
      const r = await this.intentar(seq, texto, senal);
      if (r.tipo === "ok") return this.aceptar(seq, r.cuerpo);

      if (r.tipo === "red") {
        this.log("voz_turno_fallo", { codigo: r.codigo, intento });
        if (tecnicos >= reintentosTecnicos) return this.cerrarConFrase(FRASE_PROBLEMA_TECNICO, "error_tecnico");
        tecnicos += 1;
        await this.esperar(500, senal);
        continue;
      }

      const { estado, cuerpo, retryAfterS } = r;
      this.log("voz_turno_http", { codigo: String(estado), intento });
      if (estado === 429) {
        const espera = retryAfterS ?? 3;
        if (espera > 5) return this.cerrarConFrase(FRASE_TOPE, "tope");
        if (rafagas >= reintentosRafaga) return this.cerrarConFrase(FRASE_PROBLEMA_TECNICO, "error_tecnico");
        rafagas += 1;
        await this.esperar(Math.max(espera, 1) * 1000, senal);
        continue;
      }
      if (estado === 503) {
        if (cuerpo.fin === true && typeof cuerpo.texto === "string" && cuerpo.texto.trim() !== "") return this.cerrarConFrase(cuerpo.texto, "apagado");
        if (cuerpo.fin === true) return this.cerrarConFrase(FRASE_APAGADO, "apagado");
        if (rafagas >= reintentosRafaga) return this.cerrarConFrase(FRASE_PROBLEMA_TECNICO, "error_tecnico");
        rafagas += 1;
        await this.esperar(Math.max(retryAfterS ?? 3, 1) * 1000, senal);
        continue;
      }
      if (estado === 409) {
        const mensaje = typeof cuerpo.error === "string" ? cuerpo.error : "";
        if (!/en proceso|se adelant/i.test(mensaje)) {
          // otro telefono o seq fuera de orden: bug del worker, no se reintenta a ciegas
          return this.cerrarConFrase(FRASE_PROBLEMA_TECNICO, "error_tecnico");
        }
        decirEspera();
        inicioEnProceso ??= this.ahora();
        if (this.ahora() - inicioEnProceso + intervalo > presupuesto) return this.cerrarConFrase(FRASE_DEVOLVER_LLAMADA, "en_proceso_agotado");
        await this.esperar(intervalo, senal);
        continue;
      }
      if (estado >= 500) {
        if (tecnicos >= reintentosTecnicos) return this.cerrarConFrase(FRASE_PROBLEMA_TECNICO, "error_tecnico");
        tecnicos += 1;
        await this.esperar(500, senal);
        continue;
      }
      // 400, 401 y cualquier otro: entrada invalida o secreto incorrecto. No se reintenta.
      return this.cerrarConFrase(FRASE_PROBLEMA_TECNICO, "error_tecnico");
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
