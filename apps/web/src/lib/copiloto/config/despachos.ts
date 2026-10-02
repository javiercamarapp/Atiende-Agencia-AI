// Configuracion del Copiloto de DESPACHOS (CHAT-11). Todas las preguntas dicen su periodo (o no lo necesitan: cartera, antigüedad,
// cierres, carga y 69-B se calculan "a hoy") y apuntan a una herramienta que EXISTE en `buildDespachosDataChatCatalog`
// (packages/domain-despachos/src/data-chat/catalog.ts): cartera_por_cliente, cobranza_antiguedad, cfdi_por_periodo, impuestos_del_mes,
// obligaciones_fiscales, cierres_pendientes, alertas_efos y carga_de_trabajo. Nada aqui son respuestas: solo preguntas que el servidor
// contesta con datos reales (el catalogo es cerrado y de solo lectura).
import type { CopilotoConfigVertical } from "./tipos.ts";

export const SUGERENCIAS_COPILOTO_DESPACHOS: readonly string[] = [
  "¿Cuánto me deben mis clientes hoy?",
  "¿Cuánta cobranza tengo vencida por antigüedad?",
  "¿Cuántos CFDI se recibieron este mes?",
  "¿Qué obligaciones fiscales vencen este mes?",
  "¿Algún proveedor de mis clientes aparece en la lista 69-B del SAT?",
];

export const COPILOTO_DESPACHOS: CopilotoConfigVertical = {
  vertical: "despachos",
  textos: {
    titulo: "Pregunta a tus datos",
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
};
