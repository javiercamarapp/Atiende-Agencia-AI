import { describe, expect, it } from "vitest";
import { ESTADOS_ENTREGA, avanzarEstadoEntrega, extractMetaStatuses, motivoFalloEntrega } from "../src/statuses.ts";
import type { EstadoEntrega } from "../src/statuses.ts";

const PNID = "106540352242922";

/** Forma documentada por Meta (WhatsApp Cloud API, webhook `messages`, objeto `statuses`). Sin telefonos reales. */
function payload(statuses: unknown[], phoneNumberId: string | null = PNID): unknown {
  return {
    object: "whatsapp_business_account",
    entry: [{ id: "WABA-ID", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { display_phone_number: "15550000000", ...(phoneNumberId ? { phone_number_id: phoneNumberId } : {}) }, statuses } }] }],
  };
}

describe("extractMetaStatuses", () => {
  it("delivered y read: wamid, estado, momento y destinatario; sin texto de mensaje", () => {
    const r = extractMetaStatuses(payload([
      { id: "wamid.HBgLAAA", status: "delivered", timestamp: "1700000000", recipient_id: "15551230000", conversation: { id: "c1", origin: { type: "service" } }, pricing: { billable: true } },
      { id: "wamid.HBgLAAA", status: "read", timestamp: "1700000060", recipient_id: "15551230000" },
    ]));
    expect(r).toEqual([
      { phoneNumberId: PNID, wamid: "wamid.HBgLAAA", status: "delivered", occurredAt: "2023-11-14T22:13:20.000Z", recipientId: "15551230000", errorCode: null, errorTitle: null },
      { phoneNumberId: PNID, wamid: "wamid.HBgLAAA", status: "read", occurredAt: "2023-11-14T22:14:20.000Z", recipientId: "15551230000", errorCode: null, errorTitle: null },
    ]);
    expect(JSON.stringify(r)).not.toMatch(/body|text/);
  });

  it("failed con errors[]: codigo y titulo del primer error", () => {
    const r = extractMetaStatuses(payload([
      { id: "wamid.F1", status: "failed", timestamp: "1700000100", recipient_id: "15551230000", errors: [{ code: 131047, title: "Re-engagement message", message: "Re-engagement message", error_data: { details: "Message failed to send because more than 24 hours have passed since the customer last replied to this number." } }, { code: 1, title: "otro" }] },
    ]));
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ status: "failed", errorCode: 131047, errorTitle: "Re-engagement message" });
  });

  it("un failed sin errors[] queda con codigo null; el error de un estado no-failed se descarta", () => {
    const r = extractMetaStatuses(payload([
      { id: "w1", status: "failed", timestamp: "1700000100" },
      { id: "w2", status: "delivered", timestamp: "1700000100", errors: [{ code: 5, title: "x" }] },
    ]));
    expect(r[0]).toMatchObject({ errorCode: null, errorTitle: null });
    expect(r[1]).toMatchObject({ errorCode: null });
  });

  it("batch mixto mensajes + statuses: solo devuelve los statuses; y un payload solo de mensajes devuelve []", () => {
    const mixto = { entry: [{ changes: [
      { value: { metadata: { phone_number_id: PNID }, messages: [{ id: "wamid.IN", from: "15551230000", type: "text", text: { body: "hola" } }], statuses: [{ id: "wamid.OUT", status: "sent", timestamp: "1700000000" }] } },
    ] }] };
    expect(extractMetaStatuses(mixto).map((s) => s.wamid)).toEqual(["wamid.OUT"]);
    expect(extractMetaStatuses({ entry: [{ changes: [{ value: { metadata: { phone_number_id: PNID }, messages: [{ id: "x", from: "1", type: "text", text: { body: "a" } }] } }] }] })).toEqual([]);
  });

  it("cada change conserva SU phone_number_id (un status de otro numero no se mezcla)", () => {
    const dos = { entry: [{ changes: [
      { value: { metadata: { phone_number_id: "AAA" }, statuses: [{ id: "w1", status: "sent" }] } },
      { value: { metadata: { phone_number_id: "BBB" }, statuses: [{ id: "w2", status: "sent" }] } },
      { value: { statuses: [{ id: "w3", status: "sent" }] } },
    ] }] };
    expect(extractMetaStatuses(dos).map((s) => [s.wamid, s.phoneNumberId])).toEqual([["w1", "AAA"], ["w2", "BBB"], ["w3", null]]);
  });

  it("ignora sin lanzar estados desconocidos, ids invalidos y elementos que no son objetos", () => {
    const r = extractMetaStatuses(payload([null, "x", 7, { id: "", status: "sent" }, { id: "a".repeat(256), status: "sent" }, { id: "w", status: "deleted" }, { id: "w", status: "warning" }, { id: 5, status: "sent" }, { id: "ok", status: "sent", timestamp: "no-es-numero" }]));
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ wamid: "ok", occurredAt: null });
  });

  it("payloads con otra forma no lanzan", () => {
    for (const p of [null, undefined, 5, "x", {}, { entry: "x" }, { entry: [null] }, { entry: [{ changes: "x" }] }, { entry: [{ changes: [null, { value: null }, { value: { statuses: "x" } }] }] }]) {
      expect(extractMetaStatuses(p)).toEqual([]);
    }
  });
});

describe("avanzarEstadoEntrega", () => {
  it("avanza sent -> delivered -> read y nunca retrocede", () => {
    expect(avanzarEstadoEntrega(null, "sent")).toBe("sent");
    expect(avanzarEstadoEntrega("sent", "delivered")).toBe("delivered");
    expect(avanzarEstadoEntrega("delivered", "read")).toBe("read");
    expect(avanzarEstadoEntrega("read", "delivered")).toBe("read");
    expect(avanzarEstadoEntrega("read", "sent")).toBe("read");
    expect(avanzarEstadoEntrega("delivered", "sent")).toBe("delivered");
  });

  it("failed gana sobre todo y es terminal; repetir un estado no cambia nada", () => {
    for (const e of ESTADOS_ENTREGA) {
      expect(avanzarEstadoEntrega(e as EstadoEntrega, "failed")).toBe("failed");
      expect(avanzarEstadoEntrega("failed", e as EstadoEntrega)).toBe("failed");
      expect(avanzarEstadoEntrega(e as EstadoEntrega, e as EstadoEntrega)).toBe(e);
    }
  });
});

describe("motivoFalloEntrega", () => {
  it("clasifica los codigos de Meta que importan", () => {
    expect(motivoFalloEntrega(131047)).toBe("fuera_de_ventana");
    expect(motivoFalloEntrega(131026)).toBe("numero_no_entregable");
    expect(motivoFalloEntrega(131049)).toBe("limite_marketing");
    expect(motivoFalloEntrega(132001)).toBe("plantilla");
    expect(motivoFalloEntrega(132015)).toBe("plantilla");
    expect(motivoFalloEntrega(500)).toBe("otro");
    expect(motivoFalloEntrega(null)).toBe("otro");
  });
});
