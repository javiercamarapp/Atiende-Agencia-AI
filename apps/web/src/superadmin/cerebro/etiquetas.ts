// Etiquetas de los catalogos del Cerebro para la ficha (las mismas que ya usa la lista de prospectos).
export const NOMBRE_BASE_LICITUD: Readonly<Record<string, string>> = {
  interes_declarado: "Interés declarado",
  relacion_previa: "Relación previa",
  fuente_publica_b2b: "Fuente pública B2B",
  referido_con_consentimiento: "Referido con consentimiento",
};

export const NOMBRE_ORIGEN_PERSONA: Readonly<Record<string, string>> = {
  sitio_web_oficial: "Sitio web oficial",
  directorio_publico: "Directorio público",
  perfil_profesional_publico: "Perfil profesional público",
  formulario_propio: "Formulario propio",
  referido_documentado: "Referido documentado",
};

export const NOMBRE_CANAL_PERSONA: Readonly<Record<string, string>> = { telefono: "Teléfono", correo: "Correo", whatsapp: "WhatsApp", otro: "Otro" };

export const NOMBRE_EVENTO: Readonly<Record<string, string>> = {
  toque_saliente: "Toque saliente",
  toque_entrante: "Toque entrante",
  cambio_etapa: "Cambio de etapa",
  nota: "Nota",
  importacion: "Importación",
  enriquecimiento: "Enriquecimiento",
};

export const NOMBRE_DIMENSION: Readonly<Record<string, string>> = { ajuste: "Ajuste (ICP)", urgencia: "Urgencia", cierre: "Cierre", completitud: "Datos completos" };

/** Solo se enlaza una evidencia http(s): el SQL ya lo exige, y aqui nunca se pinta un `javascript:`. */
export function esUrlHttp(u: string | null | undefined): u is string {
  return typeof u === "string" && /^https?:\/\//iu.test(u);
}
