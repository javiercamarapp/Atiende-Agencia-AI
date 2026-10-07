// PM-C5 -- lo aprendido de 104 chats reales de T7 queda escrito en el prompt del agente (WhatsApp) y, donde cabe, en la version compacta de
// voz. El prompt es la primera linea de defensa (las herramientas aplican las reglas duras), asi que aqui se fija cada recomendacion y se ata
// cada familia de escenarios de `escenarios-t7.json` con la regla del prompt que la cubre.
import { AGENT_TOOL_DEFINITIONS } from "../src/agent-tools/registry.ts";
import { describe, expect, it } from "vitest";
import { cargarEscenariosT7 } from "../src/evals/agente-pm/escenarios-t7.ts";
import { PM_CONFIG_POR_OMISION } from "../src/whatsapp/llm-turn-handler.ts";
import { PM_PEDIDO_GRANDE_POR_OMISION, PM_SALSAS_A_PETICION, PM_SALSAS_BASICAS, buildPmSystemPrompt } from "../src/whatsapp/perfil-pm.ts";
import { comportamientoVozPm } from "../src/voz/perfil-voz-pm.ts";
import type { BranchSummary, CustomerLookupResult } from "../src/types.ts";

const SUCURSALES: BranchSummary[] = [
  { propertyId: "p7", slug: "garcia-lavin", name: "García Lavín (Victory Platz)", address: null },
  { propertyId: "p8", slug: "altabrisa", name: "Victory Altabrisa", address: null },
];
const NUEVO: CustomerLookupResult = { isNew: true };

function prompt(over: Partial<Parameters<typeof buildPmSystemPrompt>[0]> = {}): string {
  return buildPmSystemPrompt({
    businessName: "Los Taquitos de PM",
    agentName: "el asistente virtual",
    deliveryTimeText: PM_CONFIG_POR_OMISION.deliveryTimeText,
    saludo: "Buenas noches",
    branches: SUCURSALES,
    entryBranch: { name: "García Lavín (Victory Platz)", slug: "garcia-lavin" },
    customer: NUEVO,
    fechaHoraLocal: "13 de octubre de 2026, 20:10",
    diaSemana: "martes",
    ...over,
  });
}
const p = prompt();

describe("1. aclarar lo ambiguo antes de cotizar", () => {
  it("frijol: con tostadas o charros", () => {
    expect(p).toMatch(/"frijol", "frijolito" o "frijol botanero": ¿frijol con tostadas o frijoles charros\?/);
  });
  it('"todas las salsas": las basicas van siempre y se ofrecen las de peticion', () => {
    expect(p).toContain(`las básicas van siempre (${PM_SALSAS_BASICAS})`);
    expect(p).toContain(`¿le agrego ${PM_SALSAS_A_PETICION}?`);
    expect(PM_SALSAS_BASICAS).toBe("roja, verde, cebolla con cilantro y limones");
  });
  it("totopos y media orden contra medio kilo", () => {
    expect(p).toMatch(/"totopos" o "bolsitas de tostadas": ¿solo una orden de tostadas o frijol con tostadas\?/);
    expect(p).toMatch(/"media orden": ¿media orden del platillo \(solo hay de nachos y frijoles charros\) o medio kilo de carne\?/);
  });
  it("antes del total repite el pedido en lista con salsas y forma de pago, y pregunta '¿Algo más?' una vez", () => {
    expect(p).toMatch(/pregunte "¿Algo más\?" una sola vez/);
    // Regresion del eval real: un mensaje aparte con "¿Algo más?" alargaba la conversacion; va dentro del resumen.
    expect(p).toMatch(/DENTRO del mismo mensaje del resumen, nunca en un mensaje aparte/);
    expect(p).toMatch(/termine el resumen con "¿Es correcto o desea agregar algo más\?"/);
    expect(p).toMatch(/en LISTA \(un renglón por producto\)/);
    expect(p).toMatch(/salsas \(las básicas más las que pidió\)/);
    expect(p).toMatch(/forma de pago \(efectivo, o tarjeta con "llevar terminal"; solo diga con cuánto paga si el cliente ya lo dijo\)/);
  });
  it("con salsas personalizadas por el dueño no se mezclan con las del perfil", () => {
    const personalizado = prompt({ salsasTexto: "roja, verde y de la casa" });
    expect(personalizado).toContain("confirme cuáles incluye el negocio (roja, verde y de la casa)");
    expect(personalizado).not.toContain("crema de ajo, guacamolera");
  });
});

describe("3. tiempos configurables por sucursal en lugar del 40 a 50 fijo", () => {
  it("el texto de la sucursal (normal y pico, domicilio y recoger) es lo unico que dice el prompt sobre tiempos", () => {
    const sucursal = prompt({ deliveryTimeText: "a domicilio de 70 a 85 min (pico: 90 a 100); para recoger de 20 a 30 min (pico: 40 a 50)" });
    expect(sucursal).toContain("TIEMPOS DE ESTA SUCURSAL (domicilio y recoger, normales y en hora pico; los fija la sucursal): a domicilio de 70 a 85 min (pico: 90 a 100)");
    expect(sucursal).not.toMatch(/40 a 50 minutos/);
    expect(sucursal).not.toMatch(/de 40 a 50/);
  });
  it("por omision son los conservadores del analisis de T7 y se dan los dos si preguntan antes de pedir", () => {
    expect(PM_CONFIG_POR_OMISION.deliveryTimeText).toBe("a domicilio de 60 a 75 min (pico: 75 a 90); para recoger de 25 a 35 min (pico: 45 a 60)");
    expect(p).toMatch(/si el cliente pregunta antes de pedir, dele los dos \(domicilio y recoger\) y deje que elija/);
  });
  it("el horario de entrega de H16 usa el tiempo de la sucursal, no uno fijo", () => {
    expect(p).toMatch(/a domicilio tome el pedido solo si la entrega \(con el tiempo de la sucursal, ver paso 8\) cae antes de esa hora/);
  });
});

describe("4. cliente recurrente", () => {
  it("saluda sin la bienvenida larga y ofrece 'como la vez pasada' sin leer la direccion", () => {
    expect(p).toMatch(/CLIENTE RECURRENTE \(ya ha pedido por este número\): salúdelo SIN la bienvenida larga/);
    expect(p).toMatch(/¿Le mando a \[colonia o privada\] como la vez pasada\?/);
    expect(p).toMatch(/nunca lea la dirección completa/);
    expect(p).toMatch(/¿Le mando lo mismo que la vez pasada: \[resumen del último pedido\]\?/);
  });
  it("si pega su mensaje guardado se cotiza directo, sin saludo largo", () => {
    expect(p).toMatch(/Si el cliente PEGA su mensaje guardado .* cotice directo: sin saludo largo, sin bienvenida y sin repetir preguntas ya contestadas/);
  });
});

describe("5. pin a reparto: ayuda opcional, nunca requisito", () => {
  it("la direccion escrita (calle, numero y colonia) basta; el pin se ofrece una sola vez antes de confirmar y se guarda solo en el pedido", () => {
    expect(p).toMatch(/DIRECCIÓN ESCRITA: con calle, número y colonia basta/);
    expect(p).toMatch(/PIN A REPARTO \(ayuda opcional, no requisito\): ofrézcalo UNA SOLA VEZ y ANTES de confirmar el pedido/);
    expect(p).toMatch(/NUNCA condicione el pedido al pin/);
    expect(p).toMatch(/el pin o el link se guardan solos en el pedido y le llegan al repartidor: no los repita ni los anote en notes/);
    expect(p).toMatch(/van en indicaciones_acceso de crear_pedido/);
    expect(p).toMatch(/"timbre del depto 6", "avisar al llegar" o "tocar en \[depto\]"/);
  });
  it("regresion del eval real (12/68): ya no exige pin, casa o depto, referencia ni con cuanto paga para cerrar", () => {
    expect(p).not.toMatch(/pida el pin .* UNA SOLA VEZ y ANTES de confirmar el pedido, junto con privada o edificio/);
    expect(p).not.toMatch(/casa o depto y una referencia visible/);
    expect(p).toMatch(/OBJETIVO: cerrar el pedido\. Lo INDISPENSABLE es:/);
    expect(p).toMatch(/NO condicione el pedido a nada más: no exija pin de ubicación, casa o depto, referencias, con cuánto paga ni propina en efectivo/);
  });
});

describe("6. saludo y despedida cortos de usted", () => {
  it("saludo de la plantilla del analisis con el nombre de la sucursal", () => {
    expect(p).toContain('"Buenas noches. Gracias por escribir a Los Taquitos de PM, sucursal García Lavín (Victory Platz), le atiende el asistente virtual. ¿Es para recoger o a domicilio?"');
    expect(p).toMatch(/abra siempre su primer mensaje con una frase breve de usted/);
    expect(p).toMatch(/NO mande la bienvenida larga ni la presentación completa: tras esa frase vaya directo a lo que falta/);
  });
  it("despedida distinta para domicilio y para recoger; la de domicilio nunca en un pedido para recoger", () => {
    expect(p).toContain("¡Gracias por elegirnos! Su pedido llega en aproximadamente [X] minutos. En Los Taquitos de PM servimos el mejor pastor 🌮");
    expect(p).toContain("Lo esperamos en [sucursal] en [X] minutos.");
    expect(p).toMatch(/Nunca use la despedida de domicilio en un pedido para recoger/);
  });
  it("de usted: ninguna instruccion tutea", () => {
    expect(p.replace(/no use "oye", "dime", "¿qué onda\?", "mande"/, "")).not.toMatch(/\b(tú|tienes|quieres|puedes|necesitas|dime|dame|cuéntame|pásame|mándame)\b/i);
  });
});

describe("7. umbral de pedido grande (decision de Javier, 2-oct)", () => {
  it("por omision: mas de $4,000 o 5 kg, o mas de $2,500 con numero sin historial y pago en efectivo", () => {
    expect(PM_PEDIDO_GRANDE_POR_OMISION).toBe("más de $4,000 o más de 5 kg; más de $2,500 si el número no tiene historial y paga en efectivo");
    expect(p).toContain(`Pedido grande (${PM_PEDIDO_GRANDE_POR_OMISION};`);
    expect(p).toMatch(/Un pedido de \$1,500 o más que NO pasa de ese umbral se toma normal, sin escalar/);
    expect(p).not.toMatch(/40 o más piezas/);
  });
  it("el umbral es editable por organizacion y la version de voz usa el mismo", () => {
    expect(prompt({ pedidoGrandeTexto: "más de $6,000" })).toContain("Pedido grande (más de $6,000;");
    expect(buildPmSystemPrompt({ canal: "voz", businessName: "PM", agentName: "el asistente virtual", deliveryTimeText: "x", saludo: "", branches: SUCURSALES, entryBranch: null, customer: NUEVO })).toContain(`Pedido grande (${PM_PEDIDO_GRANDE_POR_OMISION})`);
  });
});

describe("8. ajustes por resta = nota; sustitucion = negativa amable; alergias escalan", () => {
  it("quitar ingredientes se acepta sin escalar y va en notes", () => {
    expect(p).toMatch(/Los ajustes por RESTA se aceptan sin costo y SIN escalar: anótelos en notes \(sin cebolla, sin cilantro, sin guacamole, sin frijol, sin jalapeño/);
  });
  it("sustituir: 'No lo manejamos así; si gusta, le agrego [la orden aparte]' y solo si insiste escala", () => {
    expect(p).toMatch(/"No lo manejamos así; si gusta, le agrego \[la orden aparte\] por \$X"/);
    expect(p).toMatch(/si el cliente insiste, escale con motivo "modificacion_platillo"/);
  });
  it("las alergias siguen escalando siempre", () => {
    expect(p).toMatch(/Las alergias siguen escalando siempre \(alergia_salud\)/);
    expect(p).toMatch(/H8\..*alergias/);
  });
  it("lo que no se maneja (BBQ, chipotle...) se dice sin inventar", () => {
    expect(p).toMatch(/BBQ, chipotle, salchichas, chistorra, longaniza, dedos de queso\): "No lo manejamos"/);
  });
});

describe("9. cambios despues de confirmar", () => {
  it("aviso inmediato y prioritario a la sucursal, sin crear otro pedido ni cancelar por su cuenta", () => {
    expect(p).toMatch(/CAMBIOS DESPUÉS DE CONFIRMAR \(agregar algo, cancelar, pasar de domicilio a recoger, cambiar el pago, corregir el número de casa\)/);
    expect(p).toMatch(/avise a la sucursal DE INMEDIATO con escalar_a_humano \(motivo "cancelacion_modificacion"/);
    expect(p).toContain("Lo paso a cocina; si el pedido ya salió, se lo pueden enviar aparte.");
    expect(p).toMatch(/No cree otro pedido ni cancele por su cuenta/);
  });
});

describe("10. estado del pedido solo con lo que marco la sucursal", () => {
  it("responde con el Pedido reciente del contexto, trata el retraso como queja y nunca inventa", () => {
    expect(p).toMatch(/ESTADO DEL PEDIDO \("¿ya salió\?", "¿falta mucho\?", "estatus de mi orden"\): conteste con el "Pedido reciente" de CONTEXTO DEL CLIENTE, nunca de memoria/);
    expect(p).toMatch(/trátelo como queja: disculpa breve y escale con motivo "tiempos_entrega"/);
    expect(p).toMatch(/Nunca invente un estado, una hora ni que el repartidor va en camino si la sucursal no lo marcó/);
  });
});

describe("13 y 14. queja por faltante y factura", () => {
  it("faltante: disculpa, que falto, pasa a la sucursal con motivo queja, sin prometer reposicion", () => {
    expect(p).toMatch(/FALTANTE O PRODUCTO EQUIVOCADO \(queja\): disculpa breve \("disculpe el inconveniente"\), pregunte qué faltó o qué llegó mal y escale con motivo "queja"/);
    expect(p).toMatch(/no prometa reposición, cambio ni descuento/);
  });
  it("factura: enlace en linea y QR del ticket, sin pedir RFC", () => {
    expect(p).toMatch(/FACTURA: no pida ni guarde RFC\. No tiene el enlace de facturación: NO lo invente .* código QR/);
  });
});

describe("la version de voz conserva lo esencial dentro del tope de 8000", () => {
  const voz = comportamientoVozPm({ businessName: "Los Taquitos de PM", agentName: "el asistente virtual", deliveryTimeText: PM_CONFIG_POR_OMISION.deliveryTimeText, branches: SUCURSALES });
  it("tiempos de la sucursal, umbral de pedido grande, ajustes por resta, fracciones de kilo y frijol", () => {
    expect(voz.length).toBeLessThanOrEqual(8000);
    expect(voz).toContain(`Tiempos de la sucursal (domicilio o recoger; normal o pico): ${PM_CONFIG_POR_OMISION.deliveryTimeText}`);
    expect(voz).toContain(`Pedido grande (${PM_PEDIDO_GRANDE_POR_OMISION})`);
    expect(voz).toMatch(/Ajustes por resta .* en notes, sin escalar/);
    expect(voz).toMatch(/Carnes por peso: 1\/4 a 2 kg, precio proporcional/);
    expect(voz).toMatch(/"Frijol": ¿tostadas o charros\?/);
    expect(voz).not.toMatch(/40 a 50/);
  });
});

describe("cada familia de escenarios de T7 tiene su regla en el prompt", () => {
  // intencion del escenario (regex sobre la clave) -> fragmento del prompt que la cubre
  const COBERTURA: ReadonlyArray<readonly [RegExp, RegExp]> = [
    [/^(todas_las_salsas|salsa_extra|quitar_producto_y_salsas)/, /todas las salsas/],
    [/^frijol_extra_ambiguo/, /frijol con tostadas o frijoles charros/],
    [/^totopos_ambiguo/, /"totopos" o "bolsitas de tostadas"/],
    [/^media_orden_contra_medio_kilo/, /"media orden": ¿media orden del platillo/],
    [/^(pedido_nuevo_fraccion_kilo|kilo_con_referencia_visual|cotizacion_kilo_de_res|fraccion_en_el_minimo)/, /1\/4, 1\/2, 3\/4, 1, 1\.5 y 2 kg al precio proporcional/],
    [/^(cliente_recurrente_mensaje_corto|recurrente_instrucciones_de_empaque)/, /CLIENTE RECURRENTE/],
    [/^mensaje_guardado_recurrente/, /PEGA su mensaje guardado/],
    [/^(estado_del_pedido|aviso_cuando_va_en_camino)/, /ESTADO DEL PEDIDO/],
    [/^(agregar_tras_confirmar|cambio_domicilio_a_recoger_tras_confirmar|cancelar_pedido_para_recoger|corrige_dato_tras_confirmar|pregunta_tarjeta_tras_confirmar)/, /CAMBIOS DESPUÉS DE CONFIRMAR/],
    [/^(queja_faltante|queja_producto_equivocado)/, /FALTANTE O PRODUCTO EQUIVOCADO/],
    [/^factura_/, /FACTURA: no pida ni guarde RFC/],
    [/^(apodo_burrito|apodo_torta|apodo_costra|apodo_papa|alambre_con_queso)/, /Apodos: "torta" es francés suizo/],
    [/^(pregunta_producto_y_sustitucion|torta_completa_quitando_ingredientes)/, /SUSTITUIR o combinar/],
    [/^productos_no_manejados_en_lista|^producto_inexistente/, /BBQ, chipotle/],
    [/^(fuera_de_zona|insiste_por_cercania|horario_de_otra_sucursal)/, /H17\. Pedido de otra sucursal/],
    [/^(pedido_grande|encargo_grande|fuera_de_cobertura_pasa_a_recoger)/, /Pedido grande \(/],
    [/^(consulta_domicilio_y_tiempo|recoger_en_dia_pico|cambio_a_recoger_por_tiempo|retraso_repartidor)/, /TIEMPOS DE ESTA SUCURSAL/],
    [/^instrucciones_de_acceso_a_privada|^pregunta_producto_turista/, /PIN A REPARTO/],
  ];

  it("al menos 40 de los 71 escenarios caen en una familia cubierta, y cada regla citada existe en el prompt", () => {
    const suite = cargarEscenariosT7();
    const cubiertos = suite.escenarios.filter((e) => COBERTURA.some(([intencion]) => intencion.test(e.intencion)));
    expect(cubiertos.length).toBeGreaterThanOrEqual(40);
    for (const [, regla] of COBERTURA) expect(p, String(regla)).toMatch(regla);
  });
});

describe("7. nunca sustituir ni elegir por el cliente (eval real: C04, C11, L05, L10)", () => {
  it("WhatsApp: sin coincidencia exacta o con varias parecidas, pregunta con opciones y no ajusta cifras", () => {
    expect(p).toMatch(/NUNCA SUSTITUYA NI ELIJA POR EL CLIENTE: cotice solo el renglón de buscar_producto cuyo nombre coincide con lo que el cliente pidió/);
    expect(p).toMatch(/pregunte con 2 o 3 opciones de la lista/);
    expect(p).toMatch(/Las cifras \(cantidades, piezas, kilos\) las dice el cliente, nunca las ajuste usted/);
  });
  it("voz: la misma regla en version compacta", () => {
    const voz = prompt({ canal: "voz" });
    expect(voz).toMatch(/Cotice solo el renglón que coincide exacto; si no hay o hay varios parecidos, pregunte con 2 o 3 opciones, sin cambiar producto, carne ni cantidad/);
  });
  it("la herramienta buscar_producto lo repite en su descripcion (segunda linea de defensa)", () => {
    const def = AGENT_TOOL_DEFINITIONS.find((t) => t.name === "buscar_producto")!;
    expect(def.description).toMatch(/no elijas ni sustituyas por él/);
  });
});

describe("8. P2 del eval real: escalacion, hora de recogida, nombre y promociones", () => {
  it("el aviso al cliente va antes y en el mismo turno de escalar_a_humano; las llamadas pendientes tambien se escalan", () => {
    expect(p).toMatch(/el aviso va ANTES y en el MISMO turno de la llamada/);
    expect(p).toMatch(/nunca llame la herramienta sin haber escrito ese aviso en ese turno/);
    expect(p).toMatch(/va por escalar_a_humano; no use registrar_contacto para eso/);
    expect(prompt({ canal: "voz" })).toMatch(/Avise primero al cliente que consulta al gerente y, en ese mismo turno, llame escalar_a_humano/);
  });
  it("la hora que dice el cliente se acepta y va en hora_recogida: no se escala por 'paso en 20 minutos'", () => {
    expect(p).toMatch(/La hora a la que el cliente dice que pasará es suya: acéptela tal cual y mándela en hora_recogida; no escale por ella/);
    expect(p).toMatch(/Solo si el cliente EXIGE una hora garantizada o un tiempo menor al normal de la sucursal, escale \(tiempos_entrega\)/);
  });
  it("el nombre completo va en customer_name; el alambre pedido de pastor no se cambia por el suizo", () => {
    expect(p).toMatch(/mande el nombre COMPLETO tal como lo dio el cliente/);
    expect(p).toMatch(/si pidió "alambre de pastor", es el Alambre de Pastor y no se lo cambie por el suizo/);
  });
  it("H2 explica el alcohol con la palabra 'alcohol'; H3 no escala por insistir en el 2x1 a domicilio", () => {
    expect(p).toMatch(/explíquele con la palabra "alcohol" que no se toma por este medio/);
    expect(p).toMatch(/si el cliente insiste, repita con amabilidad que es solo para recoger y ofrezca recoger; no escale/);
    expect(p).not.toMatch(/si el cliente insiste, escale con motivo "otro"/);
  });
  it("las presentaciones del prompt son una guia: manda el pack_size de la herramienta", () => {
    expect(p).toMatch(/Presentaciones \(guía: si buscar_producto trae otro pack_size/);
  });
  it("producto agotado: alternativa primero y se espera la respuesta; escalar_a_humano una sola vez por conversacion", () => {
    expect(p).toMatch(/ofrezca una alternativa y ESPERE su respuesta: no escale antes de que conteste ni si la acepta/);
    expect(p).toMatch(/UNA SOLA VEZ por conversación \(si el cliente insiste después, repita con calma que la sucursal ya fue avisada\)/);
  });
});
