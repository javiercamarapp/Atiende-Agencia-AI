// Barredor de turnos HUERFANOS del turno asincrono de WhatsApp (cerebro v2): con el 200 a Meta al terminar la fase A, un turno cuya funcion murio ya no lo
// reintenta Meta. `/internal/restaurantes/whatsapp/turnos-huerfanos` (y el propio webhook, en segundo plano, para su organizacion) reclama esos mensajes
// (migracion 192, aqui inyectada) y los re-ejecuta con `responderTrasEspera`: contesta lo pendiente una sola vez.
import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { recibirMensajeConEspera, LEASE_TURNO_ASINCRONO_SEGUNDOS, type TurnoHuerfano, type WhatsAppTurnHandler } from "@atiende/domain-restaurantes";
import { buildApp } from "../src/app.ts";
import { buildTestDeps, TEST_ENV } from "./fixtures.ts";

const RUTA = "/internal/restaurantes/whatsapp/turnos-huerfanos";
const TEL = "+5219991234567";

function signedPostInit(bodyObject: unknown): RequestInit {
  const raw = JSON.stringify(bodyObject);
  const bytes = new TextEncoder().encode(raw);
  const signature = `sha256=${createHmac("sha256", TEST_ENV.whatsappAppSecret).update(bytes).digest("hex")}`;
  return { method: "POST", body: raw, headers: { "content-type": "application/json", "content-length": String(bytes.byteLength), "x-hub-signature-256": signature } };
}

async function setup(reclamar: (opts: { organizationId?: string | null; todas: boolean; limite: number }) => Promise<readonly TurnoHuerfano[] | null>) {
  const base = await buildTestDeps();
  base.restaurantesRepo.seedWhatsAppBranchChannel(base.organizationId, base.propertyId, "pn-t7");
  await base.restaurantesRepo.upsertWhatsAppAgentConfig(base.organizationId, null, { perfil: "taqueria_pm", agentName: null, businessName: null, toneStyle: null, deliveryTimeText: null });
  const vistos: Array<{ mensajes: string[]; turnoAsincrono: boolean | undefined }> = [];
  const handler: WhatsAppTurnHandler = {
    async handleInboundMessage({ messages, turnoAsincrono }) {
      vistos.push({ mensajes: messages.map((m) => m.content), turnoAsincrono });
      return { reply: `respuesta ${vistos.length}`, orderId: null, propertyId: null };
    },
  };
  const tareas: Array<Promise<unknown>> = [];
  const app = buildApp({
    ...base.deps,
    turnHandler: handler,
    reclamarTurnosHuerfanos: (_db, opts) => reclamar(opts),
    turnoAsincrono: async () => true,
    enSegundoPlano: (p) => void tareas.push(p),
  });
  return { ...base, app, vistos, tareas };
}

const salida = (repo: Awaited<ReturnType<typeof setup>>["restaurantesRepo"]) => repo.getOutbox().map((o) => (o.payload as { body: string }).body);
const conSecreto = { method: "POST", headers: { "x-atiende-internal-secret": TEST_ENV.internalSecret } } as const;

describe("barredor de turnos huerfanos de WhatsApp", () => {
  it("sin el secreto interno responde 401 y no reclama nada", async () => {
    const reclamar = vi.fn(async () => []);
    const s = await setup(reclamar);
    expect((await s.app.request(RUTA, { method: "GET" })).status).toBe(401);
    expect(reclamar).not.toHaveBeenCalled();
  });

  it("re-ejecuta un huerfano (fase A confirmada, la funcion murio antes del turno) y contesta UNA vez aunque se barra dos veces", async () => {
    let huerfano: TurnoHuerfano | null = null;
    const s = await setup(async () => (huerfano ? [huerfano] : []));
    // Fase A confirmada y la funcion "muere": nadie corre la fase B.
    await recibirMensajeConEspera(s.restaurantesRepo, { organizationId: s.organizationId, messageId: "wamid.h1", phone: TEL, body: "Quiero 3 de pastor", leaseSegundos: LEASE_TURNO_ASINCRONO_SEGUNDOS });
    huerfano = { organizationId: s.organizationId, messageId: "wamid.h1", phone: TEL, propertyId: s.propertyId, phoneNumberId: "pn-t7" };
    const ahora = Date.now();
    const reloj = vi.spyOn(Date, "now").mockReturnValue(ahora + (LEASE_TURNO_ASINCRONO_SEGUNDOS + 1) * 1000); // el lease del turno ya vencio
    try {
      const r = await s.app.request(RUTA, conSecreto);
      expect(r.status).toBe(200);
      expect(await r.json()).toMatchObject({ ok: true, status: "ok", retomados: 1 });
      expect(s.vistos).toEqual([{ mensajes: ["Quiero 3 de pastor"], turnoAsincrono: true }]);
      expect(salida(s.restaurantesRepo)).toEqual(["respuesta 1"]);
      // Un segundo barrido que vuelve a ver el mismo mensaje (p. ej. dos barredores a la vez) no contesta otra vez: ya no hay pendientes.
      expect((await s.app.request(RUTA, conSecreto)).status).toBe(200);
      expect(s.vistos).toHaveLength(1);
      expect(salida(s.restaurantesRepo)).toEqual(["respuesta 1"]);
    } finally {
      reloj.mockRestore();
    }
  });

  it("si otro mensaje tiene el turno de la conversacion, no contesta y deja el huerfano para el siguiente barrido", async () => {
    const s = await setup(async () => [{ organizationId: s.organizationId, messageId: "wamid.h2", phone: TEL, propertyId: s.propertyId, phoneNumberId: "pn-t7" }]);
    await recibirMensajeConEspera(s.restaurantesRepo, { organizationId: s.organizationId, messageId: "wamid.h2", phone: TEL, body: "Hola", leaseSegundos: LEASE_TURNO_ASINCRONO_SEGUNDOS });
    // El lease sigue vigente (otro dueno vivo): no se corre el turno.
    const r = await s.app.request(RUTA, conSecreto);
    expect(r.status).toBe(200);
    expect(s.vistos).toHaveLength(0);
    // Queda reclamable (failed) para el siguiente barrido.
    await expect(s.restaurantesRepo.claimWhatsAppMessage(s.organizationId, "wamid.h2", "x".repeat(64))).resolves.toBe(true);
  });

  it("sin la migracion 192 responde 200 con not_available (nunca 500)", async () => {
    const s = await setup(async () => null);
    const r = await s.app.request(RUTA, conSecreto);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, status: "not_available", retomados: 0 });
  });

  it("el webhook, en segundo plano y tras su propio turno, barre UN huerfano de SU organizacion", async () => {
    const pedidos: Array<{ organizationId?: string | null; limite: number }> = [];
    const s = await setup(async (opts) => {
      pedidos.push({ organizationId: opts.organizationId, limite: opts.limite });
      return [];
    });
    const payload = { entry: [{ changes: [{ value: { metadata: { phone_number_id: "pn-t7" }, messages: [{ id: "wamid.n1", from: "5219990000001", type: "text", text: { body: "Hola" } }] } }] }] };
    expect((await s.app.request("/v1/restaurantes/whatsapp/webhook", signedPostInit(payload))).status).toBe(200);
    await Promise.all(s.tareas);
    expect(pedidos).toEqual([{ organizationId: s.organizationId, limite: 1 }]);
  });
});
