// Pruebas portadas del cerebro «suelto» (wt-suelto-voz e69279e) para cerebro-v2/pago.ts: pago-efectivo-pregunta.test.ts
// (rondas 5-7 del PR #19), fallos-pr19-ronda4.test.ts (P2-5), fallos-post-c3-r81 (R81-I), r85 (R85-7), pm-policies.test.ts
// y fallos-post-c3-flujos-comunes / r76 / r77 (transferencia_realizada), whatsapp-agent-core.test.ts (cobro duplicado),
// fallos-pr18-aviso.test.ts (el cobro doble abierto no absorbe otro reclamo) y voz-respuestas.test.ts (huellaCobro). Sin PII.
import { describe, it, expect } from "vitest";
import * as core from "../src/whatsapp/cerebro-v2/pago.ts";
import { OrderValidationError } from "../src/errors.ts";
import type { MensajeHilo } from "../src/whatsapp/cerebro-v2/texto-plano.ts";

function assert(condition: boolean, message: string) {
  expect(condition, message).toBe(true);
}

describe("pago-efectivo-pregunta (PR #19 rondas 5-7)", () => {
  const n = (extra: Record<string, unknown>, textos?: string[], entrega: "domicilio" | "recoger" = "domicilio") =>
    core.normalizarPagoEfectivo({ payment_method: "efectivo", ...extra }, entrega, textos);

  it("pago: sin monto ni «exacto» en los textos del cliente se rechaza y manda a preguntar", () => {
    for (const extra of [{ pago_exacto: true }, { paga_con: 500 }]) {
      try {
        n(extra, ["2 tacos de pastor", "a domicilio en calle diez", "efectivo"]);
      } catch (e) {
        assert(e instanceof OrderValidationError && /con cuánto paga/.test(e.message), (e as Error).message);
        continue;
      }
      throw new Error(`debio rechazar ${JSON.stringify(extra)}`);
    }
  });

  it("pago: con monto o «exacto/justo/sin cambio/cabal» del cliente se acepta; recoger y tarjeta no lo piden", () => {
    assert(n({ paga_con: 500 }, ["efectivo", "pago con 500"]).paga_con === 500, "monto");
    assert(n({ pago_exacto: true }, ["tengo el pago exacto"]).pago_exacto === true, "exacto");
    assert(n({ pago_exacto: true }, ["llevo justo"]).pago_exacto === true, "justo");
    assert(n({ pago_exacto: true }, ["sin cambio"]).pago_exacto === true, "sin cambio");
    assert(n({ pago_exacto: true }, ["cabal"]).pago_exacto === true, "cabal");
    assert(n({ paga_con: 500 }, ["efectivo"], "recoger").paga_con === 500, "recoger no se verifica");
    assert(core.normalizarPagoEfectivo({ payment_method: "tarjeta" }, "domicilio", ["hola"]).paga_con === undefined, "tarjeta");
  });

  const PREG = { role: "assistant", content: "¿Con cuánto paga? ¿O paga exacto?" };
  const u = (content: string) => ({ role: "user", content });
  const h = (...resp: string[]): MensajeHilo[] => [u("10 tacos a calle 45 en efectivo"), PREG, ...resp.map(u)];
  const nh = (extra: Record<string, unknown>, hilo: MensajeHilo[]) =>
    core.normalizarPagoEfectivo({ payment_method: "efectivo", ...extra }, "domicilio", undefined, hilo);
  const rechaza = (extra: Record<string, unknown>, hilo: MensajeHilo[]) => {
    try {
      nh(extra, hilo);
    } catch (e) {
      assert(e instanceof OrderValidationError && /con cuánto paga/.test(e.message), (e as Error).message);
      return;
    }
    throw new Error(`debio rechazar ${JSON.stringify(hilo)}`);
  };

  it("pago ronda 6: respuestas honestas se aceptan", () => {
    for (const t of [
      "cuatrocientos", "ciento cincuenta", "mil", "500", "$500", "con 200", "pago con un billete de 500", "quinientos pesos",
      "no necesito cambio", "no ocupo cambio", "no requiero cambio", "traigo completo", "con lo justito", "exacto", "cabal", "sin cambio",
    ]) {
      assert(nh({ paga_con: 500 }, h(t)).paga_con === 500, t);
    }
    assert(nh({ pago_exacto: true }, h("sí")).pago_exacto === true, "sí a ¿paga exacto?");
  });

  it("pago ronda 6: numeros del pedido o la direccion no cuentan; sin respuesta posterior se rechaza", () => {
    rechaza({ paga_con: 500 }, [u("10 tacos a calle 45 en efectivo"), PREG]);
    rechaza({ paga_con: 500 }, h("calle 45 numero 12", "son 10 tacos"));
    rechaza({ paga_con: 500 }, [u("pago con 500"), PREG, u("hola?")]);
    rechaza({ pago_exacto: true }, [u("sí"), { role: "assistant", content: "¿Es a domicilio?" }, u("sí")]);
  });

  it("pago ronda 6: valvula anti-bucle, tras un rechazo y una respuesta del cliente se acepta", () => {
    const rech = { role: "tool", content: JSON.stringify({ error: "El cliente aún no dijo con cuánto paga. Pregúntele..." }) };
    rechaza({ paga_con: 500 }, [...h("hola"), rech]);
    assert(nh({ paga_con: 500 }, [...h("hola"), rech, PREG, u("pues ahi vemos")]).paga_con === 500, "acepta tras un rechazo");
  });

  it("pago ronda 7: un rechazo anterior a un crear_pedido exitoso no abre la valvula del pedido siguiente", () => {
    const rech = { role: "tool", content: JSON.stringify({ error: "El cliente aún no dijo con cuánto paga. Pregúntele..." }) };
    const ok = { role: "tool", content: JSON.stringify({ order: { id: "ord-1" } }) };
    rechaza({ paga_con: 500 }, [...h("hola"), rech, u("mmm"), ok, u("quiero otro pedido a calle 12")]);
    assert(nh({ paga_con: 500 }, [...h("hola"), ok, u("otro"), rech, u("pues ahi vemos")]).paga_con === 500, "rechazo del pedido actual");
  });

  it("pago ronda 7: «si/no» a «¿necesita cambio?» o «no, mejor tarjeta» no son dato de efectivo", () => {
    const pc = { role: "assistant", content: "¿Necesita cambio?" };
    rechaza({ pago_exacto: true }, [u("10 tacos a calle 45 en efectivo"), pc, u("sí")]);
    rechaza({ pago_exacto: true }, h("no, mejor tarjeta"));
    assert(nh({ pago_exacto: true }, h("sí, gracias")).pago_exacto === true, "sí a ¿paga exacto?");
  });

  it("pago ronda 7: un resumen o «¿efectivo o tarjeta?» no son la pregunta de pago", () => {
    rechaza({ pago_exacto: true }, [u("10 tacos a calle 45"), { role: "assistant", content: "Pago exacto registrado en efectivo. ¿Confirmas?" }, u("sí")]);
    rechaza({ pago_exacto: true }, [u("10 tacos a calle 45"), { role: "assistant", content: "Va en efectivo o con cambio listo. ¿Confirmas?" }, u("sí")]);
    for (const q of ["¿Con cuánto paga?", "¿Paga exacto?", "¿Necesita cambio?", "¿De cuánto es su billete?"]) {
      assert(nh({ paga_con: 500 }, [u("pido 10 tacos"), { role: "assistant", content: q }, u("500")]).paga_con === 500, q);
    }
  });

  it("pago ronda 7: «no» a «¿paga exacto?» no valida pago_exacto ni paga_con; «sí» solo valida pago_exacto", () => {
    rechaza({ pago_exacto: true }, h("no"));
    rechaza({ paga_con: 500 }, h("no"));
    rechaza({ paga_con: 500 }, h("sí"));
    assert(nh({ paga_con: 500 }, h("no", "500")).paga_con === 500, "no y luego monto");
    assert(nh({ pago_exacto: true }, h("sí")).pago_exacto === true, "sí a ¿paga exacto?");
  });
});

describe("fallos-pr19-ronda4 (P2-5)", () => {
  it("P2-5: normalizarPagoEfectivo acepta «500», «$500», «1,500 pesos», «true»; invalido da error claro; efectivo a domicilio lo exige", () => {
    const n = (extra: Record<string, unknown>, entrega: "domicilio" | "recoger" = "domicilio") =>
      core.normalizarPagoEfectivo({ payment_method: "efectivo", ...extra }, entrega);
    assert(n({ paga_con: 500 }).paga_con === 500, "numero");
    assert(n({ paga_con: "500" }).paga_con === 500, "'500'");
    assert(n({ paga_con: "$500" }).paga_con === 500, "'$500'");
    assert(n({ paga_con: "1,500 pesos" }).paga_con === 1500, "'1,500 pesos'");
    assert(n({ paga_con: "$1000.50" }).paga_con === 1000.5, "decimales");
    assert(n({ pago_exacto: true }).pago_exacto === true, "true");
    assert(n({ pago_exacto: "true" }).pago_exacto === true, "'true'");
    const falla = (extra: Record<string, unknown>, patron: RegExp, entrega: "domicilio" | "recoger" = "domicilio") => {
      try { n(extra, entrega); } catch (e) {
        assert(e instanceof OrderValidationError && patron.test(e.message), `${JSON.stringify(extra)} -> ${(e as Error).message}`);
        return;
      }
      throw new Error(`no fallo: ${JSON.stringify(extra)}`);
    };
    falla({ paga_con: "mil pesos" }, /paga_con debe ser el monto/);
    falla({ paga_con: {} }, /paga_con debe ser el monto/);
    falla({ pago_exacto: "si" }, /pago_exacto debe ser true/);
    falla({}, /con cuánto paga/);
    falla({ pago_exacto: false }, /con cuánto paga/);
    assert(n({}, "recoger").paga_con === undefined, "recoger no lo exige");
    assert(core.normalizarPagoEfectivo({ payment_method: "tarjeta" }, "domicilio").paga_con === undefined, "tarjeta no lo exige");
  });
});

describe("fallos-post-c3-r81 (R81-I) y r85 (R85-7)", () => {
  it("R81-I: el efectivo en inglés cuenta como pago dicho y la pregunta en inglés abre la ventana", () => {
    const PREG = "Your total is $450. How will you pay, cash or card? If cash, how much will you pay with?";
    const pasa = (frase: string, pago: Record<string, unknown>, pregunta = PREG) => {
      const hilo = [{ role: "user", content: "10 pastor tacos to calle 20 100 itzimna" }, { role: "assistant", content: pregunta }, { role: "user", content: frase }];
      try {
        core.normalizarPagoEfectivo({ payment_method: "efectivo", ...pago }, "domicilio", undefined, hilo);
        return true;
      } catch {
        return false;
      }
    };
    for (const [frase, pago] of [
      ["I'll pay cash with a 500 bill", { paga_con: 500 }], ["cash, exact change", { pago_exacto: true }],
      ["I have 1000 in cash", { paga_con: 1000 }], ["paying with 200", { paga_con: 200 }], ["exact amount, cash", { pago_exacto: true }],
      ["no change needed", { pago_exacto: true }], ["efectivo, pago con un billete de 500", { paga_con: 500 }],
    ] as Array<[string, Record<string, unknown>]>) {
      assert(pasa(frase, pago), `«${frase}» no contó`);
    }
    assert(pasa("yes", { pago_exacto: true }, "Will you pay the exact amount?"), "«yes» a «exact amount?»");
    const hilo = [
      { role: "user", content: "I'll pay with 500" }, { role: "assistant", content: "Sorry, how much will you pay with?" }, { role: "user", content: "cash" },
    ];
    let lanzo = false;
    try {
      core.normalizarPagoEfectivo({ payment_method: "efectivo", paga_con: 500 }, "domicilio", undefined, hilo);
    } catch {
      lanzo = true;
    }
    assert(lanzo, "la pregunta en inglés no abrió la ventana del pago");
    for (const frase of ["I want 500 tacos", "cash"]) assert(!pasa(frase, { paga_con: 500 }), `control «${frase}» contó`);
  });

  it("R85-7: paga_con en otro formato con el monto ya dicho por el cliente: se toma su monto, no se le pregunta otra vez", () => {
    assert(core.montoDichoPorElCliente(["Hi! 5 tacos de pastor delivered to calle 60 #512 por 45 y 47 centro, cash 500"]) === 500, "cash 500");
    let error = "";
    try {
      core.normalizarPagoEfectivo({ payment_method: "efectivo", paga_con: 500 }, "domicilio", ["Hi! 12 tacos de pastor delivered to calle 60 #512 centro, cash 500"]);
    } catch (e) {
      error = String(e);
    }
    assert(error === "", `cash 500: ${error}`);
    // La parte del turno completo, reducida: «billete de 500» del modelo con el monto del cliente se toma de lo que escribió.
    assert(core.normalizarPagoEfectivo({ payment_method: "efectivo", paga_con: "billete de 500" }, "domicilio", ["12 tacos de pastor a domicilio calle 60 512 centro, pago con un billete de 500"]).paga_con === 500, "formato");
    let sin = "";
    try {
      core.normalizarPagoEfectivo({ payment_method: "efectivo", paga_con: "un billete" }, "domicilio", ["pago en efectivo"]);
    } catch (e) {
      sin = String(e);
    }
    assert(/Pregúntele con cuánto paga/.test(sin), `sin monto: ${sin}`);
  });
});

describe("transferencia_realizada (pm-policies.test.ts, flujos-comunes R75, r76 R76-7, r77 R77-3)", () => {
  it("transferencia: solo escala cuando el cliente dice que YA transfirió o manda comprobante", () => {
    for (const texto of [
      "ya transferí", "Ya te transferí los $350", "acabo de transferir", "ya deposité en la cuenta", "ya hice la transferencia",
      "te hice el depósito hace rato", "ya pagué por transferencia", "te mando el comprobante", "ya envié mi comprobante",
      "aquí está el comprobante", "te paso captura del pago", "Adjunto comprobante",
    ]) assert(core.esTransferenciaRealizada(texto), `debía escalar por transferencia realizada: «${texto}»`);
  });
  it("transferencia: preguntar o proponer transferir NO escala (el agente ofrece efectivo o tarjeta)", () => {
    for (const texto of [
      "¿puedo pagar por transferencia?", "prefiero transferencia", "si te transfiero después, ¿lo mandas?", "¿aceptan depósito?",
      "no tengo efectivo, ¿se puede transferir?", "¿necesito mandar comprobante?", "Quiero 3 tacos de pastor, pago en efectivo",
    ]) assert(!core.esTransferenciaRealizada(texto), `no debía escalar por transferencia: «${texto}»`);
  });
  it("Flujos comunes R75: «ya les mandé el pago por transferencia», «ya pagué por la app» avisan el pago a revisar", () => {
    for (const u of ["ya les mandé el pago por transferencia", "ya pagué por la app", "mandé el dinero a la cuenta"]) assert(core.esTransferenciaRealizada(u), u);
    for (const u of ["¿puedo pagar por transferencia?", "¿les mando el pago por transferencia?", "¿ya les mandé el pago o falta?", "¿mandé el dinero a la cuenta correcta?"]) {
      assert(!core.esTransferenciaRealizada(u), `«${u}»: transferencia`);
    }
  });
  it("R76-7: «ya le pasé el dinero al repartidor», «ya hice el pago con tarjeta», «el pago de la luz» no son transferencia", () => {
    for (const u of [
      "ya le pasé el dinero al repartidor", "ya hice el pago con tarjeta", "ya pagué con la app de uber eats", "ya hice el pago en la terminal",
      "ya mandé el pago de la luz", "ya pagué por la app de rappi", "ya le di el pago en efectivo al chofer",
    ]) assert(!core.esTransferenciaRealizada(u), `«${u}»: transferencia`);
    for (const u of ["ya les mandé el pago por transferencia", "ya pagué por la app", "mandé el dinero a la cuenta", "ya hice la transferencia", "ya pagué por spei"]) {
      assert(core.esTransferenciaRealizada(u), `control «${u}»`);
    }
  });
  it("R77-3: «ya mandé el pago, para que el repartidor no me cobre» avisa la transferencia", () => {
    for (const u of [
      "ya mandé el pago por transferencia, no traigo efectivo", "ya mandé el pago, para que el repartidor no me cobre",
      "ya hice el pago, avísenle al repartidor", "ya pagué por la app del banco, díganle al repartidor", "ya mandé el pago, aquí el recibo",
      "ya les mandé el pago a la tarjeta que me pasaron", "ya les mandé el dinero a la cuenta, pero el repartidor no ha llegado",
    ]) assert(core.esTransferenciaRealizada(u), u);
    for (const u of [
      "ya le pasé el dinero al repartidor", "ya hice el pago con tarjeta", "ya pagué con la app de uber eats", "ya hice el pago en la terminal",
      "ya mandé el pago de la luz", "ya pagué por la app de rappi", "ya le di el pago en efectivo al chofer", "ya hice el pago en efectivo",
      "ya le pasé el pago al repartidor en efectivo", "ya hice el pago por uber",
    ]) assert(!core.esTransferenciaRealizada(u), `control «${u}»: transferencia`);
  });
  it("R87-R: «pago», «pago_realizado», «confirmar pago» del modelo son la categoría transferencia_realizada", () => {
    for (const r of ["pago", "pago_realizado", "confirmar pago", "pago hecho", "alto_riesgo:transferencia_realizada", "comprobante"]) {
      assert(core.categoriaDeRazon(r) === "transferencia_realizada", r);
    }
    assert(core.categoriaDeRazon("cobro duplicado") === "cobro_duplicado", "cobro");
  });
});

describe("cobro doble", () => {
  it("classifyHighRiskIntent detects a duplicate charge complaint (whatsapp-agent-core.test.ts)", () => {
    assert(core.esCobroDuplicado("oigan me cobraron dos veces el mismo pedido"), "dos veces");
    assert(core.esCobroDuplicado("me cobraron dos veces") && core.esCobroDuplicado("cobro duplicado"), "básicos");
    assert(!core.esCobroDuplicado("¿cuánto me cobran por el envío?"), "pregunta");
  });
  it("fallos-pr18-aviso P1-C: un cobro duplicado abierto no absorbe el faltante; sí los avisos del mismo cobro", () => {
    const reclamo = "reclamo de pedido: faltante, producto equivocado o demora";
    assert(!core.cobroDuplicadoAbiertoCubre("alto_riesgo:cobro_duplicado", reclamo, "me llegó incompleto, faltó la coca"), "faltante absorbido");
    assert(core.cobroDuplicadoAbiertoCubre("alto_riesgo:cobro_duplicado", "reclamo de cobro", "me cobraron dos veces, revisen porfa"), "mismo cobro");
    assert(core.cobroDuplicadoAbiertoCubre("alto_riesgo:cobro_duplicado", "cobro_duplicado", `${core.MARCA_AVISO_URGENTE} yo no hice otro pedido, me cobraron doble`), "marca urgente");
    assert(!core.cobroDuplicadoAbiertoCubre("alto_riesgo:cobro_duplicado", "reclamo de cobro", "me cobraron dos veces y el repartidor fue grosero"), "otro asunto");
    assert(!core.cobroDuplicadoAbiertoCubre("alto_riesgo:cancelacion", "reclamo de cobro", "me cobraron dos veces"), "otra fila");
  });
  it("huellaCobro (voz-respuestas V13/V16): el mismo cobro es ESE pedido; otros productos no", () => {
    const A = { branch_slug: "garcia-lavin", items: [{ product_id: "g1", product_name: "Gringa de Pastor", requested_quantity: 2 }], entrega: "recoger" };
    const B = { branch_slug: "garcia-lavin", items: [{ product_id: "s1", product_name: "Suizo de Pastor", requested_quantity: 1 }], entrega: "recoger" };
    assert(core.huellaCobro(A) === core.huellaCobro({ ...A, notes: "sin cebolla", customer_name: "Ana", entrega: "domicilio" }), "notas, nombre y entrega no cuentan");
    assert(core.huellaCobro(A) !== core.huellaCobro(B) && core.huellaCobro(A) !== core.huellaCobro({ ...A, items: [{ ...A.items[0], requested_quantity: 1 }] }), "otros renglones");
    assert(core.pedidoConElMismoCobro([{ id: "ORD-1", args: A }], A) === "ORD-1" && core.pedidoConElMismoCobro([{ id: "ORD-1", args: A }], B) === null, "dedupe al crear");
    assert(core.huellaCobroPedido(A) === core.huellaCobroPedido({ ...A, payment_method: "tarjeta" }), "huellaCobroPedido sin pago");
  });
});
