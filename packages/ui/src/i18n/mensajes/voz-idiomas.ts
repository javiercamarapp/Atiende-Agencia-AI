import type { ModuloEs } from "../tipos.ts";

/** Selector de idiomas del agente de VOZ por sucursal (Agente de voz -> Voz). La traduccion vive en `en/voz-idiomas.ts`. */
export const vozIdiomas = {
  "vozIdiomas.titulo": "Idiomas del agente de voz",
  "vozIdiomas.descripcion": "En qué idioma saluda el agente y a cuáles puede cambiar durante la llamada. Solo cambia cómo habla; ninguna regla del negocio cambia.",
  "vozIdiomas.principal": "Idioma principal",
  "vozIdiomas.adicionales": "Idiomas adicionales",
  "vozIdiomas.adicionales.vacio": "Sin idiomas adicionales: el agente habla solo el idioma principal.",
  "vozIdiomas.adicionales.agregar": "Agregar idioma",
  "vozIdiomas.adicionales.elegir": "Elige un idioma…",
  "vozIdiomas.adicionales.quitar": "Quitar {idioma}",
  "vozIdiomas.adicionales.tope": { one: "Máximo {count} idioma adicional.", other: "Máximo {count} idiomas adicionales." },
  "vozIdiomas.deteccion": "Detectar el idioma del cliente",
  "vozIdiomas.deteccion.ayuda": "Si el cliente habla en uno de los idiomas adicionales, el agente le contesta en ese idioma el resto de la llamada.",
  "vozIdiomas.deteccion.requiereAdicional": "Agrega al menos un idioma adicional para activar la detección.",
  "vozIdiomas.guardar": "Guardar idiomas",
  "vozIdiomas.guardando": "Guardando…",
  "vozIdiomas.descartar": "Descartar",
  "vozIdiomas.guardado": "Idiomas guardados.",
  "vozIdiomas.noDisponible": "No disponible aún: requiere el PR #712 y la migración 181 en la base. Mientras tanto el agente habla solo español (México).",
  "vozIdiomas.error.cargar": "No se pudieron cargar los idiomas del agente.",
  "vozIdiomas.error.guardar": "No se pudieron guardar los idiomas.",
  "vozIdiomas.soloVoz": "Aplica a las llamadas de esta sucursal. El agente de WhatsApp no usa este ajuste.",
} as const satisfies ModuloEs;
