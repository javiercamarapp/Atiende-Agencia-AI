// Ajustes por ORGANIZACION del agente de restaurantes: modelo y temperatura del agente de WhatsApp, modelo de la cascada de voz, temperatura,
// ritmo y estilo de habla de la voz, y el sonido de fondo opcional de la llamada. Es el equivalente en la arquitectura vigente de lo que el
// original dejaba ajustar en ElevenLabs (modelo, temperatura, velocidad/estilo, sonido de fondo). La clonacion de voz NO se construye: Gemini
// solo tiene el catalogo de 30 voces (`CLONACION_DE_VOZ_ESTADO`).
import {
  AJUSTES_HABLA_POR_DEFECTO,
  FONDO_VOLUMEN_MAX,
  FONDO_VOLUMEN_POR_DEFECTO,
  TEMPERATURA_VOZ_MAX,
  TEMPERATURA_VOZ_MIN,
  esEstiloHabla,
  esRitmoHabla,
  esTemperaturaVoz,
  esVolumenFondo,
} from "@atiende/voice-core";
import type { EstiloHabla, RitmoHabla } from "@atiende/voice-core";
import { MODELO_PREDETERMINADO_ID, esModeloAgentePermitido, modeloAgentePorId } from "./modelos.ts";

export interface AjustesAgente {
  /** Modelo del agente de WhatsApp (id de la lista permitida). null = el de la plataforma. */
  readonly whatsappModelo: string | null;
  /** Temperatura 0..1 del agente de WhatsApp. null = la de siempre (0). Solo si el modelo la admite. */
  readonly whatsappTemperatura: number | null;
  /** Modelo de texto de la cascada de voz (el respaldo de Gemini Live). null = el de la plataforma. */
  readonly vozModeloCascada: string | null;
  /** Temperatura 0..1 de la voz (Gemini Live y, si el modelo la admite, la cascada). null = la del proveedor. */
  readonly vozTemperatura: number | null;
  readonly vozRitmo: RitmoHabla;
  readonly vozEstilo: EstiloHabla;
  /** Sonido de fondo de restaurante en la llamada. Apagado por omision. */
  readonly vozFondoActivo: boolean;
  /** Volumen del fondo, entero 0..FONDO_VOLUMEN_MAX (% de plena escala). */
  readonly vozFondoVolumen: number;
}

export const AJUSTES_AGENTE_POR_DEFECTO: AjustesAgente = Object.freeze({
  whatsappModelo: null,
  whatsappTemperatura: null,
  vozModeloCascada: null,
  vozTemperatura: null,
  vozRitmo: AJUSTES_HABLA_POR_DEFECTO.ritmo,
  vozEstilo: AJUSTES_HABLA_POR_DEFECTO.estilo,
  vozFondoActivo: false,
  vozFondoVolumen: FONDO_VOLUMEN_POR_DEFECTO,
});

/** Estado honesto de la clonacion de voz: no se construye. La pantalla lo muestra tal cual. */
export const CLONACION_DE_VOZ_ESTADO = Object.freeze({
  disponible: false,
  motivo: "No disponible con el proveedor actual: Gemini Live solo ofrece las 30 voces del catalogo y no clona voces.",
  decision: "Clonar una voz exigiria contratar un proveedor de voz aparte (decision de Javier: costo, consentimiento de la persona clonada y una llave nueva).",
});

/** Lo que la plataforma NO genera como documento de conocimiento automatico, y por que (ventas y personal del original). */
export const DOCUMENTOS_AUTO_OMITIDOS = Object.freeze([
  {
    tipo: "ventas",
    motivo: "El agente que atiende al cliente no necesita cifras de ventas para tomar un pedido, y ponerlas en su contexto las expondria a cualquier conversacion. Las preguntas de ventas del dueno las responde el Copiloto con datos en vivo.",
  },
  {
    tipo: "personal",
    motivo: "El personal es informacion de personas (nombres, turnos, contacto): no es conocimiento del agente y no debe salir en una conversacion con un cliente.",
  },
] as const);

export class AjustesInvalidosError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AjustesInvalidosError";
  }
}

export interface AjustesEntrada {
  readonly whatsappModelo?: unknown;
  readonly whatsappTemperatura?: unknown;
  readonly vozModeloCascada?: unknown;
  readonly vozTemperatura?: unknown;
  readonly vozRitmo?: unknown;
  readonly vozEstilo?: unknown;
  readonly vozFondoActivo?: unknown;
  readonly vozFondoVolumen?: unknown;
}

function nulable<T>(v: unknown, valido: (x: unknown) => x is T, mensaje: string): T | null {
  if (v === null) return null;
  if (!valido(v)) throw new AjustesInvalidosError(mensaje);
  return v;
}

function campoRequerido(raw: AjustesEntrada, campo: keyof AjustesEntrada): unknown {
  if (!(campo in raw) || raw[campo] === undefined) throw new AjustesInvalidosError(`${campo}: campo requerido (los ajustes se guardan completos para no borrar por omision lo que un cliente desactualizado no conoce).`);
  return raw[campo];
}

/** El PUT reemplaza TODOS los ajustes: cada campo es obligatorio (null = "usar el de la plataforma"). Valida la lista permitida y que la temperatura solo se
 * pida a un modelo que la admite. */
export function validarAjustesAgente(raw: AjustesEntrada): AjustesAgente {
  const whatsappModelo = nulable(campoRequerido(raw, "whatsappModelo"), esModeloAgentePermitido, "whatsappModelo: no esta en la lista de modelos permitidos.");
  const whatsappTemperatura = nulable(campoRequerido(raw, "whatsappTemperatura"), esTemperaturaVoz, `whatsappTemperatura: un numero entre ${TEMPERATURA_VOZ_MIN} y ${TEMPERATURA_VOZ_MAX}.`);
  const vozModeloCascada = nulable(campoRequerido(raw, "vozModeloCascada"), esModeloAgentePermitido, "vozModeloCascada: no esta en la lista de modelos permitidos.");
  const vozTemperatura = nulable(campoRequerido(raw, "vozTemperatura"), esTemperaturaVoz, `vozTemperatura: un numero entre ${TEMPERATURA_VOZ_MIN} y ${TEMPERATURA_VOZ_MAX}.`);
  const vozRitmo = campoRequerido(raw, "vozRitmo");
  if (!esRitmoHabla(vozRitmo)) throw new AjustesInvalidosError("vozRitmo: pausado, normal o agil.");
  const vozEstilo = campoRequerido(raw, "vozEstilo");
  if (!esEstiloHabla(vozEstilo)) throw new AjustesInvalidosError("vozEstilo: neutro, calido, sobrio o animado.");
  const vozFondoActivo = campoRequerido(raw, "vozFondoActivo");
  if (typeof vozFondoActivo !== "boolean") throw new AjustesInvalidosError("vozFondoActivo: true o false.");
  const vozFondoVolumen = campoRequerido(raw, "vozFondoVolumen");
  if (!esVolumenFondo(vozFondoVolumen)) throw new AjustesInvalidosError(`vozFondoVolumen: un entero entre 0 y ${FONDO_VOLUMEN_MAX}.`);

  const efectivoWa = modeloAgentePorId(whatsappModelo ?? MODELO_PREDETERMINADO_ID);
  if (whatsappTemperatura !== null && efectivoWa && !efectivoWa.aceptaTemperatura) {
    throw new AjustesInvalidosError(`whatsappTemperatura: ${efectivoWa.etiqueta} no admite temperatura; elige otro modelo o deja la temperatura en automatica.`);
  }
  return { whatsappModelo, whatsappTemperatura, vozModeloCascada, vozTemperatura, vozRitmo, vozEstilo, vozFondoActivo, vozFondoVolumen };
}

/** Temperatura que el turno de WhatsApp manda al gateway: la elegida si el modelo la admite; si no, 0 (como siempre). */
export function temperaturaEfectivaWhatsapp(ajustes: Pick<AjustesAgente, "whatsappModelo" | "whatsappTemperatura">): number {
  const modelo = modeloAgentePorId(ajustes.whatsappModelo ?? MODELO_PREDETERMINADO_ID);
  if (ajustes.whatsappTemperatura !== null && modelo?.aceptaTemperatura) return ajustes.whatsappTemperatura;
  return 0;
}

/** Lo que el servicio de llamadas necesita al abrir una llamada (modelo de cascada y temperatura para el proveedor; el fondo para el worker). */
export interface AjustesDeLlamada {
  readonly modeloCascada: string | null;
  readonly temperatura: number | null;
  readonly ritmo: RitmoHabla;
  readonly estilo: EstiloHabla;
  readonly fondo: { readonly activo: boolean; readonly volumen: number };
}

export function ajustesDeLlamada(ajustes: AjustesAgente): AjustesDeLlamada {
  return {
    modeloCascada: ajustes.vozModeloCascada,
    temperatura: ajustes.vozTemperatura,
    ritmo: ajustes.vozRitmo,
    estilo: ajustes.vozEstilo,
    fondo: { activo: ajustes.vozFondoActivo && ajustes.vozFondoVolumen > 0, volumen: ajustes.vozFondoActivo ? ajustes.vozFondoVolumen : 0 },
  };
}
