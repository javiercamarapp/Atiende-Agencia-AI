// PM PR-9 (restaurantes) -- detección determinista de derechos ARCO y fast-path (arco-intent.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { detectArcoConfirmation, detectArcoIntent, normalizeArcoText, runArcoFastPath } from "../src/privacidad/arco-intent.ts";
import { InMemoryPrivacidadRepository } from "../src/privacidad/in-memory-repository.ts";

const ORG = "00000000-0000-0000-0000-0000000000a1";
const PHONE = "+5219981234567";

describe("detectArcoIntent -- los 4 derechos, sin falsos positivos del flujo de pedidos", () => {
  it.each([
    ["Quiero conocer qué datos personales tienen de mí", "acceso"],
    ["Solicito acceso a mis datos personales", "acceso"],
    ["Quiero rectificar mis datos personales, mi nombre está mal", "rectificacion"],
    ["necesito corregir mis datos personales", "rectificacion"],
    ["Quiero que eliminen mis datos personales", "cancelacion"],
    ["Pido la cancelación de mis datos personales", "cancelacion"],
    ["Quiero que borren mis datos", "cancelacion"],
    ["Me opongo al uso de mis datos personales", "oposicion"],
    ["No quiero que usen mis datos personales para publicidad", "oposicion"],
    ["Revoco mi consentimiento sobre mis datos personales", "oposicion"],
  ])("«%s» -> %s", (text, right) => {
    expect(detectArcoIntent(text)).toEqual({ kind: "request", right });
  });

  it.each([
    "Quiero cancelar mi pedido de hace rato",
    "¿Pueden cambiar mi dirección de entrega a otra colonia?",
    "Quiero actualizar mi pedido, agrégale una coca",
    "Hola, quiero 3 tacos al pastor",
    "gracias",
    "",
  ])("«%s» NO es una solicitud ARCO (sin mención de datos personales/privacidad)", (text) => {
    expect(detectArcoIntent(text)).toBeNull();
  });

  // QA-PM-R5-whatsapp-05: "mis datos" suelto en una conversacion de factura / pedido no es ARCO.
  it.each([
    "ya te pase mis datos, facturame",
    "ya te mande mis datos para la factura",
    "te paso mis datos para facturar",
    "estos son mis datos: Juan Perez, RFC XAXX010101000",
    "ahi van mis datos del pedido",
    "ya le pase mis datos a la sucursal",
  ])("«%s» NO es ARCO (datos para facturar o del pedido)", (text) => {
    expect(detectArcoIntent(text)).toBeNull();
  });

  // Regresion de privacidad: un verbo de cancelacion/oposicion/rectificacion NUNCA lo anula la mencion de pedido/factura/"ya te pase".
  it.each([
    ["ya les di mis datos y quiero que los borren", "cancelacion"],
    ["borren mis datos de mi pedido, ya no quiero que los tengan", "cancelacion"],
    ["quiero eliminar mis datos, ya no voy a hacer otro pedido", "cancelacion"],
    ["ya les pase mis datos, quiero darme de baja", "cancelacion"],
    ["borren mis datos y facturame", "cancelacion"],
    ["cancelen mis datos", "cancelacion"],
    ["me opongo a que usen mis datos para mi pedido", "oposicion"],
    ["ya te mande mis datos para la factura pero corrijan mis datos, el RFC esta mal", "rectificacion"],
    ["quiero ver mis datos", "acceso"],
    ["¿pueden borrar mis datos? ya les pase mi pedido", "cancelacion"],
    ["si me dan la factura, despues borren mis datos del pedido", "cancelacion"],
    ["ya les pase mis datos antes, ahora quiero que los eliminen", "cancelacion"],
    ["mas adelante voy a pedir que borren mis datos de mis pedidos", "cancelacion"],
  ])("«%s» sigue siendo ARCO (%s) aunque hable de pedido/factura", (text, right) => {
    expect(detectArcoIntent(text)).toEqual({ kind: "request", right });
  });

  it.each([
    "ya te pase mis datos, facturame",
    "necesito factura, mis datos son Juan Perez RFC XAXX010101000",
    "mandame mis datos del ticket",
  ])("«%s» NO es ARCO: solo verbo de acceso + factura/pedido", (text) => {
    expect(detectArcoIntent(text)).toBeNull();
  });

  it("menciona ARCO/privacidad sin un derecho concreto -> menú, sin registrar nada", () => {
    expect(detectArcoIntent("Quiero ejercer mis derechos ARCO")).toEqual({ kind: "menu" });
    expect(detectArcoIntent("tienen aviso de privacidad?")).toEqual({ kind: "menu" });
  });

  it("varios derechos específicos en un solo mensaje -> menú (se pide elegir uno)", () => {
    expect(detectArcoIntent("quiero que borren mis datos personales y que no los compartan")).toEqual({ kind: "menu" });
  });

  it("pide datos de OTRA persona -> negativa guiada (third_party), nunca una solicitud", () => {
    expect(detectArcoIntent("Quiero conocer los datos personales de mi esposa")).toEqual({ kind: "third_party" });
    expect(detectArcoIntent("dame los datos personales de otra persona")).toEqual({ kind: "third_party" });
  });

  it("es insensible a acentos y mayúsculas", () => {
    expect(normalizeArcoText("RECTIFICACIÓN, por favor!")).toBe("rectificacion por favor");
    expect(detectArcoIntent("RECTIFICACIÓN de MIS DATOS PERSONALES")).toEqual({ kind: "request", right: "rectificacion" });
  });
});

// Corpus de regresion de la revision independiente de #528 (62 frases etiquetadas): un falso negativo en ARCO es el riesgo grave (la solicitud determinista no debe
// depender del modelo). true = hay que detectarla (request / menu / third_party); false = no es ARCO (solo verbo de acceso + factura/pedido, o pedido ajeno).
const CORPUS_REVISION: ReadonlyArray<readonly [string, boolean]> = [
 // obligatorias ARCO
 ["ya les di mis datos y quiero que los borren", true],
 ["borren mis datos de mi pedido, ya no quiero que los tengan", true],
 ["quiero eliminar mis datos, ya no voy a hacer otro pedido", true],
 ["ya les pasé mis datos, quiero darme de baja", true],
 ["borren mis datos y facturame", true],
 ["cancelen mis datos", true],
 ["me opongo a que usen mis datos para mi pedido", true],
 // obligatorias NO
 ["ya te pasé mis datos, facturame", false],
 ["necesito factura, mis datos son Juan Perez RFC PEJU800101XXX", false],
 // corpus propio ARCO
 ["BORREN MIS DATOS PORFAVOR", true],
 ["k borren mis datos", true],
 ["kiero que borren mis datos ya", true],
 ["ya no quiero que tengan mis datos", true],
 ["eliminen mis datos personales de su sistema", true],
 ["quiero ejercer mis derechos arco", true],
 ["no quiero que usen mis datos para publicidad", true],
 ["dejen de usar mis datos, ya les pedi una orden y me llegan mensajes", true],
 ["dejen de mandarme promociones, no autorizo el uso de mis datos", true],
 ["quiero saber que datos tienen mios", true],
 ["que datos personales tienen de mi?", true],
 ["quiero una copia de mis datos personales", true],
 ["mis datos estan mal, corrijan mi nombre", true],
 ["actualicen mis datos, cambie de correo", true],
 ["ya les di mis datos en el pedido pasado pero estan mal, corrijanlos", true],
 ["den de baja mis datos", true],
 ["denme de baja de su base de datos", true],
 ["sáquenme de su base de datos", true],
 ["quiero que borren mi numero y mi direccion de su sistema", true],
 ["no quiero que guarden mis datos", true],
 ["ya no me manden nada y borren mi info", true],
 ["olviden mis datos", true],
 ["revoco mi consentimiento para que usen mis datos", true],
 ["ya te pase mis datos, ahora borralos", true],
 ["borra mis datos, ya no voy a pedir", true],
 ["quiero que eliminen mis datos despues de entregar mi pedido", true],
 ["ya les mande mis datos para la factura pero quiero que los borren despues", true],
 ["ya les di mis datos y no quiero que los compartan con nadie", true],
 ["por favor eliminar mis datos del aviso de privacidad", true],
 ["k datos mios tienen? kiero verlos", true],
 ["qué hacen con mis datos?", true],
 ["quiero ver mis datos, ya les hice un pedido", true],
 ["quiero saber que hacen con mis datos de mi pedido", true],
 ["mandenme mis datos que tienen guardados, hice una orden la semana pasada", true],
 // NO ARCO (falsos positivos potenciales)
 ["mi direccion es calle 60 x 45 centro, borren la salsa de mi pedido", false],
 ["cancelen mi pedido", false],
 ["datos de mi tarjeta no, solo efectivo", false],
 ["quiero cancelar mi orden", false],
 ["ya te mande mis datos, cuando llega mi pedido", false],
 ["te pase mis datos para el pedido, ¿ya lo vieron?", false],
 ["mis datos de facturacion: RFC XAXX010101000, correo a@b.com", false],
 ["actualiza mi direccion de entrega", false],
 ["ya les pase mis datos, me mandan el ticket", false],
 ["mis datos son: Juan, calle 20 #300, quiero 1 kilo de cochinita", false],
 ["ya te di mis datos, quiero ver el estado de mi orden", false],
 ["ya les di mis datos, cancelen el pedido porfa ya no lo quiero", false],
 ["te pase mis datos, cancela la orden y haz otra", false],
 ["cancelar pedido, ya les mande mis datos", false],
 ["corrijan mi pedido, ya les pase mis datos, era sin cebolla", false],
 ["ya te pase mis datos, quiero modificar la orden", false],
 ["quiero factura, mis datos son los mismos de la vez pasada", false],
 ["envien la factura con mis datos", false],
 ["borren la cebolla, mis datos ya los tienen", false],
];
// Falsos positivos CONOCIDOS y aceptados (iguales o peores en main): preferible mandar al menu ARCO que dejar una solicitud al modelo.
const FALSOS_POSITIVOS_ACEPTADOS = new Set([
  "mis datos son: Juan, calle 20 #300, quiero 1 kilo de cochinita",
  "corrijan mi pedido, ya les pase mis datos, era sin cebolla",
  "ya te pase mis datos, quiero modificar la orden",
  "borren la cebolla, mis datos ya los tienen",
]);

describe("corpus de 62 frases de la revision independiente", () => {
  it.each(CORPUS_REVISION.filter(([, esArco]) => esArco))("ARCO, nunca al modelo: «%s»", (frase) => {
    expect(detectArcoIntent(frase)).not.toBeNull();
  });
  it.each(CORPUS_REVISION.filter(([frase, esArco]) => !esArco && !FALSOS_POSITIVOS_ACEPTADOS.has(frase)))("no ARCO: «%s»", (frase) => {
    expect(detectArcoIntent(frase)).toBeNull();
  });
  it("cancelen/cancela sobre pedido u orden NO es cancelacion de datos", () => {
    expect(detectArcoIntent("ya les di mis datos, cancelen el pedido porfa")).toBeNull();
    expect(detectArcoIntent("cancelen mis datos")).toEqual({ kind: "request", right: "cancelacion" });
  });
  it("pronombre pegado al verbo y variantes de baja / guardar / compartir", () => {
    for (const [f, right] of [
      ["borralos, son mis datos", "cancelacion"],
      ["bórrenlos, son mis datos", "cancelacion"],
      ["eliminenlos, mis datos", "cancelacion"],
      ["den de baja mis datos", "cancelacion"],
      ["no quiero que guarden mis datos", "cancelacion"],
      ["no autorizo el uso de mis datos", "oposicion"],
      ["no quiero que los compartan, son mis datos", "oposicion"],
    ] as const) expect(detectArcoIntent(f), f).toEqual({ kind: "request", right });
  });
  it("totales: 0 falsos negativos y a lo mas 6 falsos positivos", () => {
    const fn = CORPUS_REVISION.filter(([f, esArco]) => esArco && detectArcoIntent(f) === null).length;
    const fp = CORPUS_REVISION.filter(([f, esArco]) => !esArco && detectArcoIntent(f) !== null).length;
    expect(fn).toBe(0);
    expect(fp).toBeLessThanOrEqual(6);
  });
});

describe("detectArcoConfirmation -- solo frases explícitas", () => {
  it.each([
    ["CONFIRMO", "confirm"],
    ["Confirmo.", "confirm"],
    ["confirmo mi solicitud", "confirm"],
    ["CANCELAR SOLICITUD", "withdraw"],
    ["no confirmo", "withdraw"],
  ])("«%s» -> %s", (text, expected) => {
    expect(detectArcoConfirmation(text)).toBe(expected);
  });

  it.each(["sí", "si", "ok", "no", "confirmo mi pedido", "quiero confirmar mi pedido", "cancelar"])("«%s» NO confirma ni retira", (text) => {
    expect(detectArcoConfirmation(text)).toBeNull();
  });
});

describe("runArcoFastPath -- flujo guiado de punta a punta (repositorio en memoria)", () => {
  let repo: InMemoryPrivacidadRepository;
  beforeEach(() => {
    repo = new InMemoryPrivacidadRepository();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("mensaje no ARCO -> null (sigue al agente)", async () => {
    expect(await runArcoFastPath(repo, ORG, PHONE, "Quiero 2 tacos de bistec")).toBeNull();
    expect(repo.requests).toHaveLength(0);
  });

  it("solicitud nueva: registra pendiente_confirmacion para ESE teléfono y pide CONFIRMO, sin exponer datos", async () => {
    const result = await runArcoFastPath(repo, ORG, PHONE, "Quiero acceso a mis datos personales");
    expect(result?.reply).toContain("CONFIRMO");
    expect(result?.reply).toContain("acceso");
    expect(repo.requests).toHaveLength(1);
    expect(repo.requests[0]).toMatchObject({ organizationId: ORG, customerPhone: PHONE, rightType: "acceso", status: "pendiente_confirmacion", channel: "whatsapp" });
    expect(result?.reply).not.toContain(PHONE);
  });

  it("repetir el mismo derecho es idempotente (no abre una segunda solicitud)", async () => {
    await runArcoFastPath(repo, ORG, PHONE, "Quiero acceso a mis datos personales");
    await runArcoFastPath(repo, ORG, PHONE, "Quiero acceso a mis datos personales otra vez");
    expect(repo.requests).toHaveLength(1);
  });

  it("CONFIRMO desde el mismo número: queda recibida con plazos de 20 y 35 días y respuesta con fechas", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-30T15:00:00Z"));
    await runArcoFastPath(repo, ORG, PHONE, "Quiero rectificar mis datos personales");
    const result = await runArcoFastPath(repo, ORG, PHONE, "CONFIRMO");
    const row = repo.requests[0]!;
    expect(row.status).toBe("recibida");
    expect(row.responseDueAt).toBe("2026-10-20T15:00:00.000Z");
    expect(row.executionDueAt).toBe("2026-11-04T15:00:00.000Z");
    expect(result?.reply).toContain("rectificación");
    expect(result?.reply).toContain("20 de octubre de 2026");
    expect(result?.reply).toContain("no envío datos personales");
  });

  it("cancelación: el aviso explica que se bloquea antes de suprimir", async () => {
    await runArcoFastPath(repo, ORG, PHONE, "Quiero que eliminen mis datos personales");
    const result = await runArcoFastPath(repo, ORG, PHONE, "CONFIRMO");
    expect(result?.reply).toContain("se bloquean primero");
  });

  it("CANCELAR SOLICITUD la retira", async () => {
    await runArcoFastPath(repo, ORG, PHONE, "Quiero acceso a mis datos personales");
    const result = await runArcoFastPath(repo, ORG, PHONE, "CANCELAR SOLICITUD");
    expect(result?.reply).toContain("retiré su solicitud");
    expect(repo.requests[0]!.status).toBe("cancelada_titular");
  });

  it("CONFIRMO sin solicitud pendiente de ESE teléfono -> null (puede ser otra conversación)", async () => {
    await runArcoFastPath(repo, ORG, PHONE, "Quiero acceso a mis datos personales");
    expect(await runArcoFastPath(repo, ORG, "+5219990000000", "CONFIRMO")).toBeNull();
    expect(repo.requests[0]!.status).toBe("pendiente_confirmacion");
  });

  it("una confirmación de más de 24 h ya no aplica", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-30T15:00:00Z"));
    await runArcoFastPath(repo, ORG, PHONE, "Quiero acceso a mis datos personales");
    vi.setSystemTime(new Date("2026-10-01T16:00:00Z"));
    expect(await runArcoFastPath(repo, ORG, PHONE, "CONFIRMO")).toBeNull();
    expect(repo.requests[0]!.status).toBe("pendiente_confirmacion");
  });

  it("pedir datos de otra persona no registra nada", async () => {
    const result = await runArcoFastPath(repo, ORG, PHONE, "Quiero los datos personales de mi esposa");
    expect(result?.reply).toContain("solo puedo recibir solicitudes sobre los datos personales asociados a este mismo número");
    expect(repo.requests).toHaveLength(0);
  });

  it("organizaciones distintas no se mezclan", async () => {
    await runArcoFastPath(repo, ORG, PHONE, "Quiero acceso a mis datos personales");
    expect(await runArcoFastPath(repo, "00000000-0000-0000-0000-0000000000a2", PHONE, "CONFIRMO")).toBeNull();
  });

  it("el detalle guardado va redactado (tarjetas) y acotado", async () => {
    await runArcoFastPath(repo, ORG, PHONE, "Quiero acceso a mis datos personales, mi tarjeta es 4111 1111 1111 1111");
    expect(repo.requests[0]!.detail).toContain("[TARJETA REDACTADA]");
    expect(repo.requests[0]!.detail).not.toContain("4111");
  });

  it("base sin migrar: devuelve null y el mensaje sigue al agente (nunca promete un seguimiento inexistente)", async () => {
    repo.migrada = false;
    expect(await runArcoFastPath(repo, ORG, PHONE, "Quiero acceso a mis datos personales")).toBeNull();
    expect(await runArcoFastPath(repo, ORG, PHONE, "CONFIRMO")).toBeNull();
  });

  it("canal de voz: la solicitud nace con channel voice e identidad por identificador de llamada", async () => {
    const result = await runArcoFastPath(repo, ORG, PHONE, "quiero que borren mis datos personales", "voice");
    expect(result?.reply).toContain("CONFIRMO");
    expect(repo.requests[0]).toMatchObject({ channel: "voice", identityBasis: "llamada_identificador", rightType: "cancelacion" });
  });

  it("canal de WhatsApp: la identidad se basa en el numero que escribe", async () => {
    await runArcoFastPath(repo, ORG, PHONE, "quiero acceso a mis datos personales");
    expect(repo.requests[0]).toMatchObject({ channel: "whatsapp", identityBasis: "whatsapp_numero" });
  });

  it("la zona horaria del negocio se usa para las fechas del aviso de plazos", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-30T03:00:00Z"));
    await runArcoFastPath(repo, ORG, PHONE, "quiero acceso a mis datos personales", "whatsapp", "America/Merida");
    const result = await runArcoFastPath(repo, ORG, PHONE, "CONFIRMO", "whatsapp", "America/Merida");
    expect(result?.reply).toContain("19 de octubre de 2026");
  });
});
