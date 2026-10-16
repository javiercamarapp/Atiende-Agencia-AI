// QA-PM-R5 A24 (D31): numero nuevo + efectivo + $2,800 (> $2,500) por WhatsApp. En la ronda 5 quedo escalado como `falla_sistema` (el crear_pedido del modelo fallaba) y no como
// `pedido_grande`, y el agente nunca explico que la sucursal lo confirmaria. La regla vive en el SERVIDOR: con los argumentos que el modelo de verdad manda para "sin propina"
// (omitidos, null, vacios) el pedido NO entra a cocina, queda el aviso `escalada:pedido_grande` en T7 con la conversacion cedida, y NO queda ningun aviso de falla del sistema.
// (Los rellenos con 0 / "0" los cubre el contrato de crear_pedido de la ronda 5, pm-r5-contrato-relleno-del-modelo.spec.ts.)
import { afterEach, describe, expect, it, vi } from "vitest";
import { banco, call, item, say } from "./qa/r1-arnes-whatsapp-pm.ts";

afterEach(() => {
  vi.useRealTimers();
});

const RELLENOS: ReadonlyArray<[string, Record<string, unknown>]> = [
  ["sin campos de propina", {}],
  ["propina null", { propina: null, propina_porcentaje: null }],
  ["propina vacia", { propina: "", propina_porcentaje: "" }],
];

describe("A24: numero nuevo + efectivo + $2,800 -> pedido_grande, no falla_sistema", () => {
  it.each(RELLENOS)("relleno de propina: %s", async (_nombre, relleno) => {
    const b = await banco();
    // 2 kg de pastor ($1,800) + 1 kg ($900) = $2,700 > $2,500; paga en efectivo y el numero no tiene historial.
    const items = [item(b.pid("Pastor — 2 kg"), "Pastor — 2 kg", 1), item(b.pid("Pastor — 1 kg"), "Pastor — 1 kg", 1)];
    b.setGuion([call("cotizar_pedido", { branch_slug: "garcia-lavin", canal: "recoger", items }), say("Total cotizado. ¿Confirma?")]);
    await b.enviar("+5219990000124", "quiero para recoger");
    b.setGuion([call("confirmar_resumen", {}), call("crear_pedido", { branch_slug: "garcia-lavin", canal: "recoger", customer_name: "Evento", payment_method: "efectivo", items, ...relleno }), say("Su pedido es grande: la sucursal lo confirma primero.")]);
    const r = await b.enviar("+5219990000124", "si efectivo");
    expect((await b.w.repo.listOrders(b.w.organizationId, { propertyIds: null, limit: 10 })).orders).toHaveLength(0);
    const avisos = b.callbacks();
    const grande = avisos.filter((c) => c.reason === "escalada:pedido_grande");
    expect(grande).toHaveLength(1);
    expect(grande[0]?.propertyId).toBe(b.t7);
    expect(grande[0]?.message).toMatch(/sin_historial|numero sin historial/);
    expect(avisos.some((c) => (c.reason ?? "").includes("falla_sistema"))).toBe(false);
    expect(r.escalated).toBe(true);
  });

  it("negativo: el mismo pedido con TARJETA ($2,700 < $4,000) se crea normal, sin aviso de pedido grande", async () => {
    const b = await banco();
    const items = [item(b.pid("Pastor — 2 kg"), "Pastor — 2 kg", 1), item(b.pid("Pastor — 1 kg"), "Pastor — 1 kg", 1)];
    b.setGuion([call("cotizar_pedido", { branch_slug: "garcia-lavin", canal: "recoger", items }), say("Total cotizado. ¿Confirma?")]);
    await b.enviar("+5219990000125", "quiero para recoger");
    b.setGuion([call("confirmar_resumen", {}), call("crear_pedido", { branch_slug: "garcia-lavin", canal: "recoger", customer_name: "Evento", payment_method: "tarjeta", items }), say("Listo, su pedido quedó registrado.")]);
    const r = await b.enviar("+5219990000125", "si tarjeta");
    expect(r.orderId).toBeTruthy();
    expect(b.callbacks().some((c) => c.reason === "escalada:pedido_grande")).toBe(false);
  });
});
