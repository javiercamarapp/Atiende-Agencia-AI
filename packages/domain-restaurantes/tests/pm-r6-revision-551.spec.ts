// Revision de #551 (Opus): sobre-escalado del clasificador de alto riesgo, "le/les/nos falto", modificacion del pedido, avisos espurios, guacamole, rechazo del resumen y notas.
// Cada guarda con regex lleva corpus ETIQUETADO (positivos y negativos, FP/FN contra main), contrato de entrada y reloj fijo (nada de TZ de proceso).
import { describe, expect, it } from "vitest";
import { afirmaHaberAvisado, aclararGuacamoleExtra, classifyHighRiskIntent, classifyHighRiskIntentInMessages, ESPERA_LARGA_MINUTOS, type HighRiskContext } from "../src/whatsapp/guards.ts";
import { rechazaElResumen } from "../src/agent-tools/order-flow.ts";
import { complementosExcluidosEnNotas } from "../src/order-quote.ts";
import { saludoHora } from "../src/evals/agente-pm/referencia.ts";

const mk = (estado: string): HighRiskContext => ({ pedidoReciente: { estado, canal: "domicilio", sucursal: "T7", confirmadoHoraLocal: "14:00", minutosDesdeConfirmacion: 20 } as never });
const CTX: readonly [string, HighRiskContext][] = [["desconocido", {}], ["sinPedido", { pedidoReciente: null }], ["preparando", mk("preparando")], ["porConfirmar", mk("por_confirmar")], ["salio", mk("salio")], ["entregado", mk("entregado")]];
const intent = (t: string, c: HighRiskContext) => classifyHighRiskIntent(t, c)?.intent ?? null;

// Salida de classifyHighRiskIntent de MAIN (a2d23e2a5) para estos textos y los 6 contextos de CTX, en ese orden. Los motivos que ya existian NO cambian.
const MAIN_TABLA: Record<string, (string | null)[]> = {
  "soy alérgico al cacahuate": ["alergia_salud", "alergia_salud", "alergia_salud", "alergia_salud", "alergia_salud", "alergia_salud"],
  "mi hija es celíaca": ["alergia_salud", "alergia_salud", "alergia_salud", "alergia_salud", "alergia_salud", "alergia_salud"],
  "tengo intolerancia a la lactosa": ["alergia_salud", "alergia_salud", "alergia_salud", "alergia_salud", "alergia_salud", "alergia_salud"],
  "me cobraron dos veces": ["cobro_duplicado", "cobro_duplicado", "cobro_duplicado", "cobro_duplicado", "cobro_duplicado", "cobro_duplicado"],
  "cobro duplicado en mi tarjeta": ["cobro_duplicado", "cobro_duplicado", "cobro_duplicado", "cobro_duplicado", "cobro_duplicado", "cobro_duplicado"],
  "quiero cancelar mi pedido": ["cancelacion_modificacion", null, "cancelacion_modificacion", "cancelacion_modificacion", "cancelacion_modificacion", "cancelacion_modificacion"],
  "cancela mi pedido por favor": ["cancelacion_modificacion", null, "cancelacion_modificacion", "cancelacion_modificacion", "cancelacion_modificacion", "cancelacion_modificacion"],
  "ya no quiero el pedido": [null, null, null, null, null, null],
  "quiero pagar por transferencia": ["transferencia", "transferencia", "transferencia", "transferencia", "transferencia", "transferencia"],
  "¿aceptan transferencia?": ["transferencia", "transferencia", "transferencia", "transferencia", "transferencia", "transferencia"],
  "mi pedido llegó frío": ["queja", "queja", "queja", "queja", "queja", "queja"],
  "pésimo servicio, llegó incompleto": ["queja", "queja", "queja", "queja", "queja", "queja"],
  "quiero poner una queja": ["queja", "queja", "queja", "queja", "queja", "queja"],
  "me faltó la bebida de mi pedido": ["queja", "queja", "queja", "queja", "queja", "queja"],
  "no me llegó la coca de mi pedido": ["queja", "queja", "queja", "queja", "queja", "queja"],
  "vino todo frío": [null, null, null, null, "queja", "queja"],
  "mi pedido es urgente, ¿ya viene?": ["urgencia", null, "urgencia", "urgencia", "urgencia", "urgencia"],
  "¿ya viene mi pedido? es urgente": ["urgencia", null, "urgencia", "urgencia", "urgencia", "urgencia"],
  "quiero hablar con una persona": ["cliente_lo_pide", "cliente_lo_pide", "cliente_lo_pide", "cliente_lo_pide", "cliente_lo_pide", "cliente_lo_pide"],
  "pásame con el gerente": ["cliente_lo_pide", "cliente_lo_pide", "cliente_lo_pide", "cliente_lo_pide", "cliente_lo_pide", "cliente_lo_pide"],
  "quiero que borren mis datos": ["privacidad_arco", "privacidad_arco", "privacidad_arco", "privacidad_arco", "privacidad_arco", "privacidad_arco"],
  "quiero ejercer mis derechos ARCO": ["privacidad_arco", "privacidad_arco", "privacidad_arco", "privacidad_arco", "privacidad_arco", "privacidad_arco"],
  "me faltaron las salsas": [null, null, null, null, "queja", "queja"],
  "mal armado el pedido": ["queja", "queja", "queja", "queja", "queja", "queja"],
  "me trajeron mal el pedido": ["queja", "queja", "queja", "queja", "queja", "queja"],
  "me llegó equivocado": [null, null, null, null, "queja", "queja"],
  "el repartidor fue grosero, quiero queja": ["queja", "queja", "queja", "queja", "queja", "queja"],
  "me cobraron doble y llegó frío": ["cobro_duplicado", "cobro_duplicado", "cobro_duplicado", "cobro_duplicado", "cobro_duplicado", "cobro_duplicado"],
  "¿mi pedido se canceló?": [null, null, null, null, null, null],
  "cancélalo, mejor ponme bistec": [null, null, null, null, null, null],
  "lo necesito urgente: medio kilo de pastor": [null, null, null, null, null, null],
  "me faltó pedir una horchata": [null, null, null, null, null, null]
};

describe("los motivos de escalado que ya existian no cambian (tabla de main)", () => {
  for (const [texto, esperado] of Object.entries(MAIN_TABLA)) {
    it(texto, () => {
      CTX.forEach(([nombre, ctx], i) => expect(intent(texto, ctx), `${nombre}: ${texto}`).toBe(esperado[i]));
    });
  }
});

describe("intoxicacion / malestar: solo cuando habla de lo que comio", () => {
  const SI = ["me intoxiqué con sus tacos de ayer", "me dio diarrea después de comer ahí", "vomité toda la noche", "creo que la comida estaba en mal estado", "me enfermé después de comer sus tacos", "me cayó mal la comida de ayer", "me dio dolor de panza después de cenar", "sospecho un envenenamiento"];
  const NO = [
    "me enfermé y no puedo salir, mándenlo a domicilio", "el habanero me cayó mal la otra vez, sin habanero", "el picante me hizo daño la otra vez, sin chile porfa", "el niño tiene dolor de panza, ¿tienen algo sin grasa?",
    "estoy malo del estómago, algo ligero", "es para mi mamá que está enferma", "quiero 3 tacos de pastor",
  ];
  it.each(SI)("escala: %s", (t) => expect(intent(t, {})).toBe("alergia_salud"));
  it.each(NO)("no escala: %s", (t) => CTX.forEach(([, c]) => expect(intent(t, c)).toBeNull()));
});

describe("espera larga: pedido VIGENTE y mas que el plazo prometido (60 a 75 min)", () => {
  it("el umbral esta por encima del plazo prometido", () => expect(ESPERA_LARGA_MINUTOS).toBeGreaterThan(75));
  const NO = ["llevo media hora esperando para pedir", "llevo 30 minutos esperando que me contesten", "llevo una hora esperando el menú", "llevo 45 minutos esperando mi pedido", "llevo 1 hora esperando mi pedido", "llevo 89 minutos esperando mi pedido"];
  it.each(NO)("no es urgencia en ningun contexto: %s", (t) => CTX.forEach(([, c]) => expect(intent(t, c), t).toBeNull()));
  it.each(["llevo 2 horas esperando mi pedido", "llevo hora y media esperando", "llevo 90 minutos esperando mi pedido", "llevo más de dos horas esperando"] as const)("urgencia con pedido preparando o en camino: %s", (t) => {
    expect(intent(t, mk("preparando"))).toBe("urgencia");
    expect(intent(t, mk("salio"))).toBe("urgencia");
  });
  it("sin pedido vigente (nuevo, sin pedido, entregado, por confirmar) no hay espera de pedido", () => {
    for (const c of [{ pedidoReciente: null }, mk("entregado"), mk("por_confirmar")]) expect(intent("llevo 2 horas esperando mi pedido", c)).toBeNull();
    expect(intent("llevo 2 horas esperando para pedir", {})).toBeNull();
  });
  it("sin el dato del pedido (lectura no disponible) solo cuenta si habla de «mi pedido»", () => expect(intent("llevo 2 horas esperando mi pedido", {})).toBe("urgencia"));
  it("«urgente» sobre el pedido que ya existe sigue escalando (como en main)", () => expect(intent("mi pedido es urgente, ¿ya viene?", mk("preparando"))).toBe("urgencia"));
});

describe("«le / les / nos faltó»: mismo criterio que «me faltó»", () => {
  const CARRITO = ["le faltó la horchata al resumen", "nos faltó una coca, agrégala porfa", "le faltó la coca", "les faltó poner el agua de jamaica", "me faltó una coca"];
  it.each(CARRITO)("sin pedido entregado ni en camino es el carrito: %s", (t) => {
    for (const nombre of ["desconocido", "sinPedido", "preparando", "porConfirmar"]) expect(intent(t, CTX.find(([n]) => n === nombre)![1])).toBeNull();
  });
  it("«le faltó la horchata al resumen» no es queja ni con el pedido entregado", () => expect(intent("le faltó la horchata al resumen", mk("entregado"))).toBeNull());
  it.each(["a mi pedido le faltaron las salsas", "le faltó la salsa a mi pedido"])("hablando del pedido ya hecho es queja: %s", (t) => expect(intent(t, {})).toBe("queja"));
  it.each(["le faltó la salsa", "nos faltaron las bebidas"])("con el pedido entregado o en camino es queja: %s", (t) => {
    expect(intent(t, mk("entregado"))).toBe("queja");
    expect(intent(t, mk("salio"))).toBe("queja");
  });
});

describe("«cargo doble»: la pregunta no es un cobro duplicado", () => {
  it.each(["¿me cobran cargo doble si pago con tarjeta?", "¿hay cargo doble al pagar con tarjeta?", "¿cobran doble por la salsa extra?", "si pago con tarjeta, ¿hay cargo duplicado?"])("no escala: %s", (t) => expect(intent(t, {})).toBeNull());
  it.each(["me hicieron un doble cargo", "me cargaron dos veces en la tarjeta", "me cobraron doble", "¿por qué me cobraron doble?", "tengo un cargo doble en mi tarjeta"])("escala: %s", (t) => expect(intent(t, {})).toBe("cobro_duplicado"));
});

describe("modificar el pedido: intent propio, mismo aviso al equipo", () => {
  it.each(["cámbiame el pedido a harina", "modifica el pedido, agrega 2 tacos", "quiero modificar mi pedido"])("%s con pedido preparando", (t) => {
    const m = classifyHighRiskIntent(t, mk("preparando"));
    expect(m?.intent).toBe("modificacion_pedido");
    expect(m?.motivo).toBe("cancelacion_modificacion");
  });
  it("cancelar sigue siendo cancelacion_modificacion en intent y motivo", () => {
    const m = classifyHighRiskIntent("quiero cancelar mi pedido", mk("preparando"));
    expect([m?.intent, m?.motivo]).toEqual(["cancelacion_modificacion", "cancelacion_modificacion"]);
  });
  it("en una rafaga conserva el intent y el texto", () => {
    const r = classifyHighRiskIntentInMessages(["hola", "cámbiame el pedido a harina"], mk("preparando"));
    expect([r?.intent, r?.text]).toEqual(["modificacion_pedido", "cámbiame el pedido a harina"]);
  });
  it.each([0, "", null, undefined, false, [], {}].map((v) => [v]))("contrato de entrada %j: no lanza y no escala", (v) => {
    expect(classifyHighRiskIntent(v as never, v as never)).toBeNull();
  });
});

describe("afirmaHaberAvisado: avisos de preparacion y consultas a la sucursal no son un aviso al gerente", () => {
  const NO = ["Ya platiqué con el encargado y lo tiene listo en 20 min.", "Le comunicamos a la sucursal que usted pasa a las 8.", "Ya hablé con la sucursal y sí hay pastor.", "Dejé el mensaje a la sucursal para que lo preparen.", "Le notificamos a la sucursal que usted recoge a las 9."];
  const SI = ["Ya hablé con el gerente.", "Ya hablé con el gerente y le contesta.", "Ya platiqué con la encargada de su queja.", "Dejé el recado con la encargada.", "Dejé el mensaje para el gerente."];
  it.each(NO)("no afirma aviso: %s", (t) => expect(afirmaHaberAvisado(t)).toBe(false));
  it.each(SI)("afirma aviso: %s", (t) => expect(afirmaHaberAvisado(t)).toBe(true));
});

describe("aclararGuacamoleExtra: la eleccion con otras palabras cierra la aclaracion", () => {
  const EXTRA = ["Taco Al Pastor", "Extra Guacamole"];
  const conv = (q: string, r: string) => [{ role: "user", content: "3 tacos de pastor y guacamole" }, { role: "assistant", content: q }, { role: "user", content: r }];
  it.each([
    ["¿Desea el guacamole extra ($49) o el guacamole completo ($142)?", "el de 49"], ["¿Guacamole entero o para sus tacos?", "el entero"], ["¿Cuál guacamole: el chico de $49 o el grande de $142?", "el chico"],
    ["¿Lo quiere aparte o como extra?", "aparte"], ["¿Platillo o extra?", "platillo"],
  ])("%s", (q, r) => expect(aclararGuacamoleExtra(EXTRA, conv(q, r))).toBeNull());
  it.each([["Anoto Extra Guacamole, ¿algo más?", "no"], ["Anoto el guacamole. ¿Algo más o es todo?", "es todo"], ["Extra salsa, ¿le parece?", "sí"]])("NO es una eleccion: %s", (q, r) => expect(aclararGuacamoleExtra(EXTRA, conv(q, r))).not.toBeNull());
});

describe("rechazaElResumen: confirmaciones legitimas con «no» / «así no» dentro", () => {
  it.each(["No está mal, confírmelo", "Perfecto, no cambia nada", "confírmalo, así no se me olvida", "Va, así no tengo que salir", "Listo, así no me complico", "Así no se me pasa, dale", "no hay nada mal, confirma"])("no rechaza: %s", (t) => expect(rechazaElResumen(t)).toBe(false));
  it.each(["No, así no", "no es correcto", "está mal", "No, mejor sin cebolla", "no, quita la coca", "no está bien así", "así no me gusta, cámbialo", "incorrecto", "no es correcto el nombre, es Ana"])("rechaza: %s", (t) => expect(rechazaElResumen(t)).toBe(true));
  it.each([0, "", null, undefined, false, [], {}].map((v) => [v]))("contrato %j", (v) => expect(rechazaElResumen(v)).toBe(false));
});

describe("notas: lo que se excluye de verdad", () => {
  it.each([
    ["sin cebolla pero con cilantro", []], ["con cebolla y sin cilantro", []], ["sin salsa roja en los de pastor, en bistec sí", []], ["sin cilantro en los frijoles", []], ["sin salsa verde para los de bistec", []],
    ["sin cebolla, sin cilantro", ["cebolla_cilantro"]], ["sin cebolla", ["cebolla_cilantro"]], ["sin salsa roja", ["salsa_roja"]], ["sin salsa roja en los tacos", ["salsa_roja"]], ["sin limones y sin salsa verde", ["salsa_verde", "limones"]],
    ["sin cebolla pero con salsa roja", ["cebolla_cilantro"]],
  ] as const)("%s", (t, esperado) => expect(new Set(complementosExcluidosEnNotas(t))).toEqual(new Set(esperado)));
  it.each([0, "", null, undefined, false, [], {}].map((v) => [v]))("contrato %j", (v) => expect(complementosExcluidosEnNotas(v)).toEqual([]));
});

describe("saludo de referencia: buenas tardes hasta las 19:59", () => {
  it.each([["04:59", "Buenas noches"], ["05:00", "Buenos días"], ["11:59", "Buenos días"], ["12:00", "Buenas tardes"], ["19:00", "Buenas tardes"], ["19:59", "Buenas tardes"], ["20:00", "Buenas noches"]])("%s", (h, esperado) =>
    expect(saludoHora(h)).toBe(esperado));
});
