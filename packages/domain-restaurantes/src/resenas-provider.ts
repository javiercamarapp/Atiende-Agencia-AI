// Puerto de resenas externas (Google Business Profile, huecos-finales-restaurantes seccion 8). NO se construye la
// integracion real: Google aprueba el acceso a la Business Profile API aparte y tarda (ver docs/RESTAURANTES-GOOGLE-BUSINESS.md).
// Aqui quedan la interfaz, un adaptador falso para pruebas y el adaptador "no disponible aun" (honesto: nunca finge) y la
// regla del dominio: la respuesta a una resena de <= 3 estrellas SIEMPRE necesita aprobacion humana antes de publicarse
// (mismo criterio que `respondToGuestReview` de hoteles: el agente redacta un borrador, una persona lo aprueba).
import { contieneIncentivoDeResena } from "./encuesta-reglas.ts";

export interface ResenaExterna {
  readonly id: string;
  readonly sucursalSlug: string;
  /** 1 a 5 estrellas. */
  readonly calificacion: number;
  readonly texto: string;
  readonly creadaEn: string;
}

export interface ResenasProvider {
  /** false = el proveedor no esta conectado (sin acceso aprobado a la API): las operaciones lanzan `ResenasNoDisponiblesError`. */
  readonly disponible: boolean;
  listarResenas(args: { readonly sucursalSlug: string; readonly desde?: string }): Promise<readonly ResenaExterna[]>;
  publicarRespuesta(args: { readonly resenaId: string; readonly texto: string }): Promise<{ readonly publicada: boolean }>;
}

export class ResenasNoDisponiblesError extends Error {
  constructor() {
    super("Las reseñas de Google no están disponibles aún: requieren el acceso aprobado a la Business Profile API de Google.");
    this.name = "ResenasNoDisponiblesError";
  }
}

export class RespuestaRequiereAprobacionError extends Error {
  constructor(readonly calificacion: number) {
    super(`La respuesta a una reseña de ${calificacion} estrella(s) necesita la aprobación de una persona antes de publicarse.`);
    this.name = "RespuestaRequiereAprobacionError";
  }
}

/** Umbral de calificacion (inclusive) hasta el cual la aprobacion humana es OBLIGATORIA. */
export const RESENA_APROBACION_OBLIGATORIA_HASTA = 3;

export function requiereAprobacionHumana(calificacion: number): boolean {
  return calificacion <= RESENA_APROBACION_OBLIGATORIA_HASTA;
}

/** Adaptador real pendiente: nunca devuelve datos inventados. */
export function resenasProviderNoDisponible(): ResenasProvider {
  return {
    disponible: false,
    async listarResenas() {
      throw new ResenasNoDisponiblesError();
    },
    async publicarRespuesta() {
      throw new ResenasNoDisponiblesError();
    },
  };
}

/** Adaptador falso en memoria, SOLO para pruebas. */
export class FakeResenasProvider implements ResenasProvider {
  readonly disponible = true;
  readonly respuestas: Array<{ resenaId: string; texto: string }> = [];
  constructor(private readonly resenas: readonly ResenaExterna[] = []) {}
  async listarResenas(args: { sucursalSlug: string; desde?: string }): Promise<readonly ResenaExterna[]> {
    return this.resenas.filter((r) => r.sucursalSlug === args.sucursalSlug && (!args.desde || r.creadaEn >= args.desde));
  }
  async publicarRespuesta(args: { resenaId: string; texto: string }): Promise<{ publicada: boolean }> {
    this.respuestas.push({ resenaId: args.resenaId, texto: args.texto });
    return { publicada: true };
  }
}

/** Borrador de respuesta (plantilla, trato de usted, sin incentivos). Una persona lo revisa; nunca promete compensaciones. */
export function redactarBorradorRespuesta(resena: ResenaExterna, nombreSucursal: string): string {
  if (resena.calificacion >= 4) return `Gracias por su reseña de ${nombreSucursal}. Nos da gusto que haya disfrutado su pedido; lo esperamos pronto.`;
  return `Lamentamos que su experiencia en ${nombreSucursal} no haya sido la esperada. Nos gustaría atenderle: por favor llame a la sucursal y con gusto revisamos lo ocurrido.`;
}

/**
 * Publica la respuesta a una resena. <= 3 estrellas: exige `aprobadaPor` (id de la persona que la reviso); sin eso lanza
 * `RespuestaRequiereAprobacionError` y NO llama al proveedor. Un texto con incentivo o condicion se rechaza siempre.
 */
export async function publicarRespuestaAResena(
  provider: ResenasProvider,
  resena: ResenaExterna,
  texto: string,
  aprobadaPor: string | null,
): Promise<{ readonly publicada: boolean }> {
  if (contieneIncentivoDeResena(texto)) throw new Error("La respuesta no puede ofrecer incentivos ni condicionar reseñas.");
  if (requiereAprobacionHumana(resena.calificacion) && !aprobadaPor) throw new RespuestaRequiereAprobacionError(resena.calificacion);
  return provider.publicarRespuesta({ resenaId: resena.id, texto });
}
