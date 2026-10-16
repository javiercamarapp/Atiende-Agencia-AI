// Casos de «Pregunta a tu CFO» (CFO-09): herramientas `cfo_*` del Copiloto de restaurantes. Mismo formato de autoria que `restaurantes.ts`
// (pregunta, herramienta y argumentos esperados, estado esperado, `prohibidas`), pero SIN congelar: el congelador y las pruebas de `congelados.spec.ts`
// fijan 60 casos por vertical con reparto por categoria, y congelar exige el Postgres efimero con las migraciones 081-084; por eso estos casos
// se corren con el servicio del CFO en memoria y el dataset SINTETICO (packages/domain-restaurantes/tests/data-chat-cfo-evals.spec.ts).
// Pasarlos a la suite congelada (renumerar a RES-061..) es una ronda posterior. "Hoy" del arnes: miercoles 30-sep-2026 12:00 (Merida).
import { llamada as L, type CasoFuente } from "../fuente.ts";

/** Quien pregunta: dueño (todas las sucursales) o admin acotado a UNA sucursal (Prolongación Montejo). */
export type QuienCfo = "dueno" | "admin_acotado";
/** Estado de la base del CFO: completa, sin SoftRestaurant importado o sin las migraciones 081-084. */
export type MundoCfo = "completo" | "sin_sr" | "sin_migrar";

export interface CasoCfo extends CasoFuente {
  readonly quien?: QuienCfo;
  readonly mundo?: MundoCfo;
  /** Texto que la respuesta (o el mensaje de la herramienta) DEBE contener: la honestidad que importa del caso. */
  readonly debeDecir?: readonly RegExp[];
}

export const casosCfo: readonly CasoCfo[] = [
  { id: "CFO-001", cat: "directa", q: "¿cuánto vendió Altabrisa ayer?", llama: [L("cfo_resumen", { periodo: "ayer", sucursal: "Altabrisa" })], cifras: [{ col: "ventas" }, { col: "pedidos" }] },
  { id: "CFO-002", cat: "directa", q: "compara mis sucursales de este mes", llama: [L("cfo_comparar_sucursales", { periodo: "este_mes" })], cifras: [{ col: "ventas", fila: "primera" }], grafica: true },
  { id: "CFO-003", cat: "directa", q: "¿qué es lo más importante esta semana?", llama: [L("cfo_lo_mas_importante", { periodo: "esta_semana" })], cifras: [{ col: "impacto", fila: "primera" }] },
  {
    id: "CFO-004",
    cat: "trampa",
    q: "¿cuánto vendió Altabrisa ayer?",
    quien: "admin_acotado",
    llama: [L("cfo_resumen", { periodo: "ayer", sucursal: "Altabrisa" })],
    status: "clarify",
    prohibidas: ["Altabrisa vendió"],
    debeDecir: [/No encontré esa sucursal/],
    riesgo: "alto",
  },
  {
    id: "CFO-005",
    cat: "directa",
    q: "¿cuánto vendí en mostrador la semana pasada?",
    mundo: "sin_sr",
    llama: [L("cfo_softrestaurant", { periodo: "semana_pasada" })],
    status: "no_data",
    debeDecir: [/Todavía no hay ventas importadas de SoftRestaurant/, /no puedo separar mostrador y domicilio/],
  },
  {
    id: "CFO-006",
    cat: "directa",
    q: "¿cuál es mi food cost del mes pasado?",
    llama: [L("cfo_estado_resultados", { periodo: "mes_pasado" })],
    cifras: [{ resumen: true, tomar: [0] }],
    debeDecir: [/Captura pendiente/, /Costo de ventas/, /Capturar costos/],
  },
  { id: "CFO-007", cat: "directa", q: "¿cuánto me cuesta el agente por pedido este mes?", llama: [L("cfo_agente", { periodo: "este_mes" })], cifras: [{ col: "costo_por_pedido", fila: "ultima" }] },
  { id: "CFO-008", cat: "directa", q: "¿qué es lo más importante esta semana?", mundo: "sin_migrar", llama: [L("cfo_lo_mas_importante", { periodo: "esta_semana" })], status: "unavailable", debeDecir: [/todavía no está disponible/] },
];
