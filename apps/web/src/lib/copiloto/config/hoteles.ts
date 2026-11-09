// Configuracion del Copiloto de HOTELES (CHAT-09). Todas las preguntas dicen su periodo (o no lo necesitan, como tickets y
// housekeeping) y apuntan a una herramienta que EXISTE en `buildHotelesDataChatTools` (packages/domain-hoteles/src/data-chat/catalog.ts):
// ocupacion_adr_revpar, ingresos_por_periodo, llegadas_y_salidas, cancelaciones, tickets_abiertos_sla y housekeeping_pendiente.
// Nada aqui son respuestas: solo preguntas que el servidor contesta con datos reales (el catalogo es cerrado y solo owner/gm lo usan).
import type { CopilotoConfigIngles, CopilotoConfigVertical } from "./tipos.ts";

export const SUGERENCIAS_COPILOTO_HOTELES: readonly string[] = [
  "¿Cómo va la ocupación esta semana?",
  "¿Cuál fue el ADR y el RevPAR de los últimos 30 días?",
  "¿Qué llegadas y salidas tengo mañana?",
  "¿Cuántos tickets abiertos tengo con el SLA vencido?",
  "¿Cuántas reservas se cancelaron este mes?",
];

/** Ingles de la config (i18n ES/EN): misma consulta directa por pregunta, textos de la portada y temas. */
export const COPILOTO_HOTELES_EN: CopilotoConfigIngles = {
  textos: {
    titulo: "Ask your data",
    subtitulo: "Your occupancy, bookings and operations, with the figure the system already calculated.",
    nota: "Answers only with figures already calculated on the server and tells you where they come from; if there's no data, it says so. It never makes up numbers.",
    placeholder: "Ask about your hotel…",
    fases: [
      [0, "Reading your bookings…"],
      [2500, "Querying your data…"],
      [8000, "Putting the answer together…"],
      [20000, "Still working on this…"],
    ],
  },
  temas: {
    "Ocupación e ingresos": "Occupancy and revenue",
    "Reservas": "Bookings",
    "Operación": "Operations",
  },
  preguntas: {
    "¿Cómo va la ocupación esta semana?": "How is occupancy this week?",
    "¿Cuál fue el ADR y el RevPAR de los últimos 30 días?": "What were ADR and RevPAR over the last 30 days?",
    "¿Qué llegadas y salidas tengo mañana?": "What arrivals and departures do I have tomorrow?",
    "¿Cuántos tickets abiertos tengo con el SLA vencido?": "How many open tickets are past their SLA?",
    "¿Cuántas reservas se cancelaron este mes?": "How many bookings were canceled this month?",
    "¿Cuánto ingresé por habitaciones y A&B este mes?": "How much did I earn from rooms and F&B this month?",
    "¿Cuántas tareas de housekeeping tengo pendientes hoy?": "How many housekeeping tasks are pending today?",
  },
  etiquetasHerramienta: {
    ocupacion_adr_revpar: "Calculating occupancy, ADR and RevPAR",
    ingresos_por_periodo: "Adding up revenue by period",
    llegadas_y_salidas: "Reading arrivals and departures",
    cancelaciones: "Reviewing cancellations",
    tickets_abiertos_sla: "Reviewing tickets and their SLA",
    housekeeping_pendiente: "Counting pending housekeeping",
  },
  textoSinAcceso: "Your role doesn't have access to the Copilot. Ask the owner or the manager for access.",
};

export const COPILOTO_HOTELES: CopilotoConfigVertical = {
  vertical: "hoteles",
  textos: {
    titulo: "Pregúntale a tus datos",
    subtitulo: "Tu ocupación, reservas y operación, con la cifra que ya calculó el sistema.",
    nota: "Responde solo con cifras ya calculadas en el servidor y te dice de dónde salen; si no hay dato, te lo dice. No inventa números.",
    placeholder: "Pregunta sobre tu hotel…",
    fases: [
      [0, "Leyendo tus reservas…"],
      [2500, "Consultando tus datos…"],
      [8000, "Armando la respuesta…"],
      [20000, "Sigo trabajando en esto…"],
    ],
  },
  sugerencias: SUGERENCIAS_COPILOTO_HOTELES,
  categorias: [
    {
      titulo: "Ocupación e ingresos",
      preguntas: ["¿Cómo va la ocupación esta semana?", "¿Cuál fue el ADR y el RevPAR de los últimos 30 días?", "¿Cuánto ingresé por habitaciones y A&B este mes?"],
    },
    {
      titulo: "Reservas",
      preguntas: ["¿Qué llegadas y salidas tengo mañana?", "¿Cuántas reservas se cancelaron este mes?"],
    },
    {
      titulo: "Operación",
      preguntas: ["¿Cuántos tickets abiertos tengo con el SLA vencido?", "¿Cuántas tareas de housekeeping tengo pendientes hoy?"],
    },
  ],
  directas: {
    "¿Cómo va la ocupación esta semana?": { tool: "ocupacion_adr_revpar", args: { periodo: "esta_semana" } },
    "¿Cuál fue el ADR y el RevPAR de los últimos 30 días?": { tool: "ocupacion_adr_revpar", args: { periodo: "ultimos_30_dias" } },
    "¿Cuánto ingresé por habitaciones y A&B este mes?": { tool: "ingresos_por_periodo", args: { periodo: "este_mes" } },
    "¿Qué llegadas y salidas tengo mañana?": { tool: "llegadas_y_salidas", args: { periodo: "manana" } },
    "¿Cuántas reservas se cancelaron este mes?": { tool: "cancelaciones", args: { periodo: "este_mes" } },
    "¿Cuántos tickets abiertos tengo con el SLA vencido?": { tool: "tickets_abiertos_sla" },
    "¿Cuántas tareas de housekeeping tengo pendientes hoy?": { tool: "housekeeping_pendiente" },
  },
  etiquetasHerramienta: {
    ocupacion_adr_revpar: "Calculando ocupación, ADR y RevPAR",
    ingresos_por_periodo: "Sumando los ingresos por periodo",
    llegadas_y_salidas: "Leyendo llegadas y salidas",
    cancelaciones: "Revisando las cancelaciones",
    tickets_abiertos_sla: "Revisando los tickets y su SLA",
    housekeeping_pendiente: "Contando el housekeeping pendiente",
  },
  rutasFuente: {
    ocupacion_adr_revpar: "/hoteles/:orgSlug/revenue",
    ingresos_por_periodo: "/hoteles/:orgSlug/pl",
    llegadas_y_salidas: "/hoteles/:orgSlug/recepcion",
    cancelaciones: "/hoteles/:orgSlug/reservas",
    tickets_abiertos_sla: "/hoteles/:orgSlug/tickets",
    housekeeping_pendiente: "/hoteles/:orgSlug/housekeeping",
  },
  maxCaracteres: 600,
  textoSinAcceso: "Tu rol no tiene acceso al Copiloto. Pídele acceso al dueño o al gerente.",
  en: COPILOTO_HOTELES_EN,
};
