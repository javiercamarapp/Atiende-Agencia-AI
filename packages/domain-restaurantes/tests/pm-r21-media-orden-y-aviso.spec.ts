// PM Ronda 21 (T7-038): «media orden» de un producto sin esa presentacion se PREGUNTA (no se escala), y el aviso al gerente no dice «no se ha cotizado» si ya hay cotizacion. Sin LLM.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { corregirAvisoCotizado } from "../src/aviso-pedido-gerente.ts";
import { PM_CONFIG_POR_OMISION } from "../src/whatsapp/llm-turn-handler.ts";
import { buildPmSystemPrompt } from "../src/whatsapp/perfil-pm.ts";
import { MARTES_14H, nuevoViaje, pedidosDe } from "./qa-viaje/arnes-viaje.ts";

const ctx = {
  businessName: PM_CONFIG_POR_OMISION.businessName,
  agentName: "el asistente virtual",
  deliveryTimeText: PM_CONFIG_POR_OMISION.deliveryTimeText,
  saludo: "Buenas tardes",
  branches: [{ propertyId: "p0", slug: "sucursal-a", name: "Sucursal A", address: null }],
  entryBranch: null,
  customer: { isNew: true } as const,
  fechaHoraLocal: "lunes 14:00",
  diaSemana: "lunes",
};

describe("T7-038: prompt de «media orden»", () => {
  it("manda PREGUNTAR la presentacion y prohibe escalar por eso", () => {
    const p = buildPmSystemPrompt(ctx);
    const i = p.indexOf("Si pide «media orden» (o una fracción de orden)");
    expect(i).toBeGreaterThan(-1);
    const tramo = p.slice(i, i + 400);
    expect(tramo).toContain("PREGUNTE la presentación");
    expect(tramo).toContain("NO llame escalar_a_humano por eso");
  });
});

describe("corregirAvisoCotizado", () => {
  it("con cotizacion vigente reemplaza «no se ha cotizado ni confirmado» por lo cierto", () => {
    expect(corregirAvisoCotizado("Pidió media orden de bistec; no se ha cotizado ni confirmado.", 722)).toBe("Pidió media orden de bistec; ya está cotizado por $722.00, pendiente de confirmar por el cliente.");
    expect(corregirAvisoCotizado("Aún no está cotizado.", 100)).toBe("ya está cotizado por $100.00.");
  });
  it("sin cotizacion vigente (o total invalido) no toca el texto", () => {
    expect(corregirAvisoCotizado("no se ha cotizado ni confirmado", undefined)).toBe("no se ha cotizado ni confirmado");
    expect(corregirAvisoCotizado("no se ha cotizado", 0)).toBe("no se ha cotizado");
    expect(corregirAvisoCotizado(undefined, 100)).toBeUndefined();
  });
  it("no toca textos que no dicen eso", () => {
    expect(corregirAvisoCotizado("Solicitud de 1/4 kg de pechuga", 237.5)).toBe("Solicitud de 1/4 kg de pechuga");
  });
});

describe("T7-038: el aviso del turno con cotizacion vigente no dice «no se ha cotizado»", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(MARTES_14H));
  });
  afterEach(() => vi.useRealTimers());
  const PASTOR = "Pastor — 500 g";

  it("con cotizacion vigente el servidor corrige la frase del modelo en el aviso al gerente", async () => {
    const v = await nuevoViaje();
    const cotizar = { name: "cotizar_pedido", args: { branch_slug: "garcia-lavin", canal: "recoger", payment_method: "efectivo", customer_name: "Ana Prueba", items: [{ product_id: v.producto(PASTOR), product_name: PASTOR, requested_quantity: 1 }] } };
    v.guion([{ tools: [cotizar] }, { tools: [{ name: "escalar_a_humano", args: { motivo: "pedido_especial", resumen: "Pidió media orden de un producto; no se ha cotizado ni confirmado." } }] }, { texto: "Listo." }]);
    await v.escribe("quiero media orden de bistec");
    const aviso = v.callbacks.find((c) => c.reason === "escalada:pedido_especial");
    expect(aviso?.message).toContain("ya está cotizado por $450.00");
    expect(aviso?.message).not.toMatch(/no se ha cotizado/i);
  });

  it("sin cotizacion vigente el texto del modelo queda tal cual", async () => {
    const v = await nuevoViaje();
    v.guion([{ tools: [{ name: "escalar_a_humano", args: { motivo: "pedido_especial", resumen: "Pidió algo raro; no se ha cotizado." } }] }, { texto: "Listo." }]);
    await v.escribe("quiero algo raro");
    expect(v.callbacks.find((c) => c.reason === "escalada:pedido_especial")?.message).toContain("no se ha cotizado");
  });
});

describe("T7-038 (P2): el aviso de un agregado NO se reescribe con el total de un pedido ya creado ni de una cotizacion vencida", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(MARTES_14H));
  });
  afterEach(() => vi.useRealTimers());
  const PASTOR = "Pastor — 500 g";
  const items = (v: Awaited<ReturnType<typeof nuevoViaje>>) => [{ product_id: v.producto(PASTOR), product_name: PASTOR, requested_quantity: 1 }];
  const cotizar = (v: Awaited<ReturnType<typeof nuevoViaje>>) => ({ name: "cotizar_pedido", args: { branch_slug: "garcia-lavin", canal: "recoger", payment_method: "efectivo", customer_name: "Ana Prueba", items: items(v) } });

  it("agregado tras un pedido ya creado: «el agregado no se ha cotizado» queda tal cual (sin $450.00 del pedido original)", async () => {
    const v = await nuevoViaje();
    v.guion([
      { tools: [cotizar(v)] },
      { texto: "Permítame repetirle su pedido. Total a pagar: $450.00 en efectivo, para recoger. ¿Es correcto?" },
    ]);
    await v.escribe("quiero medio kilo de pastor para recoger");
    await v.escribe("Sí, es correcto");
    expect(await pedidosDe(v)).toHaveLength(1);
    v.guion([{ tools: [{ name: "escalar_a_humano", args: { motivo: "pedido_especial", resumen: "Quiere agregar una horchata; el agregado no se ha cotizado." } }] }, { texto: "Ya avisé a la sucursal." }]);
    await v.escribe("gracias, una duda sobre mi pedido: ¿se puede ponerle algo extra?");
    const aviso = v.callbacks.find((c) => c.reason === "escalada:pedido_especial");
    expect(aviso?.message).toContain("el agregado no se ha cotizado");
    expect(aviso?.message).not.toMatch(/ya está cotizado/i);
  });

  it("cotizacion vencida (mas de 20 min): el texto del modelo queda tal cual", async () => {
    const v = await nuevoViaje();
    v.guion([{ tools: [cotizar(v)] }, { texto: "¿Es correcto?" }]);
    await v.escribe("quiero medio kilo de pastor para recoger");
    vi.setSystemTime(new Date(Date.now() + 21 * 60_000));
    v.guion([{ tools: [{ name: "escalar_a_humano", args: { motivo: "pedido_especial", resumen: "Pidió algo; no se ha cotizado." } }] }, { texto: "Listo." }]);
    await v.escribe("hola, sigo aquí");
    const aviso = v.callbacks.find((c) => c.reason === "escalada:pedido_especial");
    expect(aviso?.message).toContain("no se ha cotizado");
    expect(aviso?.message).not.toMatch(/ya está cotizado/i);
  });

  it("estado confirmado (entre confirmar_resumen y crear_pedido) con cotizacion vigente: SI se corrige el aviso", async () => {
    const v = await nuevoViaje();
    v.guion([{ tools: [cotizar(v), { name: "confirmar_resumen", args: {} }] }, { tools: [{ name: "escalar_a_humano", args: { motivo: "pedido_especial", resumen: "Pidió algo; no se ha cotizado." } }] }, { texto: "Listo." }]);
    await v.escribe("quiero medio kilo de pastor para recoger");
    const aviso = v.callbacks.find((c) => c.reason === "escalada:pedido_especial");
    expect(aviso?.message).toContain("ya está cotizado por $450.00");
  });
});
