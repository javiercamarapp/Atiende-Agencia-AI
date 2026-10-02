// Configuracion del Copiloto de LICITACIONES (CHAT-12). Todas las preguntas dicen su horizonte o periodo (o no lo necesitan) y apuntan
// a una herramienta que EXISTE en `buildLicitacionesDataChatTools` (packages/domain-licitaciones/src/data-chat/catalog.ts):
// convocatorias_abiertas, plazos_semaforo, go_no_go, propuestas_por_estado, fallos, renovaciones y preguntas_junta_pendientes.
// Nada aqui son respuestas: solo preguntas que el servidor contesta con datos reales.
import type { CopilotoConfigVertical } from "./tipos.ts";

export const SUGERENCIAS_COPILOTO_LICITACIONES: readonly string[] = [
  "¿Qué convocatorias vencen en los próximos 7 días?",
  "¿Cómo va el semáforo de mis plazos?",
  "¿Qué decisiones go/no-go tomé este mes?",
  "¿Cuántas propuestas tengo por estado?",
  "¿Qué preguntas de la junta de aclaraciones tengo pendientes?",
];

export const COPILOTO_LICITACIONES: CopilotoConfigVertical = {
  vertical: "licitaciones",
  textos: {
    titulo: "Pregunta a tus datos",
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
};
