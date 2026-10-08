// T7-044 (ronda 5): el cliente pidio «1 guacamole» (el platillo) y el agente cotizo y repitio «1 extra guacamole» por «lo de siempre»: total $1,048 en lugar de $1,141 ($93 de menos).
// Los dos productos existen a proposito; el servidor ya no deja que el modelo cambie uno por otro sin que el cliente lo diga, y la guarda NO atrapa al cliente en un bucle:
// pregunta una vez y en cuanto el cliente responde (o dice «extra») la cotizacion pasa. Sin conversacion (voz) la guarda no opina.
import { afterEach, describe, expect, it, vi } from "vitest";
import { aclararGuacamoleExtra } from "../src/whatsapp/guards.ts";
import { banco, call, item, sayObs } from "./qa/r1-arnes-whatsapp-pm.ts";

afterEach(() => {
  vi.useRealTimers();
});

const u = (content: string) => ({ role: "user", content });
const a = (content: string) => ({ role: "assistant", content });
const EXTRA = ["Taco Al Pastor (individual)", "Extra Guacamole"];

describe("aclararGuacamoleExtra (pura)", () => {
  it("el cliente dijo «guacamole» a secas, todavia no le preguntaron -> pide aclarar", () => {
    expect(aclararGuacamoleExtra(EXTRA, [u("2 órdenes de taquitos de pechuga, 4 tacos de pastor naturales, 1 guacamole. Con todas las salsas, guacamolera, ajo")])).toMatch(/platillo Guacamole y el Extra Guacamole.*productos distintos/);
    expect(aclararGuacamoleExtra(EXTRA, [u("Buenas"), a("Buenas tardes"), u("quiero un guacamole")])).not.toBeNull();
    expect(aclararGuacamoleExtra(EXTRA, [u("dos guacamoles")])).not.toBeNull();
  });

  it("T7-044: el cliente lo dijo al inicio y el agente nunca le pregunto por el guacamole (pidio dirección, tortilla...) -> sigue pidiendo aclarar", () => {
    expect(aclararGuacamoleExtra(EXTRA, [u("Buenas tardes"), a("Buenas tardes, ¿recoger o domicilio?"), u("1 guacamole y 4 tacos"), a("¿Qué tortilla desea?"), u("maíz")])).not.toBeNull();
  });

  it("SIN BUCLE: tras la pregunta del agente cualquier respuesta del cliente da por aclarado", () => {
    const pregunta = a("¿El guacamole como platillo o un extra para sus tacos?");
    for (const respuesta of ["el extra, para mis tacos", "un extra para los tacos", "2 extras de guacamole", "el platillo", "sí", "como platillo aparte"]) {
      expect(aclararGuacamoleExtra(EXTRA, [u("Quiero 4 tacos y 1 guacamole"), pregunta, u(respuesta)]), respuesta).toBeNull();
    }
  });

  it("el cliente dice «extra» por su cuenta, antes o despues de mencionarlo, aunque el agente no pregunte", () => {
    for (const m of ["un extra guacamole", "Guacamole extra por favor", "agrégame doble guacamole", "otro guacamole para los tacos", "quiero más guacamole", "guacamole adicional", "un EXTRA de guacamole", "2 extras de guacamole"]) {
      expect(aclararGuacamoleExtra(EXTRA, [u(m)]), m).toBeNull();
    }
    expect(aclararGuacamoleExtra(EXTRA, [u("1 guacamole"), a("ok, ¿pago?"), u("ah, el extra para mis tacos")])).toBeNull();
  });

  it("NEGATIVOS: ya viene el platillo, solo hablo de la salsa guacamolera, historial sin mencion nueva, o la cotizacion no lleva Extra Guacamole", () => {
    expect(aclararGuacamoleExtra(["Taco", "Guacamole", "Extra Guacamole"], [u("1 guacamole")])).toBeNull();
    expect(aclararGuacamoleExtra(EXTRA, [u("con todas las salsas, la guacamolera y la de ajo")])).toBeNull();
    expect(aclararGuacamoleExtra(EXTRA, [u("lo mismo de la vez pasada")])).toBeNull();
    expect(aclararGuacamoleExtra(["Guacamole"], [u("1 guacamole")])).toBeNull();
    expect(aclararGuacamoleExtra(["Taco"], [u("1 guacamole")])).toBeNull();
  });

  it("historial con una orden previa de guacamole ya aclarada: el pedido nuevo que no lo menciona no se bloquea", () => {
    expect(aclararGuacamoleExtra(EXTRA, [u("1 guacamole"), a("¿platillo o extra?"), u("extra"), a("Listo, pedido registrado"), u("hoy lo mismo de la vez pasada")])).toBeNull();
  });

  it("sin conversacion (voz, camino legado) no opina", () => {
    expect(aclararGuacamoleExtra(EXTRA, undefined)).toBeNull();
    expect(aclararGuacamoleExtra(EXTRA, [])).toBeNull();
  });
});

describe("T7-044 de punta a punta (agente de WhatsApp guionado)", () => {
  const tel = "+5219990000144";
  const pidoItems = (b: Awaited<ReturnType<typeof banco>>, producto: "Extra Guacamole" | "Guacamole") => [item(b.pid("Taco Al Pastor (individual)"), "Taco Al Pastor (individual)", 4, "maiz"), item(b.pid(producto), producto, 1)];
  type R = { error?: string; quote?: { total: number } };

  async function turno(b: Awaited<ReturnType<typeof banco>>, mensaje: string, producto: "Extra Guacamole" | "Guacamole", textoDelAgente = "Listo.") {
    const seen: unknown[] = [];
    b.setGuion([call("cotizar_pedido", { branch_slug: "garcia-lavin", canal: "recoger", items: pidoItems(b, producto) }), sayObs(seen, textoDelAgente)]);
    await b.enviar(tel, mensaje);
    return seen[0] as R;
  }

  it("«1 guacamole» + Extra Guacamole: el servidor rechaza una vez y dice que pregunte", async () => {
    const b = await banco();
    const r = await turno(b, "Quiero 4 tacos de pastor y 1 guacamole, con todas las salsas incluyendo guacamolera, para recoger", "Extra Guacamole", "¿El guacamole como platillo o un extra para sus tacos?");
    expect(r.error).toMatch(/pregúntele cuál quiere/);
    expect(r.quote).toBeUndefined();
  });

  it.each(["el extra, para mis tacos", "un extra para los tacos", "2 extras de guacamole", "el platillo"])("tras la pregunta, el cliente responde «%s» y la cotizacion PASA (sin bucle)", async (respuesta) => {
    const b = await banco();
    const primera = await turno(b, "Quiero 4 tacos de pastor y 1 guacamole para recoger", "Extra Guacamole", "¿El guacamole como platillo o un extra para sus tacos?");
    expect(primera.error).toBeDefined();
    const segunda = await turno(b, respuesta, "Extra Guacamole");
    expect(segunda.error).toBeUndefined();
    expect(segunda.quote?.total).toBeGreaterThan(0);
  });

  it("«1 extra guacamole» desde el inicio y «1 guacamole» con el platillo cotizan normal", async () => {
    const b1 = await banco();
    expect((await turno(b1, "Quiero 4 tacos de pastor y 1 extra guacamole para recoger", "Extra Guacamole")).error).toBeUndefined();
    const b2 = await banco();
    expect((await turno(b2, "Quiero 4 tacos de pastor y 1 guacamole para recoger", "Guacamole")).error).toBeUndefined();
  });
});
