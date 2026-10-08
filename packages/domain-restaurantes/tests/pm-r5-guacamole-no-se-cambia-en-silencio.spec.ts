// T7-044 (ronda 5): el cliente pidio «1 guacamole» (el platillo, $142) y el agente cotizo y repitio «1 extra guacamole» ($49) por «lo de siempre»: total $1,048 en lugar de $1,141 ($93 de menos).
// Los dos productos existen a proposito; el servidor ya no deja que el modelo cambie uno por otro sin que el cliente lo diga. Sin mensajes del cliente (voz) la guarda no opina.
import { afterEach, describe, expect, it, vi } from "vitest";
import { aclararGuacamoleExtra } from "../src/whatsapp/guards.ts";
import { banco, call, item, sayObs } from "./qa/r1-arnes-whatsapp-pm.ts";

afterEach(() => {
  vi.useRealTimers();
});

describe("aclararGuacamoleExtra (pura)", () => {
  const EXTRA = ["Taco Al Pastor (individual)", "Extra Guacamole"];
  it("el cliente dijo «guacamole» y la cotizacion trae Extra Guacamole sin el platillo -> pide aclarar", () => {
    expect(aclararGuacamoleExtra(EXTRA, ["2 órdenes de taquitos de pechuga, 4 tacos de pastor naturales, 1 guacamole. Con todas las salsas, guacamolera, ajo"])).toMatch(/platillo Guacamole y el Extra Guacamole.*productos distintos/);
    expect(aclararGuacamoleExtra(EXTRA, ["Buenas", "quiero un guacamole"])).not.toBeNull();
  });

  it("NEGATIVOS: pidio extra/doble/adicional/otro/mas guacamole en cualquier mensaje, o ya viene el platillo, o solo hablo de la salsa guacamolera", () => {
    for (const m of ["un extra guacamole", "Guacamole extra por favor", "agrégame doble guacamole", "otro guacamole para los tacos", "quiero más guacamole", "guacamole adicional", "un EXTRA de guacamole"]) {
      expect(aclararGuacamoleExtra(EXTRA, [m]), m).toBeNull();
    }
    expect(aclararGuacamoleExtra(["Taco", "Guacamole", "Extra Guacamole"], ["1 guacamole"])).toBeNull();
    expect(aclararGuacamoleExtra(EXTRA, ["con todas las salsas, la guacamolera y la de ajo"])).toBeNull();
    expect(aclararGuacamoleExtra(EXTRA, ["lo mismo de la vez pasada"])).toBeNull();
    // Una cotizacion sin Extra Guacamole nunca se toca.
    expect(aclararGuacamoleExtra(["Guacamole"], ["1 guacamole"])).toBeNull();
    expect(aclararGuacamoleExtra(["Taco"], ["1 guacamole"])).toBeNull();
  });

  it("sin mensajes del cliente (voz, camino legado) no opina", () => {
    expect(aclararGuacamoleExtra(EXTRA, undefined)).toBeNull();
    expect(aclararGuacamoleExtra(EXTRA, [])).toBeNull();
  });
});

describe("T7-044 de punta a punta: cotizar_pedido rechaza el cambio silencioso", () => {
  const tel = "+5219990000144";
  async function cotizarCon(mensajeDelCliente: string, productoGuacamole: "Extra Guacamole" | "Guacamole") {
    const b = await banco();
    const seen: unknown[] = [];
    const items = [item(b.pid("Taco Al Pastor (individual)"), "Taco Al Pastor (individual)", 4, "maiz"), item(b.pid(productoGuacamole), productoGuacamole, 1)];
    b.setGuion([call("cotizar_pedido", { branch_slug: "garcia-lavin", canal: "recoger", items }), sayObs(seen, "Listo.")]);
    await b.enviar(tel, mensajeDelCliente);
    return seen[0] as { error?: string; quote?: { total: number } };
  }

  it("«1 guacamole» + cotizacion con Extra Guacamole: el servidor rechaza y dice que pregunte (nada de total de $49)", async () => {
    const r = await cotizarCon("Quiero 4 tacos de pastor y 1 guacamole, con todas las salsas incluyendo guacamolera, para recoger", "Extra Guacamole");
    expect(r.error).toMatch(/pregúntele cuál quiere/);
    expect(r.quote).toBeUndefined();
  });

  it("«1 extra guacamole» + Extra Guacamole: cotiza normal", async () => {
    const r = await cotizarCon("Quiero 4 tacos de pastor y 1 extra guacamole para recoger", "Extra Guacamole");
    expect(r.error).toBeUndefined();
    expect(r.quote?.total).toBeGreaterThan(0);
  });

  it("«1 guacamole» + el platillo Guacamole: cotiza normal", async () => {
    const r = await cotizarCon("Quiero 4 tacos de pastor y 1 guacamole para recoger", "Guacamole");
    expect(r.error).toBeUndefined();
    expect(r.quote?.total).toBeGreaterThan(0);
  });
});
