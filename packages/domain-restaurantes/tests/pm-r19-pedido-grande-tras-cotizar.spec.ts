// PM Ronda 19, A22 (handler + webhook en memoria, modelo guionado, sin LLM ni llaves). Datos 100 % sinteticos.
// Si el turno muere (proveedor caido / tope de tiempo) con una cotizacion vigente que supera el umbral de pedido grande, el aviso al equipo es
// `pedido_grande` (con el resumen) y no un `falla_sistema` generico; sin umbral superado, todo igual que antes.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MENSAJE_PEDIDO_GRANDE_PENDIENTE } from "../src/agent-tools/registry.ts";
import { PEDIDO_GRANDE_TOTAL_MXN } from "../src/pedido-grande.ts";
import { MARTES_14H, nuevoViaje, pedidosDe, type Viaje } from "./qa-viaje/arnes-viaje.ts";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(MARTES_14H));
});
afterEach(() => vi.useRealTimers());

const motivos = (v: Viaje) => v.callbacks.map((c) => c.reason);
function proveedorCaido(v: Viaje) {
  v.requests.push = () => {
    throw new Error("proveedor caido (simulado)");
  };
}
async function cotiza(v: Viaje, cantidad: number) {
  v.guion([{ tools: [{ name: "cotizar_pedido", args: { branch_slug: "garcia-lavin", canal: "recoger", payment_method: "efectivo", customer_name: "Ana Prueba", items: [{ product_id: v.producto("Bistec de Res — 1 kg"), product_name: "Bistec de Res — 1 kg", requested_quantity: cantidad }] } }] }, { texto: "Permítame repetirle su pedido. ¿Es correcto?" }]);
  await v.escribe("quiero kilos de bistec para recoger");
}

describe("A22: cotizacion de pedido grande y el turno muere", () => {
  it("total sobre el umbral: aviso `pedido_grande` con el resumen, texto fijo de pedido grande, sin pedido y sin `falla_sistema`", async () => {
    const v = await nuevoViaje();
    await cotiza(v, 5);
    proveedorCaido(v);
    const r = await v.escribe("efectivo, a nombre de Ana Prueba, paso en 1 hora");
    expect(motivos(v)).toContain("escalada:pedido_grande");
    expect(motivos(v)).not.toContain("escalada:falla_sistema");
    expect(r.reply).toBe(MENSAJE_PEDIDO_GRANDE_PENDIENTE);
    expect(v.callbacks.find((c) => c.reason === "escalada:pedido_grande")?.message).toMatch(new RegExp(`mas de \\$${PEDIDO_GRANDE_TOTAL_MXN}`));
    expect(await pedidosDe(v)).toHaveLength(0);
  });

  it("total bajo el umbral: sigue el aviso `falla_sistema` de siempre", async () => {
    const v = await nuevoViaje();
    await cotiza(v, 1);
    proveedorCaido(v);
    await v.escribe("efectivo, a nombre de Ana Prueba, paso en 1 hora");
    expect(motivos(v)).toContain("escalada:falla_sistema");
    expect(motivos(v)).not.toContain("escalada:pedido_grande");
  });

  it("sin cotizacion vigente: `falla_sistema`", async () => {
    const v = await nuevoViaje();
    proveedorCaido(v);
    await v.escribe("quiero 5 kilos de bistec");
    expect(motivos(v)).toContain("escalada:falla_sistema");
    expect(motivos(v)).not.toContain("escalada:pedido_grande");
  });
});
