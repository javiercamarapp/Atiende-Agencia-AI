// Cerebro "suelto" de una llamada: puerto LLM (`PuertoLlmVoz`) que, en vez de un modelo con herramientas, llama a `voz-turno` (ver `cerebro-voz-turno.ts`).
// Se conecta a la cascada v2 existente (Deepgram STT -> este puerto -> Deepgram TTS): la sesion le pasa el historial, el puerto solo usa el ULTIMO mensaje del cliente
// y devuelve el texto del servidor sin herramientas. Tambien lleva:
//  - la fase de TELEFONO OCULTO: si el caller ID no sirve, el worker mismo dice el aviso de grabacion, pide y confirma el numero ANTES de la apertura (seq 0);
//  - la vigilancia de SILENCIO (`VigiaSilencio`): tras ~8 s sin voz se manda `[silencio]` como un turno mas.
import { esAfirmacion } from "@atiende/voice-core";
import type { PuertoLlmVoz } from "@atiende/voice-core";
import { CerebroVozTurno, FRASE_DEVOLVER_LLAMADA, TEXTO_SILENCIO } from "./cerebro-voz-turno.ts";
import { telefonoDictadoPlausible } from "./telefono-llamante.ts";
import type { MotivoCierre, OpcionesCerebroVozTurno, ResultadoTurno } from "./cerebro-voz-turno.ts";

export const AVISO_GRABACION_POR_OMISION = "Esta llamada se graba para mejorar el servicio. Su aviso de privacidad completo está en nuestro sitio web y puede pedírmelo cuando guste.";
export const PREAMBULO_POR_OMISION = "Le atiende el asistente virtual de Los Taquitos de PM.";
export const SILENCIO_POR_OMISION_MS = 8000;
export const SALUDO_SIN_AVISO = "¿En qué le puedo ayudar?";

const escaparRe = (t: string): string => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Quita de la respuesta de la apertura las frases que el worker YA dijo (aviso de grabacion y preambulo). Un servidor que aun no soporta `aviso_dado` las repite y el
 * cliente oiria el aviso dos veces. Compara sin importar mayusculas ni espacios; si no queda nada, un saludo corto.
 */
export function quitarFrasesDichas(texto: string, frases: readonly string[]): string {
  let t = texto;
  for (const f of frases) {
    const limpia = f.trim();
    if (limpia === "") continue;
    t = t.replace(new RegExp(escaparRe(limpia).replace(/\s+/g, "\\s+"), "gi"), " ");
  }
  t = t.replace(/\s+/g, " ").replace(/^[\s.,;:-]+/, "").trim();
  return t === "" ? SALUDO_SIN_AVISO : t;
}

const DIGITOS: Readonly<Record<string, string>> = { cero: "0", uno: "1", una: "1", dos: "2", tres: "3", cuatro: "4", cinco: "5", seis: "6", siete: "7", ocho: "8", nueve: "9" };

/** Los 10 digitos que dicto el cliente (cifras o palabras; acepta 52 / 521 delante), o null si no son 10. */
export function extraerTelefonoDictado(texto: string): string | null {
  const palabras = texto.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((p) => p !== "");
  let d = "";
  for (const p of palabras) {
    if (/^\d+$/.test(p)) d += p;
    else if (DIGITOS[p] !== undefined) d += DIGITOS[p];
  }
  if (d.length === 10) return d;
  if (d.length === 12 && d.startsWith("52")) return d.slice(2);
  if (d.length === 13 && d.startsWith("521")) return d.slice(3);
  return null;
}

/** "9 9 9, 1 2 3, 4 5 6 7": para que el cliente lo confirme digito por digito. */
export function telefonoEnGrupos(t: string): string {
  return [t.slice(0, 3), t.slice(3, 6), t.slice(6)].map((g) => g.split("").join(" ")).join(", ");
}

export type ResultadoConfirmarTelefono = { readonly ok: true } | { readonly ok: false };

export interface OpcionesCerebroSuelto extends Omit<OpcionesCerebroVozTurno, "telefono"> {
  /** Telefono confiable del caller ID (10 digitos) o null (numero oculto o de la sucursal: se pide al cliente). */
  readonly telefono: string | null;
  /** Texto con el que la cascada dispara el saludo (`DISPARADOR_SALUDO`): se traduce a la apertura (seq 0). */
  readonly disparadorApertura: string;
  readonly aviso?: string;
  readonly preambulo?: string;
  /** Valida y registra el telefono dictado (rechaza numeros de la sucursal/puente, emite el token de la llamada). */
  readonly confirmarTelefono?: (telefono: string) => Promise<ResultadoConfirmarTelefono>;
  /** El turno pide colgar tras hablar (el worker cuelga cuando la sintesis termina). */
  readonly alColgar?: (motivo: MotivoCierre, pedidoId: string | null) => void;
}

type Fase = "pidiendo_telefono" | "confirmando_telefono" | "activa";

export class CerebroSuelto {
  readonly puerto: PuertoLlmVoz;
  private readonly core: CerebroVozTurno;
  private fase: Fase;
  private candidato: string | null = null;
  private intentosTelefono = 0;
  private silenciosLocales = 0;
  private colgado: ResultadoTurno | null = null;
  private fin = 0;

  constructor(private readonly o: OpcionesCerebroSuelto) {
    this.core = new CerebroVozTurno({ ...o, telefono: o.telefono });
    this.fase = o.telefono === null ? "pidiendo_telefono" : "activa";
    this.puerto = {
      completar: async (p) => {
        const ultimo = [...p.mensajes].reverse().find((m) => m.role === "user");
        const texto = ultimo?.content ?? "";
        const r = await this.procesar(texto, p.senal, p.onTextDelta);
        p.onTextDelta?.(`${r.texto} `);
        return { texto: r.texto, toolCalls: [], costoMicroUsd: 0, finishReason: "stop" };
      },
    };
  }

  get pedidoId(): string | null {
    return this.core.pedidoId;
  }
  get ocupado(): boolean {
    return this.core.ocupado;
  }
  /** Instante (reloj del cerebro) del ultimo turno terminado; la vigilancia de silencio cuenta desde ahi si es posterior al ultimo audio. */
  get ultimaActividad(): number {
    return this.fin;
  }
  get cierre(): ResultadoTurno | null {
    return this.colgado;
  }

  private colgarCon(texto: string, motivo: MotivoCierre): ResultadoTurno {
    const r: ResultadoTurno = { texto, colgar: true, motivo, pedidoId: this.core.pedidoId, turno: null };
    this.colgado = r;
    return r;
  }

  private async procesar(texto: string, senal: AbortSignal | undefined, alTexto: ((d: string) => void) | undefined): Promise<ResultadoTurno> {
    const ahora = this.o.ahora ?? (() => Date.now());
    const alEspera = (frase: string): void => alTexto?.(`${frase} `);
    // Barge-in con la peticion anterior aun en vuelo: su respuesta (total, confirmacion del pedido) se habla antes de la de este turno.
    const alRespuestaPrevia = (previa: string): void => alTexto?.(`${previa} `);
    const opciones = { ...(senal ? { senal } : {}), alEspera, alRespuestaPrevia };
    let r: ResultadoTurno;
    if (this.colgado) r = this.colgado;
    else if (this.fase === "activa") {
      r = texto === this.o.disparadorApertura ? await this.core.apertura(opciones) : await this.core.turno(texto, opciones);
    } else r = await this.faseTelefono(texto, opciones);
    this.fin = ahora();
    if (r.colgar) {
      this.colgado = r;
      this.o.alColgar?.(r.motivo ?? "fin_servidor", r.pedidoId);
    }
    return r;
  }

  private async faseTelefono(texto: string, opciones: { senal?: AbortSignal; alEspera: (f: string) => void; alRespuestaPrevia: (t: string) => void }): Promise<ResultadoTurno> {
    const aviso = this.o.aviso ?? AVISO_GRABACION_POR_OMISION;
    const pre = this.o.preambulo ?? PREAMBULO_POR_OMISION;
    const sigue = (t: string): ResultadoTurno => ({ texto: t, colgar: false, motivo: null, pedidoId: null, turno: null });
    if (texto === this.o.disparadorApertura) return sigue(`${pre} ${aviso} ¿Me da su número de teléfono a diez dígitos, por favor?`);
    if (texto === TEXTO_SILENCIO) {
      this.silenciosLocales += 1;
      if (this.silenciosLocales >= 2) return this.colgarCon(FRASE_DEVOLVER_LLAMADA, "silencio");
      return sigue("¿Sigue ahí? Necesito su número de teléfono a diez dígitos.");
    }
    this.silenciosLocales = 0;
    const dictado = extraerTelefonoDictado(texto);
    if (this.fase === "confirmando_telefono" && dictado === null && this.candidato !== null) {
      if (esAfirmacion(texto)) {
        const confirmado = this.candidato;
        const res = this.o.confirmarTelefono ? await this.o.confirmarTelefono(confirmado) : { ok: true as const };
        if (res.ok && this.core.fijarTelefono(confirmado)) {
          this.fase = "activa";
          // El worker ya dijo el aviso: el servidor debe saludar corto (`aviso_dado`); si es un servidor viejo y lo repite, se le quita.
          const apertura = await this.core.apertura({ ...opciones, avisoDado: true });
          return apertura.colgar ? apertura : { ...apertura, texto: quitarFrasesDichas(apertura.texto, [aviso, AVISO_GRABACION_POR_OMISION, pre, PREAMBULO_POR_OMISION]) };
        }
        this.fase = "pidiendo_telefono";
        this.candidato = null;
        return this.fallarTelefono("Ese número no me sirve para el pedido. ¿Me da otro número de teléfono a diez dígitos, por favor?");
      }
      this.fase = "pidiendo_telefono";
      this.candidato = null;
      return this.fallarTelefono("Disculpe. ¿Me repite su número de teléfono a diez dígitos?");
    }
    if (dictado === null) return this.fallarTelefono("No alcancé a entender el número. ¿Me lo repite completo, a diez dígitos?");
    if (!telefonoDictadoPlausible(dictado)) return this.fallarTelefono("Ese número no parece válido. ¿Me lo repite completo, a diez dígitos?");
    this.candidato = dictado;
    this.fase = "confirmando_telefono";
    return sigue(`Le repito su número: ${telefonoEnGrupos(dictado)}. ¿Es correcto?`);
  }

  private fallarTelefono(frase: string): ResultadoTurno {
    this.intentosTelefono += 1;
    if (this.intentosTelefono >= 3) return this.colgarCon("No logré registrar su número. Una persona le devolverá la llamada. Hasta luego.", "telefono_no_obtenido");
    return { texto: frase, colgar: false, motivo: null, pedidoId: null, turno: null };
  }
}

/** Manda `[silencio]` una vez por episodio de silencio (`umbralMs`) y solo si no hay un turno en curso. Se alimenta con los eventos `silencio(ms)` del puente (uno por segundo). */
export class VigiaSilencio {
  private ultimoMs = 0;
  private disparado = false;

  constructor(
    private readonly o: { readonly umbralMs: number; readonly ocupado: () => boolean; readonly ultimaActividad: () => number; readonly ahora: () => number; readonly disparar: () => void },
  ) {}

  registrar(ms: number): void {
    if (ms < this.ultimoMs) this.disparado = false;
    this.ultimoMs = ms;
    if (this.disparado || this.o.ocupado()) return;
    const actividad = this.o.ultimaActividad();
    const desdeCerebro = actividad > 0 ? this.o.ahora() - actividad : Number.POSITIVE_INFINITY;
    if (Math.min(ms, desdeCerebro) < this.o.umbralMs) return;
    this.disparado = true;
    this.o.disparar();
  }
}
