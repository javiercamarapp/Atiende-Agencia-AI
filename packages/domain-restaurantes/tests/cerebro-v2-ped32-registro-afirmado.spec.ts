// C3 PED-32 (cerebro v2): tras el resumen, el cliente reclamó el cambio de tiempo («¿Por qué ahora son 75 a 90? … confírmeme») y el agente contestó «Su pedido ya quedó
// registrado por $463». La telemetría de la medición muestra que en ESE turno sí corrieron confirmar_resumen + crear_pedido (ok, sucursal que entrega) y el pedido existe:
// la afirmación era cierta. Lo que después lo negó («no aparece un pedido reciente») es del arnés: corre con el reloj desplazado semanas al futuro y `created_at` lo pone
// el now() real de Postgres, así que la ventana de 12 h de buscarPedidoReciente no lo ve. Estas pruebas fijan las dos caras con cerebro v2:
//  - sin pedido creado, la afirmación «ya quedó registrado» no le llega al cliente (guardia de honestidad del cierre, QA-PM-R3 T7-040);
//  - con el pedido creado en el turno, el texto queda intacto.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nuevoViaje, pedidosDe, type Viaje } from "./qa-viaje/arnes-viaje.ts";

const enMerida = (fecha: string, hhmm: string) => new Date(`${fecha}T${hhmm}:00-06:00`);
const AFIRMACION = "Gabriela, tiene razón en señalar la diferencia. No puedo garantizarle una hora de entrega. Su pedido ya quedó registrado por *$212*, con pago con tarjeta y terminal al entregar.";

describe("PED-32 «ya quedó registrado» con cerebro v2", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(enMerida("2026-10-13", "19:00"));
  });
  afterEach(() => vi.useRealTimers());

  async function hastaElResumen(v: Viaje) {
    const items = [{ product_id: v.producto("Coca-Cola"), product_name: "Coca-Cola", requested_quantity: 4 }];
    v.guion([
      { tools: [{ name: "cotizar_pedido", args: { branch_slug: "garcia-lavin", canal: "domicilio", colonia_entrega: "Temozón Norte", customer_address: "Calle 60 #123 entre 21 y 23", customer_name: "Gabriela Poot", payment_method: "tarjeta", items } }] },
      { texto: "Permítame repetirle su pedido: 4 Coca-Cola a domicilio, pago con tarjeta. Total $212.00. ¿Es correcto?" },
    ]);
    await v.escribe("cuatro cocas a domicilio, Calle 60 #123 entre 21 y 23, Temozón Norte, Gabriela Poot, pago con tarjeta");
  }

  it("sin pedido creado: el cliente no recibe la afirmación", async () => {
    const v = await nuevoViaje({ cerebroV2: true });
    await hastaElResumen(v);
    // El cliente reclama el tiempo SIN dar el «sí»: el modelo afirma el registro sin llamar crear_pedido.
    v.guion([{ texto: AFIRMACION }]);
    const r = await v.escribe("Ah, pero antes me dijeron 40 a 50 minutos. ¿Por qué ahora son 75 a 90?");
    expect(await pedidosDe(v)).toHaveLength(0);
    expect(r.reply).not.toMatch(/qued[oó] registrado/i);
  });

  it("con el pedido creado en el turno: el texto queda intacto", async () => {
    const v = await nuevoViaje({ cerebroV2: true });
    await hastaElResumen(v);
    v.guion([{ texto: AFIRMACION }]);
    const r = await v.escribe("Sí, así está bien");
    expect(await pedidosDe(v)).toHaveLength(1);
    expect(r.reply).toMatch(/Su pedido ya quedó registrado por \*\$212\*/);
  });
});
