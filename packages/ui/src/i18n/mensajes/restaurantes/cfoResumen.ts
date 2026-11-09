import type { ModuloEs } from "../../tipos.ts";

/** CFO, pestana Resumen: lo mas importante, resumen narrado e indicadores. Ingles: `en/restaurantes/cfoResumen.ts`. */
export const restaurantesCfoResumen = {
  "restaurantes.cfoResumen.sinDato": "{etiqueta}: sin dato",
  "restaurantes.cfoResumen.porSucursal": "Indicadores por sucursal",
  "restaurantes.cfoResumen.indicador": "Indicador",
  "restaurantes.cfoResumen.cargando": "Cargando el resumen del CFO…",
  "restaurantes.cfoResumen.loImportante": "Lo más importante",
  "restaurantes.cfoResumen.ordenar": "Ordenar hallazgos",
  "restaurantes.cfoResumen.porImpacto": "Ordenar por impacto $",
  "restaurantes.cfoResumen.porUrgencia": "Ordenar por urgencia",
  "restaurantes.cfoResumen.nadaUrgente": "Nada urgente en este periodo",
  "restaurantes.cfoResumen.nadaUrgenteMensaje": "No hay hallazgos que superen los umbrales configurados. Si faltan datos, los avisos de arriba lo dicen; un hallazgo solo aparece con cifras reales.",
  "restaurantes.cfoResumen.narrado": "Resumen narrado",
  "restaurantes.cfoResumen.sinNarrativa": "Sin datos suficientes para redactar el resumen.",
  "restaurantes.cfoResumen.indicadores": "Indicadores",
  "restaurantes.cfoResumen.noAsignado": "No asignado a una sucursal",
  "restaurantes.cfoResumen.costoAgente": "Costo del agente de la organización (IA de texto, no atribuible a una sucursal): {monto}",
  "restaurantes.cfoResumen.llmSinDato": " · IA de texto sin dato",
} as const satisfies ModuloEs;
