// Configuracion del Copiloto de CITAS (CHAT-13). Todas las preguntas dicen su periodo (o lo piden el catalogo de forma implicita) y
// apuntan a una herramienta que EXISTE en `buildCitasDataChatCatalog` (packages/domain-citas/src/data-chat/catalog.ts):
// citas_por_dia, ocupacion, no_shows_y_cancelaciones, ingresos_por_periodo, ingresos_por_servicio, clientes_nuevos_vs_recurrentes,
// huecos_libres y recordatorios. Nada aqui son respuestas: solo preguntas que el servidor contesta con datos reales (catalogo
// cerrado; solo owner y admin lo usan en el servidor).
import type { CopilotoConfigIngles, CopilotoConfigVertical } from "./tipos.ts";

export const SUGERENCIAS_COPILOTO_CITAS: readonly string[] = [
  "¿Cuántas citas tengo esta semana?",
  "¿Cuántas citas se cancelaron o no asistieron el mes pasado?",
  "¿Cuál es la ocupación de cada profesional este mes?",
  "¿Cuánto facturé por servicio este mes?",
  "¿Cuántos recordatorios fallaron esta semana?",
];

/** Ingles de la config (i18n ES/EN): misma consulta directa por pregunta, textos de la portada y temas. */
export const COPILOTO_CITAS_EN: CopilotoConfigIngles = {
  textos: {
    titulo: "Ask your data",
    subtitulo: "Your schedule, revenue and reminders, with the figure the system already calculated.",
    nota: "Answers only with figures already calculated on the server and tells you where they come from; if there's no data, it says so. It never makes up numbers.",
    placeholder: "Ask about your schedule…",
    fases: [
      [0, "Understanding your question…"],
      [2500, "Querying your schedule…"],
      [8000, "Putting the answer together…"],
      [20000, "Still working on this…"],
    ],
  },
  temas: {
    "Agenda y ocupación": "Schedule and utilization",
    "Cancelaciones y recordatorios": "Cancellations and reminders",
    "Ingresos y clientes": "Revenue and clients",
  },
  preguntas: {
    "¿Cuántas citas tengo esta semana?": "How many appointments do I have this week?",
    "¿Cuántas citas se cancelaron o no asistieron el mes pasado?": "How many appointments were canceled or no-shows last month?",
    "¿Cuál es la ocupación de cada profesional este mes?": "What is each professional's utilization this month?",
    "¿Cuánto facturé por servicio este mes?": "How much did I bill per service this month?",
    "¿Cuántos recordatorios fallaron esta semana?": "How many reminders failed this week?",
    "¿Qué huecos libres tengo mañana?": "What open slots do I have tomorrow?",
    "¿Cuánto facturé por día esta semana?": "How much did I bill per day this week?",
    "¿Cuántos clientes nuevos y recurrentes tuve este mes?": "How many new and returning clients did I have this month?",
  },
  etiquetasHerramienta: {
    citas_por_dia: "Counting appointments per day",
    ocupacion: "Calculating utilization",
    no_shows_y_cancelaciones: "Reviewing cancellations and no-shows",
    ingresos_por_periodo: "Adding up estimated revenue",
    ingresos_por_servicio: "Adding up revenue per service",
    clientes_nuevos_vs_recurrentes: "Counting new and returning clients",
    huecos_libres: "Looking for open slots",
    recordatorios: "Checking reminder status",
  },
  textoSinAcceso: "Your role doesn't have access to the Copilot. Ask the owner or an administrator of your business for access.",
};

export const COPILOTO_CITAS: CopilotoConfigVertical = {
  vertical: "citas",
  textos: {
    titulo: "Pregúntale a tus datos",
    subtitulo: "Tu agenda, tus ingresos y tus recordatorios, con la cifra que ya calculó el sistema.",
    nota: "Responde solo con cifras ya calculadas en el servidor y te dice de dónde salen; si no hay dato, te lo dice. No inventa números.",
    placeholder: "Pregunta sobre tu agenda…",
    fases: [
      [0, "Entendiendo tu pregunta…"],
      [2500, "Consultando tu agenda…"],
      [8000, "Armando la respuesta…"],
      [20000, "Sigo trabajando en esto…"],
    ],
  },
  sugerencias: SUGERENCIAS_COPILOTO_CITAS,
  categorias: [
    {
      titulo: "Agenda y ocupación",
      preguntas: ["¿Cuántas citas tengo esta semana?", "¿Cuál es la ocupación de cada profesional este mes?", "¿Qué huecos libres tengo mañana?"],
    },
    {
      titulo: "Cancelaciones y recordatorios",
      preguntas: ["¿Cuántas citas se cancelaron o no asistieron el mes pasado?", "¿Cuántos recordatorios fallaron esta semana?"],
    },
    {
      titulo: "Ingresos y clientes",
      preguntas: ["¿Cuánto facturé por servicio este mes?", "¿Cuánto facturé por día esta semana?", "¿Cuántos clientes nuevos y recurrentes tuve este mes?"],
    },
  ],
  directas: {
    "¿Cuántas citas tengo esta semana?": { tool: "citas_por_dia", args: { periodo: "esta_semana" } },
    "¿Cuántas citas se cancelaron o no asistieron el mes pasado?": { tool: "no_shows_y_cancelaciones", args: { periodo: "mes_pasado" } },
    "¿Cuál es la ocupación de cada profesional este mes?": { tool: "ocupacion", args: { periodo: "este_mes", agrupar_por: "profesional" } },
    "¿Cuánto facturé por servicio este mes?": { tool: "ingresos_por_servicio", args: { periodo: "este_mes" } },
    "¿Cuántos recordatorios fallaron esta semana?": { tool: "recordatorios", args: { periodo: "esta_semana" } },
    "¿Qué huecos libres tengo mañana?": { tool: "huecos_libres", args: { periodo: "manana" } },
    "¿Cuánto facturé por día esta semana?": { tool: "ingresos_por_periodo", args: { periodo: "esta_semana" } },
    "¿Cuántos clientes nuevos y recurrentes tuve este mes?": { tool: "clientes_nuevos_vs_recurrentes", args: { periodo: "este_mes" } },
  },
  etiquetasHerramienta: {
    citas_por_dia: "Contando las citas por día",
    ocupacion: "Calculando la ocupación",
    no_shows_y_cancelaciones: "Revisando cancelaciones y no-shows",
    ingresos_por_periodo: "Sumando los ingresos estimados",
    ingresos_por_servicio: "Sumando los ingresos por servicio",
    clientes_nuevos_vs_recurrentes: "Contando clientes nuevos y recurrentes",
    huecos_libres: "Buscando los huecos libres",
    recordatorios: "Revisando el estado de los recordatorios",
  },
  rutasFuente: {
    citas_por_dia: "/citas/:orgSlug/agenda",
    ocupacion: "/citas/:orgSlug/disponibilidad",
    no_shows_y_cancelaciones: "/citas/:orgSlug/agenda",
    ingresos_por_periodo: "/citas/:orgSlug/resumen",
    ingresos_por_servicio: "/citas/:orgSlug/servicios",
    clientes_nuevos_vs_recurrentes: "/citas/:orgSlug/clientes",
    huecos_libres: "/citas/:orgSlug/disponibilidad",
    recordatorios: "/citas/:orgSlug/avisos",
  },
  maxCaracteres: 600,
  textoSinAcceso: "Tu rol no tiene acceso al Copiloto. Pídele acceso al dueño o a un administrador de tu negocio.",
  en: COPILOTO_CITAS_EN,
};
