// Decisión de Omar (9-nov-2026): NO hay límite de pedido grande. Por omisión ningún pedido queda en espera por monto ni por kilos: entra normal a cocina.
// Pero SÍ se avisa: un pedido de un número sin historial que paga en efectivo por arriba de un monto informativo (por omisión $2,500,
// PM_PEDIDO_GRANDE_AVISO_MXN) emite la notificación in-app `restaurantes.pedido.grande` a la sucursal (dedupe por pedido, sin PII).
// La espera solo se activa si se configura su umbral: PM_PEDIDO_GRANDE_TOTAL_MXN, PM_PEDIDO_GRANDE_KG o PM_PEDIDO_GRANDE_SIN_HISTORIAL_EFECTIVO_MXN.
import { afterEach, describe, expect, it, vi } from "vitest";
import { evaluarPedidoGrande, motivoAvisoPedidoGrande, umbralesPedidoGrande } from "../src/pedido-grande.ts";
import { CATALOGO_NOTIFICACIONES } from "../../db/src/notificaciones/catalogo.ts";
import { banco, call, item, say, sayResumen } from "./qa/r1-arnes-whatsapp-pm.ts";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("umbrales de pedido grande (puro)", () => {
  it("por omisión: sin ninguna espera y aviso informativo a $2,500 (efectivo, sin historial)", () => {
    expect(umbralesPedidoGrande({})).toEqual({ totalMxn: null, kg: null, sinHistorialEfectivoMxn: null, avisoSinHistorialEfectivoMxn: 2500 });
    for (const caso of [{ total: 3700, pesoKg: 3, pagaEfectivo: true, sinHistorial: true }, { total: 9000, pesoKg: 1, pagaEfectivo: false, sinHistorial: false }, { total: 500, pesoKg: 8, pagaEfectivo: false, sinHistorial: false }]) {
      expect(evaluarPedidoGrande(caso, umbralesPedidoGrande({}))).toBeNull();
    }
    expect(motivoAvisoPedidoGrande({ total: 3700, pagaEfectivo: true, sinHistorial: true }, umbralesPedidoGrande({}))).toBe("sin_historial_efectivo");
    expect(motivoAvisoPedidoGrande({ total: 3700, pagaEfectivo: false, sinHistorial: true }, umbralesPedidoGrande({}))).toBeNull();
    expect(motivoAvisoPedidoGrande({ total: 3700, pagaEfectivo: true, sinHistorial: false }, umbralesPedidoGrande({}))).toBeNull();
    expect(motivoAvisoPedidoGrande({ total: 2400, pagaEfectivo: true, sinHistorial: true }, umbralesPedidoGrande({}))).toBeNull();
  });

  it("vacío = sin umbral; solo un valor configurado activa la espera; el aviso se apaga con «off»", () => {
    const u = umbralesPedidoGrande({ PM_PEDIDO_GRANDE_SIN_HISTORIAL_EFECTIVO_MXN: "", PM_PEDIDO_GRANDE_TOTAL_MXN: "4000", PM_PEDIDO_GRANDE_KG: "5", PM_PEDIDO_GRANDE_AVISO_MXN: "off" });
    expect(u).toEqual({ totalMxn: 4000, kg: 5, sinHistorialEfectivoMxn: null, avisoSinHistorialEfectivoMxn: null });
    expect(evaluarPedidoGrande({ total: 4500, pesoKg: 1, pagaEfectivo: false, sinHistorial: false }, u)).toBe("total");
    expect(evaluarPedidoGrande({ total: 500, pesoKg: 6, pagaEfectivo: false, sinHistorial: false }, u)).toBe("peso");
    expect(evaluarPedidoGrande({ total: 3700, pesoKg: 1, pagaEfectivo: true, sinHistorial: true }, u)).toBeNull();
    expect(umbralesPedidoGrande({ PM_PEDIDO_GRANDE_SIN_HISTORIAL_EFECTIVO_MXN: "2500" }).sinHistorialEfectivoMxn).toBe(2500);
    for (const v of ["abc", "100", "50000", "3000.5"]) expect(umbralesPedidoGrande({ PM_PEDIDO_GRANDE_TOTAL_MXN: v }).totalMxn).toBeNull();
  });

  it("el evento está en el catálogo, sin PII en el texto, con dedupe por pedido", () => {
    const e = CATALOGO_NOTIFICACIONES.find((x) => x.id === "restaurantes.pedido.grande");
    expect(e).toBeDefined();
    expect(e!.parametros).toEqual(["numero", "total"]);
    expect(`${e!.titulo} ${e!.cuerpo}`).not.toMatch(/@|\d{8,}/);
  });
});

describe("pedido grande por WhatsApp: sin espera, con aviso", () => {
  async function pedido(telefono: string, pago: "efectivo" | "tarjeta") {
    const b = await banco();
    const items = [item(b.pid("Pastor — 2 kg"), "Pastor — 2 kg", 1), item(b.pid("Pastor — 1 kg"), "Pastor — 1 kg", 1)];
    b.setGuion([call("cotizar_pedido", { branch_slug: "garcia-lavin", canal: "recoger", items }), sayResumen("Total cotizado. ¿Confirma?")]);
    await b.enviar(telefono, "quiero para recoger");
    b.setGuion([call("confirmar_resumen", {}), call("crear_pedido", { branch_slug: "garcia-lavin", canal: "recoger", customer_name: "Evento", payment_method: pago, items }), say("Listo, su pedido quedó registrado.")]);
    const r = await b.enviar(telefono, `si ${pago}`);
    return { b, r };
  }

  it("número nuevo + efectivo + $2,700: el pedido entra a cocina (pending), sin aviso de espera, y se notifica a la sucursal una vez", async () => {
    const { b, r } = await pedido("+5219990000224", "efectivo");
    expect(r.orderId).toBeTruthy();
    const [o] = (await b.w.repo.listOrders(b.w.organizationId, { propertyIds: null, limit: 10 })).orders;
    expect(o?.status).toBe("pending");
    expect(b.callbacks().some((c) => c.reason === "escalada:pedido_grande")).toBe(false);
    const avisos = b.w.repo.notificacionesPedidoGrande;
    expect(avisos).toHaveLength(1);
    expect(avisos[0]).toMatchObject({ organizationId: b.w.organizationId, propertyId: b.t7, orderId: r.orderId, total: 2700 });
  });

  it("con tarjeta no hay aviso", async () => {
    const { b, r } = await pedido("+5219990000225", "tarjeta");
    expect(r.orderId).toBeTruthy();
    expect(b.w.repo.notificacionesPedidoGrande).toHaveLength(0);
  });

  it("con la espera configurada (PM_PEDIDO_GRANDE_SIN_HISTORIAL_EFECTIVO_MXN=2500) vuelve la regla anterior: no entra a cocina y queda el aviso", async () => {
    vi.stubEnv("PM_PEDIDO_GRANDE_SIN_HISTORIAL_EFECTIVO_MXN", "2500");
    const { b } = await pedido("+5219990000226", "efectivo");
    expect((await b.w.repo.listOrders(b.w.organizationId, { propertyIds: null, limit: 10 })).orders).toHaveLength(0);
    expect(b.callbacks().some((c) => c.reason === "escalada:pedido_grande")).toBe(true);
  });
});
