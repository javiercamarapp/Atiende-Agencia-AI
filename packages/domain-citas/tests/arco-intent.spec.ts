// C-02 -- detección determinista de derechos ARCO y fast-path (arco-intent.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { detectArcoConfirmation, detectArcoIntent, normalizeArcoText, runArcoFastPath } from "../src/arco-intent.ts";
import { InMemoryCitasRepository } from "../src/in-memory-repository.ts";

const ORG = "00000000-0000-0000-0000-0000000000a1";
const PHONE = "+5219981234567";

describe("detectArcoIntent -- los 4 derechos, sin falsos positivos del flujo de citas", () => {
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
    "Quiero cancelar mi cita de mañana",
    "¿Pueden cambiar mi horario a las 5?",
    "Quiero actualizar mi correo para los recordatorios",
    "Hola, quiero agendar una cita",
    "gracias",
    "",
  ])("«%s» NO es una solicitud ARCO (sin mención de datos personales/privacidad)", (text) => {
    expect(detectArcoIntent(text)).toBeNull();
  });

  it("menciona ARCO/privacidad sin un derecho concreto -> menú, sin registrar nada", () => {
    expect(detectArcoIntent("Quiero ejercer mis derechos ARCO")).toEqual({ kind: "menu" });
    // QA-citas-R1-agentes-12: pedir o querer ver el aviso de privacidad NO es una solicitud ARCO (antes abria el menu o una de acceso con folio).
    expect(detectArcoIntent("tienen aviso de privacidad?")).toBeNull();
  });

  it("QA-citas-R1-agentes-12: el aviso de privacidad solo cuenta si pide un derecho concreto (borrar, corregir, oponerse)", () => {
    expect(detectArcoIntent("me pasan su aviso de privacidad?")).toBeNull();
    expect(detectArcoIntent("quiero ver el aviso de privacidad")).toBeNull();
    expect(detectArcoIntent("por privacidad quiero que borren mis datos")).toEqual({ kind: "request", right: "cancelacion" });
  });

  it("'quiero cancelar mi cita, mis datos son Ana' sigue siendo la CITA (el verbo debe ir pegado a 'datos')", () => {
    expect(detectArcoIntent("quiero cancelar mi cita, mis datos son Ana")).toBeNull();
    expect(detectArcoIntent("cancelar mi cita y por favor borren mis datos")).toEqual({ kind: "request", right: "cancelacion", conCita: true });
  });
  it("QA-citas-R1-viaje-06: 'ya tienen mis datos... quiero cancelar mi cita' habla de la CITA, no de borrar datos", () => {
    expect(detectArcoIntent("Hola, ya tienen mis datos de la vez pasada. Quiero cancelar mi cita del martes")).toBeNull();
    expect(detectArcoIntent("tienen mis datos, quiero eliminar mi cita del lunes")).toBeNull();
    expect(detectArcoIntent("ya tienen mis datos, me pueden dar de baja mi cita")).toBeNull();
  });

  it("QA-citas-R1-agentes-12: cancelar la cita Y pedir borrar los datos es una solicitud ARCO marcada con cita (la cita no se pierde en silencio)", () => {
    expect(detectArcoIntent("cancelar mi cita y que borren mis datos")).toEqual({ kind: "request", right: "cancelacion", conCita: true });
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

  it.each(["sí", "si", "ok", "no", "confirmo la cita de mañana", "quiero confirmar mi cita", "cancelar"])("«%s» NO confirma ni retira", (text) => {
    expect(detectArcoConfirmation(text)).toBeNull();
  });
});

describe("runArcoFastPath -- flujo guiado de punta a punta (repositorio en memoria)", () => {
  let repo: InMemoryCitasRepository;
  beforeEach(() => {
    repo = new InMemoryCitasRepository();
    repo.seedTenantConfig({ organizationId: ORG, defaultTimezone: "America/Mexico_City" });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("mensaje no ARCO -> null (sigue al agente)", async () => {
    expect(await runArcoFastPath(repo, ORG, PHONE, "Quiero agendar una cita")).toBeNull();
    expect(repo.dataRightsRequests).toHaveLength(0);
  });

  it("solicitud nueva: registra pendiente_confirmacion para ESE teléfono y pide CONFIRMO, sin exponer datos", async () => {
    const result = await runArcoFastPath(repo, ORG, PHONE, "Quiero acceso a mis datos personales");
    expect(result?.reply).toContain("CONFIRMO");
    expect(result?.reply).toContain("acceso");
    expect(repo.dataRightsRequests).toHaveLength(1);
    expect(repo.dataRightsRequests[0]).toMatchObject({ organizationId: ORG, customerPhone: PHONE, rightType: "acceso", status: "pendiente_confirmacion", channel: "whatsapp" });
    expect(result?.reply).not.toContain(PHONE);
  });

  it("QA-citas-R1-agentes-12: 'cancelar mi cita y que borren mis datos' registra la solicitud y avisa que la cita sigue como estaba", async () => {
    const result = await runArcoFastPath(repo, ORG, PHONE, "cancelar mi cita y que borren mis datos");
    expect(result?.reply).toContain("CONFIRMO");
    expect(result?.reply).toContain("Tu cita no se modificó con esta solicitud");
    expect(repo.dataRightsRequests).toHaveLength(1);
    expect(repo.dataRightsRequests[0]).toMatchObject({ rightType: "cancelacion", status: "pendiente_confirmacion" });
  });

  it("QA-citas-R1-viaje-06: 'ya tienen mis datos... quiero cancelar mi cita' no registra nada y sigue al agente", async () => {
    expect(await runArcoFastPath(repo, ORG, PHONE, "Hola, ya tienen mis datos de la vez pasada. Quiero cancelar mi cita del martes")).toBeNull();
    expect(repo.dataRightsRequests).toHaveLength(0);
  });

  it("repetir el mismo derecho es idempotente (no abre una segunda solicitud)", async () => {
    await runArcoFastPath(repo, ORG, PHONE, "Quiero acceso a mis datos personales");
    await runArcoFastPath(repo, ORG, PHONE, "Quiero acceso a mis datos personales otra vez");
    expect(repo.dataRightsRequests).toHaveLength(1);
  });

  it("CONFIRMO desde el mismo número: queda recibida con plazos de 20 y 35 días y respuesta con fechas", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-30T15:00:00Z"));
    await runArcoFastPath(repo, ORG, PHONE, "Quiero rectificar mis datos personales");
    const result = await runArcoFastPath(repo, ORG, PHONE, "CONFIRMO");
    const row = repo.dataRightsRequests[0]!;
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
    expect(result?.reply).toContain("retiré tu solicitud");
    expect(repo.dataRightsRequests[0]!.status).toBe("cancelada_titular");
  });

  it("CONFIRMO sin solicitud pendiente de ESE teléfono -> null (puede ser otra conversación)", async () => {
    await runArcoFastPath(repo, ORG, PHONE, "Quiero acceso a mis datos personales");
    expect(await runArcoFastPath(repo, ORG, "+5219990000000", "CONFIRMO")).toBeNull();
    expect(repo.dataRightsRequests[0]!.status).toBe("pendiente_confirmacion");
  });

  it("una confirmación de más de 24 h ya no aplica", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-30T15:00:00Z"));
    await runArcoFastPath(repo, ORG, PHONE, "Quiero acceso a mis datos personales");
    vi.setSystemTime(new Date("2026-10-01T16:00:00Z"));
    expect(await runArcoFastPath(repo, ORG, PHONE, "CONFIRMO")).toBeNull();
    expect(repo.dataRightsRequests[0]!.status).toBe("pendiente_confirmacion");
  });

  it("pedir datos de otra persona no registra nada", async () => {
    const result = await runArcoFastPath(repo, ORG, PHONE, "Quiero los datos personales de mi esposa");
    expect(result?.reply).toContain("solo puedo recibir solicitudes sobre los datos personales asociados a este mismo número");
    expect(repo.dataRightsRequests).toHaveLength(0);
  });

  it("organizaciones distintas no se mezclan", async () => {
    await runArcoFastPath(repo, ORG, PHONE, "Quiero acceso a mis datos personales");
    expect(await runArcoFastPath(repo, "00000000-0000-0000-0000-0000000000a2", PHONE, "CONFIRMO")).toBeNull();
  });

  it("el detalle guardado va redactado (tarjetas) y acotado", async () => {
    await runArcoFastPath(repo, ORG, PHONE, "Quiero acceso a mis datos personales, mi tarjeta es 4111 1111 1111 1111");
    expect(repo.dataRightsRequests[0]!.detail).toContain("[tarjeta oculta]");
    expect(repo.dataRightsRequests[0]!.detail).not.toContain("4111");
  });

  it("base sin migrar: devuelve null y el mensaje sigue al agente (nunca promete un seguimiento inexistente)", async () => {
    repo.dataRightsMigrationPending = true;
    expect(await runArcoFastPath(repo, ORG, PHONE, "Quiero acceso a mis datos personales")).toBeNull();
    expect(await runArcoFastPath(repo, ORG, PHONE, "CONFIRMO")).toBeNull();
  });
});
