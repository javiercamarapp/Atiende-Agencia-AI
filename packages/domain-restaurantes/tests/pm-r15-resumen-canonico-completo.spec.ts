// PM Ronda 15 (T7-001, hallazgo de ON): con la maquina de cierre activa el resumen canonico del servidor omitia salsas, tortilla de un kilo y «Llevará terminal»; el cliente
// confirmaba un resumen incompleto y el pedido se creaba con detalles que nunca vio (4 de 5 corridas ON). Ahora el resumen lleva TODO lo que afecta al pedido.
// Reloj fijo: martes 2026-10-06 13:00 America/Merida.
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { esResumenParaConfirmar, resumenCanonico, terminaEnPreguntaDeConfirmacion, PREGUNTA_CANONICA_DE_CONFIRMACION } from "../src/agent-tools/cierre-maquina.ts";
import { limpiarEntorno, prepararEntorno, setup } from "./support/cierre-r11.ts";

afterEach(limpiarEntorno);

type Sesion = ReturnType<typeof setup>;

/** Sesion con un kilo con tortilla elegida (como el 1/4 de bistec de T7-001), unos tacos y la doble salsa del catalogo. */
function sesion() {
  const s = setup();
  const f = s.f;
  const kilo = randomUUID();
  f.repo.seedProduct({ id: kilo, organizationId: f.organizationId, categoryId: f.categories.tacos, name: "Bistec de Res — 250 g", description: null, searchKeywords: [] });
  f.repo.seedBranchProduct({ propertyId: f.propertyId, productId: kilo, price: 275, isAvailable: true });
  const extra = randomUUID();
  f.repo.seedProduct({ id: extra, organizationId: f.organizationId, categoryId: f.categories.bebidas, name: "Extra Salsa", description: null, searchKeywords: [] });
  f.repo.seedBranchProduct({ propertyId: f.propertyId, productId: extra, price: 19, isAvailable: true });
  const bistec = { product_id: kilo, product_name: "Bistec de Res — 250 g", requested_quantity: 1 };
  const tacos = { product_id: f.products.tacosPastor, product_name: "Tacos de Bistec de Res (orden de 3)", requested_quantity: 3 };
  return { s, bistec, tacos };
}

const SALSAS_T7_001 = ["crema_ajo", "salsa_guacamolera", "salsa_mexicana", "salsa_habanero"];
const TARJETA = { payment_method: "tarjeta", efectivo_con: undefined };

async function canon(s: Sesion, extra: Record<string, unknown>): Promise<string> {
  await s.quote(extra);
  return s.canonico();
}

describe("T7-001: el resumen canonico del modo ON ya no omite salsas, tortilla ni terminal", () => {
  beforeEach(() => prepararEntorno(true));

  it("1/4 de bistec con tortilla de maiz, 4 salsas pedidas, tarjeta a domicilio y hora", async () => {
    const { s, bistec } = sesion();
    const c = await canon(s, {
      ...TARJETA,
      items: [{ ...bistec, tortilla: "maiz" }],
      canal: "domicilio",
      colonia_entrega: "Centro",
      programado_para: "2026-10-06T19:00:00-06:00",
      requested_complements: SALSAS_T7_001,
    });
    expect(c).toContain("• 1 × Bistec de Res — 250 g (maiz) — $275");
    expect(c).toContain("Salsas pedidas (sin costo): crema de ajo, salsa guacamolera, salsa mexicana, salsa habanero");
    expect(c).toContain("Entrega: a domicilio (para las 7:00 pm)");
    expect(c).toContain("Dirección: colonia Centro");
    expect(c).toContain("Pago: tarjeta");
    expect(c).toContain("Llevará terminal");
    expect(c).toContain("Total a pagar: $275");
    expect(c.endsWith(PREGUNTA_CANONICA_DE_CONFIRMACION)).toBe(true);
  });

  it("sigue siendo reconocido como resumen para confirmar (total + pregunta fija)", async () => {
    const { s, bistec } = sesion();
    const c = await canon(s, { ...TARJETA, items: [{ ...bistec, tortilla: "maiz" }], canal: "domicilio", colonia_entrega: "Centro", requested_complements: SALSAS_T7_001, notes: "sin cebolla" });
    expect(esResumenParaConfirmar(await s.total(), c)).toBe(true);
    expect(terminaEnPreguntaDeConfirmacion(c)).toBe(true);
  });

  it("el resultado de cotizar_pedido entrega ese mismo resumen al modelo", async () => {
    const { s, bistec } = sesion();
    const r = await s.quote({ ...TARJETA, items: [{ ...bistec, tortilla: "harina" }], canal: "domicilio", colonia_entrega: "Centro", requested_complements: ["salsa_pina"] });
    const texto = (r.result as { resumen_canonico: string }).resumen_canonico;
    expect(texto).toContain("(harina)");
    expect(texto).toContain("salsa de piña");
    expect(texto).toBe(await s.canonico());
  });
});

describe("variantes del resumen canonico completo", () => {
  beforeEach(() => prepararEntorno(true));

  it("sin salsas pedidas: no hay linea de salsas ni de notas", async () => {
    const { s, bistec } = sesion();
    const c = await canon(s, { ...TARJETA, items: [{ ...bistec, tortilla: "maiz" }], canal: "domicilio", colonia_entrega: "Centro" });
    expect(c).toContain("(maiz)");
    expect(c).not.toContain("Salsas");
    expect(c).not.toContain("Notas");
  });

  it("doble salsa cobrada: aparece con su precio y entra al total", async () => {
    const { s, bistec } = sesion();
    const c = await canon(s, { ...TARJETA, items: [{ ...bistec, tortilla: "maiz" }], canal: "domicilio", colonia_entrega: "Centro", doble_salsas: ["salsa_roja"] });
    expect(c).toMatch(/doble porción: salsa roja\) — \$19/);
    expect(c).toContain("Total a pagar: $294");
  });

  it("doble salsa y salsas pedidas juntas", async () => {
    const { s, bistec } = sesion();
    const c = await canon(s, { ...TARJETA, items: [{ ...bistec, tortilla: "maiz" }], canal: "recoger", doble_salsas: ["salsa_verde"], requested_complements: ["crema_ajo"] });
    expect(c).toContain("Salsas pedidas (sin costo): crema de ajo");
    expect(c).toMatch(/doble porción: salsa verde\) — \$19/);
    expect(c).toContain("Total a pagar: $294");
  });

  it("dos productos con tortillas distintas: cada renglon la suya (tacos maiz, kilo harina)", async () => {
    const { s, bistec, tacos } = sesion();
    const c = await canon(s, { ...TARJETA, items: [{ ...tacos, tortilla: "maiz" }, { ...bistec, tortilla: "harina" }], canal: "domicilio", colonia_entrega: "Centro" });
    expect(c).toContain("• 1 × Tacos de Bistec de Res (orden de 3) (maiz)");
    expect(c).toContain("• 1 × Bistec de Res — 250 g (harina)");
  });

  it("dos productos: tacos con tortilla mixta y kilo de maiz", async () => {
    const { s, bistec, tacos } = sesion();
    const c = await canon(s, { ...TARJETA, items: [{ ...tacos, tortilla: "mixta" }, { ...bistec, tortilla: "maiz" }], canal: "recoger" });
    expect(c).toContain("(mixta)");
    expect(c).toContain("Bistec de Res — 250 g (maiz)");
  });

  it("recoger con efectivo: paga con, sin terminal ni direccion", async () => {
    const { s, bistec } = sesion();
    const c = await canon(s, { items: [{ ...bistec, tortilla: "maiz" }], canal: "recoger", payment_method: "efectivo", efectivo_con: 500, requested_complements: ["salsa_habanero"] });
    expect(c).toContain("Entrega: recoger en sucursal");
    expect(c).toContain("Pago: efectivo (paga con $500)");
    expect(c).toContain("Salsas pedidas (sin costo): salsa habanero");
    expect(c).not.toContain("terminal");
    expect(c).not.toContain("Dirección:");
  });

  it("recoger con tarjeta: NO lleva terminal (solo tarjeta a domicilio)", async () => {
    const { s, bistec } = sesion();
    const c = await canon(s, { ...TARJETA, items: [{ ...bistec, tortilla: "maiz" }], canal: "recoger" });
    expect(c).toContain("Pago: tarjeta");
    expect(c).not.toContain("terminal");
  });

  it("domicilio con efectivo: NO lleva terminal", async () => {
    const { s, bistec } = sesion();
    const c = await canon(s, { items: [{ ...bistec, tortilla: "maiz" }], canal: "domicilio", colonia_entrega: "Centro", payment_method: "efectivo", efectivo_con: 400 });
    expect(c).toContain("Pago: efectivo (paga con $400)");
    expect(c).not.toContain("terminal");
  });

  it("programado para manana con tarjeta a domicilio: hora, colonia y terminal", async () => {
    const { s, tacos } = sesion();
    const c = await canon(s, { ...TARJETA, items: [{ ...tacos, tortilla: "harina" }], canal: "domicilio", colonia_entrega: "Centro", programado_para: "2026-10-07T14:30:00-06:00" });
    expect(c).toContain("Entrega: a domicilio (para mañana a las 2:30 pm)");
    expect(c).toContain("Dirección: colonia Centro");
    expect(c).toContain("Llevará terminal");
  });

  it("notas ya capturadas (sin cebolla) salen en el resumen", async () => {
    const { s, tacos } = sesion();
    const c = await canon(s, { ...TARJETA, items: [{ ...tacos, tortilla: "maiz" }], canal: "recoger", notes: "sin cebolla, poco queso" });
    expect(c).toContain("Notas: sin cebolla, poco queso");
  });

  it("notas con telefono, correo o saltos de linea: sin PII y en una sola linea", async () => {
    const { s, tacos } = sesion();
    const c = await canon(s, { ...TARJETA, items: [{ ...tacos, tortilla: "maiz" }], canal: "recoger", notes: "sin cebolla\nllamar al 999 123 4567 o a nora@example.com" });
    const nota = c.split("\n").find((l) => l.startsWith("Notas:")) ?? "";
    expect(nota).toContain("sin cebolla");
    expect(nota).not.toMatch(/\d{3}\s?\d{3}\s?\d{4}/);
    expect(nota).not.toContain("@");
    expect(c).not.toContain("nora@example.com");
  });

  it("notas larguisimas se recortan", async () => {
    const { s, tacos } = sesion();
    const c = await canon(s, { ...TARJETA, items: [{ ...tacos, tortilla: "maiz" }], canal: "recoger", notes: `sin cebolla ${"muy ".repeat(200)}` });
    const nota = c.split("\n").find((l) => l.startsWith("Notas:")) ?? "";
    expect(nota.length).toBeGreaterThan(0);
    expect(nota.length).toBeLessThanOrEqual(170);
    expect(c).toContain("Total a pagar:");
  });

  it("salsas quitadas (omit_default_complements) se muestran como «Sin»", async () => {
    const { s, tacos } = sesion();
    const c = await canon(s, { ...TARJETA, items: [{ ...tacos, tortilla: "maiz" }], canal: "recoger", omit_default_complements: ["salsa_verde", "limones"] });
    expect(c).toContain("Sin: salsa verde, limones");
  });

  it("una salsa basica pedida de mas y las repetidas no ensucian la lista", async () => {
    const { s, tacos } = sesion();
    const c = await canon(s, { ...TARJETA, items: [{ ...tacos, tortilla: "maiz" }], canal: "recoger", requested_complements: ["salsa_verde", "crema_ajo", "crema_ajo"] });
    expect(c).toContain("Salsas pedidas (sin costo): crema de ajo\n");
  });

  it("propina en porcentaje con tarjeta a domicilio: propina y terminal", async () => {
    const { s, bistec } = sesion();
    const c = await canon(s, { ...TARJETA, items: [{ ...bistec, tortilla: "maiz" }], canal: "domicilio", colonia_entrega: "Centro", propina_porcentaje: 10 });
    expect(c).toContain("Propina: 10% (no suma al total)");
    expect(c).toContain("Llevará terminal");
  });

  it("el orden de las lineas es estable: renglones, salsas, notas, entrega, pago, terminal, total, pregunta", async () => {
    const { s, bistec } = sesion();
    const c = await canon(s, { ...TARJETA, items: [{ ...bistec, tortilla: "maiz" }], canal: "domicilio", colonia_entrega: "Centro", requested_complements: ["crema_ajo"], notes: "sin cebolla" });
    const pos = ["• 1 ×", "Salsas pedidas", "Notas:", "Entrega:", "Dirección:", "Pago:", "Llevará terminal", "Total a pagar", "¿Está correcto?"].map((t) => c.indexOf(t));
    expect(pos.every((p) => p >= 0)).toBe(true);
    expect([...pos].sort((a, b) => a - b)).toEqual(pos);
  });

  it("sin datos extra el texto queda IGUAL que antes (recoger, efectivo, una bebida)", async () => {
    const s = setup();
    await s.quote();
    expect(await s.canonico()).toBe(
      ["Resumen de su pedido:", "• 2 × Coca-Cola — $90", "Entrega: recoger en sucursal", "Pago: efectivo (paga con $500)", "Total a pagar: $90", "", PREGUNTA_CANONICA_DE_CONFIRMACION].join("\n"),
    );
  });

  it("lo que el servidor guarda para rearmar el resumen (pago/propina) conserva salsas, notas y tortilla", async () => {
    const { s, bistec } = sesion();
    await s.quote({ ...TARJETA, items: [{ ...bistec, tortilla: "maiz" }], canal: "domicilio", colonia_entrega: "Centro", requested_complements: ["crema_ajo"], notes: "sin cebolla" });
    const base = (await s.snap())?.context?.resumenBase as { salsas?: string[]; notas?: string; lineas: { tortilla?: string | null }[] } | undefined;
    expect(base?.salsas).toEqual(["crema de ajo"]);
    expect(base?.notas).toBe("sin cebolla");
    expect(base?.lineas[0]?.tortilla).toBe("maiz");
    const rearmado = resumenCanonico({ ...(base as never as Parameters<typeof resumenCanonico>[0]), datos: { pago: "efectivo", efectivoCon: 300 } });
    expect(rearmado).toContain("Salsas pedidas (sin costo): crema de ajo");
    expect(rearmado).toContain("Notas: sin cebolla");
    expect(rearmado).toContain("(maiz)");
    expect(rearmado).toContain("Pago: efectivo (paga con $300)");
    expect(rearmado).not.toContain("terminal");
  });
});

describe("resumenCanonico (plantilla pura): terminal, salsas y pedidos grandes", () => {
  const lineas = [{ name: "Coca-Cola", quantity: 2, lineTotal: 90 }];

  it("tarjeta a domicilio lleva terminal; tarjeta a recoger no", () => {
    expect(resumenCanonico({ lineas, total: 90, canal: "domicilio", datos: { pago: "tarjeta" } })).toContain("Llevará terminal");
    expect(resumenCanonico({ lineas, total: 90, canal: "recoger", datos: { pago: "tarjeta" } })).not.toContain("terminal");
  });

  it("sin los datos extra queda como antes (tarjeta a recoger)", () => {
    expect(resumenCanonico({ lineas, total: 90, canal: "recoger", datos: { pago: "tarjeta" } })).toBe(
      ["Resumen de su pedido:", "• 2 × Coca-Cola — $90", "Entrega: recoger en sucursal", "Pago: tarjeta", "Total a pagar: $90", "", PREGUNTA_CANONICA_DE_CONFIRMACION].join("\n"),
    );
  });

  it("pedido grande (200 renglones) cabe en WhatsApp y conserva total y pregunta de confirmacion", () => {
    const muchas = Array.from({ length: 200 }, (_, i) => ({ name: `Producto numero ${i + 1} con nombre bastante largo para ocupar espacio`, quantity: 3, lineTotal: 120 + i, tortilla: "maiz" }));
    const total = muchas.reduce((a, l) => a + l.lineTotal, 0);
    const t = resumenCanonico({ lineas: muchas, total, canal: "domicilio", datos: { pago: "tarjeta" }, salsas: ["crema de ajo"], notas: "sin cebolla", hora: "para las 7:00 pm", direccion: "colonia Centro" });
    // WhatsApp admite 4096, pero la deteccion solo lee los primeros 2400 caracteres: con la frase de tono (160) tampoco se pasa de ahi.
    expect(t.length + 162).toBeLessThanOrEqual(2400);
    expect(t.length).toBeLessThanOrEqual(4096);
    expect(terminaEnPreguntaDeConfirmacion(`Con gusto, un momento por favor.\n\n${t}`)).toBe(true);
    expect(t).toContain(`Total a pagar: $${total}`);
    expect(t).toContain("Llevará terminal");
    expect(t).toContain("renglones más");
    expect(t.endsWith(PREGUNTA_CANONICA_DE_CONFIRMACION)).toBe(true);
    expect(esResumenParaConfirmar(total, t)).toBe(true);
  });

  it("pedido mediano (20 renglones) no se recorta", () => {
    const veinte = Array.from({ length: 20 }, (_, i) => ({ name: `Producto ${i + 1}`, quantity: 1, lineTotal: 10 }));
    const t = resumenCanonico({ lineas: veinte, total: 200, canal: "recoger", datos: {} });
    expect(t).not.toContain("renglones más");
    expect(t).toContain("• 1 × Producto 20 — $10");
  });
});
