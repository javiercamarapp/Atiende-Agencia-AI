// Cerebro v2, plan de conexión pasos 4-5 (SUELTO-VS-718-V2.md «Alergia en crear_pedido»; suelto whatsapp-agent-core.ts ~7961-7985 y ~8156):
//  - con una alergia avisada y sin confirmar por la sucursal, crear_pedido se rechaza (VENTANA_BLOQUEO_ALERGIA_MIN = 120 min o hasta que la sucursal
//    resuelva el aviso) con el teléfono de la sucursal; nunca se crea el pedido;
//  - pasada la ventana o resuelto el aviso, el pedido se toma con la nota «ALERGIA declarada: …» al inicio para cocina (y la preferencia «me cae mal…»);
//  - la decisión es la de `decidirBloqueoAlergia(evidenciaAlergiaEnSesion(hilo), último aviso de alergia del teléfono, ahora)` (paridad con el suelto).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nuevoViaje, pedidosDe, type Viaje } from "./qa-viaje/arnes-viaje.ts";
import { decidirBloqueoAlergia, evidenciaAlergiaEnSesion, MARCA_AVISO_URGENTE, VENTANA_BLOQUEO_ALERGIA_MIN } from "../src/whatsapp/cerebro-v2/salud.ts";
import { estadoAlergiaParaCrear } from "../src/agent-tools/registry.ts";

const T0 = new Date("2026-10-13T19:00:00-06:00");

async function conAlergiaYResumen(v: Viaje, minutosDespues = 0) {
  await v.escribe("Hola, soy alérgica al cacahuate");
  if (minutosDespues > 0) vi.setSystemTime(new Date(T0.getTime() + minutosDespues * 60_000));
  const items = [{ product_id: v.producto("Coca-Cola"), product_name: "Coca-Cola", requested_quantity: 4 }];
  v.guion([
    { tools: [{ name: "cotizar_pedido", args: { branch_slug: "garcia-lavin", canal: "domicilio", colonia_entrega: "Temozón Norte", customer_address: "Calle 60 #123 entre 21 y 23", customer_name: "Gabriela Poot", payment_method: "tarjeta", items } }] },
    { texto: "Permítame repetirle su pedido: 4 Coca-Cola a domicilio, pago con tarjeta. Total $212.00. ¿Es correcto?" },
  ]);
  await v.escribe("cuatro cocas a domicilio, Calle 60 #123 entre 21 y 23, Temozón Norte, Gabriela Poot, pago con tarjeta");
}

describe("cerebro v2: alergia sin confirmar en crear_pedido", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
  });
  afterEach(() => vi.useRealTimers());

  it("la alergia sola no cede la conversación a una persona (el suelto no tiene toma): el agente sigue atendiendo", async () => {
    const v = await nuevoViaje({ cerebroV2: true });
    await v.escribe("Hola, soy alérgica al cacahuate");
    v.guion([{ texto: "Con gusto, ¿qué le gustaría pedir?" }]);
    const r = await v.escribe("quiero ver el menú");
    expect(r.reply).toBeDefined();
  });

  it("con el aviso abierto y dentro de la ventana no se crea el pedido", async () => {
    const v = await nuevoViaje({ cerebroV2: true });
    await conAlergiaYResumen(v);
    v.guion([{ texto: "¡Listo! Su pedido quedó registrado." }]);
    const r = await v.escribe("Sí, así está bien");
    expect(await pedidosDe(v)).toHaveLength(0);
    // Clase «alergia» (suelto R84-1): «Perdón, su pedido todavía no quedó registrado: por su seguridad…»; nunca el «¡Listo!» del modelo.
    expect(r.reply).not.toMatch(/¡Listo!/i);
    expect(r.reply).toMatch(/todavía no quedó registrado/i);
    // El aviso de alergia existe y es URGENTE.
    expect(v.callbacks.some((c) => c.reason === "escalada:alergia_salud" && c.urgente === true && c.message?.startsWith(MARCA_AVISO_URGENTE))).toBe(true);
  });

  it("resuelto el aviso por la sucursal, el pedido se toma con la nota de alergia al inicio", async () => {
    const v = await nuevoViaje({ cerebroV2: true });
    await conAlergiaYResumen(v);
    const guardados = (v.world.repo as unknown as { callbackRequests: Array<{ reason?: string; resolved: boolean }> }).callbackRequests;
    for (const c of guardados) if (c.reason === "escalada:alergia_salud") c.resolved = true;
    vi.setSystemTime(new Date(T0.getTime() + 5 * 60_000));
    v.guion([{ texto: "¡Listo! Su pedido quedó registrado." }]);
    await v.escribe("Sí, así está bien");
    const pedidos = await pedidosDe(v);
    expect(pedidos).toHaveLength(1);
    expect(pedidos[0]!.notes ?? "").toMatch(/^ALERGIA declarada: .*cacahuate/);
  });

  it("pasada la ventana sin respuesta de la sucursal, el pedido se toma con la nota", async () => {
    const v = await nuevoViaje({ cerebroV2: true });
    // La cotización vence antes que la ventana: el resumen se arma ya pasada la ventana.
    await conAlergiaYResumen(v, VENTANA_BLOQUEO_ALERGIA_MIN + 1);
    v.guion([{ texto: "¡Listo! Su pedido quedó registrado." }]);
    await v.escribe("Sí, así está bien");
    const pedidos = await pedidosDe(v);
    expect(pedidos).toHaveLength(1);
    expect(pedidos[0]!.notes ?? "").toMatch(/^ALERGIA declarada:/);
  });

  it("paridad: la decisión es la de decidirBloqueoAlergia con la evidencia del hilo y el último aviso", () => {
    const ahora = T0.getTime();
    const hilo = [
      { role: "user" as const, content: "soy alérgica al cacahuate", at: new Date(ahora - 10 * 60_000).toISOString() },
      { role: "assistant" as const, content: "Gracias por avisarnos, es importante. Ya avisé a la sucursal para que una persona le confirme directamente antes de tomar su pedido.", at: new Date(ahora - 10 * 60_000).toISOString() },
    ];
    const fila = { id: "a1", reason: "escalada:alergia_salud", resolved: false, created_at: new Date(ahora - 9 * 60_000).toISOString(), message: "soy alérgica al cacahuate", property_id: null };
    for (const filas of [[fila], [{ ...fila, resolved: true }], [], null]) {
      const suelto = decidirBloqueoAlergia(evidenciaAlergiaEnSesion(hilo), filas === null ? { ok: false, fila: null } : { ok: true, fila: filas[0] ?? null }, ahora);
      expect(estadoAlergiaParaCrear(hilo, filas, ahora).bloquear).toBe(suelto.bloquear);
    }
  });

});
