// Regresion QA-restaurantes-R1-agentes-13 (precio hablado distinto al cotizado: G_PRECIO_HABLADO), contra el simulador de voz es-MX (proveedor FALSO guionado, nucleo real de voice-core).
import { describe, expect, it } from "vitest";
import { correrGuion } from "../src/voz/simulador/correr-guion.ts";
import { evaluarLlamada } from "../src/voz/simulador/graders-voz.ts";
import { BRANCH_SLUG_PRINCIPAL } from "../src/voz/simulador/mundo-voz.ts";
import type { GuionLlamada, MemoriaTools, PasoAgente } from "../src/voz/simulador/tipos.ts";

const SUC = BRANCH_SLUG_PRINCIPAL;
const buscar = (query: string): PasoAgente => ({ tool: "buscar_producto", args: { query, branch_slug: SUC } });
const linea = (m: MemoriaTools, frag: string, piezas: number, tortilla?: "maiz" | "harina") => {
  const p = m.producto(frag);
  return { product_id: p.id, product_name: p.name, requested_quantity: piezas, ...(tortilla ? { tortilla } : {}) };
};
const recoger = (items: (m: MemoriaTools) => unknown[]): PasoAgente => ({ tool: "cotizar_pedido", args: (m) => ({ branch_slug: SUC, canal: "recoger", items: items(m) }) });
const confirmar: PasoAgente = { tool: "confirmar_resumen", args: (m) => ({ quote_hash: m.quoteHash() }) };
const crear = (items: (m: MemoriaTools) => unknown[]): PasoAgente => ({ tool: "crear_pedido", args: (m) => ({ branch_slug: SUC, customer_name: "Cliente Prueba", canal: "recoger", payment_method: "efectivo", items: items(m) }) });
const dice = (texto: string): PasoAgente => ({ dice: texto });
const bistec6 = (m: MemoriaTools) => [linea(m, "bistec", 6, "maiz")];
const PEDIDO_6 = { sucursal: "Francisco de Montejo", canal: "recoger" as const, pago: "efectivo" as const, total: 328, items: [{ nombre: "Tacos de Bistec de Res (orden de 3)", cantidad: 2 }] };

async function correr(g: GuionLlamada) {
  const llamada = await correrGuion(g);
  const fallos = (await evaluarLlamada(llamada)).filter((r) => !r.ok);
  return { llamada, fallos };
}

describe("agentes-13 (simulador de voz es-MX)", () => {
  it("13 el agente DICE 'doscientos pesos' cuando cotizar_pedido devolvio $328: G_PRECIO_HABLADO lo marca", async () => {
    const { fallos } = await correr({
      id: "VQA-precio-inventado-hablado",
      titulo: "precio hablado distinto al cotizado",
      rasgos: ["precio inventado"],
      turnos: [
        { kind: "voz", cliente: "Seis de bistec para recoger, de maíz", agente: [buscar("bistec"), recoger(bistec6), dice("Son dos órdenes de bistec, doscientos pesos. ¿Le parece bien?")] },
        { kind: "voz", cliente: "Sí, efectivo, a nombre de Cliente Prueba", agente: [confirmar, crear(bistec6), dice("Listo, su pedido quedó registrado por doscientos pesos.")] },
      ],
      esperado: { resultado: "pedido_creado", pedido: PEDIDO_6 },
    });
    expect(fallos.map((f) => f.grader)).toEqual(["G_PRECIO_HABLADO"]);
  });

  it("13 el agente dice el importe cotizado (en palabras y en digitos): ningun grader falla", async () => {
    const { fallos } = await correr({
      id: "VQA-precio-correcto-hablado",
      titulo: "precio hablado igual al cotizado",
      rasgos: ["precio"],
      turnos: [
        { kind: "voz", cliente: "Seis de bistec para recoger, de maíz", agente: [buscar("bistec"), recoger(bistec6), dice("Son dos órdenes de bistec, trescientos veintiocho pesos. ¿Le parece bien?")] },
        { kind: "voz", cliente: "Sí, efectivo, a nombre de Cliente Prueba", agente: [confirmar, crear(bistec6), dice("Listo, su pedido quedó registrado por $328.")] },
      ],
      esperado: { resultado: "pedido_creado", pedido: PEDIDO_6 },
    });
    expect(fallos).toEqual([]);
  });

});
