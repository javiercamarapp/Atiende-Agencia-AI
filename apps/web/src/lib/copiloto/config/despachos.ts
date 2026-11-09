// Configuracion del Copiloto de DESPACHOS (CHAT-11). Todas las preguntas dicen su periodo (o no lo necesitan: cartera, antigüedad,
// cierres, carga y 69-B se calculan "a hoy") y apuntan a una herramienta que EXISTE en `buildDespachosDataChatCatalog`
// (packages/domain-despachos/src/data-chat/catalog.ts): cartera_por_cliente, cobranza_antiguedad, cfdi_por_periodo, impuestos_del_mes,
// obligaciones_fiscales, cierres_pendientes, alertas_efos y carga_de_trabajo. Nada aqui son respuestas: solo preguntas que el servidor
// contesta con datos reales (el catalogo es cerrado y de solo lectura).
import type { CopilotoConfigIngles, CopilotoConfigVertical } from "./tipos.ts";

export const SUGERENCIAS_COPILOTO_DESPACHOS: readonly string[] = [
  "¿Cuánto me deben mis clientes hoy?",
  "¿Cuánta cobranza tengo vencida por antigüedad?",
  "¿Cuántos CFDI se recibieron este mes?",
  "¿Qué obligaciones fiscales vencen este mes?",
  "¿Algún proveedor de mis clientes aparece en la lista 69-B del SAT?",
];

/** Ingles de la config (i18n ES/EN): misma consulta directa por pregunta, textos de la portada y temas. */
export const COPILOTO_DESPACHOS_EN: CopilotoConfigIngles = {
  textos: {
    titulo: "Ask your data",
    subtitulo: "Your receivables, CFDIs and tax obligations, with the figure the system already calculated.",
    nota: "Answers only with figures already calculated on the server and tells you where they come from; if there's no data, it says so. It never makes up numbers or calculates tax returns.",
    placeholder: "Ask about your clients…",
    fases: [
      [0, "Reading your clients' information…"],
      [2500, "Querying your data…"],
      [8000, "Putting the answer together…"],
      [20000, "Still working on this…"],
    ],
  },
  temas: {
    "Cobranza": "Collections",
    "Fiscal": "Tax",
    "Operación": "Operations",
  },
  preguntas: {
    "¿Cuánto me deben mis clientes hoy?": "How much do my clients owe me today?",
    "¿Cuánta cobranza tengo vencida por antigüedad?": "How much overdue receivables do I have by age?",
    "¿Cuántos CFDI se recibieron este mes?": "How many CFDIs were received this month?",
    "¿Qué obligaciones fiscales vencen este mes?": "Which tax obligations are due this month?",
    "¿Algún proveedor de mis clientes aparece en la lista 69-B del SAT?": "Does any of my clients' suppliers appear on the SAT 69-B list?",
    "¿Cuánto IVA acreditable tuvo cada cliente este mes?": "How much creditable VAT did each client have this month?",
    "¿Qué cierres mensuales siguen pendientes?": "Which month-end closes are still pending?",
    "¿Qué clientes tienen más pendientes por atender hoy?": "Which clients have the most pending items today?",
  },
  etiquetasHerramienta: {
    cartera_por_cliente: "Adding up receivables per client",
    cobranza_antiguedad: "Calculating balance aging",
    cfdi_por_periodo: "Counting the period's CFDIs",
    impuestos_del_mes: "Adding up creditable VAT",
    obligaciones_fiscales: "Reviewing tax deadlines",
    cierres_pendientes: "Reviewing month-end closes",
    alertas_efos: "Matching CFDIs against the 69-B list",
    carga_de_trabajo: "Counting pending items per client",
  },
  textoSinAcceso: "Your role doesn't have access to the Copilot. Ask a firm administrator for access.",
};

export const COPILOTO_DESPACHOS: CopilotoConfigVertical = {
  vertical: "despachos",
  textos: {
    titulo: "Pregúntale a tus datos",
    subtitulo: "Tu cartera, tus CFDI y tus obligaciones fiscales, con la cifra que ya calculó el sistema.",
    nota: "Responde solo con cifras ya calculadas en el servidor y te dice de dónde salen; si no hay dato, te lo dice. No inventa números ni calcula declaraciones.",
    placeholder: "Pregunta sobre tus clientes…",
    fases: [
      [0, "Leyendo la información de tus clientes…"],
      [2500, "Consultando tus datos…"],
      [8000, "Armando la respuesta…"],
      [20000, "Sigo trabajando en esto…"],
    ],
  },
  sugerencias: SUGERENCIAS_COPILOTO_DESPACHOS,
  categorias: [
    {
      titulo: "Cobranza",
      preguntas: ["¿Cuánto me deben mis clientes hoy?", "¿Cuánta cobranza tengo vencida por antigüedad?"],
    },
    {
      titulo: "Fiscal",
      preguntas: ["¿Qué obligaciones fiscales vencen este mes?", "¿Cuánto IVA acreditable tuvo cada cliente este mes?", "¿Algún proveedor de mis clientes aparece en la lista 69-B del SAT?"],
    },
    {
      titulo: "Operación",
      preguntas: ["¿Cuántos CFDI se recibieron este mes?", "¿Qué cierres mensuales siguen pendientes?", "¿Qué clientes tienen más pendientes por atender hoy?"],
    },
  ],
  directas: {
    "¿Cuánto me deben mis clientes hoy?": { tool: "cartera_por_cliente" },
    "¿Cuánta cobranza tengo vencida por antigüedad?": { tool: "cobranza_antiguedad" },
    "¿Cuántos CFDI se recibieron este mes?": { tool: "cfdi_por_periodo", args: { periodo: "este_mes" } },
    "¿Qué obligaciones fiscales vencen este mes?": { tool: "obligaciones_fiscales", args: { periodo: "este_mes" } },
    "¿Algún proveedor de mis clientes aparece en la lista 69-B del SAT?": { tool: "alertas_efos" },
    "¿Cuánto IVA acreditable tuvo cada cliente este mes?": { tool: "impuestos_del_mes", args: { periodo: "este_mes" } },
    "¿Qué cierres mensuales siguen pendientes?": { tool: "cierres_pendientes" },
    "¿Qué clientes tienen más pendientes por atender hoy?": { tool: "carga_de_trabajo" },
  },
  etiquetasHerramienta: {
    cartera_por_cliente: "Sumando la cartera por cliente",
    cobranza_antiguedad: "Calculando la antigüedad de saldos",
    cfdi_por_periodo: "Contando los CFDI del periodo",
    impuestos_del_mes: "Sumando el IVA acreditable",
    obligaciones_fiscales: "Revisando los vencimientos fiscales",
    cierres_pendientes: "Revisando los cierres mensuales",
    alertas_efos: "Cruzando los CFDI con la lista 69-B",
    carga_de_trabajo: "Contando los pendientes por cliente",
  },
  rutasFuente: {
    cartera_por_cliente: "/despachos/:orgSlug/cobranza",
    cobranza_antiguedad: "/despachos/:orgSlug/cola-cobranza",
    cfdi_por_periodo: "/despachos/:orgSlug/cfdi",
    impuestos_del_mes: "/despachos/:orgSlug/declaraciones",
    obligaciones_fiscales: "/despachos/:orgSlug/vencimientos",
    cierres_pendientes: "/despachos/:orgSlug/cierre-mensual",
    alertas_efos: "/despachos/:orgSlug/cfdi",
    carga_de_trabajo: "/despachos/:orgSlug/cartera",
  },
  maxCaracteres: 600,
  textoSinAcceso: "Tu rol no tiene acceso al Copiloto. Pídele acceso a un administrador del despacho.",
  en: COPILOTO_DESPACHOS_EN,
};
