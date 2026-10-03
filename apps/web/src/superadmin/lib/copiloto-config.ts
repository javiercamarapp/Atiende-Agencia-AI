// Configuracion del Copiloto de PLATAFORMA (superadmin). Solo textos y listas: las respuestas salen del servidor (`POST /superadmin/copiloto`) con el catalogo
// de `apps/api/src/superadmin-copiloto/catalogo.ts`. Cada chip y pregunta de tarjeta tiene consulta DIRECTA (sin modelo) a una herramienta que existe; un test del
// API (`superadmin-copiloto-config.spec.ts`) lo valida contra el catalogo real. Los chips evitan las herramientas financieras (exigen step-up): esas se piden
// escribiendo la pregunta, y el cliente abre el dialogo de verificacion si hace falta.
import type { CopilotoDirecta } from "@atiende/ui";
import type { CopilotoConfigVertical } from "../../lib/copiloto/config/tipos.ts";

const P1 = "¿Cuántas organizaciones tengo por estado?";
const P2 = "¿Cómo va mi embudo de prospectos?";
const P3 = "¿Cuánto se usó cada vertical este mes?";
const P4 = "¿Qué planes y topes tengo definidos?";
const P5 = "¿Cuánto gasté en IA este mes por vertical?";
const P6 = "¿Qué agentes están apagados?";
const P7 = "¿Qué errores recientes hay en la plataforma?";
const P8 = "¿Cuántos clientes están en prueba?";
const P9 = "¿Qué clientes están suspendidos?";

export const SUGERENCIAS_COPILOTO_SUPERADMIN: readonly string[] = [P1, P2, P5, P6, P7];

export const DIRECTAS_COPILOTO_SUPERADMIN: Readonly<Record<string, CopilotoDirecta>> = {
  [P1]: { tool: "organizaciones" },
  [P2]: { tool: "prospectos", args: { agrupar: "estado" } },
  [P3]: { tool: "uso_por_vertical", args: { periodo: "este_mes" } },
  [P4]: { tool: "planes_y_topes", args: { ver: "planes" } },
  [P5]: { tool: "costos_ia", args: { periodo: "este_mes", agrupar: "vertical" } },
  [P6]: { tool: "agentes_interruptores" },
  [P7]: { tool: "errores" },
  [P8]: { tool: "organizaciones", args: { estado: "trial" } },
  [P9]: { tool: "organizaciones", args: { estado: "suspended" } },
};

export const COPILOTO_SUPERADMIN: CopilotoConfigVertical = {
  vertical: "plataforma",
  textos: {
    titulo: "Pregunta a tus datos",
    subtitulo: "Tu plataforma completa, con la cifra que ya calculó el sistema: clientes, costos de IA, agentes y salud.",
    nota: "Responde solo con cifras ya calculadas en el servidor y te dice de dónde salen; si no hay dato, te lo dice. No inventa números. Puede proponer acciones, pero nunca las ejecuta: tú confirmas.",
    placeholder: "Pregunta sobre la plataforma…",
    fases: [
      [0, "Leyendo la plataforma…"],
      [3000, "Calculando cifras…"],
      [9000, "Cruzando cifras…"],
      [17000, "Preparando la respuesta…"],
      [30000, "Esto está tardando más de lo normal…"],
    ],
    contexto: "Toda la plataforma",
  },
  sugerencias: SUGERENCIAS_COPILOTO_SUPERADMIN,
  categorias: [
    { titulo: "Plataforma y ventas", preguntas: [P2, P3, P4] },
    { titulo: "Costos y agentes", preguntas: [P5, P6, P7] },
    { titulo: "Clientes", preguntas: [P1, P8, P9] },
  ],
  directas: DIRECTAS_COPILOTO_SUPERADMIN,
  etiquetasHerramienta: {
    organizaciones: "Leyendo las organizaciones",
    costos_ia: "Sumando los costos de IA",
    consumo_vs_tope: "Comparando consumos y topes",
    uso_por_vertical: "Midiendo el uso por vertical",
    agentes_interruptores: "Revisando agentes e interruptores",
    ultimas_corridas: "Revisando las últimas corridas",
    errores: "Buscando errores recientes",
    salud_colas: "Revisando las colas de mensajes",
    planes_y_topes: "Leyendo planes y topes",
    eventos_seguridad: "Leyendo eventos de seguridad",
    prospectos: "Leyendo los prospectos",
    uso_copiloto: "Midiendo el uso del Copiloto",
    mrr: "Calculando el MRR",
    margen_costos_unitarios: "Calculando márgenes y costos unitarios",
    pyl: "Armando el P&L",
    contratos_por_vencer: "Buscando contratos por vencer",
    proponer_accion: "Preparando la propuesta",
  },
  rutasFuente: {
    organizaciones: "/superadmin/organizaciones",
    costos_ia: "/superadmin/gasto-api",
    consumo_vs_tope: "/superadmin/gasto-api",
    uso_por_vertical: "/superadmin",
    agentes_interruptores: "/superadmin/agentes",
    ultimas_corridas: "/superadmin/salud",
    errores: "/superadmin/salud",
    salud_colas: "/superadmin/salud",
    planes_y_topes: "/superadmin/planes",
    eventos_seguridad: "/superadmin/seguridad",
    prospectos: "/superadmin/prospectos",
    uso_copiloto: "/superadmin/gasto-api",
    mrr: "/superadmin/cfo",
    margen_costos_unitarios: "/superadmin/costos-margen",
    pyl: "/superadmin/pyl",
    contratos_por_vencer: "/superadmin/contratos",
  },
  maxCaracteres: 600,
  textoSinAcceso: "Tu rol no tiene acceso al Copiloto de plataforma.",
};
