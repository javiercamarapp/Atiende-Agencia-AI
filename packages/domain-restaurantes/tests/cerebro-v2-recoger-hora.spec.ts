// C3 S-PED-004 / S-REC-002 / S-REC-003 (cerebro v2, decisión del dueño: conducta del suelto, create-order-core.ts validarRecoger de pm-policies.ts):
//  - recoger SIN hora: el suelto nunca deja el pedido sin hora; sin una pedida usa ahora + RECOGER_ESPERA_POR_OMISION_MIN (30). Aquí: la cotización sin hora queda con
//    ahora + 30 y el pedido la lleva (el monorrepo la dejaba nula = «para ya»);
//  - la espera mínima de 25 min se REVALIDA al crear (el suelto valida la hora en createOrderCore, al crear): una hora exacta que ya quedó a menos de 25 min se rechaza con
//    «Esa hora es muy pronto… Lo más temprano es HH:MM»; un PLAZO («en 30 minutos», o el de omisión) se cuenta desde que se crea el pedido.
// Sin la bandera todo queda igual.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nuevoViaje, pedidosDe, type Viaje } from "./qa-viaje/arnes-viaje.ts";

const T0 = new Date("2026-10-13T19:00:00-06:00");
const RECOGER_ESPERA_POR_OMISION_MIN = 30; // pm-policies.ts del suelto
const RECOGER_ESPERA_MINIMA_MIN = 25;

function capturarHoras(v: Viaje): Array<string | null> {
  const horas: Array<string | null> = [];
  const original = v.world.repo.createOrderIdempotent.bind(v.world.repo);
  v.world.repo.createOrderIdempotent = async (order, huella, llave) => {
    horas.push(order.horaRecogida ?? null);
    return original(order, huella, llave);
  };
  return horas;
}

async function cotizaRecoger(v: Viaje, extra: Record<string, unknown>, mensaje: string) {
  const items = [{ product_id: v.producto("Coca-Cola"), product_name: "Coca-Cola", requested_quantity: 4 }];
  v.guion([
    { tools: [{ name: "cotizar_pedido", args: { branch_slug: "garcia-lavin", canal: "recoger", customer_name: "Gabriela Poot", payment_method: "efectivo", items, ...extra } }] },
    { texto: "Permítame repetirle su pedido: 4 Coca-Cola para recoger en García Lavín, pago en efectivo. Total $192.00. ¿Es correcto?" },
  ]);
  await v.escribe(mensaje);
}

describe("cerebro v2: hora de recoger como el suelto", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
  });
  afterEach(() => vi.useRealTimers());

  it("sin hora: el pedido sale con ahora + 30 min (nunca sin hora)", async () => {
    const v = await nuevoViaje({ cerebroV2: true });
    const horas = capturarHoras(v);
    await cotizaRecoger(v, {}, "cuatro cocas para recoger en García Lavín, a nombre de Gabriela Poot, pago en efectivo");
    v.guion([{ texto: "¡Listo! Su pedido quedó registrado." }]);
    await v.escribe("Sí, así está bien");
    expect(await pedidosDe(v)).toHaveLength(1);
    expect(horas[0]).not.toBeNull();
    const min = (Date.parse(horas[0]!) - Date.now()) / 60_000;
    expect(min).toBeGreaterThanOrEqual(RECOGER_ESPERA_POR_OMISION_MIN - 1);
    expect(min).toBeLessThanOrEqual(RECOGER_ESPERA_POR_OMISION_MIN + 1);
  });

  it("hora exacta que al crear ya queda a menos de 25 min: no se crea (muy pronto)", async () => {
    const v = await nuevoViaje({ cerebroV2: true });
    await cotizaRecoger(v, { hora_recogida: "2026-10-13T19:26:00-06:00" }, "cuatro cocas para recoger en García Lavín a las 7:26, a nombre de Gabriela Poot, pago en efectivo");
    vi.setSystemTime(new Date(T0.getTime() + 5 * 60_000));
    v.guion([{ texto: "¡Listo! Su pedido quedó registrado." }]);
    await v.escribe("Sí, así está bien");
    expect(await pedidosDe(v)).toHaveLength(0);
  });

  it("plazo («en 30 minutos») se cuenta desde que se crea el pedido", async () => {
    const v = await nuevoViaje({ cerebroV2: true });
    const horas = capturarHoras(v);
    await cotizaRecoger(v, { minutos_para_recoger: 30 }, "cuatro cocas para recoger en García Lavín, paso en 30 minutos, a nombre de Gabriela Poot, pago en efectivo");
    vi.setSystemTime(new Date(T0.getTime() + 10 * 60_000));
    v.guion([{ texto: "¡Listo! Su pedido quedó registrado." }]);
    await v.escribe("Sí, así está bien");
    expect(await pedidosDe(v)).toHaveLength(1);
    const min = (Date.parse(horas[0]!) - Date.now()) / 60_000;
    expect(min).toBeGreaterThanOrEqual(RECOGER_ESPERA_MINIMA_MIN);
  });

  it("sin cerebro v2: recoger sin hora sigue saliendo sin hora", async () => {
    const v = await nuevoViaje();
    const horas = capturarHoras(v);
    await cotizaRecoger(v, {}, "cuatro cocas para recoger en García Lavín, a nombre de Gabriela Poot, pago en efectivo");
    v.guion([{ texto: "¡Listo! Su pedido quedó registrado." }]);
    await v.escribe("Sí, así está bien");
    if ((await pedidosDe(v)).length === 1) expect(horas[0]).toBeNull();
  });
});
