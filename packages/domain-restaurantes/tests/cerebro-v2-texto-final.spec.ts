// Pruebas portadas del cerebro «suelto» (wt-suelto-voz e69279e) para cerebro-v2/texto-final.ts: las aserciones puras de
// fallos-c3-1939849.test.ts (ROB-10), fallos-post-c3-r82..r89.test.ts (texto veraz, rechazo para el cliente, oraciones
// secundarias, pedido por aprobar). Los rechazos que la fuente generaba con pm-policies (validarRecoger,
// validarDomicilioProgramado) van aquí con el texto literal que esas funciones devuelven. Sin PII.
import { describe, it, expect } from "vitest";
import * as core from "../src/whatsapp/cerebro-v2/texto-final.ts";
import { PREGUNTA_PEDIDO_APARTE } from "../src/whatsapp/cerebro-v2/pedido-aparte.ts";
import type { MensajeHilo } from "../src/whatsapp/cerebro-v2/texto-plano.ts";

function assert(condition: boolean, message: string) {
  expect(condition, message).toBe(true);
}
const hilo = (cliente: string, extra: MensajeHilo[] = []): MensajeHilo[] => [...extra, { role: "user", content: cliente }];

describe("fallos-c3-1939849 (C3-ROB-10, fc5797c + e69279e)", () => {
  it("C3-ROB-10: detecta la promesa de un producto que el cliente nombro y ninguna herramienta devolvio", () => {
    const p = core.promesaDeProductoSinBuscar("Buenas tardes, somos Los Taquitos de PM. Con gusto le preparo sus tacos de camarón. ¿Me indica su nombre, por favor?", hilo("Hola, quiero unos tacos de camarón"));
    assert(p?.producto === "tacos de camarón" && p.oracion === "Con gusto le preparo sus tacos de camarón.", JSON.stringify(p));
    const conBusqueda: MensajeHilo[] = [{ role: "assistant", content: null, tool_calls: [{ id: "t1", function: { name: "buscar_producto", arguments: "{}" } }] }, { role: "tool", tool_call_id: "t1", content: JSON.stringify([{ name: "Tacos de Poc-Chuc (orden de 3)", price: 189 }]) }];
    assert(core.promesaDeProductoSinBuscar("Con gusto le preparo sus tacos de poc-chuc.", hilo("quiero tacos de poc-chuc", conBusqueda)) === null, "lo encontrado si se promete");
    for (const t of ["Con gusto le preparo su pedido. ¿A nombre de quién?", "Le anoto su nombre, Hilda.", "Con gusto le ayudo. ¿Me indica su nombre?"]) {
      assert(core.promesaDeProductoSinBuscar(t, hilo("Hola, quiero unos tacos de camarón")) === null, t);
    }
  });
  it("C3-ROB-10: lo prometido que no esta en el menu se dice («no tenemos»), sin mencionar otra sucursal (menú consultado por quien llama)", () => {
    const t = core.corregirPromesaSinBuscar("Buenas tardes, somos Los Taquitos de PM. Con gusto le preparo sus tacos de camarón. ¿Me indica su nombre, por favor?", hilo("Hola, quiero unos tacos de camarón"), false);
    assert(t !== null && /no tenemos tacos de camarón en el menú/i.test(t) && !/le preparo sus tacos de camar/i.test(t) && !/sucursal/i.test(t) && /¿Me indica su nombre, por favor\?$/.test(t), String(t));
    assert(core.consultasDeMenuParaPromesa("tacos de camarón").join("|") === "tacos de camarón|camarón", "consultas al menú");
  });
  it("C3-ROB-10 (e69279e): lo prometido que SI esta en el menu (o si el menu no se puede leer) no se toca", () => {
    assert(core.corregirPromesaSinBuscar("Con gusto le preparo sus tacos de poc-chuc. ¿Me indica su nombre?", hilo("quiero unos tacos de poc-chuc"), true) === null, "en el menú");
    assert(core.corregirPromesaSinBuscar("Con gusto le preparo sus tacos de camarón.", hilo("quiero tacos de camarón"), null) === null, "lectura fallida");
  });
  it("C3-ROB-10 (turno real, reducido a la guardia): la promesa sin buscar sale corregida a «no tenemos»", () => {
    const r = core.guardiaTextoFinal("Buenas tardes, somos Los Taquitos de PM. Con gusto le preparo sus tacos de camarón. ¿Me indica su nombre, por favor?", {
      pedidoCreadoEnTurno: false, pedidoPorAprobar: false, productosDevueltosPorHerramientas: [], mensajes: hilo("Hola, quiero unos tacos de camarón"), productoPrometidoEnMenu: false,
    });
    assert(/no tenemos tacos de camarón en el menú/i.test(r.texto) && !/le preparo sus tacos de camar/i.test(r.texto) && r.reemplazado && r.motivo === "promesa_producto_sin_buscar", JSON.stringify(r));
  });
});

describe("fallos-post-c3-r82 / r83 / r84: el motivo del rechazo para el cliente", () => {
  it("R82-2: un rechazo sin razón reconocida: genérico veraz con pregunta; la pregunta exacta del rechazo se respeta", () => {
    const generico = core.motivoDelRechazoParaCliente("Productos o cantidades inválidos", undefined, false);
    assert(/todav[ií]a no pude registrar su pedido/.test(generico) && /\?$/.test(generico), generico);
    const aparte = core.motivoDelRechazoParaCliente("… Pregúntele exactamente: «¿Es un pedido aparte para otra dirección?». Únicamente si…", undefined, false);
    assert(aparte.endsWith("¿Es un pedido aparte para otra dirección?"), aparte);
  });
  it("R83-6: la hora programada que no se puede dice la más temprana y pregunta", () => {
    const hora = core.motivoDelRechazoParaCliente(
      "Esa hora no es posible para hoy: debe estar dentro del horario de la sucursal y con al menos 35 minutos de preparación y reparto (si está cerrada, contados desde que abre). Lo más temprano es 10:36 pm. Ofrézcale esa hora u otra posterior dentro del horario.",
      undefined,
      false,
    );
    assert(/10:36 pm/.test(hora) && /\?$/.test(hora), hora);
  });
  it("R84-5: el horario en inglés usa «to» y la hora de recoger que ya pasó dice la más temprana", () => {
    const cerrada = "La sucursal está cerrada en este momento (horario de hoy: 8:00 am a 11:00 pm). No crees el pedido; dígaselo al cliente.";
    const tarde = core.motivoDelRechazoParaCliente(cerrada, undefined, true, { abreMasTardeHoy: true });
    const hoyNo = core.motivoDelRechazoParaCliente(cerrada, undefined, true, { abreMasTardeHoy: false });
    assert(/8:00 am to 11:00 pm/.test(tarde) && /8:00 am to 11:00 pm/.test(hoyNo) && !/ am a /.test(tarde + hoyNo), `${tarde} / ${hoyNo}`);
    const es = core.motivoDelRechazoParaCliente(cerrada, undefined, false, { abreMasTardeHoy: true });
    assert(/8:00 am a 11:00 pm/.test(es), es);
    const fuera = core.motivoDelRechazoParaCliente("La sucursal no está abierta a esa hora (horario de ese día: 8:00 am a 11:00 pm). Ofrécele al cliente una hora dentro del horario.", undefined, true);
    assert(/8:00 am to 11:00 pm/.test(fuera), fuera);
    const paso = core.motivoDelRechazoParaCliente("Esa hora ya pasó o queda muy lejos (solo se programa dentro de las próximas 12 horas). Lo más temprano es 9:25 pm.", undefined, false);
    assert(/lo más temprano es 9:25 pm/.test(paso) && /\?$/.test(paso), paso);
  });
});

describe("fallos-post-c3-r85", () => {
  it("R85-6: si la espera mínima llega al cierre, recoger dice a qué hora cierra y que hoy ya no se puede", () => {
    const error = "Ya no es posible recoger hoy: la sucursal cierra a las 12:00 am."; // validarRecoger (pm-policies), literal de la fuente
    const cliente = core.motivoDelRechazoParaCliente(error, undefined, false);
    assert(/ya no es posible recoger hoy: la sucursal cierra a las 12:00 am/.test(cliente) && !/más temprano/.test(cliente), cliente);
    const en = core.motivoDelRechazoParaCliente(error, undefined, true);
    assert(/pickup is no longer possible today; the branch closes at 12:00 am/.test(en), en);
  });
  it("R85-7: abierta pero sin tiempo para programar: dice a qué hora cierra y ofrece para ahora; la hora fuera dice la más tarde", () => {
    const r = "Ya no alcanza para programar un pedido para más tarde hoy: la sucursal cierra a las 12:00 am. Si el cliente lo quiere para ahora, tómelo como pedido normal (sin hora_programada).";
    const cliente = core.motivoDelRechazoParaCliente(r, undefined, false);
    assert(/ya no alcanza para programarlo más tarde hoy: la sucursal cierra a las 12:00 am/.test(cliente) && /¿Se lo mandamos para ahora\?$/.test(cliente) && !/ya no se puede programar un pedido para hoy/.test(cliente), cliente);
    const fuera = "Esa hora no es posible para hoy: debe estar dentro del horario de la sucursal y con al menos 40 minutos de preparación y reparto (si está cerrada, contados desde que abre). Lo más temprano es 7:40 pm y para hoy lo más tarde es 12:55 am. Ofrézcale una hora en ese rango.";
    const c2 = core.motivoDelRechazoParaCliente(fuera, undefined, false);
    assert(/lo más temprano es 7:40 pm y para hoy lo más tarde es 12:55 am/.test(c2), c2);
  });
  it("R85-7: la pregunta normal del pago no empieza con «Perdón, su pedido todavía no quedó registrado»", () => {
    const es = core.motivoDelRechazoParaCliente("El cliente aún no dijo con cuánto paga. Pregúntele «¿con cuánto paga?» y espere su respuesta.", undefined, false);
    assert(es === "Para registrar su pedido, me falta saber con cuánto va a pagar. ¿Con cuánto paga?", es);
    const en = core.motivoDelRechazoParaCliente("El cliente aún no dijo con cuánto paga. Pregúntele «¿con cuánto paga?».", undefined, true);
    assert(en === "To place your order, I still need to know how much cash you'll pay with. How much will you pay with?", en);
    const min = core.motivoDelRechazoParaCliente("El pedido mínimo a domicilio es de $200 y este suma $100.00.", "minimo_domicilio", false);
    assert(/^Perdón, su pedido todavía no quedó registrado: el pedido mínimo/.test(min), min);
  });
  it("R85-1: mencionaMonto", () => {
    assert(core.mencionaMonto("Son $1,240.00", 1240) && !core.mencionaMonto("Son $2400", 240), "mencionaMonto");
  });
  it("R85-2: sin pregunta del cliente no se agrega nada; lo que habla del pedido nunca pasa", () => {
    assert(core.oracionesSecundarias("Claro, con gusto se lo preparamos hoy mismo.", ["5 tacos de pastor a domicilio"]).length === 0, "sin pregunta");
    assert(core.oracionesSecundarias("Su pedido quedó listo. Llega en 40 minutos.", ["¿cuánto tarda?"]).length === 0, "filtro (R88-5)");
  });
  it("R85-2: fuera de zona ofrece otra sucursal; «no se puede comprobar» dice la sucursal más cercana", () => {
    const fuera = core.motivoDelRechazoParaCliente(
      "Fuera de zona: a domicilio solo se entrega a 8 km o menos de la sucursal y esa dirección queda más lejos. NO prometa envío.",
      "fuera_de_zona",
      false,
    );
    assert(/otra sucursal/.test(fuera) && /recoger/.test(fuera), fuera);
    const comprobar = core.motivoDelRechazoParaCliente(
      "No se puede comprobar que esa dirección quede dentro de 8 km de la sucursal elegida (la más cercana a su colonia es «francisco-de-montejo»). Ofrezca esa sucursal, o que recoja, y no prometa envío desde la otra.",
      undefined,
      false,
    );
    assert(/sucursal Francisco De Montejo, la más cercana a su colonia/.test(comprobar), comprobar);
  });
  it("R85-7: si el modelo afirmó que el pedido quedó, la pregunta del pago sí lleva la disculpa", () => {
    const fallido = { interno: false, error: "El cliente aún no dijo con cuánto paga. Pregúntele «¿con cuánto paga?».", clase: "nada" as const };
    const afirma = core.textoVerazSobreElPedido("¡Listo! Su pedido quedó registrado.", null, fallido);
    assert(afirma.texto === "Perdón, su pedido todavía no quedó registrado: me falta saber con cuánto va a pagar. ¿Con cuánto paga?", String(afirma.texto));
    const neutro = core.textoVerazSobreElPedido("¿Con cuánto paga?", null, fallido);
    assert(neutro.texto === "Para registrar su pedido, me falta saber con cuánto va a pagar. ¿Con cuánto paga?", String(neutro.texto));
  });
});

describe("fallos-post-c3-r88 / r89: el pedido por aprobar y las oraciones secundarias", () => {
  it("R88-4: «su otro pedido» solo se excluye si en el turno se creó otro; lo que afirma ESE pedido sí se reemplaza", () => {
    assert(!core.afirmaPedidoPorAprobarEnMarcha("Su otro pedido ya está en cocina y llega en 20 min.", { otroPedidoCreado: true }), "otro pedido");
    for (const t of ["Listo, su pedido quedó confirmado y ya está en cocina. Llega en 35 a 50 min.", "Sí, su pedido está confirmado.", "Ya avisé a la sucursal. Su pedido llega en 35 a 50 min."]) {
      assert(core.afirmaPedidoPorAprobarEnMarcha(t), `no afirma: ${t}`);
    }
  });
  it("R88-5: tras un rechazo, las oraciones del modelo sobre cuándo llega, la cocina o el repartidor no se agregan", () => {
    const cliente = ["10 tacos pastor maiz a domicilio calle 60 512 centro, tarjeta, soy Ana. cuanto tarda?"];
    for (const t of ["Llega en 35 a 50 min.", "Normalmente tardamos de 35 a 50 minutos en llegar.", "Ya lo estamos preparando en cocina.", "Su comida sale en un momento.", "El repartidor sale en breve.", "Ya salió de la sucursal.", "Va en camino ahorita mismo."]) {
      assert(core.oracionesSecundarias(t, cliente).length === 0, `pasa: ${t}`);
    }
    assert(core.oracionesSecundarias("Sí tenemos estacionamiento gratis. Llega en 35 a 50 min.", ["¿tienen estacionamiento?"]).join("|") === "Sí tenemos estacionamiento gratis.", "otra respuesta sí pasa");
  });
  it("R89-2: con un pedido por aprobar, la cláusula que lo afirma se reemplaza aunque otra pregunte o acuse un cambio", () => {
    for (const t of [
      "Su pedido quedó confirmado y llega en 40 minutos. ¿Me confirma si necesita factura?", "Ya le avisé a la sucursal; su pedido llega en 40 minutos.",
      "Sí, su pedido ya está en cocina. ¿Le confirmo algo más?", "Ya avisé a la sucursal; su pedido ya va en camino.",
      "Ya avisé a la sucursal y su pedido llega en 40 min.", "Su otro pedido ya está en cocina y llega en 20 min.",
    ]) assert(core.afirmaPedidoPorAprobarEnMarcha(t), `no afirma: ${t}`);
    for (const t of [
      "Son $60 para recoger. Lo tiene listo en 15 a 20 min. ¿Le confirmo?", "Su pedido aún no está confirmado; la sucursal lo revisa.",
      "Listo, ya avisé a la sucursal para agregar 2 Coca-Cola; quedará confirmado cuando la sucursal apruebe su pedido.",
    ]) assert(!core.afirmaPedidoPorAprobarEnMarcha(t), `afirma: ${t}`);
    // La parte del turno completo (M5), reducida a la guardia: el acuse se conserva delante del texto de por aprobar.
    const r = core.guardiaTextoFinal("Ya avisé a la sucursal; su pedido ya va en camino.", { pedidoCreadoEnTurno: false, pedidoPorAprobar: true, productosDevueltosPorHerramientas: [], pedidoPrevioRegistrado: true });
    assert(r.texto === `Ya avisé a la sucursal. ${core.PEDIDO_POR_APROBAR_REPLY}` && r.motivo === "pedido_por_aprobar_afirmado_en_marcha", JSON.stringify(r));
  });
});

describe("guardiaTextoFinal (composición)", () => {
  const base = { pedidoCreadoEnTurno: false, pedidoPorAprobar: false, productosDevueltosPorHerramientas: [] as string[] };
  it("sin pedido creado ni rechazo, «ya quedó registrado» se quita (salvo un pedido previo del número)", () => {
    const r = core.guardiaTextoFinal("¡Listo! Su pedido quedó registrado.", base);
    assert(r.reemplazado && !/registrado\./.test(r.texto.replace("Todavía no queda registrado", "")) && r.motivo === "afirma_pedido_registrado_sin_pedido", JSON.stringify(r));
    const previo = core.guardiaTextoFinal("¡Listo! Su pedido quedó registrado.", { ...base, pedidoPrevioRegistrado: true });
    assert(!previo.reemplazado, JSON.stringify(previo));
  });
  it("R81-G / R84-1: con crear_pedido rechazado el texto lo arma el servidor (aparte: la pregunta exacta; interno: alerta)", () => {
    const aparte = core.guardiaTextoFinal("¡Listo, quedó!", { ...base, crearFallido: { interno: false, clase: "aparte", pregunta: PREGUNTA_PEDIDO_APARTE } });
    assert(aparte.texto === PREGUNTA_PEDIDO_APARTE && aparte.motivo === "armada_por_el_servidor_tras_rechazo", JSON.stringify(aparte));
    const interno = core.guardiaTextoFinal("Listo.", { ...base, crearFallido: { interno: true, clase: "interno" } });
    assert(interno.texto === core.PEDIDO_NO_REGISTRADO_INTERNO && interno.alertar, JSON.stringify(interno));
  });
  it("R82-4: con pedido creado, «su pedido no se pudo registrar» se cambia por la confirmación; «no pude registrar la factura» no", () => {
    const ctx = { ...base, pedidoCreadoEnTurno: true, orderId: "ORD-1", tiempoEstimado: "35 a 50 min" };
    const r = core.guardiaTextoFinal("Perdón, su pedido no se pudo registrar.", ctx);
    assert(r.texto === "¡Listo! Su pedido ya quedó registrado y se mandó a cocina. Tiempo estimado: 35 a 50 min.", r.texto);
    assert(!core.guardiaTextoFinal("Su pedido quedó. No pude registrar la factura.", ctx).reemplazado, "factura");
  });
});
