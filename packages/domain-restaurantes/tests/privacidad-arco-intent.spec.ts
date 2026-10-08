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
