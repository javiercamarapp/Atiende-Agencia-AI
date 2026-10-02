// Configuracion del Copiloto de RENTAS (CHAT-10). Todas las preguntas dicen su periodo (o no lo necesitan) y apuntan a una
// herramienta que EXISTE en `buildRentasDataChatTools` (packages/domain-rentas/src/data-chat/catalog.ts): ocupacion_por_unidad,
// ingresos_por_canal, ingresos_por_propietario, conflictos_calendario_abiertos, tareas_pendientes, liquidaciones_propietarios y
// pagos_de_canal. Nada aqui son respuestas: solo preguntas que el servidor contesta con datos reales.
import type { CopilotoConfigVertical } from "./tipos.ts";

export const SUGERENCIAS_COPILOTO_RENTAS: readonly string[] = [
  "¿Cuál fue la ocupación por unidad el mes pasado?",
  "¿Cuánto ingresé por canal este mes?",
  "¿Cuánto ingresó cada propietario este mes?",
  "¿Qué conflictos de calendario siguen abiertos?",
  "¿Qué limpiezas están pendientes hasta hoy?",
];

export const COPILOTO_RENTAS: CopilotoConfigVertical = {
  vertical: "rentas",
  textos: {
    titulo: "Pregunta a tus datos",
    subtitulo: "Tu ocupación, ingresos y operación, con la cifra que ya calculó el sistema.",
    nota: "Responde solo con cifras ya calculadas en el servidor y te dice de dónde salen; si no hay dato, te lo dice. No inventa números.",
    placeholder: "Pregunta sobre tus propiedades…",
    fases: [
      [0, "Entendiendo tu pregunta…"],
      [2500, "Consultando tus datos…"],
      [8000, "Armando la respuesta…"],
      [20000, "Sigo trabajando en esto…"],
    ],
  },
  sugerencias: SUGERENCIAS_COPILOTO_RENTAS,
  categorias: [
    {
      titulo: "Ocupación",
      preguntas: ["¿Cuál fue la ocupación por unidad el mes pasado?", "¿Cuántas noches reservé y cuántas bloqueé este mes?"],
    },
    {
      titulo: "Ingresos",
      preguntas: [
        "¿Cuánto ingresé por canal este mes?",
        "¿Cuánto ingresó cada propietario este mes?",
        "¿Qué pagos de canal recibí este mes y cuáles siguen sin conciliar?",
      ],
    },
    {
      titulo: "Operación",
      preguntas: [
        "¿Qué conflictos de calendario siguen abiertos?",
        "¿Qué limpiezas están pendientes hasta hoy?",
        "¿Qué liquidaciones a propietarios generé el mes pasado?",
      ],
    },
  ],
  directas: {
    "¿Cuál fue la ocupación por unidad el mes pasado?": { tool: "ocupacion_por_unidad", args: { periodo: "mes_pasado" } },
    "¿Cuánto ingresé por canal este mes?": { tool: "ingresos_por_canal", args: { periodo: "este_mes" } },
    "¿Cuánto ingresó cada propietario este mes?": { tool: "ingresos_por_propietario", args: { periodo: "este_mes" } },
    "¿Qué conflictos de calendario siguen abiertos?": { tool: "conflictos_calendario_abiertos" },
    "¿Qué limpiezas están pendientes hasta hoy?": { tool: "tareas_pendientes", args: { tipo: "limpieza" } },
    "¿Cuántas noches reservé y cuántas bloqueé este mes?": { tool: "ocupacion_por_unidad", args: { periodo: "este_mes" } },
    "¿Qué pagos de canal recibí este mes y cuáles siguen sin conciliar?": { tool: "pagos_de_canal", args: { periodo: "este_mes" } },
    "¿Qué liquidaciones a propietarios generé el mes pasado?": { tool: "liquidaciones_propietarios", args: { periodo: "mes_pasado" } },
  },
  etiquetasHerramienta: {
    ocupacion_por_unidad: "Calculando la ocupación por unidad",
    ingresos_por_canal: "Sumando los ingresos por canal",
    ingresos_por_propietario: "Sumando los ingresos por propietario",
    conflictos_calendario_abiertos: "Revisando los conflictos de calendario",
    tareas_pendientes: "Revisando las tareas pendientes",
    liquidaciones_propietarios: "Revisando las liquidaciones a propietarios",
    pagos_de_canal: "Revisando los pagos de canal",
  },
  rutasFuente: {
    ocupacion_por_unidad: "/rentas/:orgSlug/calendario",
    ingresos_por_canal: "/rentas/:orgSlug/finanzas",
    ingresos_por_propietario: "/rentas/:orgSlug/finanzas",
    conflictos_calendario_abiertos: "/rentas/:orgSlug/monitor-sync",
    tareas_pendientes: "/rentas/:orgSlug/mis-tareas",
    liquidaciones_propietarios: "/rentas/:orgSlug/finanzas",
    pagos_de_canal: "/rentas/:orgSlug/finanzas",
  },
  maxCaracteres: 600,
  textoSinAcceso: "Tu rol no tiene acceso al Copiloto. Pídele acceso a la administradora de la gestora.",
};
