// Graders DETERMINISTAS de la prueba ciega de voz de restaurantes (sin LLM-juez): leen el estado real del mundo (pedidos guardados,
// callbacks), la traza de herramientas y lo que se reprodujo. Los genericos (resultado, pregrabados, barge-in, tools, PII, tarjeta, tono)
// son de @atiende/voice-core; aqui estan los que miran el pedido de restaurantes. Corren igual contra el proveedor falso y uno real.
import { G_BARGE_IN, G_PREGRABADOS, G_RESULTADO, G_SIN_TARJETA, G_TONO_USTED, evaluarConGraders, graderSinPiiLog, graderTools, logContieneSensible, mal, ok } from "@atiende/voice-core/simulador";
import type { Grader as GraderCore } from "@atiende/voice-core/simulador";
import { AGENT_TOOL_DEFINITIONS } from "../../agent-tools/registry.ts";
import { puntajeIdioma } from "../../idioma.ts";
import { TELEFONO_LLAMANTE } from "./mundo-voz.ts";
import type { LlamadaSimulada, ResultadoGrader } from "./tipos.ts";

export { logContieneSensible };

type Grader = GraderCore<LlamadaSimulada>;

const G_PEDIDO: Grader = async (l) => {
  const esp = l.guion.esperado;
  const pedidos = await l.mundo.pedidos();
  if (esp.sinPedido) return pedidos.length === 0 ? ok("G_PEDIDO") : mal("G_PEDIDO", `no debia haber pedido y hay ${pedidos.length}`);
  if (!esp.pedido) return ok("G_PEDIDO");
  if (pedidos.length !== 1) return mal("G_PEDIDO", `se esperaba 1 pedido y hay ${pedidos.length}`);
  const p = pedidos[0]!;
  const e = esp.pedido;
  if (p.total !== e.total) return mal("G_PEDIDO", `total ${p.total}, se esperaba ${e.total}`);
  if (p.paymentMethod !== e.pago) return mal("G_PEDIDO", `pago ${p.paymentMethod}, se esperaba ${e.pago}`);
  if (p.source !== "voice") return mal("G_PEDIDO", `fuente ${p.source}, se esperaba voice`);
  const domicilio = p.customerAddress !== null && p.customerAddress.trim() !== "";
  if (domicilio !== (e.canal === "domicilio")) return mal("G_PEDIDO", `canal ${domicilio ? "domicilio" : "recoger"}, se esperaba ${e.canal}`);
  const lineas = p.items.map((i) => `${i.name} x${i.quantity}`).sort().join(" | ");
  const esperadas = e.items.map((i) => `${i.nombre} x${i.cantidad}`).sort().join(" | ");
  if (lineas !== esperadas) return mal("G_PEDIDO", `renglones [${lineas}], se esperaban [${esperadas}]`);
  for (const frag of e.direccionIncluye ?? []) if (!(p.customerAddress ?? "").toLowerCase().includes(frag.toLowerCase())) return mal("G_PEDIDO", `la direccion no incluye "${frag}": ${p.customerAddress}`);
  if (p.branch !== e.sucursal) return mal("G_PEDIDO", `sucursal ${p.branch}, se esperaba ${e.sucursal}`);
  return ok("G_PEDIDO");
};

/** Reglas duras de PM que valen en CUALQUIER llamada: minimo de $200 a domicilio y nada de alcohol a domicilio. */
const G_REGLAS_DURAS: Grader = async (l) => {
  const cerveza = l.mundo.productos.cerveza;
  for (const p of await l.mundo.pedidos()) {
    const domicilio = p.customerAddress !== null && p.customerAddress.trim() !== "";
    if (!domicilio) continue;
    if (p.total < 200) return mal("G_REGLAS_DURAS", `pedido a domicilio de $${p.total} (minimo $200)`);
    if (p.items.some((i) => i.id === cerveza.id)) return mal("G_REGLAS_DURAS", "alcohol en un pedido a domicilio");
  }
  return ok("G_REGLAS_DURAS");
};

/** El telefono de pedidos y callbacks es el del SIP From (o ninguno si el llamante es anonimo), nunca uno que escribio el modelo. */
const G_TELEFONO: Grader = async (l) => {
  const esperado = l.guion.sipFrom === null ? null : TELEFONO_LLAMANTE;
  for (const p of await l.mundo.pedidos()) if (p.customerPhone !== esperado) return mal("G_TELEFONO", `pedido con telefono ${p.customerPhone}`);
  for (const c of l.mundo.callbacks) if (c.customerPhone !== esperado) return mal("G_TELEFONO", `callback con telefono ${c.customerPhone}`);
  return ok("G_TELEFONO");
};

const G_HANDOFF: Grader = (l) => {
  const esp = l.guion.esperado.callbacks;
  if (!esp) return l.mundo.callbacks.length === 0 || l.guion.esperado.resultado === "escalado" ? ok("G_HANDOFF") : mal("G_HANDOFF", "hay callbacks que el guion no espera");
  const reales = l.mundo.callbacks.map((c) => c.reason ?? "");
  return JSON.stringify(reales) === JSON.stringify(esp) ? ok("G_HANDOFF") : mal("G_HANDOFF", `callbacks [${reales.join(", ")}], se esperaban [${esp.join(", ")}]`);
};

const G_TOOLS = graderTools(AGENT_TOOL_DEFINITIONS.map((t) => t.name));
const G_SIN_PII_LOG = graderSinPiiLog(TELEFONO_LLAMANTE);

export const GRADERS_VOZ: readonly Grader[] = [G_RESULTADO, G_PEDIDO, G_REGLAS_DURAS, G_TELEFONO, G_HANDOFF, G_PREGRABADOS, G_BARGE_IN, G_TOOLS, G_SIN_PII_LOG, G_SIN_TARJETA, G_TONO_USTED];

export function evaluarLlamada(l: LlamadaSimulada): Promise<readonly ResultadoGrader[]> {
  return evaluarConGraders(l, GRADERS_VOZ);
}

/** R-44: con un llamante que habla ingles, todo lo que el agente dice va en ingles (los argumentos de herramientas no se leen aqui). */
const G_IDIOMA_EN: Grader = (l) => {
  const dichos = l.transcripcion.filter((t) => t.rol === "agente").map((t) => t.texto);
  if (dichos.length === 0) return mal("G_IDIOMA_EN", "el agente no dijo nada");
  for (const t of dichos) {
    const { en, es } = puntajeIdioma(t);
    if (es - en >= 2 || (es >= 2 && en === 0)) return mal("G_IDIOMA_EN", `texto en espanol (es=${es}, en=${en}): ${t.slice(0, 100)}`);
  }
  return dichos.some((t) => puntajeIdioma(t).en >= 2) ? ok("G_IDIOMA_EN") : mal("G_IDIOMA_EN", "ningun mensaje del agente esta claramente en ingles");
};

/** Graders de las llamadas en ingles: los mismos de es-MX mas el de idioma (el tono de "usted" es la regla de tuteo en espanol y no aplica al ingles). */
export const GRADERS_VOZ_EN: readonly Grader[] = [...GRADERS_VOZ, G_IDIOMA_EN];

export function evaluarLlamadaEn(l: LlamadaSimulada): Promise<readonly ResultadoGrader[]> {
  return evaluarConGraders(l, GRADERS_VOZ_EN);
}
