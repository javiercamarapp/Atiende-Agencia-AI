// Datos de la configuracion del Copiloto de PLATAFORMA (superadmin). Solo textos y listas: las respuestas salen del servidor (`POST /superadmin/copiloto`) con el catalogo
// de `apps/api/src/superadmin-copiloto/catalogo.ts`. Cada chip y pregunta de tarjeta tiene consulta DIRECTA (sin modelo) a una herramienta que existe; un test del
// API (`superadmin-copiloto-config.spec.ts`) lo valida contra el catalogo real. Las consultas CFO (MRR, P&L, margen, cobranza, contratos) tambien son chips y tarjetas:
// exigen step-up y el cliente abre el dialogo de verificacion MFA y reintenta (nunca se muestran cifras sin esa verificacion).
//
// DATOS PUROS, sin importar nada (ni tipos de @atiende/ui): asi la prueba del API puede leerlos sin arrastrar la UI al typecheck de la raiz. `copiloto-config.ts` los
// tipa como `CopilotoConfigVertical`.

interface Directa {
  readonly tool: string;
  readonly args?: Readonly<Record<string, string | number>>;
}

const P1 = "¿Cuántas organizaciones tengo por estado?";
const P2 = "¿Cómo va mi embudo de prospectos?";
const P3 = "¿Cuánto se usó cada vertical este mes?";
const P4 = "¿Qué planes y topes tengo definidos?";
const P5 = "¿Cuánto gasté en IA este mes por vertical?";
const P6 = "¿Qué agentes están apagados?";
const P7 = "¿Qué errores recientes hay en la plataforma?";
const P8 = "¿Cuántos clientes están en prueba?";
const P10 = "¿Cuál es mi MRR por vertical?";
const P11 = "¿Cómo va el P&L por vertical este mes?";
const P12 = "¿Qué clientes tienen menor margen?";
const P13 = "¿Qué clientes tienen el pago pendiente?";
const P14 = "¿Qué contratos vencen en los próximos 60 días?";
const P15 = "¿Cómo están las colas de mensajes?";
const P16 = "¿Qué organizaciones gastan más en IA este mes?";
const P17 = "¿Qué hoteles tengo y en qué estado están?";
const P19 = "¿Qué restaurantes tengo activos?";
const P18 = "Compara restaurantes y hoteles este mes";
const P20 = "¿Qué organizaciones tuvieron más pedidos, reservas y citas este mes?";
const P21 = "¿Qué restaurantes vendieron más este mes?";
const P22 = "¿Qué hoteles tuvieron más reservas este mes?";
const P23 = "¿Qué organizaciones escalaron más conversaciones a una persona este mes?";
const P24 = "¿Qué despachos tienen vencimientos fiscales abiertos?";

const FASES: ReadonlyArray<readonly [number, string]> = [
  [0, "Leyendo la plataforma…"],
  [3000, "Calculando cifras…"],
  [9000, "Cruzando cifras…"],
  [17000, "Preparando la respuesta…"],
  [30000, "Esto está tardando más de lo normal…"],
];

export const SUGERENCIAS_COPILOTO_SUPERADMIN: readonly string[] = [P1, P10, P13, P5, P6];

export const DIRECTAS_COPILOTO_SUPERADMIN: Readonly<Record<string, Directa>> = {
  [P1]: { tool: "organizaciones" },
  [P2]: { tool: "prospectos", args: { agrupar: "estado" } },
  [P3]: { tool: "uso_por_vertical", args: { periodo: "este_mes" } },
  [P4]: { tool: "planes_y_topes", args: { ver: "planes" } },
  [P5]: { tool: "costos_ia", args: { periodo: "este_mes", agrupar: "vertical" } },
  [P6]: { tool: "agentes_interruptores" },
  [P7]: { tool: "errores" },
  [P8]: { tool: "organizaciones", args: { estado: "trial" } },
  [P10]: { tool: "mrr" },
  [P11]: { tool: "pyl" },
  [P12]: { tool: "margen_costos_unitarios" },
  [P13]: { tool: "facturacion_cobranza", args: { estado: "pago_pendiente" } },
  [P14]: { tool: "contratos_por_vencer", args: { dias: 60 } },
  [P15]: { tool: "salud_colas" },
  [P16]: { tool: "ranking_organizaciones", args: { periodo: "este_mes", ordenar_por: "costo_ia" } },
  [P17]: { tool: "buscar_organizacion", args: { vertical: "hoteles" } },
  [P19]: { tool: "buscar_organizacion", args: { vertical: "restaurantes", estado: "active" } },
  [P18]: { tool: "uso_por_vertical", args: { periodo: "este_mes" } },
  [P20]: { tool: "ranking_actividad", args: { periodo: "este_mes", metrica: "operaciones" } },
  [P21]: { tool: "ranking_actividad", args: { periodo: "este_mes", metrica: "ingresos", vertical: "restaurantes" } },
  [P22]: { tool: "ranking_actividad", args: { periodo: "este_mes", metrica: "operaciones", vertical: "hoteles" } },
  [P23]: { tool: "ranking_actividad", args: { periodo: "este_mes", metrica: "escalaciones" } },
  [P24]: { tool: "ranking_actividad", args: { periodo: "este_mes", metrica: "abiertos", vertical: "despachos" } },
};

export const DATOS_COPILOTO_SUPERADMIN = {
  vertical: "plataforma",
  textos: {
    titulo: "Pregunta a tus datos",
    subtitulo: "Tu plataforma completa, con la cifra que ya calculó el sistema: clientes, actividad de cada negocio, costos de IA, agentes y salud.",
    nota: "Responde solo con cifras ya calculadas en el servidor y te dice de dónde salen; si no hay dato, te lo dice. No inventa números. Puede proponer acciones, pero nunca las ejecuta: tú confirmas.",
    placeholder: "Pregunta sobre la plataforma…",
    fases: FASES,
    contexto: "Toda la plataforma",
  },
  sugerencias: SUGERENCIAS_COPILOTO_SUPERADMIN,
  categorias: [
    { titulo: "CFO y cobranza", preguntas: [P10, P11, P12, P13, P14] },
    { titulo: "Ventas y costos de IA", preguntas: [P2, P3, P5, P4] },
    { titulo: "Clientes, agentes y salud", preguntas: [P1, P8, P6, P7, P15] },
    { titulo: "Varias organizaciones", preguntas: [P16, P17, P19, P18] },
    { titulo: "Actividad por negocio", preguntas: [P20, P21, P22, P23, P24] },
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
    buscar_organizacion: "Buscando la organización",
    ranking_organizaciones: "Ordenando las organizaciones",
    operaciones_organizacion: "Leyendo la operación de la organización",
    agentes_organizacion: "Revisando los agentes de la organización",
    ranking_actividad: "Ordenando la actividad de cada negocio",
    mrr: "Calculando el MRR",
    margen_costos_unitarios: "Calculando márgenes y costos unitarios",
    pyl: "Armando el P&L",
    contratos_por_vencer: "Buscando contratos por vencer",
    facturacion_cobranza: "Revisando la facturación y la cobranza",
    proponer_accion: "Preparando la propuesta",
  },
  rutasFuente: {
    organizaciones: "/superadmin/organizaciones",
    costos_ia: "/superadmin/consumo-ia",
    consumo_vs_tope: "/superadmin/consumo-ia",
    uso_por_vertical: "/superadmin",
    agentes_interruptores: "/superadmin/agentes",
    ultimas_corridas: "/superadmin/salud",
    errores: "/superadmin/salud",
    salud_colas: "/superadmin/salud",
    planes_y_topes: "/superadmin/planes",
    eventos_seguridad: "/superadmin/seguridad",
    prospectos: "/superadmin/cerebro",
    uso_copiloto: "/superadmin/consumo-ia",
    buscar_organizacion: "/superadmin/organizaciones",
    ranking_organizaciones: "/superadmin/consumo-ia",
    operaciones_organizacion: "/superadmin/organizaciones",
    agentes_organizacion: "/superadmin/agentes",
    ranking_actividad: "/superadmin/organizaciones",
    mrr: "/superadmin/ejecutivo",
    margen_costos_unitarios: "/superadmin/costos-facturacion?tab=costos",
    pyl: "/superadmin/costos-facturacion?tab=pyl",
    contratos_por_vencer: "/superadmin/costos-facturacion?tab=contratos",
    facturacion_cobranza: "/superadmin/costos-facturacion?tab=facturacion",
  },
  maxCaracteres: 600,
  textoSinAcceso: "Tu rol no tiene acceso al Copiloto de plataforma.",
};
