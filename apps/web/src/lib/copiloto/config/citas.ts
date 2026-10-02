// Configuracion del Copiloto de CITAS (CHAT-13). Todas las preguntas dicen su periodo (o lo piden el catalogo de forma implicita) y
// apuntan a una herramienta que EXISTE en `buildCitasDataChatCatalog` (packages/domain-citas/src/data-chat/catalog.ts):
// citas_por_dia, ocupacion, no_shows_y_cancelaciones, ingresos_por_periodo, ingresos_por_servicio, clientes_nuevos_vs_recurrentes,
// huecos_libres y recordatorios. Nada aqui son respuestas: solo preguntas que el servidor contesta con datos reales (catalogo
// cerrado; solo owner y admin lo usan en el servidor).
import type { CopilotoConfigVertical } from "./tipos.ts";

export const SUGERENCIAS_COPILOTO_CITAS: readonly string[] = [
  "¿Cuántas citas tengo esta semana?",
  "¿Cuántas citas se cancelaron o no asistieron el mes pasado?",
  "¿Cuál es la ocupación de cada profesional este mes?",
  "¿Cuánto facturé por servicio este mes?",
  "¿Cuántos recordatorios fallaron esta semana?",
];

export const COPILOTO_CITAS: CopilotoConfigVertical = {
  vertical: "citas",
  textos: {
    titulo: "Pregunta a tus datos",
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
};
