// PM Ronda 18, S1 / G1 (handler + webhook en memoria, modelo guionado, sin LLM ni llaves). Datos 100 % sinteticos.
// El cliente dijo «si» a un resumen vigente y el turno muere: el servidor crea UN pedido con lo ya cotizado (idempotente) o, sin datos completos, conserva el aviso honesto.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { datosCierreDeCotizacion, planCierreDeterminista } from "../src/agent-tools/cierre-determinista.ts";
import { toolDefinitionsForChannel } from "../src/agent-tools/registry.ts";
import type { OrderFlowSnapshot } from "../src/agent-tools/order-flow.ts";
import { MARTES_14H, nuevoViaje, pedidosDe, TEL_CLIENTE, type Viaje } from "./qa-viaje/arnes-viaje.ts";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(MARTES_14H));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

const min = (n: number) => n * 60_000;
const avanza = (ms: number) => vi.setSystemTime(new Date(Date.now() + ms));
const motivos = (v: Viaje) => v.callbacks.map((c) => c.reason);

// ── S1 / G1 ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// A domicilio el minimo es $200: 4 Coca-Cola ($212); para recoger bastan 2 ($106).
const TOTAL = { recoger: 106, domicilio: 212 } as const;
function renglones(v: Viaje, canal: "recoger" | "domicilio") {
  return [{ product_id: v.producto("Coca-Cola"), product_name: "Coca-Cola", requested_quantity: canal === "domicilio" ? 4 : 2 }];
}

async function conResumen(v: Viaje, extra: Record<string, unknown> = {}, canal: "recoger" | "domicilio" = "recoger") {
  const items = renglones(v, canal);
  v.guion([{ tools: [{ name: "cotizar_pedido", args: { branch_slug: "garcia-lavin", canal, payment_method: "efectivo", items, ...(canal === "domicilio" ? { colonia_entrega: "Santa Gertrudis Copó" } : {}), ...extra } }] }, { texto: `Permítame repetirle su pedido: ${items[0]!.requested_quantity} Coca-Cola. Total $${TOTAL[canal]}.00. ¿Es correcto?` }]);
  await v.escribe("dos cocas");
  return items;
}
function proveedorCaido(v: Viaje) {
  const original = v.requests.push.bind(v.requests);
  v.requests.push = () => {
    throw new Error("proveedor caido (simulado)");
  };
  return () => {
    v.requests.push = original;
  };
}

describe.each([
  ["maquina de cierre apagada", undefined],
  ["maquina de cierre encendida", "1"],
] as const)("S1 / G1: el «si» tras un resumen completo crea el pedido aunque el turno muera (%s)", (_nombre, flag) => {
  beforeEach(() => {
    if (flag) vi.stubEnv("RESTAURANTES_CIERRE_MAQUINA_ESTADOS", flag);
  });

  it("recoger con el nombre ya cotizado: UN pedido con lo cotizado, confirmacion del servidor, sin avisar falla del sistema ni pedir otro «si»", async () => {
    const v = await nuevoViaje();
    await conResumen(v, { customer_name: "Ana Prueba" });
    proveedorCaido(v);
    const r = await v.escribe("Sí, es correcto");
    const pedidos = await pedidosDe(v);
    expect(pedidos).toHaveLength(1);
    expect(pedidos[0]!.total).toBe(106);
    expect(pedidos[0]!.customerName ?? "").toMatch(/Ana/);
    expect(r.orderId).toBe(pedidos[0]!.id);
    expect(r.reply).toMatch(/106/);
    expect(r.reply).not.toMatch(/problema t[eé]cnico|no alcanc[eé]|compa[nñ]ero/i);
    expect(motivos(v)).not.toContain("escalada:falla_sistema");
  });

  it("idempotente: otro «si» despues no crea un segundo pedido", async () => {
    const v = await nuevoViaje();
    await conResumen(v, { customer_name: "Ana Prueba" });
    const restaura = proveedorCaido(v);
    await v.escribe("Sí, es correcto");
    restaura();
    v.guion([{ texto: "Su pedido ya quedó registrado." }]);
    await v.escribe("sí");
    v.guion([{ texto: "Con gusto." }]);
    await v.escribe("sí, gracias");
    expect(await pedidosDe(v)).toHaveLength(1);
  });

  it("a domicilio con direccion y colonia cotizadas: se crea con esa direccion", async () => {
    const v = await nuevoViaje();
    await conResumen(v, { customer_name: "Ana Prueba", customer_address: "Calle 32 #345 x 20 y 22, Santa Gertrudis Copó" }, "domicilio");
    proveedorCaido(v);
    const r = await v.escribe("Sí, es correcto");
    const pedidos = await pedidosDe(v);
    expect(pedidos).toHaveLength(1);
    expect(r.orderId).toBe(pedidos[0]!.id);
    expect(pedidos[0]!.canal).toBe("domicilio");
  });

  it("a domicilio SIN direccion guardada: no se inventa, queda el aviso honesto de siempre y ningun pedido", async () => {
    const v = await nuevoViaje();
    await conResumen(v, { customer_name: "Ana Prueba" }, "domicilio");
    proveedorCaido(v);
    const r = await v.escribe("Sí, es correcto");
    expect(await pedidosDe(v)).toHaveLength(0);
    expect(r.reply).toMatch(/no alcanc[eé] a registrar/i);
    expect(motivos(v)).toContain("escalada:falla_sistema");
  });

  it("sin nombre (cliente nuevo que no lo dio al cotizar): no se crea el pedido por esta via", async () => {
    const v = await nuevoViaje({ phone: "+5219995550177" });
    await conResumen(v);
    proveedorCaido(v);
    const r = await v.escribe("Sí, es correcto", { phone: "+5219995550177" });
    expect(await pedidosDe(v)).toHaveLength(0);
    expect(r.reply).toMatch(/no alcanc[eé] a registrar/i);
  });

  it("un mensaje que NO es un «si» claro (cambio de opinion) no crea nada aunque el proveedor este caido", async () => {
    const v = await nuevoViaje();
    await conResumen(v, { customer_name: "Ana Prueba" });
    proveedorCaido(v);
    await v.escribe("mejor 3 cocas");
    expect(await pedidosDe(v)).toHaveLength(0);
  });

  it("un resumen vencido (mas de 20 minutos) no se registra", async () => {
    const v = await nuevoViaje();
    await conResumen(v, { customer_name: "Ana Prueba" });
    avanza(min(25));
    proveedorCaido(v);
    await v.escribe("Sí, es correcto");
    expect(await pedidosDe(v)).toHaveLength(0);
  });

  it("si el modelo SI responde, el camino normal no cambia (el servidor no se adelanta)", async () => {
    const v = await nuevoViaje();
    const items = await conResumen(v, { customer_name: "Ana Prueba" });
    const crear = { name: "crear_pedido", args: { branch_slug: "garcia-lavin", canal: "recoger", customer_name: "Ana Prueba", items, payment_method: "efectivo" } };
    v.guion([{ tools: [{ name: "confirmar_resumen", args: {} }] }, { tools: [crear] }, { texto: "Listo, su pedido quedó registrado." }]);
    const r = await v.escribe("Sí, es correcto");
    expect(r.orderId).toBeTruthy();
    expect(await pedidosDe(v)).toHaveLength(1);
  });
});

describe.each([
  ["maquina de cierre apagada", undefined],
  ["maquina de cierre encendida", "1"],
] as const)("revision de #631: el «si» debe ser de ESTE resumen (%s)", (_nombre, flag) => {
  beforeEach(() => {
    if (flag) vi.stubEnv("RESTAURANTES_CIERRE_MAQUINA_ESTADOS", flag);
  });

  it("rafaga «mejor 3 cocas» + «si» con el proveedor caido: NO se crea el pedido viejo de 2", async () => {
    const v = await nuevoViaje();
    await conResumen(v, { customer_name: "Ana Prueba" });
    proveedorCaido(v);
    await v.world.repo.appendWhatsAppUserMessageOnce(v.world.organizationId, TEL_CLIENTE, { role: "user", content: "mejor 3 cocas" });
    const r = await v.escribe("sí");
    expect(await pedidosDe(v)).toHaveLength(0);
    expect(r.reply).not.toMatch(/quedó registrado|registr[oó] su pedido/i);
  });

  it("rafaga de dos «si» claros si crea UN pedido", async () => {
    const v = await nuevoViaje();
    await conResumen(v, { customer_name: "Ana Prueba" });
    proveedorCaido(v);
    await v.world.repo.appendWhatsAppUserMessageOnce(v.world.organizationId, TEL_CLIENTE, { role: "user", content: "sí" });
    await v.escribe("sí, es correcto");
    expect(await pedidosDe(v)).toHaveLength(1);
  });

  it("una re-cotizacion con notas y complementos VACIOS los limpia: el pedido no los lleva", async () => {
    const v = await nuevoViaje();
    const items = await conResumen(v, { customer_name: "Ana Prueba", notes: "sin hielo", requested_complements: ["crema_ajo"] });
    v.guion([{ tools: [{ name: "cotizar_pedido", args: { branch_slug: "garcia-lavin", canal: "recoger", payment_method: "efectivo", items, notes: "", requested_complements: [] } }] }, { texto: "Permítame repetirle su pedido: 2 Coca-Cola. Total $106.00. ¿Es correcto?" }]);
    await v.escribe("mejor sin hielo ni crema");
    proveedorCaido(v);
    await v.escribe("sí");
    const pedidos = await pedidosDe(v);
    expect(pedidos).toHaveLength(1);
    expect(JSON.stringify(pedidos[0])).not.toMatch(/hielo|crema/i);
  });

  it("estado confirmado: si el ultimo mensaje del asistente NO es el resumen ni su pregunta, el «si» no crea nada", async () => {
    const v = await nuevoViaje();
    await conResumen(v, { customer_name: "Ana Prueba" });
    v.guion([{ tools: [{ name: "confirmar_resumen", args: {} }] }, { texto: "Un momento, reviso algo con la sucursal." }]);
    await v.escribe("sí, es correcto");
    expect(await pedidosDe(v)).toHaveLength(0);
    proveedorCaido(v);
    await v.escribe("sí");
    expect(await pedidosDe(v)).toHaveLength(0);
  });
});

describe("datos de cierre: semantica de vaciado, saneo y canal", () => {
  it("«» y [] mandados LIMPIAN el campo; omitido o null lo conserva", () => {
    const previo = datosCierreDeCotizacion({ customer_name: "Ana", notes: "sin hielo", requested_complements: ["crema_ajo"], omit_default_complements: ["cebolla"] }, undefined);
    expect(previo).toMatchObject({ customerName: "Ana", notes: "sin hielo", requestedComplements: ["crema_ajo"], omitDefaultComplements: ["cebolla"] });
    expect(datosCierreDeCotizacion({}, previo)).toMatchObject({ notes: "sin hielo", requestedComplements: ["crema_ajo"] });
    expect(datosCierreDeCotizacion({ notes: null, requested_complements: null }, previo)).toMatchObject({ notes: "sin hielo", requestedComplements: ["crema_ajo"] });
    const limpio = datosCierreDeCotizacion({ notes: "", requested_complements: [], omit_default_complements: [] }, previo);
    expect(limpio.notes).toBeUndefined();
    expect(limpio.requestedComplements).toBeUndefined();
    expect(limpio.omitDefaultComplements).toBeUndefined();
    expect(limpio.customerName).toBe("Ana");
  });

  it("las notas se sanean como en el resumen: sin telefonos ni correos", () => {
    const d = datosCierreDeCotizacion({ notes: "sin hielo, llamar al 9991234567 o a ana@correo.com" }, undefined);
    expect(d.notes).not.toMatch(/9991234567|@/);
  });

  it("cotizar para recoger limpia los datos de entrega guardados", () => {
    const previo = datosCierreDeCotizacion({ canal: "domicilio", customer_address: "Calle 1", colonia_entrega: "Centro", maps_url: "https://maps.example/x", usar_ubicacion_compartida: true, customer_name: "Ana" }, undefined);
    expect(previo.customerAddress).toBe("Calle 1");
    const recoger = datosCierreDeCotizacion({ canal: "recoger" }, previo);
    expect(recoger).toEqual({ customerName: "Ana" });
  });

  it("voz no ve los campos de datos del cliente en cotizar_pedido; WhatsApp si", () => {
    const campos = ["customer_name", "customer_address", "indicaciones_acceso", "referencias_acceso", "direccion_etiqueta", "maps_url", "usar_ubicacion_compartida"];
    const props = (canal: "voz" | "whatsapp") => Object.keys(toolDefinitionsForChannel(canal).find((t) => t.name === "cotizar_pedido")!.parameters.properties);
    for (const c of campos) {
      expect(props("voz")).not.toContain(c);
      expect(props("whatsapp")).toContain(c);
    }
  });
});

describe("planCierreDeterminista (puro)", () => {
  const ahora = Date.parse(MARTES_14H);
  const base = {
    quoteHash: "h",
    quotedAtMs: ahora - 1_000,
    quotedTurn: "1",
    quotedItems: [{ id: "p1", name: "Taco", qty: 3, tortilla: "maiz" as string | null }],
    quotedBranchSlug: "garcia-lavin",
    quotedCanal: "recoger",
    quotedPago: "efectivo" as const,
    quotedEfectivoCon: 200,
    quotedTotal: 126,
    datosCierre: { customerName: "Ana" },
  };
  const snap = (c: object, state: OrderFlowSnapshot["state"] = "cotizado"): OrderFlowSnapshot => ({ state, context: c as never, version: 1 });

  it("arma el input con los renglones cotizados, el pago y el nombre", () => {
    const p = planCierreDeterminista(snap(base), { ahoraMs: ahora });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.crearPedido).toMatchObject({ branch_slug: "garcia-lavin", canal: "recoger", customer_name: "Ana", payment_method: "efectivo", efectivo_con: 200, items: [{ product_id: "p1", requested_quantity: 3, tortilla: "maiz" }] });
    expect(p.crearPedido).not.toHaveProperty("customer_address");
  });

  it.each([
    ["sin cotizacion", null, "sin_cotizacion"],
    ["ya creado", snap(base, "creado"), "ya_creado"],
    ["vencida", snap({ ...base, quotedAtMs: ahora - 21 * 60_000 }), "vencida"],
    ["sin renglones", snap({ ...base, quotedItems: [] }), "sin_renglones"],
    ["sin pago", snap({ ...base, quotedPago: undefined }), "sin_pago"],
    ["sin nombre", snap({ ...base, datosCierre: {} }), "sin_nombre"],
    ["domicilio sin direccion", snap({ ...base, quotedCanal: "domicilio", datosCierre: { customerName: "Ana", coloniaEntrega: "Centro" } }), "sin_direccion"],
    ["domicilio sin colonia", snap({ ...base, quotedCanal: "domicilio", datosCierre: { customerName: "Ana", customerAddress: "Calle 1" } }), "sin_colonia"],
  ] as const)("%s: no se crea (%s)", (_n, s, motivo) => {
    const p = planCierreDeterminista(s as OrderFlowSnapshot | null, { ahoraMs: ahora });
    expect(p).toEqual({ ok: false, motivo });
  });

  it("usa el nombre de la ficha del cliente si la cotizacion no lo trae, y con tarjeta a domicilio lleva terminal", () => {
    const p = planCierreDeterminista(snap({ ...base, quotedCanal: "domicilio", quotedPago: "tarjeta", quotedPropinaPct: 10, datosCierre: { customerAddress: "Calle 1", coloniaEntrega: "Centro" } }), { ahoraMs: ahora, nombreDeLaFicha: "Beto" });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.crearPedido).toMatchObject({ customer_name: "Beto", llevar_terminal: true, propina_porcentaje: 10, customer_address: "Calle 1", colonia_entrega: "Centro" });
    expect(p.crearPedido).not.toHaveProperty("efectivo_con");
  });
});
