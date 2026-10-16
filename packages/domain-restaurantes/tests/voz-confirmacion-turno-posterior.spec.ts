// Regresion QA-restaurantes-R1-viaje-08: por voz la maquina de estados del pedido exige que la confirmacion llegue en un turno del cliente
// POSTERIOR a la cotizacion (igual que en WhatsApp). El turno lo cuenta el controlador de la llamada (hablas inteligibles del cliente), no el modelo.
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
type Lineas = (m: MemoriaTools) => unknown[];
const bistec = (n: number): Lineas => (m) => [linea(m, "bistec", n, "maiz")];
const cotizar = (items: Lineas, extra: Record<string, unknown> = {}): PasoAgente => ({ tool: "cotizar_pedido", args: (m) => ({ branch_slug: SUC, items: items(m), canal: "domicilio", colonia_entrega: "Centro", ...extra }) });
const confirmar: PasoAgente = { tool: "confirmar_resumen", args: (m) => ({ quote_hash: m.quoteHash() }) };
const crear = (items: Lineas, extra: Record<string, unknown> = {}): PasoAgente => ({
  tool: "crear_pedido",
  args: (m) => ({ branch_slug: SUC, customer_name: "Cliente QA", items: items(m), payment_method: "efectivo", canal: "domicilio", colonia_entrega: "Centro", customer_address: "Calle 60 número 100, Centro", ...extra }),
});
const dice = (texto: string): PasoAgente => ({ dice: texto });

async function correr(g: GuionLlamada) {
  const l = await correrGuion(g);
  const fallas = (await evaluarLlamada(l)).filter((r) => !r.ok);
  return { l, fallas, pedidos: await l.mundo.pedidos() };
}

describe("viaje-08: confirmacion en un turno posterior por voz", () => {
  it("cotizar + confirmar + crear en el MISMO turno del cliente: confirmar_resumen se rechaza y no se crea pedido", async () => {
    const { pedidos, l } = await correr({
      id: "QA-V-confirma-solo",
      titulo: "el modelo confirma por su cuenta",
      rasgos: ["maquina de estados", "confirmacion"],
      turnos: [
        {
          kind: "voz",
          cliente: "Seis de bistec de maíz a domicilio en el Centro, en efectivo, a nombre de Cliente QA, calle sesenta número cien",
          agente: [buscar("bistec"), cotizar(bistec(6)), confirmar, crear(bistec(6)), dice("Listo, su pedido quedó registrado.")],
        },
        { kind: "cuelga" },
      ],
      esperado: { resultado: "abandonado", sinPedido: true },
    });
    expect(l.tools.find((t) => t.nombre === "confirmar_resumen")?.resultado).toMatchObject({ error: expect.stringMatching(/contest|respuesta|cliente/i) });
    expect(l.tools.find((t) => t.nombre === "crear_pedido")?.resultado).toMatchObject({ error: expect.stringMatching(/confirm/i) });
    expect(pedidos).toHaveLength(0);
  });

  it("cotizar en un turno y confirmar + crear cuando el cliente contesta 'si' en el siguiente: el pedido se crea", async () => {
    const { fallas, pedidos, l } = await correr({
      id: "QA-V-confirma-con-si",
      titulo: "flujo normal con confirmacion del cliente",
      rasgos: ["maquina de estados", "confirmacion"],
      turnos: [
        { kind: "voz", cliente: "Seis de bistec de maíz a domicilio en el Centro", agente: [buscar("bistec"), cotizar(bistec(6)), dice("Son trescientos veintiocho pesos. ¿Le parece bien?")] },
        { kind: "voz", cliente: "Sí, en efectivo, a nombre de Cliente QA, calle sesenta número cien", agente: [confirmar, crear(bistec(6)), dice("Listo, su pedido quedó registrado.")] },
      ],
      esperado: { resultado: "pedido_creado", pedido: { sucursal: "Francisco de Montejo", canal: "domicilio", pago: "efectivo", total: 328, items: [{ nombre: "Tacos de Bistec de Res (orden de 3)", cantidad: 2 }] } },
    });
    expect(fallas).toEqual([]);
    expect(l.resultado).toBe("pedido_creado");
    expect(pedidos).toHaveLength(1);
  });
});
