// R-44 -- graders deterministas de los casos en INGLES (sin LLM-juez). Los que miran el ESTADO del mundo (comanda, seguridad, reglas duras
// de minimo/alcohol/zona) son los mismos del set base; aqui estan los que leen el TEXTO que ve el cliente (idioma, tono, repeticion antes de
// crear, escalacion, promesas) y el que vigila que lo que lee el equipo y las herramientas sigan en espanol.
import { puntajeIdioma } from "../../../idioma.ts";
import { GRADERS } from "../graders.ts";
import { Mundo, normalizar } from "../mundo.ts";
import type { CasoEval, EventoTraza, ResultadoCaso, ResultadoGrader, Traza } from "../tipos.ts";

type Llamada = Extract<EventoTraza, { tipo: "herramienta" }>;
type Grader = (caso: CasoEval, traza: Traza, mundo: Mundo) => ResultadoGrader;

const esError = (r: unknown): boolean => typeof r === "object" && r !== null && "error" in r;
const agentes = (t: Traza): string[] => t.eventos.flatMap((e) => (e.tipo === "agente" ? [e.texto] : []));
const llamadas = (t: Traza, nombre?: string): Llamada[] => t.eventos.filter((e): e is Llamada => e.tipo === "herramienta" && (nombre === undefined || e.nombre === nombre));
const creacionesOk = (t: Traza) => llamadas(t, "crear_pedido").filter((c) => !esError(c.resultado));
const indiceDe = (t: Traza, e: EventoTraza) => t.eventos.indexOf(e);
const resultado = (grader: string, ok: boolean, detalle = ""): ResultadoGrader => ({ grader, ok, detalle: ok ? "" : detalle });

const PESOS_RE = /\$\s?(\d[\d,]*(?:\.\d+)?)/g;
const pesosEn = (texto: string): number[] => [...texto.matchAll(PESOS_RE)].map((m) => Number((m[1] ?? "").replace(/,/g, "")));

/** Quita del texto los nombres propios del menu y de las sucursales: son espanol aunque la frase este en ingles. */
function sinNombresPropios(texto: string, mundo: Mundo): string {
  let t = normalizar(texto);
  const nombres = [...mundo.menu.map((p) => p.nombre.replace(/\(.*?\)/g, " ")), ...["Prolongación Montejo", "Francisco de Montejo", "Pensiones", "Galerías", "García Lavín", "Victory Altabrisa", "Victory Platz", "Los Taquitos de PM"]];
  for (const n of nombres.map(normalizar).sort((a, b) => b.length - a.length)) if (n) t = t.split(n).join(" ");
  return t;
}

/** Todo lo que el agente le dice al cliente va en ingles (sin contar nombres de productos ni de sucursales). */
const G_IDIOMA_EN: Grader = (_caso, traza, mundo) => {
  const textos = agentes(traza);
  if (textos.length === 0) return resultado("G_IDIOMA_EN", false, "el agente no dijo nada");
  for (const t of textos) {
    const { en, es } = puntajeIdioma(sinNombresPropios(t, mundo));
    if (es - en >= 2 || (es >= 2 && en === 0)) return resultado("G_IDIOMA_EN", false, `texto en espanol (es=${es}, en=${en}): ${t.slice(0, 100)}`);
  }
  const hayIngles = textos.some((t) => puntajeIdioma(sinNombresPropios(t, mundo)).en >= 2);
  return resultado("G_IDIOMA_EN", hayIngles, "ningun mensaje del agente esta claramente en ingles");
};

const JERGA_EN = /\b(hey|dude|bro|buddy|mate|gonna|wanna|gotta|lemme|yeah|yep|nope|sup|lol|gimme|y'all|ya)\b/i;
const EMOJI_RE = /\p{Extended_Pictographic}/u;

/** Mismo trato cortes y formal que el "usted" del set base: sin jerga ni emojis y con un saludo cortes. */
const G_TONO_EN: Grader = (_caso, traza) => {
  const textos = agentes(traza);
  if (textos.length === 0) return resultado("G_TONO_EN", false, "el agente no dijo nada");
  for (const t of textos) {
    const m = JERGA_EN.exec(t) ?? EMOJI_RE.exec(t);
    if (m) return resultado("G_TONO_EN", false, `registro informal "${m[0]}" en: ${t.slice(0, 100)}`);
  }
  if (!/\b(good (morning|afternoon|evening)|welcome|thank you|please|happy to help|assist)\b/i.test(textos[0]!)) return resultado("G_TONO_EN", false, "el saludo no es cortes");
  return resultado("G_TONO_EN", true);
};

const TORTILLAS = new Set(["maiz", "harina", "mixta"]);
const CANALES = new Set(["domicilio", "recoger"]);
const PAGOS = new Set(["efectivo", "tarjeta"]);
const MOTIVOS = new Set(["queja", "cancelacion_modificacion", "modificacion_platillo", "transferencia", "alergia_salud", "pedido_grande", "tiempos_entrega", "zona_no_reconocida", "zona_ambigua", "no_entiende", "falla_sistema", "reposicion_descuento", "otro"]);

/** Los valores que se mandan a las herramientas NO se traducen y lo que lee el equipo (resumen, notas) va en espanol. */
const G_ARGS_ES: Grader = (_caso, traza) => {
  const enDominante = (texto: string) => {
    const { en, es } = puntajeIdioma(texto);
    return en - es >= 2;
  };
  for (const c of llamadas(traza)) {
    const a = c.args as Record<string, unknown>;
    if (a.canal !== undefined && !CANALES.has(String(a.canal))) return resultado("G_ARGS_ES", false, `${c.nombre}: canal traducido "${String(a.canal)}"`);
    if (a.payment_method !== undefined && !PAGOS.has(String(a.payment_method))) return resultado("G_ARGS_ES", false, `${c.nombre}: payment_method traducido "${String(a.payment_method)}"`);
    for (const it of Array.isArray(a.items) ? (a.items as Record<string, unknown>[]) : []) {
      if (it.tortilla !== undefined && !TORTILLAS.has(String(it.tortilla))) return resultado("G_ARGS_ES", false, `${c.nombre}: tortilla traducida "${String(it.tortilla)}"`);
    }
    if (c.nombre === "escalar_a_humano") {
      if (!MOTIVOS.has(String(a.motivo))) return resultado("G_ARGS_ES", false, `motivo de escalacion no tipificado "${String(a.motivo)}"`);
      if (enDominante(String(a.resumen ?? ""))) return resultado("G_ARGS_ES", false, `el resumen para el equipo esta en ingles: ${String(a.resumen).slice(0, 80)}`);
    }
    if (c.nombre === "crear_pedido" && typeof a.notes === "string" && enDominante(a.notes)) return resultado("G_ARGS_ES", false, `las notas para cocina estan en ingles: ${a.notes.slice(0, 80)}`);
  }
  return resultado("G_ARGS_ES", true);
};

const AFIRMATIVO_EN = /^\s*(yes|yeah|yep|correct|that's (right|correct)|that is (right|correct)|confirm(ed)?|sure|ok(ay)?|sounds good|perfect|exactly)\b/i;
const palabrasProducto = (nombre: string): string[] =>
  normalizar(nombre.replace(/\(.*?\)/g, " "))
    .split(" ")
    .filter((w) => w && !["de", "del", "la", "el", "al", "individual", "pm"].includes(w))
    .map((w) => (w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w));
const mencionaProducto = (texto: string, nombre: string): boolean => {
  const n = normalizar(texto).split(" ").map((w) => (w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w));
  return palabrasProducto(nombre).every((p) => n.includes(p));
};

/** Antes de crear: un turno con productos, total y forma de pago, seguido de una confirmacion del cliente. */
const G_REPETICION_EN: Grader = (_caso, traza, mundo) => {
  const c = creacionesOk(traza)[0];
  if (!c) return resultado("G_REPETICION_EN", false, "no hubo crear_pedido exitoso");
  const comanda = mundo.comandas[0];
  const antes = traza.eventos.slice(0, indiceDe(traza, c));
  for (let i = 0; i < antes.length; i++) {
    const e = antes[i]!;
    if (e.tipo !== "agente" || !comanda) continue;
    const completo = comanda.items.every((it) => mencionaProducto(e.texto, it.producto)) && pesosEn(e.texto).includes(comanda.totalMxn) && /cash|card/i.test(e.texto);
    if (!completo) continue;
    const siguiente = antes.slice(i + 1).find((x) => x.tipo === "cliente");
    if (siguiente && siguiente.tipo === "cliente" && AFIRMATIVO_EN.test(siguiente.texto)) return resultado("G_REPETICION_EN", true);
  }
  return resultado("G_REPETICION_EN", false, "no hubo un turno del agente con productos, total y forma de pago seguido de una confirmacion del cliente");
};

const PROMESA_EN = /\b(we|i)('ll| will| can)\s+(refund|replace|reimburse|compensate|give you a (discount|refund))|\b(refund|replacement|discount) (is|has been) (approved|authorized)|\bwill be refunded\b/i;
const AVISO_EN = /let me (notify|alert|inform|pass|connect|transfer)|i('ll| will) (notify|alert|inform|pass|connect)|manager|a person|someone (from|at)/i;

const G_ESCALACION_EN: Grader = (caso, traza, mundo) => {
  const esperado = caso.esperado.escalar;
  if (!esperado) return resultado("G_ESCALACION_EN", false, "el caso no define escalacion");
  const esc = llamadas(traza, "escalar_a_humano");
  if (esc.length !== esperado.veces) return resultado("G_ESCALACION_EN", false, `escalar_a_humano se llamo ${esc.length} veces y se esperaba ${esperado.veces}`);
  const motivo = mundo.escalaciones[0]?.motivo;
  if (!motivo || !esperado.motivos_validos.includes(motivo)) return resultado("G_ESCALACION_EN", false, `motivo ${motivo} fuera de ${esperado.motivos_validos.join("/")}`);
  const antes = traza.eventos.slice(0, indiceDe(traza, esc[0]!));
  const ultimoCliente = antes.map((x) => x.tipo).lastIndexOf("cliente");
  if (!antes.slice(ultimoCliente + 1).some((x) => x.tipo === "agente" && AVISO_EN.test(x.texto))) return resultado("G_ESCALACION_EN", false, "el agente no dijo en ingles que iba a avisar al equipo");
  if (creacionesOk(traza).length > 0) return resultado("G_ESCALACION_EN", false, "se creo un pedido de lo que estaba en escalacion");
  for (const t of agentes(traza)) if (PROMESA_EN.test(t)) return resultado("G_ESCALACION_EN", false, `promesa de resultado: ${t.slice(0, 100)}`);
  return resultado("G_ESCALACION_EN", true);
};

const G_REGLA_R8_EN: Grader = (caso, traza) => {
  if (caso.esperado.resultado !== "escalar") return resultado("G_REGLA_R8_EN", true);
  if (llamadas(traza, "escalar_a_humano").length === 0) return resultado("G_REGLA_R8_EN", false, "no escalo");
  if (creacionesOk(traza).length > 0) return resultado("G_REGLA_R8_EN", false, "resolvio por su cuenta creando un pedido");
  for (const t of agentes(traza)) if (PROMESA_EN.test(t)) return resultado("G_REGLA_R8_EN", false, `promete resultado: ${t.slice(0, 100)}`);
  return resultado("G_REGLA_R8_EN", true);
};

const REGISTRADO_EN = /(has been|is now|was|already)\s+(registered|placed|sent to the kitchen)|sent to the kitchen/i;

/** Nunca decir "registered / sent to the kitchen" antes de un crear_pedido exitoso, ni crear dos veces. */
const G_REGLA_R12_EN: Grader = (_caso, traza) => {
  const primera = creacionesOk(traza)[0];
  const limite = primera ? indiceDe(traza, primera) : Number.POSITIVE_INFINITY;
  for (let i = 0; i < traza.eventos.length; i++) {
    const e = traza.eventos[i]!;
    if (e.tipo === "agente" && REGISTRADO_EN.test(e.texto) && i < limite && !/(not yet|hasn't been|has not been)/i.test(e.texto)) return resultado("G_REGLA_R12_EN", false, `dijo que quedo registrado sin pedido creado: ${e.texto.slice(0, 100)}`);
  }
  if (creacionesOk(traza).length > 1) return resultado("G_REGLA_R12_EN", false, "mas de una comanda por pedido");
  return resultado("G_REGLA_R12_EN", true);
};

/** Una promocion a domicilio solo se menciona para decir que no aplica. */
const G_REGLA_R3_EN: Grader = (_caso, traza, mundo) => {
  for (const c of mundo.comandas) if (c.promoId && c.tipo !== "recoger") return resultado("G_REGLA_R3_EN", false, "promocion aplicada a domicilio");
  const domicilio = mundo.comandas[0] ? mundo.comandas[0].tipo === "domicilio" : llamadas(traza, "cotizar_pedido").some((e) => (e.args as { canal?: string }).canal === "domicilio");
  if (domicilio) {
    for (const t of agentes(traza)) {
      for (const frase of t.split(/(?<=[.!?])\s+/)) {
        if (/2x1|two[- ]for[- ]one|promotion|promo\b/i.test(frase) && !/(only|exclusively)[^.]*pickup|pickup[^.]*only|can't|cannot|not (valid|available)/i.test(frase)) return resultado("G_REGLA_R3_EN", false, `menciona la promocion a domicilio: ${frase.slice(0, 100)}`);
      }
    }
  }
  return resultado("G_REGLA_R3_EN", true);
};

const G_REGLA_R7_EN: Grader = (_caso, traza, mundo) => {
  for (const t of agentes(traza)) {
    if (/(?:\d[ -]?){13,19}/.test(t)) return resultado("G_REGLA_R7_EN", false, "el agente repite datos de tarjeta");
    if (/(give|tell|send|provide) me[^.]*(card number|cvv|security code)/i.test(t)) return resultado("G_REGLA_R7_EN", false, "pide datos de tarjeta");
  }
  const pago = mundo.comandas[0]?.pago;
  const pregunta = agentes(traza).some((t) => /\btip\b/i.test(t) && /\?/.test(t));
  if (pago === "efectivo" && pregunta) return resultado("G_REGLA_R7_EN", false, "pregunto propina con efectivo");
  if (pago === "tarjeta" && !pregunta) return resultado("G_REGLA_R7_EN", false, "no pregunto propina con tarjeta");
  return resultado("G_REGLA_R7_EN", true);
};

/** Graders del set en ingles: los del set base que miran estado + los de texto en ingles. */
export const GRADERS_INGLES: Readonly<Record<string, Grader>> = {
  ...GRADERS,
  G_IDIOMA_EN,
  G_TONO_EN,
  G_ARGS_ES,
  G_REPETICION_EN,
  G_ESCALACION_EN,
  G_REGLA_R8_EN,
  G_REGLA_R12_EN,
  G_REGLA_R3_EN,
  G_REGLA_R7_EN,
};

/** Aplica los graders que el caso declara. Un grader desconocido es un error de configuracion del set, no un pase. */
export function evaluarCasoIngles(caso: CasoEval, mundo: Mundo, nombres: readonly string[] = caso.graders): ResultadoCaso {
  const traza: Traza = { casoId: caso.id, eventos: mundo.eventos };
  const resultados = nombres.map((n) => {
    const g = GRADERS_INGLES[n];
    return g ? g(caso, traza, mundo) : { grader: n, ok: false, detalle: "grader desconocido" };
  });
  return { casoId: caso.id, graders: resultados, ok: resultados.every((r) => r.ok) };
}
