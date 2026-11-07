import type { ModuloEs } from "../../tipos.ts";

/** Boton Exportar (CSV/PDF) de Historial y Clientes. Ingles: `en/restaurantes/exportar.ts`. */
export const restaurantesExportar = {
  "restaurantes.exportar.boton": "Exportar",
  "restaurantes.exportar.listaCsv": "Exportación lista (CSV, ábrelo con Excel).",
  "restaurantes.exportar.listaPdf": "Exportación lista (PDF).",
  "restaurantes.exportar.error": "No se pudo exportar.",
  "restaurantes.exportar.pdf": "PDF",
  "restaurantes.exportar.csv": "CSV (Excel)",
} as const satisfies ModuloEs;
