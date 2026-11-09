// Cerebro v2 (SUELTO-VS-718-V2.md, reglas recortadas por COMPORTAMIENTO): las reglas de PM_POLICY_RULES del suelto (pm-policies.ts e69279e) que se habían
// recortado vuelven LITERALES, con los nombres de herramientas del monorrepo: tiempos, horarios, reglas duras, estado del pedido, post-venta, alergias, otro
// pedido y modalidad. Las de herramientas que aquí no existen (componer_kilos, salsas_extra, paga_con) siguen fuera (fontanería).
import { describe, expect, it } from "vitest";
import { PM_POLICY_RULES_V2 } from "../src/whatsapp/cerebro-v2/prompt-v2.ts";

const regla = (inicio: string) => PM_POLICY_RULES_V2.split("\n").find((l) => l.startsWith(`- ${inicio}`)) ?? "";

describe("PM_POLICY_RULES_V2 con las reglas del suelto", () => {
  it("tiempos: rango aproximado, sin ajustar por lluvia, contesta lluvia/tráfico y retoma", () => {
    expect(regla("Tiempos")).toMatch(/rango aproximado/);
    expect(regla("Tiempos")).toMatch(/no lo ajuste por lluvia/);
    expect(regla("Tiempos")).toMatch(/retome el pedido/);
  });
  it("horarios: sin pedir colonia, cerrada desde la primera frase, programado si abre hoy, ya cerró → cuándo abre mañana", () => {
    expect(regla("Horarios")).toMatch(/sin pedirle antes su colonia/);
    expect(regla("Horarios")).toMatch(/DESDE LA PRIMERA FRASE/);
    expect(regla("Horarios")).toMatch(/PROGRAMADO/);
    expect(regla("Horarios")).toMatch(/cuándo abre mañana/);
  });
  it("reglas duras: alcohol solo recoger, mínimo $200, 8 km", () => {
    expect(regla("Reglas duras")).toMatch(/alcohol no \(solo recoger\)/);
    expect(regla("Reglas duras")).toMatch(/\$200/);
    expect(regla("Reglas duras")).toMatch(/8 km/);
  });
  it("estado del pedido: solo lo que dice el estado; nunca que ya salió si no lo dice", () => {
    expect(regla("Estado del pedido")).toMatch(/SOLO lo que/);
    expect(regla("Estado del pedido")).toMatch(/Nunca afirme que ya salió/);
  });
  it("post-venta: disculpa, registrar_contacto, nunca prometa ni niegue reposición, sin datos del repartidor", () => {
    expect(regla("Post-venta")).toMatch(/disculpa breve/);
    expect(regla("Post-venta")).toMatch(/registrar_contacto/);
    expect(regla("Post-venta")).toMatch(/NUNCA prometa ni niegue reposición/);
    expect(regla("Post-venta")).toMatch(/no dé nombre, teléfono/);
  });
  it("alergias: no tome el pedido hasta que una persona lo confirme", () => {
    expect(regla("Alergias")).toMatch(/no tome el pedido hasta que una persona de la sucursal lo confirme/);
  });
  it("otro pedido: 90 minutos, la pregunta exacta y el sí vale para UN pedido", () => {
    expect(regla("Otro pedido")).toMatch(/90 minutos/);
    expect(regla("Otro pedido")).toMatch(/«¿Quiere hacer un pedido aparte\?»/);
    expect(regla("Otro pedido")).toMatch(/UN solo pedido/);
  });
  it("modalidad: recoger sin dirección, ~30 min, mínimo 25, hora_recogida", () => {
    expect(regla("Modalidad")).toMatch(/no pida ni invente dirección/);
    expect(regla("Modalidad")).toMatch(/mínimo 25/);
    expect(regla("Modalidad")).toMatch(/hora_recogida/);
  });
});
