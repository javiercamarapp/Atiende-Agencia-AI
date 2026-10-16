// R11, arquitectura B (PR #574): endurecimiento de la maquina de estados del cierre contra los huecos conocidos de la guarda de #566. Deterministas, sin LLM real.
// Los textos describen la CLASE del intento (respuestas cortas, compuestas, de pago/propina, cambios, dobles disparos); nada de esto es una receta contra el sistema.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ambiguoAceptablePorSalida,
  clasificarRespuestaCierre,
  datosDelMensaje,
  montoDePago,
  type RespuestaCierre,
} from "../src/agent-tools/cierre-maquina.ts";
import { limpiarEntorno, llamada, mundo, prepararEntorno, PHONE, setup, texto, type Fixture, type Msg } from "./support/cierre-r11.ts";

const pedidosDe = async (f: Fixture) => (await f.repo.listOrders(f.organizationId, { propertyIds: null, limit: 50 })).orders;

type Rechazo = { rechazoDelFlujo?: string; result: { error?: string; confirmado?: boolean; resumen_canonico?: string } };

describe("con la maquina ENCENDIDA", () => {
  beforeEach(() => prepararEntorno(true));
  afterEach(limpiarEntorno);

  // -------------------------------------------------------------------------------------------------------------------
  describe("clasificador: respuestas cortas y compuestas", () => {
    const tabla: Array<[string, RespuestaCierre, boolean]> = [
      // Rechazos sueltos: nunca confirman, ni dentro ni fuera del resumen.
      ["No", "no", true], ["nop", "no", true], ["nope", "no", true], ["nel", "no", true], ["no no", "no", true], ["ya no", "no", true], ["No, ya no quiero", "no", true], ["claro que no", "no", true], ["mejor no", "no", true], ["olvídalo", "no", true],
      ["No", "no", false], ["nop", "no", false], ["claro que no", "no", false],
      // «nada» suelto es ambiguo: no confirma (la salida segura solo acepta titubeos inocuos).
      ["nada", "ambiguo", true], ["nada", "ambiguo", false],
      // Cortesias contestadas al RESUMEN (que pregunta si esta correcto): son el visto bueno.
      ["ok", "si", true], ["ok gracias", "si", true], ["No gracias", "si", true], ["no, así está bien", "si", true], ["No, gracias 🙂", "si", true],
      // Las mismas, contestadas a OTRA pregunta (propina, pago): respuesta de dato, no confirman.
      ["No gracias", "dato", false], ["no, así está bien", "dato", false],
      // Compuestos con pago o propina: dato, nunca confirmacion.
      ["No gracias. Pago con $1,000", "dato", true], ["No gracias. Pago con $1,000", "dato", false], ["con 600, sin propina", "dato", true], ["con 600, sin propina", "dato", false],
      ["sí, con 600, sin propina", "dato", true], ["ok, con mil", "dato", true], ["tarjeta, de propina 10%", "dato", true],
      // Titubeos: no confirman.
      ["sí, creo", "ambiguo", true], ["tal vez", "ambiguo", true], ["no estoy seguro", "ambiguo", true], ["no sé", "ambiguo", true], ["quizá sí", "ambiguo", true],
      // Cambios de cantidad, de producto y de direccion tras el resumen.
      ["dos más", "cambio", true], ["que sean 3", "cambio", true], ["mejor solo uno", "cambio", true], ["mi dirección es Calle 5 #20", "cambio", true], ["sí, pero en otra dirección", "cambio", true], ["a la otra calle", "cambio", true],
      // Afirmaciones limpias.
      ["Sí", "si", true], ["sí sí", "si", true], ["sí 👍🏽", "si", true], ["👍", "si", true], ["dale gracias 😊", "si", true], ["sí, a nombre de Juan", "si", true],
    ];
    for (const [msg, esperado, despues] of tabla) {
      it(`«${msg}» ${despues ? "(tras el resumen)" : "(fuera del resumen)"} => ${esperado}`, () => {
        expect(clasificarRespuestaCierre(msg, { despuesDelResumen: despues, total: 90 })).toBe(esperado);
      });
    }
    it("solo la clase «si» confirma; ninguna otra respuesta de la tabla puede confirmar", () => {
      for (const [msg, esperado, despues] of tabla) {
        if (esperado === "si") continue;
        expect(clasificarRespuestaCierre(msg, { despuesDelResumen: despues, total: 90 }), msg).not.toBe("si");
      }
    });
  });

  describe("montos de pago", () => {
    it("separador de miles, decimales y palabras", () => {
      expect(montoDePago("pago con $1,000")).toBe(1000);
      expect(montoDePago("cambio de $1,000.50")).toBe(1000.5);
      expect(montoDePago("con 1000 pesos")).toBe(1000);
      expect(montoDePago("con mil")).toBe(1000);
      expect(montoDePago("con mil quinientos")).toBe(1500);
      expect(montoDePago("con dos mil")).toBe(2000);
      expect(montoDePago("con quinientos")).toBe(500);
      expect(montoDePago("con 600, sin propina")).toBe(600);
      expect(montoDePago("500")).toBe(500);
      expect(montoDePago("con 10% de propina")).toBeUndefined();
      expect(montoDePago("con 20 de propina")).toBeUndefined();
    });
    it("datos del mensaje combinados", () => {
      expect(datosDelMensaje("No gracias. Pago con $1,000", 90)).toEqual({ pago: "efectivo", efectivoCon: 1000, sinPropina: true });
      expect(datosDelMensaje("con 600, sin propina", 90)).toEqual({ pago: "efectivo", efectivoCon: 600, sinPropina: true });
      expect(datosDelMensaje("tarjeta y 10% de propina", 90)).toEqual({ pago: "tarjeta", propinaPct: 10 });
      expect(datosDelMensaje("con 50", 90)).toEqual({}); // no alcanza el total
    });
    it("la salida segura solo acepta titubeos inocuos", () => {
      for (const m of ["mmm", "a ver", "pues órale", "ps ya"]) expect(ambiguoAceptablePorSalida(m), m).toBe(true);
      for (const m of ["¿cuánto tarda?", "no sé", "no estoy seguro", "tal vez", "nada", "mejor 3", "con tarjeta", "mi dirección es otra", ""]) expect(ambiguoAceptablePorSalida(m), m).toBe(false);
    });
  });

  // -------------------------------------------------------------------------------------------------------------------
  describe("las respuestas cortas a una pregunta de propina o pago NO confirman el resumen ni crean pedido", () => {
    const mensajes = ["No", "nop", "nada", "ok", "ok gracias", "no, así está bien", "No gracias. Pago con $1,000", "con 600, sin propina", "No gracias", "efectivo", "sí"];
    for (const preguntaDelAsistente of ["Su pedido suma $90. ¿Desea agregar propina?", "Su pedido suma $90. ¿Con cuánto paga?", "Su pedido suma $90. ¿Efectivo o tarjeta?"]) {
      for (const m of mensajes) {
        it(`${preguntaDelAsistente.split(". ")[1]} -> «${m}»`, async () => {
          const s = setup();
          s.cliente("dos cocas para recoger, soy Nora");
          await s.quote();
          s.asistente(preguntaDelAsistente.replace("$90", `$${await s.total()}`));
          s.cliente(m);
          const r = (await s.confirm()) as unknown as Rechazo;
          expect(r.result.confirmado).toBeUndefined();
          expect(r.rechazoDelFlujo).toBe("cierre_resumen_no_mostrado");
          expect((await s.snap())?.state).toBe("cotizado");
          await expect(s.create()).rejects.toMatchObject({ code: "sin_confirmacion" });
        });
      }
    }
  });

  describe("el resumen vigente + respuestas que NO son un si", () => {
    for (const m of ["No", "nop", "nada", "No gracias. Pago con $1,000", "con 600, sin propina", "tarjeta", "10% de propina", "dos más", "mi dirección es Calle 5 #20", "sí, creo", "tal vez"]) {
      it(`«${m}» no confirma ni crea`, async () => {
        const s = setup();
        s.cliente("dos cocas para recoger, soy Nora");
        await s.quote();
        await s.muestraResumen();
        s.cliente(m);
        const r = (await s.confirm()) as unknown as Rechazo;
        expect(r.result.confirmado).toBeUndefined();
        expect(r.rechazoDelFlujo).toMatch(/^cierre_/);
        expect((await s.snap())?.state).toBe("cotizado");
        await expect(s.create()).rejects.toMatchObject({ code: "sin_confirmacion" });
      });
    }
    for (const m of ["ok", "ok gracias", "No gracias", "no, así está bien", "Sí", "dale 👍"]) {
      it(`«${m}» al resumen vigente SI es el visto bueno y crea un solo pedido`, async () => {
        const s = setup();
        s.cliente("dos cocas para recoger, soy Nora");
        await s.quote();
        await s.muestraResumen();
        s.cliente(m);
        expect(((await s.confirm()) as unknown as Rechazo).result.confirmado).toBe(true);
        expect((await s.create()).orderId).not.toBeNull();
      });
    }
  });

  // -------------------------------------------------------------------------------------------------------------------
  describe("pago y propina: antes y despues del resumen", () => {
    it("«con 600, sin propina» TRAS el resumen: se adopta (efectivo con 600, sin propina), se rearma el resumen y hace falta otro sí", async () => {
      const s = setup();
      s.cliente("dos cocas para recoger, soy Nora");
      await s.quote({ payment_method: "tarjeta", efectivo_con: undefined, propina_porcentaje: 10 });
      await s.muestraResumen();
      expect(await s.canonico()).toContain("Propina: 10%");
      s.cliente("mejor con 600, sin propina");
      const r = (await s.confirm()) as unknown as Rechazo;
      expect(r.rechazoDelFlujo).toBe("cierre_sin_si_explicito");
      expect(r.result.resumen_canonico).toContain("paga con $600");
      expect(r.result.resumen_canonico).not.toContain("Propina");
      s.asistente(r.result.resumen_canonico!);
      s.cliente("sí");
      expect(((await s.confirm()) as unknown as Rechazo).result.confirmado).toBe(true);
      const creado = await s.create({ efectivo_con: 600 });
      expect(creado.orderId).not.toBeNull();
    });
    it("«No gracias. Pago con $1,000» TRAS el resumen adopta el efectivo de 1,000 (no 0 ni 000)", async () => {
      const s = setup();
      s.cliente("dos cocas para recoger, soy Nora");
      await s.quote();
      await s.muestraResumen();
      s.cliente("No gracias. Pago con $1,000");
      const r = (await s.confirm()) as unknown as Rechazo;
      expect(r.rechazoDelFlujo).toBe("cierre_sin_si_explicito");
      expect(r.result.resumen_canonico).toContain("paga con $1000");
      expect((await s.snap())?.context?.quotedEfectivoCon).toBe(1000);
    });
    it("pago/propina ANTES del resumen no confirman: el servidor los adopta y el resumen que se muestra ya los trae", async () => {
      const s = setup();
      s.cliente("dos cocas para recoger, soy Nora");
      await s.quote({ payment_method: undefined, efectivo_con: undefined });
      s.asistente(`Su pedido suma $${await s.total()}. ¿Cómo desea pagar?`);
      s.cliente("con 600, sin propina");
      const r = (await s.confirm()) as unknown as Rechazo;
      expect(r.rechazoDelFlujo).toBe("cierre_resumen_no_mostrado");
      expect(r.result.confirmado).toBeUndefined();
      expect((await s.snap())?.context?.quotedEfectivoCon).toBe(600);
      expect(r.result.error).toContain("paga con $600");
    });
    it("el sí que llega junto con un pago DISTINTO al del resumen no confirma", async () => {
      const s = setup();
      s.cliente("dos cocas para recoger, soy Nora");
      await s.quote();
      await s.muestraResumen();
      s.cliente("sí, pero pago con tarjeta");
      const r = (await s.confirm()) as unknown as Rechazo;
      expect(r.result.confirmado).toBeUndefined();
      expect((await s.snap())?.context?.quotedPago).toBe("tarjeta");
    });
  });

  describe("cambios tras el resumen exigen re-confirmar", () => {
    it("cantidad: «dos más» -> no confirma; re-cotiza, muestra el resumen NUEVO y solo un sí a ese crea; el viejo ya no sirve", async () => {
      const s = setup();
      s.cliente("dos cocas para recoger, soy Nora");
      await s.quote();
      await s.muestraResumen();
      const viejo = await s.total();
      s.cliente("dos más");
      expect(((await s.confirm()) as unknown as Rechazo).rechazoDelFlujo).toBe("cierre_sin_si_explicito");
      await s.quote({}, 4);
      expect(await s.total()).toBeGreaterThan(viejo);
      s.asistente("Claro, agregué dos más.");
      s.cliente("sí");
      expect(((await s.confirm()) as unknown as Rechazo).rechazoDelFlujo).toBe("cierre_resumen_no_mostrado");
      await s.muestraResumen();
      s.cliente("sí");
      expect(((await s.confirm()) as unknown as Rechazo).result.confirmado).toBe(true);
      await expect(s.create({}, 2)).rejects.toMatchObject({ code: "pedido_distinto_al_cotizado" });
      expect((await s.create({}, 4)).orderId).not.toBeNull();
    });
    it("direccion: dicha tras el resumen no confirma", async () => {
      const s = setup();
      s.cliente("dos cocas para recoger, soy Nora");
      await s.quote();
      await s.muestraResumen();
      s.cliente("mejor mándalo a la otra dirección");
      expect(((await s.confirm()) as unknown as Rechazo).rechazoDelFlujo).toBe("cierre_sin_si_explicito");
    });
    it("tras confirmar, si en el turno de crear el cliente cambio algo, crear NO crea y vuelve a cotizado", async () => {
      const s = setup();
      s.cliente("dos cocas para recoger, soy Nora");
      await s.quote();
      await s.muestraResumen();
      s.cliente("sí");
      await s.confirm();
      s.asistente("¿A nombre de quién?");
      s.cliente("dos más, por favor");
      const r = (await s.createSafe()) as unknown as Rechazo & { orderId: string | null };
      expect(r.orderId).toBeNull();
      expect(r.rechazoDelFlujo).toBe("cierre_sin_si_explicito");
      expect((await s.snap())?.state).toBe("cotizado");
    });
  });

  // -------------------------------------------------------------------------------------------------------------------
  describe("«sí» ambiguo y salida segura (nunca mas de un turno de retraso, nunca bucle)", () => {
    it("titubeo inocuo: se rechaza una vez; en un turno posterior, tras volver a mostrar el resumen, pasa", async () => {
      const s = setup();
      s.cliente("dos cocas para recoger, soy Nora");
      await s.quote();
      await s.muestraResumen();
      s.cliente("mmm");
      expect(((await s.confirm()) as unknown as Rechazo).rechazoDelFlujo).toBe("cierre_sin_si_explicito");
      await s.muestraResumen();
      s.cliente("a ver");
      expect(((await s.confirm()) as unknown as Rechazo).result.confirmado).toBe(true);
    });
    it("una duda o pregunta NO se acepta por la salida segura, por mas veces que se repita", async () => {
      const s = setup();
      s.cliente("dos cocas para recoger, soy Nora");
      await s.quote();
      for (const m of ["no estoy seguro", "tal vez", "¿cuánto tarda?", "no sé"]) {
        await s.muestraResumen();
        s.cliente(m);
        const r = (await s.confirm()) as unknown as Rechazo;
        expect(r.result.confirmado, m).toBeUndefined();
      }
      expect((await s.snap())?.state).toBe("cotizado");
    });
    it("falso negativo del texto (resumen con el total pero sin pregunta reconocible): el sí se rechaza UNA vez y en el turno siguiente pasa", async () => {
      const s = setup();
      s.cliente("dos cocas para recoger, soy Nora");
      await s.quote();
      s.asistente(`Su pedido: 2 Coca-Cola, total $${await s.total()}. ¿Le late?`);
      s.cliente("sí");
      const r1 = (await s.confirm()) as unknown as Rechazo;
      expect(r1.rechazoDelFlujo).toBe("cierre_resumen_no_mostrado");
      // el modelo vuelve a decir lo mismo con el mismo defecto de redaccion
      s.asistente(`Su pedido: 2 Coca-Cola, total $${await s.total()}. ¿Le late?`);
      s.cliente("sí");
      expect(((await s.confirm()) as unknown as Rechazo).result.confirmado).toBe(true);
      expect((await s.create()).orderId).not.toBeNull();
    });
    it("la salida de «no visto» solo acepta un sí claro: un «no» o un dato no pasan", async () => {
      const s = setup();
      s.cliente("dos cocas para recoger, soy Nora");
      await s.quote();
      s.asistente("Anotado.");
      s.cliente("sí");
      expect(((await s.confirm()) as unknown as Rechazo).rechazoDelFlujo).toBe("cierre_resumen_no_mostrado");
      s.asistente("Anotado de nuevo.");
      s.cliente("no");
      const r = (await s.confirm()) as unknown as Rechazo;
      expect(r.result.confirmado).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------------------------------------------------
  describe("doble «sí» concurrente y timeout", () => {
    it("dos «sí» a la vez (confirmar + crear en paralelo, dos veces) dejan UN pedido", async () => {
      const s = setup();
      s.cliente("dos cocas para recoger, soy Nora");
      await s.quote();
      await s.muestraResumen();
      s.cliente("sí");
      await s.confirm();
      const cierre = async () => {
        const c = (await s.confirmSafe()) as { orderId?: string | null };
        void c;
        return s.createSafe();
      };
      const rs = await Promise.all([cierre(), cierre(), cierre()]);
      const ids = new Set(rs.map((r) => (r as { orderId?: string | null }).orderId).filter((x): x is string => typeof x === "string" && x.length > 0));
      expect(ids.size).toBe(1);
      expect((await pedidosDe(s.f)).length).toBe(1);
    });
    it("el sí a la vez que el cliente cambia el pago: gana el dato nuevo y NO se crea con el viejo", async () => {
      const s = setup();
      s.cliente("dos cocas para recoger, soy Nora");
      await s.quote();
      await s.muestraResumen();
      s.cliente("sí");
      await s.confirm();
      const r = (await s.createSafe({ payment_method: "tarjeta", efectivo_con: undefined })) as unknown as Rechazo & { orderId: string | null };
      expect(r.orderId).toBeNull();
      expect(r.rechazoDelFlujo).toBe("cierre_datos_cambiaron");
    });
    it("timeout a mitad: reclamo viejo se retoma sin pedir otro sí; uno reciente espera", async () => {
      const s = setup();
      s.cliente("dos cocas para recoger, soy Nora");
      await s.quote();
      await s.muestraResumen();
      s.cliente("sí");
      await s.confirm();
      const sn = (await s.snap())!;
      await s.f.repo.writeOrderFlow(s.f.organizationId, "k:wa", sn.version, { state: "creando", context: { ...sn.context!, claimedAtMs: Date.now() } }, 7200);
      await expect(s.create()).rejects.toMatchObject({ code: "pedido_en_proceso" });
    });
  });

  // -------------------------------------------------------------------------------------------------------------------
  describe("voz sin historial: intacta", () => {
    it("sin conversacion reciente la maquina no interviene: cotiza (sin resumen canonico), confirma y crea", async () => {
      const s = setup({ canal: "voz" });
      const q = (await s.quote()) as { result: Record<string, unknown> };
      expect(q.result.resumen_canonico).toBeUndefined();
      expect(q.result.instruccion_resumen).toBeUndefined();
      expect(((await s.confirm()) as unknown as Rechazo).result.confirmado).toBe(true);
      expect((await s.create()).orderId).not.toBeNull();
      const flow = await s.snap();
      expect(flow?.context?.confirmedFirma).toBeUndefined();
      expect(flow?.context?.cierreAmbiguoTurn).toBeUndefined();
    });
  });
});

// =====================================================================================================================
// Flujo completo por el manejador de WhatsApp con modelo guionado.
// =====================================================================================================================
describe("flujo completo con modelo guionado (maquina ENCENDIDA)", () => {
  beforeEach(() => prepararEntorno(true));
  afterEach(limpiarEntorno);

  const items = (f: Fixture, qty = 2) => [{ product_id: f.products.cocaCola, product_name: "Coca-Cola", requested_quantity: qty }];
  const cot = (f: Fixture, extra: object = {}) => llamada("c1", "cotizar_pedido", { branch_slug: "fco-montejo", canal: "recoger", items: items(f), ...extra });
  const crea = (f: Fixture, extra: object = {}) => llamada("c3", "crear_pedido", { branch_slug: "fco-montejo", canal: "recoger", customer_name: "Nora", items: items(f), ...extra });

  /** Dos turnos: el modelo cotiza y redacta SIN total (el servidor pone el resumen); el cliente dice `respuesta`; el modelo confirma y crea. */
  async function dosTurnos(opts: { extra: object; pide: string; respuesta: string; cliente?: { isNew: true } | { isNew: false; [k: string]: unknown } }) {
    const m = await mundo((paso, f) => {
      if (paso === 1) return cot(f, opts.extra);
      if (paso === 2) return texto("¡Claro que sí!\n\n¿Confirma su pedido?");
      if (paso === 3) return llamada("c2", "confirmar_resumen", {});
      if (paso === 4) return crea(f, opts.extra);
      return texto("Su pedido quedó registrado.");
    }, opts.cliente);
    const t1 = await m.turno([{ role: "user", content: opts.pide }]);
    const t2 = await m.turno([{ role: "user", content: opts.pide }, { role: "assistant", content: t1.reply }, { role: "user", content: opts.respuesta }]);
    return { m, t1, t2 };
  }

  it("cliente nuevo, recoger, efectivo con cambio: resumen del servidor y «sí» crea", async () => {
    const { m, t1, t2 } = await dosTurnos({ extra: { payment_method: "efectivo", efectivo_con: 500 }, pide: "dos cocas para recoger, soy Nora, pago con 500", respuesta: "sí" });
    expect(t1.reply).toContain("Pago: efectivo (paga con $500)");
    expect(t1.orderId ?? null).toBeNull();
    expect(t2.orderId).toBeTruthy();
    expect(await pedidosDe(m.f)).toHaveLength(1);
  });

  it("cliente conocido, recoger, tarjeta con propina: el resumen trae la propina y el pedido la lleva", async () => {
    const { t1, t2, m } = await dosTurnos({
      extra: { payment_method: "tarjeta", propina_porcentaje: 10 },
      pide: "lo mismo de siempre, dos cocas para recoger, con tarjeta y 10% de propina",
      respuesta: "ok gracias",
      cliente: { isNew: false, name: "Marcela", orderCount: 4, addresses: [], lastOrderItems: null, frequentItems: [], agentNotes: [] },
    });
    expect(t1.reply).toContain("Pago: tarjeta");
    expect(t1.reply).toContain("Propina: 10% (no suma al total)");
    expect(t2.orderId).toBeTruthy();
    expect(((await pedidosDe(m.f))[0] as { propina?: number }).propina).toBeGreaterThan(0);
  });

  it("pedido programado: la hora viaja en el resumen y el pedido queda programado", async () => {
    const hora = "2026-10-07T14:00:00-06:00";
    const { t1, t2, m } = await dosTurnos({ extra: { payment_method: "efectivo", efectivo_con: 500, programado_para: hora }, pide: "dos cocas para mañana a las 2, soy Nora, pago con 500", respuesta: "sí, correcto" });
    expect(t1.reply).toContain("Total a pagar");
    expect(t2.orderId).toBeTruthy();
    expect(((await pedidosDe(m.f))[0] as { status: string }).status).toBe("programado");
  });

  it("cliente que contesta «No gracias. Pago con $1,000» al resumen: no se crea; ve el resumen nuevo y su «sí» crea", async () => {
    const m = await mundo((paso, f, req) => {
      void req;
      if (paso === 1) return cot(f, { payment_method: "efectivo", efectivo_con: 500 });
      if (paso === 2) return texto("Listo.\n\n¿Confirma su pedido?");
      if (paso === 3) return llamada("c2", "confirmar_resumen", {});
      if (paso === 4) return texto("Perfecto.\n\n¿Confirma su pedido?");
      if (paso === 5) return llamada("c4", "confirmar_resumen", {});
      if (paso === 6) return crea(f, { payment_method: "efectivo", efectivo_con: 1000 });
      return texto("Su pedido quedó registrado.");
    });
    const base: Msg[] = [{ role: "user", content: "dos cocas para recoger, soy Nora, pago con 500" }];
    const t1 = await m.turno(base);
    const h2: Msg[] = [...base, { role: "assistant", content: t1.reply }, { role: "user", content: "No gracias. Pago con $1,000" }];
    const t2 = await m.turno(h2);
    expect(t2.orderId ?? null).toBeNull();
    expect(t2.reply).toContain("paga con $1000");
    const h3: Msg[] = [...h2, { role: "assistant", content: t2.reply }, { role: "user", content: "sí" }];
    const t3 = await m.turno(h3);
    expect(t3.orderId).toBeTruthy();
    expect(await pedidosDe(m.f)).toHaveLength(1);
  });

  it("el modelo se empeña en crear sin confirmar: el servidor no crea pedido en ningun turno intermedio", async () => {
    const m = await mundo((paso, f) => {
      if (paso === 1) return cot(f, { payment_method: "efectivo", efectivo_con: 500 });
      if (paso === 2) return crea(f, { payment_method: "efectivo", efectivo_con: 500 });
      return texto("¿Desea agregar propina?");
    });
    const t1 = await m.turno([{ role: "user", content: "dos cocas para recoger, soy Nora, pago con 500" }]);
    expect(t1.orderId ?? null).toBeNull();
    expect(await pedidosDe(m.f)).toHaveLength(0);
  });
  void PHONE;
});

// =====================================================================================================================
// Bandera APAGADA: el comportamiento es el de main (guarda de #566), y encendida no contradice a esa guarda.
// =====================================================================================================================
describe("con la bandera APAGADA el comportamiento es el de main", () => {
  beforeEach(() => prepararEntorno(false));
  afterEach(limpiarEntorno);

  it("cotizar no agrega resumen canonico ni campos de la maquina a la fila del flujo", async () => {
    const s = setup();
    s.cliente("dos cocas para recoger, soy Nora");
    const q = (await s.quote({ propina: 10 })) as { result: Record<string, unknown> };
    expect(q.result.resumen_canonico).toBeUndefined();
    expect(q.result.instruccion_resumen).toBeUndefined();
    const ctx = (await s.snap())?.context as unknown as Record<string, unknown>;
    expect(ctx.resumenCanonico).toBeUndefined();
    expect(ctx.resumenBase).toBeUndefined();
    s.asistente(`Total $${await s.total()}. ¿Es correcto?`);
    s.cliente("sí");
    await s.confirm();
    const ctx2 = (await s.snap())?.context as unknown as Record<string, unknown>;
    expect(ctx2.confirmedFirma).toBeUndefined();
    expect(ctx2.confirmedTurn).toBeUndefined();
    expect(ctx2.cierreAmbiguoTurn).toBeUndefined();
    expect(ctx2.cierreNoVistoTurn).toBeUndefined();
  });

  it("confirmar pasa con cualquier mensaje (como en main); la guarda de #566 decide en crear_pedido", async () => {
    const s = setup();
    s.cliente("dos cocas para recoger, soy Nora");
    await s.quote();
    s.asistente(`Total $${await s.total()}. ¿Desea agregar propina?`);
    s.cliente("No gracias");
    expect(((await s.confirm()) as unknown as Rechazo).result.confirmado).toBe(true);
    await expect(s.create()).rejects.toMatchObject({ code: "resumen_no_mostrado" });
  });

  it("la guarda de #566 sigue dejando pasar «No gracias» al resumen que pregunta si esta correcto", async () => {
    const s = setup();
    s.cliente("dos cocas para recoger, soy Nora");
    await s.quote();
    s.asistente(`Total $${await s.total()}. ¿Es correcto o desea agregar algo más?`);
    s.cliente("No gracias");
    await s.confirm();
    expect((await s.create()).orderId).not.toBeNull();
  });

  it("un cambio de pago tras confirmar NO se detecta (no es de esta maquina): se crea con lo que manda el modelo, como en main", async () => {
    const s = setup();
    s.cliente("dos cocas para recoger, soy Nora");
    await s.quote();
    s.asistente(`Total $${await s.total()}. ¿Es correcto?`);
    s.cliente("sí");
    await s.confirm();
    const r = await s.create({ efectivo_con: 200 });
    expect(r.orderId).not.toBeNull();
  });
});

describe("encendida y apagada no se contradicen con la guarda de #566", () => {
  afterEach(limpiarEntorno);

  const asistentes: Record<string, (t: number) => string> = {
    resumen: (t) => `Resumen: 2 Coca-Cola, total $${t}. ¿Es correcto o desea agregar algo más?`,
    propina: (t) => `El total es de $${t}. ¿Desea agregar propina?`,
    pago: (t) => `Total $${t}. ¿Con cuánto paga?`,
    sin_total: () => "Listo, anotado.",
  };
  const mensajes = ["sí", "Sí", "ok", "ok gracias", "No gracias", "no, así está bien", "nada", "No", "nop", "efectivo", "con 600", "con 600, sin propina", "No gracias. Pago con $1,000", "mmm", "dale 👍", "dos más"];

  async function resultado(maquina: boolean, preguntaAsistente: string, mensaje: string): Promise<boolean> {
    prepararEntorno(maquina);
    try {
      const s = setup();
      s.cliente("dos cocas para recoger, soy Nora");
      await s.quote();
      s.asistente(asistentes[preguntaAsistente]!(await s.total()));
      s.cliente(mensaje);
      try {
        await s.confirm();
        const r = await s.create();
        return r.orderId !== null && r.orderId !== undefined;
      } catch {
        return false;
      }
    } finally {
      limpiarEntorno();
    }
  }

  for (const p of Object.keys(asistentes)) {
    for (const m of mensajes) {
      it(`${p} -> «${m}»: si la maquina crea el pedido, la guarda de #566 (bandera apagada) tambien lo habria creado`, async () => {
        const encendida = await resultado(true, p, m);
        const apagada = await resultado(false, p, m);
        if (encendida) expect(apagada, `la maquina crea pero #566 no: contradiccion (${p} / ${m})`).toBe(true);
      });
    }
  }
});
