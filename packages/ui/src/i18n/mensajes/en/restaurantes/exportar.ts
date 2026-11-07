import type { Traduccion } from "../../../tipos.ts";
import type { restaurantesExportar } from "../../restaurantes/exportar.ts";

export const restaurantesExportarEn: Traduccion<typeof restaurantesExportar> = {
  "restaurantes.exportar.boton": "Export",
  "restaurantes.exportar.listaCsv": "Export ready (CSV, open it with Excel).",
  "restaurantes.exportar.listaPdf": "Export ready (PDF).",
  "restaurantes.exportar.error": "Couldn't export.",
  "restaurantes.exportar.pdf": "PDF document",
  "restaurantes.exportar.csv": "CSV (for Excel)",
};
