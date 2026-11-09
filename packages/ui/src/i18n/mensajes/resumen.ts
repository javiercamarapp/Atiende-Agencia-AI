import type { ModuloEs } from "../tipos.ts";

/** Marco comun del Resumen (`ResumenLayout`): antetitulo, H1 ds3, franja de estado de los datos y «Requiere tu atención». Ingles: `en/resumen.ts`. */
export const resumen = {
  "resumen.eyebrow": "Resumen",
  "resumen.titulo": "Resumen",
  "resumen.estadoDatos": "Estado de los datos",
  "resumen.atencion": "Requiere tu atención",
  "resumen.atencionVacia": "Nada requiere tu atención ahora.",
} as const satisfies ModuloEs;
