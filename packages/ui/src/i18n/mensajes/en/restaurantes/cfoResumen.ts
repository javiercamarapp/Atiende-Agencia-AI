import type { Traduccion } from "../../../tipos.ts";
import type { restaurantesCfoResumen } from "../../restaurantes/cfoResumen.ts";

export const restaurantesCfoResumenEn: Traduccion<typeof restaurantesCfoResumen> = {
  "restaurantes.cfoResumen.sinDato": "{etiqueta}: no data",
  "restaurantes.cfoResumen.porSucursal": "KPIs by branch",
  "restaurantes.cfoResumen.indicador": "KPI",
  "restaurantes.cfoResumen.cargando": "Loading the CFO overview…",
  "restaurantes.cfoResumen.loImportante": "What matters most",
  "restaurantes.cfoResumen.ordenar": "Sort findings",
  "restaurantes.cfoResumen.porImpacto": "Sort by $ impact",
  "restaurantes.cfoResumen.porUrgencia": "Sort by urgency",
  "restaurantes.cfoResumen.nadaUrgente": "Nothing urgent this period",
  "restaurantes.cfoResumen.nadaUrgenteMensaje": "No findings exceed the configured thresholds. If data is missing, the notices above say so; a finding only appears with real figures.",
  "restaurantes.cfoResumen.narrado": "Narrative summary",
  "restaurantes.cfoResumen.sinNarrativa": "Not enough data to write the summary.",
  "restaurantes.cfoResumen.indicadores": "KPIs",
  "restaurantes.cfoResumen.noAsignado": "Not assigned to a branch",
  "restaurantes.cfoResumen.costoAgente": "Organization agent cost (text AI, not attributable to a branch): {monto}",
  "restaurantes.cfoResumen.llmSinDato": " · text AI has no data",
};
