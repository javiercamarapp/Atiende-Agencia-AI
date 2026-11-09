// Configuracion del Copiloto de LICITACIONES (CHAT-12). Todas las preguntas dicen su horizonte o periodo (o no lo necesitan) y apuntan
// a una herramienta que EXISTE en `buildLicitacionesDataChatTools` (packages/domain-licitaciones/src/data-chat/catalog.ts):
// convocatorias_abiertas, plazos_semaforo, go_no_go, propuestas_por_estado, fallos, renovaciones y preguntas_junta_pendientes.
// Nada aqui son respuestas: solo preguntas que el servidor contesta con datos reales.
import type { CopilotoConfigIngles, CopilotoConfigVertical } from "./tipos.ts";

export const SUGERENCIAS_COPILOTO_LICITACIONES: readonly string[] = [
  "¿Qué convocatorias vencen en los próximos 7 días?",
  "¿Cómo va el semáforo de mis plazos?",
  "¿Qué decisiones go/no-go tomé este mes?",
  "¿Cuántas propuestas tengo por estado?",
  "¿Qué preguntas de la junta de aclaraciones tengo pendientes?",
];

/** Ingles de la config (i18n ES/EN): misma consulta directa por pregunta, textos de la portada y temas. */
export const COPILOTO_LICITACIONES_EN: CopilotoConfigIngles = {
  textos: {
    titulo: "Ask your data",
    subtitulo: "Your tenders, deadlines and proposals, with the figure the system already calculated.",
    nota: "Answers only with figures already calculated on the server and tells you where they come from; if there's no data, it says so. It never makes up numbers.",
    placeholder: "Ask about your tenders…",
    fases: [
      [0, "Understanding your question…"],
      [2500, "Querying your data…"],
      [8000, "Putting the answer together…"],
      [20000, "Still working on this…"],
    ],
  },
  temas: {
    "Oportunidades": "Opportunities",
    "Plazos y propuestas": "Deadlines and proposals",
    "Resultados y contratos": "Awards and contracts",
  },
  preguntas: {
    "¿Qué convocatorias vencen en los próximos 7 días?": "Which tenders close in the next 7 days?",
    "¿Cómo va el semáforo de mis plazos?": "How does my deadline traffic light look?",
    "¿Qué decisiones go/no-go tomé este mes?": "What go/no-go decisions did I make this month?",
    "¿Cuántas propuestas tengo por estado?": "How many proposals do I have by status?",
    "¿Qué preguntas de la junta de aclaraciones tengo pendientes?": "Which clarification-meeting questions are still pending?",
    "¿Qué convocatorias tengo abiertas?": "Which tenders do I have open?",
    "¿Qué fallos recibí este mes?": "What awards did I receive this month?",
    "¿Qué contratos terminan su vigencia en los próximos 90 días?": "Which contracts expire in the next 90 days?",
  },
  etiquetasHerramienta: {
    convocatorias_abiertas: "Reviewing open tenders",
    plazos_semaforo: "Calculating the deadline traffic light",
    go_no_go: "Reviewing go / no-go decisions",
    propuestas_por_estado: "Counting proposals by status",
    fallos: "Reviewing awards",
    renovaciones: "Reviewing contract renewals",
    preguntas_junta_pendientes: "Reviewing clarification-meeting questions",
  },
  textoSinAcceso: "Your role doesn't have access to the Copilot. Ask an administrator of your organization for access.",
};

export const COPILOTO_LICITACIONES: CopilotoConfigVertical = {
  vertical: "licitaciones",
  textos: {
    titulo: "Pregúntale a tus datos",
    subtitulo: "Tus convocatorias, plazos y propuestas, con la cifra que ya calculó el sistema.",
    nota: "Responde solo con cifras ya calculadas en el servidor y te dice de dónde salen; si no hay dato, te lo dice. No inventa números.",
    placeholder: "Pregunta sobre tus licitaciones…",
    fases: [
      [0, "Entendiendo tu pregunta…"],
      [2500, "Consultando tus datos…"],
      [8000, "Armando la respuesta…"],
      [20000, "Sigo trabajando en esto…"],
    ],
  },
  sugerencias: SUGERENCIAS_COPILOTO_LICITACIONES,
  categorias: [
    {
      titulo: "Oportunidades",
      preguntas: ["¿Qué convocatorias vencen en los próximos 7 días?", "¿Qué convocatorias tengo abiertas?", "¿Qué decisiones go/no-go tomé este mes?"],
    },
    {
      titulo: "Plazos y propuestas",
      preguntas: [
        "¿Cómo va el semáforo de mis plazos?",
        "¿Cuántas propuestas tengo por estado?",
        "¿Qué preguntas de la junta de aclaraciones tengo pendientes?",
      ],
    },
    {
      titulo: "Resultados y contratos",
      preguntas: ["¿Qué fallos recibí este mes?", "¿Qué contratos terminan su vigencia en los próximos 90 días?"],
    },
  ],
  directas: {
    "¿Qué convocatorias vencen en los próximos 7 días?": { tool: "convocatorias_abiertas", args: { vencen_en_dias: 7 } },
    "¿Cómo va el semáforo de mis plazos?": { tool: "plazos_semaforo" },
    "¿Qué decisiones go/no-go tomé este mes?": { tool: "go_no_go", args: { periodo: "este_mes" } },
    "¿Cuántas propuestas tengo por estado?": { tool: "propuestas_por_estado" },
    "¿Qué preguntas de la junta de aclaraciones tengo pendientes?": { tool: "preguntas_junta_pendientes" },
    "¿Qué convocatorias tengo abiertas?": { tool: "convocatorias_abiertas" },
    "¿Qué fallos recibí este mes?": { tool: "fallos", args: { periodo: "este_mes" } },
    "¿Qué contratos terminan su vigencia en los próximos 90 días?": { tool: "renovaciones", args: { dentro_de_dias: 90 } },
  },
  etiquetasHerramienta: {
    convocatorias_abiertas: "Revisando las convocatorias abiertas",
    plazos_semaforo: "Calculando el semáforo de plazos",
    go_no_go: "Revisando las decisiones go / no-go",
    propuestas_por_estado: "Contando las propuestas por estado",
    fallos: "Revisando los fallos",
    renovaciones: "Revisando las renovaciones de contratos",
    preguntas_junta_pendientes: "Revisando las preguntas de la junta de aclaraciones",
  },
  rutasFuente: {
    convocatorias_abiertas: "/licitaciones/:orgSlug/convocatorias",
    plazos_semaforo: "/licitaciones/:orgSlug/seguimiento",
    go_no_go: "/licitaciones/:orgSlug/convocatorias",
    propuestas_por_estado: "/licitaciones/:orgSlug/convocatorias",
    fallos: "/licitaciones/:orgSlug/convocatorias",
    renovaciones: "/licitaciones/:orgSlug/radar-renovaciones",
    preguntas_junta_pendientes: "/licitaciones/:orgSlug/convocatorias",
  },
  maxCaracteres: 600,
  textoSinAcceso: "Tu rol no tiene acceso al Copiloto. Pídele acceso a un administrador de tu organización.",
  en: COPILOTO_LICITACIONES_EN,
};
