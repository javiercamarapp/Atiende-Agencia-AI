// PM Ronda 13 (T7-026, hallazgo de la hora): el resumen canonico de la maquina de cierre (modo ON) no mostraba la hora ni la direccion: el cliente confirmaba «Entrega: recoger en
// sucursal» sin ver a que hora, y el pedido quedo a las 18:00 cuando pidio 7 pm. Ahora el resumen dice la hora de entrega/recogida en la zona de la sucursal («para las 7:00 pm») y,
// a domicilio, la colonia y si llego el pin. Reloj fijo: martes 2026-10-06 13:00 America/Merida.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { esResumenParaConfirmar, resumenCanonico, terminaEnPreguntaDeConfirmacion } from "../src/agent-tools/cierre-maquina.ts";
import { limpiarEntorno, prepararEntorno, setup } from "./support/cierre-r11.ts";

afterEach(limpiarEntorno);

describe("resumen canonico del modo ON: hora de entrega y direccion", () => {
  beforeEach(() => prepararEntorno(true));

  it.each([
    ["programado_para 7 pm hoy", { programado_para: "2026-10-06T19:00:00-06:00" }, "Entrega: recoger en sucursal (para las 7:00 pm)"],
    ["hora_recogida 7 pm hoy", { hora_recogida: "2026-10-06T19:00:00-06:00" }, "Entrega: recoger en sucursal (para las 7:00 pm)"],
    ["hora_recogida 2 pm hoy", { hora_recogida: "2026-10-06T14:00:00-06:00" }, "Entrega: recoger en sucursal (para las 2:00 pm)"],
    ["mediodia de manana", { programado_para: "2026-10-07T12:00:00-06:00" }, "Entrega: recoger en sucursal (para mañana a las 12:00 pm)"],
    ["medianoche (cruce de dia: es del turno del martes pero ya es miercoles)", { programado_para: "2026-10-07T00:00:00-06:00" }, "Entrega: recoger en sucursal (para mañana a las 12:00 am)"],
    ["otro dia de la semana", { programado_para: "2026-10-09T14:30:00-06:00" }, "Entrega: recoger en sucursal (para el vie 09/10 a las 2:30 pm)"],
    ["en 40 minutos (hora que calcula el servidor)", { minutos_para_recoger: 40 }, "Entrega: recoger en sucursal (para la 1:40 pm)"],
    ["en una hora (las 2:00 pm exactas)", { minutos_para_recoger: 60 }, "Entrega: recoger en sucursal (para las 2:00 pm)"],
  ])("%s", async (_n, extra, esperado) => {
    const s = setup();
    await s.quote(extra);
    expect(await s.canonico()).toContain(esperado);
  });

  it("sin hora (en cuanto este) el resumen queda como siempre, sin parentesis", async () => {
    const s = setup();
    await s.quote();
    const c = await s.canonico();
    expect(c).toContain("Entrega: recoger en sucursal\n");
    expect(c).not.toMatch(/para (las?|mañana|el) /);
  });

  it("la hora se muestra en la zona de la SUCURSAL, no en la del proceso (Cancun: 7 pm locales son las 00:00Z)", async () => {
    const s = setup();
    void s.f.repo.upsertBranchZonaHoraria(s.f.propertyId, "America/Cancun");
    await s.quote({ programado_para: "2026-10-06T19:00:00-05:00" });
    expect(await s.canonico()).toContain("(para las 7:00 pm)");
  });

  it("a domicilio con colonia: la direccion que el servidor conoce sale en el resumen", async () => {
    const s = setup();
    await s.quote({ canal: "domicilio", colonia_entrega: "Centro" });
    const c = await s.canonico();
    expect(c).toContain("Entrega: a domicilio");
    expect(c).toContain("Dirección: colonia Centro");
  });

  it("a domicilio programado: hora y colonia juntas", async () => {
    const s = setup();
    await s.quote({ canal: "domicilio", colonia_entrega: "Centro", programado_para: "2026-10-06T19:00:00-06:00" });
    const c = await s.canonico();
    expect(c).toContain("Entrega: a domicilio (para las 7:00 pm)");
    expect(c).toContain("Dirección: colonia Centro");
  });

  it("recoger NO muestra linea de direccion", async () => {
    const s = setup();
    await s.quote({ programado_para: "2026-10-06T19:00:00-06:00", colonia_entrega: "Centro" });
    expect(await s.canonico()).not.toContain("Dirección:");
  });

  it("el resumen con hora sigue siendo reconocido como resumen para confirmar (total + pregunta)", async () => {
    const s = setup();
    await s.quote({ programado_para: "2026-10-06T19:00:00-06:00" });
    const c = await s.canonico();
    const total = await s.total();
    expect(esResumenParaConfirmar(total, c)).toBe(true);
    expect(terminaEnPreguntaDeConfirmacion(c)).toBe(true);
    expect(c).toContain(`Total a pagar: $${total}`);
  });

  it("el resultado de cotizar_pedido entrega ese mismo resumen al modelo", async () => {
    const s = setup();
    const r = await s.quote({ programado_para: "2026-10-06T19:00:00-06:00" });
    expect((r.result as { resumen_canonico: string }).resumen_canonico).toContain("(para las 7:00 pm)");
  });

  it("el resumen rearmado con un dato nuevo (pago/propina) conserva la hora", async () => {
    const s = setup();
    await s.quote({ programado_para: "2026-10-06T19:00:00-06:00", payment_method: "tarjeta", efectivo_con: undefined });
    const base = (await s.snap())?.context?.resumenBase as { hora?: string } | undefined;
    expect(base?.hora).toMatch(/7:00 pm/);
  });

  it("crear el pedido tras confirmar guarda la misma hora que el resumen mostro", async () => {
    const s = setup();
    await s.quote({ programado_para: "2026-10-06T19:00:00-06:00" });
    await s.muestraResumen();
    s.cliente("si");
    await s.confirm();
    const r = await s.create({ programado_para: "2026-10-06T19:00:00-06:00" });
    expect((r.raw as { programadoPara?: string | null }).programadoPara).toBe("2026-10-07T01:00:00.000Z");
  });
});

describe("resumenCanonico (plantilla pura)", () => {
  const datos = { pago: "efectivo" as const, efectivoCon: 500 };
  const lineas = [{ name: "Coca-Cola", quantity: 2, lineTotal: 90 }];

  it("domicilio con hora y direccion", () => {
    const t = resumenCanonico({ lineas, total: 90, canal: "domicilio", datos, hora: "para las 7:00 pm", direccion: "colonia Centro" });
    expect(t).toContain("Entrega: a domicilio (para las 7:00 pm)");
    expect(t).toContain("Dirección: colonia Centro");
  });

  it("recoger ignora la direccion", () => {
    const t = resumenCanonico({ lineas, total: 90, canal: "recoger", datos, hora: "para las 7:00 pm", direccion: "colonia Centro" });
    expect(t).toContain("Entrega: recoger en sucursal (para las 7:00 pm)");
    expect(t).not.toContain("Dirección:");
  });

  it("sin hora ni direccion queda igual que antes", () => {
    const t = resumenCanonico({ lineas, total: 90, canal: "domicilio", datos });
    expect(t).toContain("Entrega: a domicilio\n");
    expect(t).not.toContain("Dirección:");
  });
});

describe("maquina de cierre APAGADA", () => {
  beforeEach(() => prepararEntorno(false));

  it("no arma resumen canonico (el camino de main no cambia) y la hora igual se cotiza", async () => {
    const s = setup();
    const r = await s.quote({ programado_para: "2026-10-06T19:00:00-06:00" });
    expect((r.result as { resumen_canonico?: string }).resumen_canonico).toBeUndefined();
    expect((r.result as { quote: { programado_para?: string } }).quote.programado_para).toBe("2026-10-07T01:00:00.000Z");
  });
});
