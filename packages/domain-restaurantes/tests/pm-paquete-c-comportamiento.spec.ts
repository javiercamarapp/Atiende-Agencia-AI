// PM Paquete C, pruebas de COMPORTAMIENTO (handler + webhook en memoria, modelo guionado, sin LLM ni llaves). Datos 100 % sinteticos.
//  G7-8-10: una queja con detalle se escala con motivo `queja` aunque ya haya una toma abierta por un cambio/cancelacion.
//  Rafagas: el motivo de alto riesgo se detecta aunque venga en el PRIMER mensaje de una rafaga de 4, 8 o 12; el modelo recibe todo en orden (manda la ultima version).
//  NU-4 / S1: si el cliente ya dijo «si» a un resumen vigente y el turno muere, no se culpa a un «problema tecnico»: se dice la verdad, se avisa al equipo y el «si» siguiente crea UN pedido.
//  Llamada perdida a media venta: el carrito sigue intacto.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MARTES_14H, nuevoViaje, pedidosDe, TEL_CLIENTE, type Viaje } from "./qa-viaje/arnes-viaje.ts";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(MARTES_14H));
});
afterEach(() => vi.useRealTimers());

const min = (n: number) => n * 60_000;
const avanza = (ms: number) => vi.setSystemTime(new Date(Date.now() + ms));
// La negacion fija del servidor («yo no puedo prometerle una reposicion ni un descuento») no es una promesa.
const promete = (reply: string | undefined) => /reembols|devoluci[oó]n de (?:su )?dinero|de cortes[ií]a|descuento|reposici[oó]n|en \d+ minutos|aproximadamente/i.test((reply ?? "").replace(/(?:yo )?no puedo prometerle[^.]*\./gi, "").replace(/no hacemos devoluciones de dinero[^.;]*[.;]/gi, ""));

function renglones(v: Viaje) {
  return [{ product_id: v.producto("Coca-Cola"), product_name: "Coca-Cola", requested_quantity: 2 }];
}
const motivos = (v: Viaje) => v.callbacks.map((c) => c.reason);

async function conResumen(v: Viaje) {
  const items = renglones(v);
  v.guion([{ tools: [{ name: "cotizar_pedido", args: { branch_slug: "garcia-lavin", canal: "recoger", items } }] }, { texto: "Permítame repetirle su pedido: 2 Coca-Cola. Total $106.00. ¿Es correcto?" }]);
  await v.escribe("dos cocas para recoger");
  return items;
}

describe("G7-8-10: la queja se escala con motivo queja aunque ya haya una toma abierta", () => {
  it("cancelacion/cambio primero (toma pendiente) y luego la queja con detalle: queda el aviso `queja` y no se promete nada", async () => {
    const v = await nuevoViaje();
    expect((await v.escribe("quiero cancelar mi pedido")).escalated).toBe(true);
    expect(motivos(v)).toContain("escalada:cancelacion_modificacion");
    avanza(min(2));
    const r = await v.escribe("recibí el pedido pero no mandaron las salsas");
    expect(motivos(v)).toContain("escalada:queja");
    expect(r.reply).toBeTruthy();
    expect(promete(r.reply)).toBe(false);
  });

  it("sin toma previa la queja sigue escalando con motivo queja y sin reembolsos", async () => {
    const v = await nuevoViaje();
    const r = await v.escribe("me faltó una orden de papas en mi pedido");
    expect(motivos(v)).toContain("escalada:queja");
    expect(promete(r.reply)).toBe(false);
  });

  it("exigir reembolso: se escala, no se promete dinero", async () => {
    const v = await nuevoViaje();
    const r = await v.escribe("me faltaron las papas de mi pedido, quiero mi dinero de vuelta");
    expect(v.callbacks.length).toBeGreaterThan(0);
    expect(r.reply).not.toMatch(/le (?:devolvemos|reembolsamos)|haremos el reembolso/i);
  });
});

describe("Rafagas de 4, 8 y 12 mensajes", () => {
  async function rafaga(v: Viaje, textos: string[]) {
    for (const t of textos.slice(0, -1)) await v.world.repo.appendWhatsAppUserMessageOnce(v.world.organizationId, TEL_CLIENTE, { role: "user", content: t });
    return v.escribe(textos.at(-1)!);
  }
  const relleno = (n: number) => Array.from({ length: n }, (_, i) => `dato ${i + 1}`);

  it.each([4, 8, 12])("una queja en el PRIMER mensaje de una rafaga de %i se escala con motivo queja", async (n) => {
    const v = await nuevoViaje();
    await rafaga(v, ["no mandaron las salsas de mi pedido", ...relleno(n - 1)]);
    expect(motivos(v)).toContain("escalada:queja");
  });

  it.each([4, 8, 12])("rafaga de %i con autocorreccion: UNA sola respuesta y el modelo ve todo en orden, con la ultima version al final", async (n) => {
    const v = await nuevoViaje();
    v.guion([{ texto: "Entendido: una rebanada de pastel. ¿Para recoger o a domicilio?" }]);
    const textos = ["quiero dos flanes", ...relleno(n - 2), "perdón, una rebanada de pastel"];
    const r = await rafaga(v, textos);
    expect(r.reply).toBeTruthy();
    expect(v.requests.length).toBe(1);
    const usuario = v.requests[0]!.messages.filter((m) => m.role === "user").map((m) => String(m.content));
    expect(usuario.join("\n")).toContain("quiero dos flanes");
    expect(usuario.at(-1)).toContain("perdón, una rebanada de pastel");
  });

  it("otro cliente al mismo tiempo: su queja no se mezcla con la ráfaga del primero", async () => {
    const v = await nuevoViaje();
    v.guion([{ texto: "¿Para recoger o a domicilio?" }]);
    await v.world.repo.appendWhatsAppUserMessageOnce(v.world.organizationId, TEL_CLIENTE, { role: "user", content: "hola" });
    await v.escribe("no mandaron las salsas de mi pedido", { phone: "+5219995550777" });
    const r = await v.escribe("quiero dos cocas");
    expect(v.callbacks.length).toBe(1);
    expect(v.callbacks[0]!.customerPhone).toMatch(/0777$/);
    expect(r.reply).toBeTruthy();
  });
});

describe("NU-4 / S1: el «si» ya dado no se pierde ni se culpa al sistema", () => {
  it("el turno del «si» muere: mensaje honesto + aviso al equipo + sin pedido; el siguiente «si» crea UN pedido", async () => {
    const v = await nuevoViaje();
    const items = await conResumen(v);
    const empujar = v.requests.push.bind(v.requests);
    v.requests.push = () => {
      throw new Error("proveedor caido (simulado)");
    };
    const r = await v.escribe("sí, es correcto");
    expect(r.reply).not.toMatch(/problema t[eé]cnico|del sistema|falla/i);
    expect(r.reply).toMatch(/recib[ií] su confirmaci[oó]n/i);
    expect(r.reply).toMatch(/106/);
    expect(motivos(v)).toContain("escalada:falla_sistema");
    expect(await pedidosDe(v)).toHaveLength(0);
    v.requests.push = empujar;
    avanza(min(20));
    const crear = { name: "crear_pedido", args: { branch_slug: "garcia-lavin", canal: "recoger", customer_name: "Cliente QA", items, payment_method: "efectivo", hora_recogida: "2026-10-13T14:40:00-06:00" } };
    v.guion([{ tools: [{ name: "confirmar_resumen", args: {} }] }, { tools: [crear, crear] }, { texto: "Listo, su pedido quedó registrado." }]);
    const r2 = await v.escribe("sí");
    expect(r2.orderId).toBeTruthy();
    expect(await pedidosDe(v)).toHaveLength(1);
  });

  it("sin resumen vigente un mensaje cualquiera con el proveedor caido conserva el aviso técnico de siempre", async () => {
    const v = await nuevoViaje();
    v.requests.push = () => {
      throw new Error("proveedor caido (simulado)");
    };
    const r = await v.escribe("hola, quiero tacos");
    expect(r.reply).toMatch(/problema t[eé]cnico/i);
  });
});

describe("Llamada perdida a media venta", () => {
  it("el carrito sigue intacto: la llamada no escala ni llama al modelo y el «si» posterior crea el pedido cotizado", async () => {
    const v = await nuevoViaje();
    const items = await conResumen(v);
    const antes = v.requests.length;
    const r = await v.escribe("Llamada perdida");
    expect(r.reply).toMatch(/no recibimos llamadas/i);
    expect(v.requests.length).toBe(antes);
    expect(r.escalated).toBe(false);
    expect(v.callbacks.length).toBe(0);
    const crear = { name: "crear_pedido", args: { branch_slug: "garcia-lavin", canal: "recoger", customer_name: "Cliente QA", items, payment_method: "efectivo", hora_recogida: "2026-10-13T14:40:00-06:00" } };
    v.guion([{ tools: [{ name: "confirmar_resumen", args: {} }] }, { tools: [crear] }, { texto: "Listo, su pedido quedó registrado." }]);
    const r2 = await v.escribe("sí, es correcto");
    expect(r2.orderId).toBeTruthy();
    expect(await pedidosDe(v)).toHaveLength(1);
  });
});
