// Contrato del Cerebro (mapa y ficha) con el API de Atiende: GET /superadmin/cerebro/prospectos (lista con score, ubicacion y la
// taxonomia vigente por vertical) y GET /superadmin/cerebro/prospectos/:id/detalle (personas y linea de tiempo). Aqui se traduce a
// la forma plana que usa el mapa. REGLA: lo que el API no trae se queda en `null` y la pantalla lo dice ("sin calificar", "no
// disponible"); nunca se rellena con un numero inventado.

export interface SenalApi {
  readonly tipo: string;
  readonly valor: string | null;
  readonly fuente: string;
  readonly url: string | null;
  readonly observadoEn: string;
}

export interface ProspectoApi {
  readonly id: string;
  readonly empresa: string;
  readonly vertical: string;
  readonly ciudad: string | null;
  readonly contactoNombre: string | null;
  readonly telefono: string | null;
  readonly correo: string | null;
  readonly estado: string;
  readonly fuente: string | null;
  readonly notas: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly subtipo?: string | null;
  readonly tamano?: string | null;
  readonly entidad?: string | null;
  readonly municipio?: string | null;
  readonly zona?: string | null;
  readonly lat?: number | null;
  readonly lng?: number | null;
  readonly sitioWeb?: string | null;
  readonly sitioVerificado?: boolean;
  readonly senales?: readonly SenalApi[];
  readonly baseLicitud?: string | null;
  readonly scoreAjuste?: number | null;
  readonly scoreUrgencia?: number | null;
  readonly scoreCierre?: number | null;
  readonly scoreCompletitud?: number | null;
  readonly scoreExplicacion?: unknown;
  readonly scoreVersion?: string | null;
  readonly ultimoToqueEn?: string | null;
  readonly siguientePaso?: string | null;
  readonly siguientePasoEn?: string | null;
  readonly contactoLegado?: boolean;
  /** Los destinos de este prospecto que estan en la lista de supresion de plataforma (SA-L-46); ausente = no se pudo verificar. */
  readonly suprimido?: { readonly telefono: boolean; readonly correo: boolean };
}

export interface TaxonomiaApi {
  readonly vertical: string;
  readonly version: number;
  readonly subtipos: readonly { readonly clave: string; readonly nombre: string }[];
  readonly rangosTamano: { readonly unidad: string; readonly rangos: readonly { readonly clave: string; readonly etiqueta: string }[] };
  readonly mensajesBase: readonly { readonly canal: string; readonly variante: string; readonly texto: string }[];
}

export interface RespuestaProspectosApi {
  readonly disponible: boolean;
  readonly mensaje?: string;
  readonly prospectos: readonly ProspectoApi[];
  readonly taxonomias: readonly TaxonomiaApi[];
}

export interface ProspectoMapa {
  readonly id: string;
  readonly empresa: string;
  readonly vertical: string;
  readonly subtipo: string | null;
  readonly ciudad: string | null;
  readonly municipio: string | null;
  readonly entidad: string | null;
  readonly lat: number | null;
  readonly lng: number | null;
  readonly telefono: string | null;
  readonly correo: string | null;
  readonly contacto: string | null;
  readonly estado: string;
  readonly fuente: string | null;
  readonly tamano: string | null;
  /** Scores 0-100; `null` = "sin calificar" (menos de 3 senales o base sin migrar): nunca se muestra como 0. */
  readonly urgencia: number | null;
  readonly cierre: number | null;
  readonly ajuste: number | null;
  readonly completitud: number | null;
  readonly ultimoToque: string | null;
  readonly creadoEn: string;
  readonly actualizadoEn: string;
  readonly notas: string | null;
  readonly sitioWeb: string | null;
  readonly sitioVerificado: boolean;
  readonly baseLicitud: string | null;
  readonly contactoLegado: boolean;
  readonly siguientePaso: string | null;
  readonly siguientePasoEn: string | null;
  readonly suprimidoTelefono: boolean;
  readonly suprimidoCorreo: boolean;
  /** `true` si el API pudo verificar la supresion; `false` = no se verifico (base sin migrar 0043): se dice en la ficha. */
  readonly supresionVerificada: boolean;
}

export function aProspectoMapa(p: ProspectoApi): ProspectoMapa {
  return {
    id: p.id,
    empresa: p.empresa,
    vertical: p.vertical,
    subtipo: p.subtipo ?? null,
    ciudad: p.ciudad,
    municipio: p.municipio ?? null,
    entidad: p.entidad ?? null,
    lat: typeof p.lat === "number" ? p.lat : null,
    lng: typeof p.lng === "number" ? p.lng : null,
    telefono: p.telefono,
    correo: p.correo,
    contacto: p.contactoNombre,
    estado: p.estado,
    fuente: p.fuente,
    tamano: p.tamano ?? null,
    urgencia: p.scoreUrgencia ?? null,
    cierre: p.scoreCierre ?? null,
    ajuste: p.scoreAjuste ?? null,
    completitud: p.scoreCompletitud ?? null,
    ultimoToque: p.ultimoToqueEn ?? null,
    creadoEn: p.createdAt,
    actualizadoEn: p.updatedAt,
    notas: p.notas,
    sitioWeb: p.sitioWeb ?? null,
    sitioVerificado: p.sitioVerificado === true,
    baseLicitud: p.baseLicitud ?? null,
    contactoLegado: p.contactoLegado === true,
    siguientePaso: p.siguientePaso ?? null,
    siguientePasoEn: p.siguientePasoEn ?? null,
    suprimidoTelefono: p.suprimido?.telefono === true,
    suprimidoCorreo: p.suprimido?.correo === true,
    supresionVerificada: p.suprimido !== undefined,
  };
}

/** Un prospecto con coordenadas validas para el mapa (lat -90..90, lng -180..180). */
export function tieneCoordenadas<T extends { readonly lat: number | null; readonly lng: number | null }>(p: T): p is T & { readonly lat: number; readonly lng: number } {
  return p.lat !== null && p.lng !== null && Number.isFinite(p.lat) && Number.isFinite(p.lng) && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180;
}

// ---- Detalle (ficha) ----

export interface PersonaApi {
  readonly id: string;
  readonly nombre: string;
  readonly cargo: string | null;
  readonly canal: string;
  readonly dato: string | null;
  readonly origen: string;
  readonly confianza: string;
  readonly evidenciaUrl: string;
  readonly creadoEn: string;
}

export interface EventoApi {
  readonly id: string;
  readonly tipo: string;
  readonly detalle: Readonly<Record<string, unknown>>;
  readonly creadoEn: string;
}

export interface RespuestaDetalleApi {
  readonly disponible: boolean;
  readonly mensaje?: string;
  readonly personas: readonly PersonaApi[];
  readonly eventos: readonly EventoApi[];
}

/** Criterio de los scores, con las mismas palabras del modulo que los calcula (apps/api/src/cerebro/scoring.ts): el pie del mapa y la ficha lo muestran. */
export const CRITERIO_SCORES = {
  ajuste: "Ajuste (ICP) = subtipo y tamaño dentro del cliente ideal de la vertical (25 + 25) más las señales de ajuste de su taxonomía (hasta 50).",
  urgencia: "Urgencia = suma de las señales de urgencia de la taxonomía de su vertical (hasta 100); cada punto cita su fuente y su fecha.",
  cierre: "Cierre = señales de cierre (hasta 60) + base de licitud (hasta 25) + una persona de contacto con evidencia (15).",
  completitud: "Datos = qué tan completo está el expediente: campos capturados, siempre calculado.",
  insuficiente: "Con menos de 3 señales válidas (tipo, fuente y fecha) ajuste, urgencia y cierre quedan «sin calificar»: nunca se muestran como 0.",
} as const;
