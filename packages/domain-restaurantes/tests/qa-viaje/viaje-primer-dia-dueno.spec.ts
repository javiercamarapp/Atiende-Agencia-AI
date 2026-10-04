// QA R1 lente VIAJE -- primer dia del dueno de PM: el checklist de "Primeros pasos" calculado sobre el mundo sembrado de DEMO-PM
// (T1, T3 y T7 activas; T7 con su numero de WhatsApp conectado) debe decir la verdad y no contradecirse entre el estado y el texto.
import { describe, expect, it } from "vitest";
import { cargarOnboarding } from "../../src/onboarding.ts";
import { nuevoViaje } from "./arnes-viaje.ts";

describe("viaje primer dia del dueno (Primeros pasos con DEMO-PM)", () => {
  it("lo calculado coincide con el seed: 3 sucursales activas, menu y horario listos, sin cobertura de entrega", async () => {
    const v = await nuevoViaje();
    const c = await cargarOnboarding(v.world.repo, v.world.organizationId);
    const item = (id: string) => c.items.find((i) => i.id === id)!;
    expect(item("sucursales").detalle).toMatch(/^3 sucursal\(es\) activa\(s\) de 7/);
    expect(item("menu").estado).toBe("hecho");
    expect(item("horarios").estado).toBe("hecho");
    expect(item("zonas_de_entrega").estado).toBe("pendiente");
    expect(item("whatsapp").estado).toBe("parcial");
    expect(item("whatsapp").faltantes).not.toContain("García Lavín (Victory Platz)");
  });

  // Con T7 conectada y sin numero general, el estado es "parcial" pero el texto dice "Ningun numero de WhatsApp conectado"; y la
  // tarjeta "Sucursales activas" sale "Listo" con un "Falta en: <sucursales inactivas>" debajo. El dueno lee dos cosas opuestas.
  it.fails("QA-restaurantes-R1-viaje-13: el texto de cada punto de Primeros pasos no contradice su estado", async () => {
    const v = await nuevoViaje();
    const c = await cargarOnboarding(v.world.repo, v.world.organizationId);
    const item = (id: string) => c.items.find((i) => i.id === id)!;
    expect(item("whatsapp").detalle).not.toMatch(/Ningún número de WhatsApp conectado/);
    expect(item("sucursales").estado === "hecho" && item("sucursales").faltantes.length > 0).toBe(false);
  });
});
