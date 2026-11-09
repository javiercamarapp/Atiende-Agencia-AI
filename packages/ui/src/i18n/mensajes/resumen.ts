import type { ModuloEs } from "../tipos.ts";

/** Marco comun del Resumen (`ResumenLayout`): antetitulo, H1 ds3, franja de estado de los datos y «Requiere tu atención». Ingles: `en/resumen.ts`. */
export const resumen = {
  "resumen.eyebrow": "Resumen",
  "resumen.titulo": "Resumen",
  "resumen.estadoDatos": "Estado de los datos",
  "resumen.atencion": "Requiere tu atención",
  "resumen.atencionVacia": "Nada requiere tu atención ahora.",
  "resumen.info.comoSeCalculo": "Cómo se calculó",
  "resumen.info.comoSeCalcula": "Cómo se calcula",
  "resumen.info.deDondeSale": "De dónde sale",
  "resumen.info.periodo": "Periodo",
  "resumen.info.alcance": "Alcance",
  "resumen.info.queNoSabemos": "Qué no sabemos",
  "resumen.info.claseDeDato": "Clase de dato",
  "resumen.info.clase.observado": "Observado",
  "resumen.info.clase.estimado": "Estimado",
  "resumen.info.clase.inferido": "Inferido",
} as const satisfies ModuloEs;
