// Configuracion del Copiloto de RESTAURANTES (vertical piloto). Todas las preguntas dicen su periodo y apuntan a una
// herramienta que EXISTE en `buildRestaurantesDataChatCatalog` (packages/domain-restaurantes/src/data-chat/catalog.ts):
// ventas_por_dia, ventas_por_sucursal, productos_mas_vendidos, ticket_medio, pedidos_por_canal, horas_pico,
// clientes_recurrentes y promociones, y (CFO-09, «Pregunta a tu CFO») las nueve `cfo_*` del CFO. Nada aqui son respuestas: solo preguntas que el servidor contesta con datos reales.
import type { CopilotoConfigVertical } from "./tipos.ts";

export const SUGERENCIAS_COPILOTO_RESTAURANTES: readonly string[] = [
  "¿Cuánto vendí esta semana?",
  "¿Cuáles son mis productos más vendidos este mes?",
  "¿A qué horas tengo más pedidos en los últimos 30 días?",
  "¿Qué es lo más importante esta semana?",
  "¿Cómo va mi estado de resultados este mes por sucursal?",
];

export const COPILOTO_RESTAURANTES: CopilotoConfigVertical = {
  vertical: "restaurantes",
  textos: {
    titulo: "Pregunta a tus datos",
    subtitulo: "Tus ventas, pedidos y clientes, con la cifra que ya calculó el sistema.",
    nota: "Responde solo con cifras ya calculadas en el servidor y te dice de dónde salen; si no hay dato, te lo dice. No inventa números. Las respuestas del CFO organizan tus datos operativos y no sustituyen a tu contador.",
    placeholder: "Pregunta sobre tu restaurante…",
    fases: [
      [0, "Entendiendo tu pregunta…"],
      [2500, "Consultando tus datos…"],
      [8000, "Armando la respuesta…"],
      [20000, "Sigo trabajando en esto…"],
    ],
  },
  sugerencias: SUGERENCIAS_COPILOTO_RESTAURANTES,
  categorias: [
    {
      titulo: "Ventas",
      preguntas: ["¿Cuánto vendí por día en los últimos 7 días?", "¿Cuál es mi ticket medio este mes?", "¿Cuánto vendió cada sucursal este mes?"],
    },
    {
      titulo: "Operación",
      preguntas: ["¿Cuántos pedidos tengo por canal este mes?", "¿A qué horas tengo más pedidos en los últimos 30 días?", "¿Cuáles son mis productos más vendidos este mes?"],
    },
    {
      titulo: "Clientes",
      preguntas: ["¿Cuántos clientes recurrentes tuve este mes?", "¿Qué promociones tengo activas y cuántas veces se han usado?"],
    },
    {
      titulo: "CFO",
      preguntas: [
        "¿Qué es lo más importante esta semana?",
        "¿Cómo va mi estado de resultados este mes por sucursal?",
        "¿Qué sucursal vende menos que su promedio este mes?",
        "¿Qué porcentaje de mis clientes son frecuentes en los últimos 30 días?",
        "¿Cuánto me cuesta el agente por pedido este mes?",
      ],
    },
  ],
  directas: {
    "¿Cuánto vendí esta semana?": { tool: "ventas_por_dia", args: { periodo: "esta_semana" } },
    "¿Cuáles son mis productos más vendidos este mes?": { tool: "productos_mas_vendidos", args: { periodo: "este_mes" } },
    "¿A qué horas tengo más pedidos en los últimos 30 días?": { tool: "horas_pico", args: { periodo: "ultimos_30_dias" } },
    "¿Cuántos clientes recurrentes tuve este mes?": { tool: "clientes_recurrentes", args: { periodo: "este_mes" } },
    "¿Qué es lo más importante esta semana?": { tool: "cfo_lo_mas_importante", args: { periodo: "esta_semana" } },
    "¿Cómo va mi estado de resultados este mes por sucursal?": { tool: "cfo_estado_resultados", args: { periodo: "este_mes" } },
    "¿Qué sucursal vende menos que su promedio este mes?": { tool: "cfo_comparar_sucursales", args: { periodo: "este_mes" } },
    "¿Qué porcentaje de mis clientes son frecuentes en los últimos 30 días?": { tool: "cfo_clientes", args: { periodo: "ultimos_30_dias" } },
    "¿Cuánto me cuesta el agente por pedido este mes?": { tool: "cfo_agente", args: { periodo: "este_mes" } },
    "¿Cuánto vendí por día en los últimos 7 días?": { tool: "ventas_por_dia", args: { periodo: "ultimos_7_dias" } },
    "¿Cuál es mi ticket medio este mes?": { tool: "ticket_medio", args: { periodo: "este_mes" } },
    "¿Cuánto vendió cada sucursal este mes?": { tool: "ventas_por_sucursal", args: { periodo: "este_mes" } },
    "¿Cuántos pedidos tengo por canal este mes?": { tool: "pedidos_por_canal", args: { periodo: "este_mes" } },
    "¿Qué promociones tengo activas y cuántas veces se han usado?": { tool: "promociones" },
  },
  etiquetasHerramienta: {
    ventas_por_dia: "Leyendo las ventas por día",
    ventas_por_sucursal: "Comparando las ventas por sucursal",
    productos_mas_vendidos: "Buscando los productos más vendidos",
    ticket_medio: "Calculando el ticket medio",
    pedidos_por_canal: "Contando los pedidos por canal",
    horas_pico: "Revisando las horas pico",
    clientes_recurrentes: "Revisando clientes recurrentes",
    promociones: "Revisando las promociones",
    cfo_resumen: "Armando el resumen del CFO",
    cfo_lo_mas_importante: "Buscando lo más importante",
    cfo_estado_resultados: "Armando el estado de resultados",
    cfo_comparar_sucursales: "Comparando tus sucursales",
    cfo_clientes: "Revisando tus clientes",
    cfo_platillos: "Revisando tus platillos",
    cfo_patrones: "Buscando patrones de venta",
    cfo_agente: "Revisando el desempeño del agente",
    cfo_softrestaurant: "Revisando SoftRestaurant",
  },
  rutasFuente: {
    ventas_por_dia: "/restaurantes/:orgSlug/historial",
    ventas_por_sucursal: "/restaurantes/:orgSlug/sucursales",
    productos_mas_vendidos: "/restaurantes/:orgSlug/productos",
    ticket_medio: "/restaurantes/:orgSlug/historial",
    pedidos_por_canal: "/restaurantes/:orgSlug/pedidos",
    horas_pico: "/restaurantes/:orgSlug/historial",
    clientes_recurrentes: "/restaurantes/:orgSlug/clientes",
    promociones: "/restaurantes/:orgSlug/promociones",
    // CFO-09: las pestañas del CFO que ya existen en main (CFO-07); Clientes, Platillos, Patrones, Operación y SoftRestaurant llegan con CFO-08:
    // mientras tanto abren la pantalla del CFO (que cae en Resumen). Repuntar a su pestaña cuando CFO-08 se fusione.
    cfo_resumen: "/restaurantes/:orgSlug/cfo/resumen",
    cfo_lo_mas_importante: "/restaurantes/:orgSlug/cfo/resumen",
    cfo_estado_resultados: "/restaurantes/:orgSlug/cfo/estado-resultados",
    cfo_comparar_sucursales: "/restaurantes/:orgSlug/cfo/sucursales",
    cfo_clientes: "/restaurantes/:orgSlug/cfo",
    cfo_platillos: "/restaurantes/:orgSlug/cfo",
    cfo_patrones: "/restaurantes/:orgSlug/cfo",
    cfo_agente: "/restaurantes/:orgSlug/cfo",
    cfo_softrestaurant: "/restaurantes/:orgSlug/cfo",
  },
  maxCaracteres: 600,
  textoSinAcceso: "Tu rol no tiene acceso al Copiloto. Pídele acceso al dueño.",
};
