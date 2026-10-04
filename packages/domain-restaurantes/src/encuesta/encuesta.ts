// Encuesta post-entrega (R-41, migracion 061). Tipos, validaciones y calculos puros. Las definiciones de cada cifra viven en el
// encabezado de packages/domain-restaurantes/migrations/061_encuesta_post_entrega.sql y los rotulos de la pantalla las repiten.
// Un dato que no existe es `null`, jamas 0 (promedio sin respuestas, tasa de respuesta sin envios).
import { porcentaje } from "../whatsapp-kpi/kpi.ts";

/** Calificaciones admitidas (estrellas). */
export const ENCUESTA_CALIFICACION_MIN = 1;
export const ENCUESTA_CALIFICACION_MAX = 5;
/** A partir de esta calificacion o menos, el staff recibe una notificacion in-app ("algo que atender"). */
export const ENCUESTA_CALIFICACION_BAJA_MAX = 2;
export const ENCUESTA_COMENTARIO_MAX = 1000;
export const ENCUESTA_ESPERA_MIN_RANGO = { min: 5, max: 1440 } as const;
export const ENCUESTA_RESENAS_URL_MAX = 500;
/** Misma regla que el CHECK de la base: solo https, host sin credenciales, sin espacios ni `<>"`. */
const RESENAS_URL_RE = /^https:\/\/[A-Za-z0-9.-]+(:[0-9]{1,5})?(\/[^\s<>"]*)?$/;

export class EncuestaValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EncuestaValidationError";
  }
}

/** La base todavia no tiene la migracion 061: una escritura explicita (guardar la configuracion) no puede fingir exito. */
export class EncuestaNoDisponibleError extends Error {
  constructor() {
    super("La encuesta post-entrega todavía no está disponible en esta base de datos (requiere la migración 061).");
    this.name = "EncuestaNoDisponibleError";
  }
}

export interface EncuestaConfig {
  readonly activa: boolean;
  /** Minutos que se espera tras la entrega antes de enviar la encuesta. */
  readonly esperaMin: number;
  /** Liga de resenas de la sucursal (https). Se ofrece solo con calificacion >= `umbralResena`. */
  readonly resenasUrl: string | null;
  readonly umbralResena: number;
}

export const ENCUESTA_CONFIG_DEFECTO: EncuestaConfig = { activa: false, esperaMin: 30, resenasUrl: null, umbralResena: 4 };

export interface EncuestaConfigEntrada {
  readonly activa: boolean;
  readonly esperaMin: number;
  readonly resenasUrl: string | null;
  readonly umbralResena: number;
}

/** Normaliza y valida lo que llega del panel; lanza `EncuestaValidationError` con un mensaje apto para el usuario. */
export function validarConfigEntrada(raw: { readonly activa?: unknown; readonly esperaMin?: unknown; readonly resenasUrl?: unknown; readonly umbralResena?: unknown }): EncuestaConfigEntrada {
  if (typeof raw.activa !== "boolean") throw new EncuestaValidationError("activa debe ser verdadero o falso.");
  const esperaMin = raw.esperaMin;
  if (typeof esperaMin !== "number" || !Number.isInteger(esperaMin) || esperaMin < ENCUESTA_ESPERA_MIN_RANGO.min || esperaMin > ENCUESTA_ESPERA_MIN_RANGO.max) {
    throw new EncuestaValidationError(`La espera debe ser un entero de ${ENCUESTA_ESPERA_MIN_RANGO.min} a ${ENCUESTA_ESPERA_MIN_RANGO.max} minutos.`);
  }
  const umbral = raw.umbralResena;
  if (typeof umbral !== "number" || !Number.isInteger(umbral) || umbral < ENCUESTA_CALIFICACION_MIN || umbral > ENCUESTA_CALIFICACION_MAX) {
    throw new EncuestaValidationError("El umbral de reseña debe ser un entero de 1 a 5.");
  }
  let url: string | null = null;
  if (raw.resenasUrl !== null && raw.resenasUrl !== undefined) {
    if (typeof raw.resenasUrl !== "string") throw new EncuestaValidationError("La liga de reseñas debe ser texto.");
    const limpia = raw.resenasUrl.trim();
    if (limpia !== "") {
      if (limpia.length > ENCUESTA_RESENAS_URL_MAX || !RESENAS_URL_RE.test(limpia)) {
        throw new EncuestaValidationError("La liga de reseñas debe ser una URL https válida (sin usuario ni espacios, máximo 500 caracteres).");
      }
      url = limpia;
    }
  }
  return { activa: raw.activa, esperaMin, resenasUrl: url, umbralResena: umbral };
}

/** Calificacion 1-5 entera. */
export function validarCalificacion(v: unknown): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < ENCUESTA_CALIFICACION_MIN || v > ENCUESTA_CALIFICACION_MAX) {
    throw new EncuestaValidationError("La calificación debe ser un entero de 1 a 5.");
  }
  return v;
}

/** Comentario opcional: recortado; vacio = null; maximo 1000 caracteres. */
export function normalizarComentario(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") throw new EncuestaValidationError("El comentario debe ser texto.");
  const limpio = v.trim();
  if (limpio === "") return null;
  if ([...limpio].length > ENCUESTA_COMENTARIO_MAX) throw new EncuestaValidationError(`El comentario no puede pasar de ${ENCUESTA_COMENTARIO_MAX} caracteres.`);
  return limpio;
}

export interface EncuestaPromedio {
  readonly enviadas: number;
  readonly respondidas: number;
  /** Promedio (2 decimales) de las respuestas de la cohorte; null sin respuestas. */
  readonly promedio: number | null;
}

export interface EncuestaPorSucursal extends EncuestaPromedio {
  readonly propertyId: string;
  readonly nombre: string;
}

export interface EncuestaPorRepartidor extends EncuestaPromedio {
  readonly repartidorId: string;
  readonly nombre: string;
}

export interface EncuestaComentario {
  readonly id: string;
  /** Numero de pedido visible para el staff. */
  readonly pedido: number | null;
  readonly propertyId: string;
  readonly sucursal: string;
  readonly calificacion: number;
  readonly comentario: string | null;
  readonly respondidaAt: string;
  readonly repartidor: string | null;
}

export interface EncuestaResumen {
  readonly global: EncuestaPromedio & {
    /** Cantidad de respuestas con 1, 2, 3, 4 y 5 estrellas. */
    readonly distribucion: readonly [number, number, number, number, number];
  };
  readonly porSucursal: readonly EncuestaPorSucursal[];
  readonly porRepartidor: readonly EncuestaPorRepartidor[];
  readonly recientes: readonly EncuestaComentario[];
}

export const ENCUESTA_RESUMEN_VACIO: EncuestaResumen = {
  global: { enviadas: 0, respondidas: 0, promedio: null, distribucion: [0, 0, 0, 0, 0] },
  porSucursal: [],
  porRepartidor: [],
  recientes: [],
};

/** Tasa de respuesta (%, un decimal) = respondidas / enviadas de la misma cohorte; null sin envios. */
export function tasaRespuestaPct(p: EncuestaPromedio): number | null {
  return porcentaje(p.respondidas, p.enviadas);
}

/** Lectura con estado honesto: `disponible: false` = la base todavia no tiene la migracion 061 (nunca se confunde con "no hay datos"). */
export interface EncuestaLectura<T> {
  readonly disponible: boolean;
  readonly valor: T;
}

/** Un pedido entregado al que toca enviar la encuesta (solo sistema: lleva telefono y nombre para el WhatsApp). */
export interface EncuestaCandidata {
  readonly orderId: string;
  readonly organizationId: string;
  readonly propertyId: string;
  readonly orgSlug: string;
  readonly sucursal: string;
  readonly customerName: string;
  readonly customerPhone: string;
}

/** Lo que ve el cliente en la pagina publica: nada personal. */
export interface EncuestaPublica {
  readonly sucursal: string;
  readonly respondida: boolean;
  readonly calificacion: number | null;
  /** Solo si ya respondio con calificacion >= umbral y la sucursal configuro la liga. */
  readonly resenasUrl: string | null;
}

export type EncuestaRespuestaEstado = "registrada" | "ya_respondida" | "no_encontrada";

export interface EncuestaRespuestaResultado {
  readonly estado: EncuestaRespuestaEstado;
  readonly propertyId: string | null;
  readonly calificacion: number | null;
  readonly resenasUrl: string | null;
}

/** Puerto de la encuesta. Staff (config/resumen) exige owner/admin; sistema (candidatas/registro/publica/responder) exige sesion sin usuario. */
export interface EncuestaRepository {
  leerConfig(organizationId: string, propertyId: string): Promise<EncuestaLectura<EncuestaConfig>>;
  /** Lanza `EncuestaNoDisponibleError` contra la base sin migrar. */
  guardarConfig(organizationId: string, propertyId: string, entrada: EncuestaConfigEntrada): Promise<EncuestaConfig>;
  resumen(organizationId: string, desde: string, hasta: string, propertyId: string | null): Promise<EncuestaLectura<EncuestaResumen>>;
  candidatas(organizationId: string | null, ahora: Date | null, limite: number): Promise<EncuestaLectura<readonly EncuestaCandidata[]>>;
  /** true = fila nueva reservada; false = el pedido ya tenia encuesta (idempotente). */
  registrarEnvio(organizationId: string, orderId: string): Promise<boolean>;
  publica(organizationId: string, orderId: string): Promise<EncuestaLectura<EncuestaPublica | null>>;
  responder(organizationId: string, orderId: string, calificacion: number, comentario: string | null): Promise<EncuestaLectura<EncuestaRespuestaResultado | null>>;
}
