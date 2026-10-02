// Configuracion del Copiloto de HOTELES (CHAT-09). Todas las preguntas dicen su periodo (o no lo necesitan, como tickets y
// housekeeping) y apuntan a una herramienta que EXISTE en `buildHotelesDataChatTools` (packages/domain-hoteles/src/data-chat/catalog.ts):
// ocupacion_adr_revpar, ingresos_por_periodo, llegadas_y_salidas, cancelaciones, tickets_abiertos_sla y housekeeping_pendiente.
// Nada aqui son respuestas: solo preguntas que el servidor contesta con datos reales (el catalogo es cerrado y solo owner/gm lo usan).
import type { CopilotoConfigVertical } from "./tipos.ts";

export const SUGERENCIAS_COPILOTO_HOTELES: readonly string[] = [
  "¿Cómo va la ocupación esta semana?",
  "¿Cuál fue el ADR y el RevPAR de los últimos 30 días?",
  "¿Qué llegadas y salidas tengo mañana?",
  "¿Cuántos tickets abiertos tengo con el SLA vencido?",
  "¿Cuántas reservas se cancelaron este mes?",
];

export const COPILOTO_HOTELES: CopilotoConfigVertical = {
  vertical: "hoteles",
  textos: {
    titulo: "Pregunta a tus datos",
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
};
