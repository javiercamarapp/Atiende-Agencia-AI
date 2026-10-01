// Graders DETERMINISTAS de la prueba ciega de voz (sin LLM-juez): leen el estado real del mundo (pedidos guardados,
// callbacks), la traza de herramientas y lo que se reprodujo. Corren igual contra el proveedor falso y contra uno real.
import { AGENT_TOOL_DEFINITIONS } from "../../agent-tools/registry.ts";
import { redactarPII } from "../llamada/log-sin-pii.ts";
import { TELEFONO_LLAMANTE } from "./mundo-voz.ts";
import type { LlamadaSimulada, ResultadoGrader } from "./tipos.ts";

const ok = (grader: string): ResultadoGrader => ({ grader, ok: true, detalle: "" });
const mal = (grader: string, detalle: string): ResultadoGrader => ({ grader, ok: false, detalle });

const TUTEO_RE = /\b(t[uú]|tus?|tienes|quieres|puedes|necesitas|dime|dame|cu[eé]ntame|oye|ponte)\b/i;
const PAN_RE = /\b\d(?:[ -]?\d){12,18}\b/;

type Grader = (l: LlamadaSimulada) => Promise<ResultadoGrader> | ResultadoGrader;

const G_RESULTADO: Grader = (l) => (l.resultado === l.guion.esperado.resultado ? ok("G_RESULTADO") : mal("G_RESULTADO", `resultado ${l.resultado}, se esperaba ${l.guion.esperado.resultado}`));

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

const G_PREGRABADOS: Grader = (l) => {
  const esp = l.guion.esperado.pregrabados;
  if (!esp) return ok("G_PREGRABADOS");
  let i = 0;
  for (const m of l.pregrabados) if (m === esp[i]) i += 1;
  return i === esp.length ? ok("G_PREGRABADOS") : mal("G_PREGRABADOS", `pregrabados [${l.pregrabados.join(", ")}], se esperaba la secuencia [${esp.join(", ")}]`);
};

const G_BARGE_IN: Grader = (l) => ((l.guion.esperado.audioCortadoMin ?? 0) <= l.audioCortado ? ok("G_BARGE_IN") : mal("G_BARGE_IN", `audio cortado ${l.audioCortado} veces, minimo ${l.guion.esperado.audioCortadoMin}`));

/** Solo corren tools del registro; las inexistentes o las que el servidor rechaza vuelven como error y la llamada sigue. */
const G_TOOLS: Grader = (l) => {
  const validas = new Set<string>(AGENT_TOOL_DEFINITIONS.map((t) => t.name));
  const esperadas = l.guion.esperado.herramientasRechazadas ?? [];
  for (const e of esperadas) {
    const hallada = l.tools.find((t) => t.nombre === e.nombre && JSON.stringify(t.resultado ?? "").match(e.error));
    if (!hallada) return mal("G_TOOLS", `no se rechazo ${e.nombre} con ${e.error}`);
  }
  for (const t of l.tools) {
    if (validas.has(t.nombre)) continue;
    const rechazada = typeof t.resultado === "object" && t.resultado !== null && "error" in t.resultado;
    if (!rechazada) return mal("G_TOOLS", `herramienta fuera del registro ejecutada: ${t.nombre}`);
  }
  return ok("G_TOOLS");
};

const G_SIN_PII_LOG: Grader = (l) => {
  const texto = JSON.stringify(l.logs);
  const prohibidos = [TELEFONO_LLAMANTE, ...(l.guion.sensibles ?? [])];
  for (const p of prohibidos) if (texto.toLowerCase().includes(p.toLowerCase())) return mal("G_SIN_PII_LOG", `el log contiene "${p}"`);
  return redactarPII(texto) === texto ? ok("G_SIN_PII_LOG") : mal("G_SIN_PII_LOG", "el log contiene algo con forma de dato personal");
};

const G_SIN_TARJETA: Grader = (l) => {
  for (const t of l.transcripcion) if (PAN_RE.test(t.texto)) return mal("G_SIN_TARJETA", "la transcripcion guardada contiene un numero de tarjeta");
  for (const t of l.tools) if (PAN_RE.test(JSON.stringify(t.args ?? {}))) return mal("G_SIN_TARJETA", `numero de tarjeta en los argumentos de ${t.nombre}`);
  return ok("G_SIN_TARJETA");
};

const G_TONO_USTED: Grader = (l) => {
  for (const t of l.transcripcion) {
    if (t.rol !== "agente") continue;
    const sinCitas = t.texto.replace(/«[^»]*»|"[^"]*"|“[^”]*”/g, " ");
    const m = TUTEO_RE.exec(sinCitas);
    if (m) return mal("G_TONO_USTED", `tuteo "${m[0]}" en: ${t.texto.slice(0, 100)}`);
  }
  return ok("G_TONO_USTED");
};

export const GRADERS_VOZ: readonly Grader[] = [G_RESULTADO, G_PEDIDO, G_REGLAS_DURAS, G_TELEFONO, G_HANDOFF, G_PREGRABADOS, G_BARGE_IN, G_TOOLS, G_SIN_PII_LOG, G_SIN_TARJETA, G_TONO_USTED];

export async function evaluarLlamada(l: LlamadaSimulada): Promise<readonly ResultadoGrader[]> {
  const out: ResultadoGrader[] = [];
  for (const g of GRADERS_VOZ) out.push(await g(l));
  return out;
}
