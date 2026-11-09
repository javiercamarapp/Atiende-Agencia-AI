// Ola 4 (H2): doble cobro de turnos LLM por el lote de Meta.
//
// Meta puede mandar VARIOS mensajes en un mismo POST firmado. La fase 1 del webhook los procesa uno tras otro en UNA
// transaccion, cada uno con un turno del agente (LLM, se paga). La funcion vive 30 s (`maxDuration`): si el lote no cabe,
// Vercel la mata, la transaccion se revierte (incluido el ledger que marcaba cada mensaje como procesado) y Meta reintenta el
// lote COMPLETO -> los turnos que ya se habian pagado se vuelven a correr y a pagar.
//
// Arreglo: el lote se parte por tiempo. Antes de empezar el turno de un mensaje se comprueba que quepa una pasada
// (`PASADA_ESTIMADA_MS`) antes del cierre (`FUNCION_MAX_MS - MARGEN_CIERRE_TURNO_MS`); si no cabe, ese mensaje y los
// siguientes NO se reclaman, la transaccion confirma lo ya hecho y se responde 500 para que Meta reintente: el reintento salta
// por el ledger lo ya procesado y solo corre los turnos pendientes. Cada turno recibe ademas `finTurnoMs` con el fin real de la
// funcion (antes solo tenia su presupuesto propio, que empezaba a contar al iniciar el turno).
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { FUNCION_MAX_MS, MARGEN_CIERRE_TURNO_MS, type WhatsAppTurnHandler } from "@atiende/domain-restaurantes";
import { buildApp } from "../src/app.ts";
import { buildTestDeps, TEST_ENV } from "./fixtures.ts";

function signedPostInit(bodyObject: unknown): RequestInit {
  const raw = JSON.stringify(bodyObject);
  const bytes = new TextEncoder().encode(raw);
  const signature = `sha256=${createHmac("sha256", TEST_ENV.whatsappAppSecret).update(bytes).digest("hex")}`;
  return { method: "POST", body: raw, headers: { "content-type": "application/json", "content-length": String(bytes.byteLength), "x-hub-signature-256": signature } };
}

/** Un POST con `n` mensajes de telefonos distintos (cada uno su conversacion y su turno). */
function lote(n: number) {
  const messages = Array.from({ length: n }, (_, i) => ({ id: `wamid.lote.${i + 1}`, from: `52199912300${i + 1}`, type: "text", text: { body: `Hola ${i + 1}` } }));
  return { entry: [{ changes: [{ value: { metadata: { phone_number_id: "pn-lote" }, messages } }] }] };
}

async function setup(msPorTurno: number) {
  const base = await buildTestDeps();
  base.restaurantesRepo.seedWhatsAppBranchChannel(base.organizationId, base.propertyId, "pn-lote");
  let ahora = 1_000_000;
  const turnos: Array<{ telefono: string; inicioMs: number; finTurnoMs: number | undefined }> = [];
  const handler: WhatsAppTurnHandler = {
    async handleInboundMessage(args) {
      turnos.push({ telefono: args.phone, inicioMs: ahora, finTurnoMs: args.finTurnoMs });
      ahora += msPorTurno; // el turno del LLM tarda esto
      return { reply: `respuesta a ${args.phone}`, orderId: null, propertyId: null };
    },
  };
  const app = buildApp({ ...base.deps, turnHandler: handler, relojMs: () => ahora });
  return { app, turnos, reloj: () => ahora, avanzar: (ms: number) => (ahora += ms) };
}

describe("webhook de restaurantes: el lote de Meta se parte por tiempo (sin doble cobro de turnos)", () => {
  it("con turnos de 10 s, un lote de 3 solo corre los que caben antes del cierre y pide reintento del resto", async () => {
    const { app, turnos, reloj } = await setup(10_000);
    const inicio = reloj();
    const res = await app.request("/v1/restaurantes/whatsapp/webhook", signedPostInit(lote(3)));
    // 0->10 s y 10->20 s caben; el tercero empezaria a los 20 s y 20 + PASADA_ESTIMADA_MS pasa del cierre (30 - 6 = 24 s).
    expect(turnos.map((t) => t.telefono)).toEqual(["+521999123001", "+521999123002"]);
    expect(res.status).toBe(500);
    // Ningun turno arranca tan tarde que no quepa antes de que muera la funcion.
    for (const t of turnos) expect(t.inicioMs - inicio).toBeLessThanOrEqual(FUNCION_MAX_MS - MARGEN_CIERRE_TURNO_MS);
  });

  it("el reintento de Meta (mismo lote) solo corre el turno pendiente: cada mensaje paga UN turno", async () => {
    const { app, turnos, avanzar } = await setup(10_000);
    expect((await app.request("/v1/restaurantes/whatsapp/webhook", signedPostInit(lote(3)))).status).toBe(500);
    avanzar(60_000); // Meta reintenta despues, en otra invocacion
    expect((await app.request("/v1/restaurantes/whatsapp/webhook", signedPostInit(lote(3)))).status).toBe(200);
    expect(turnos.map((t) => t.telefono)).toEqual(["+521999123001", "+521999123002", "+521999123003"]);
  });

  it("cada turno recibe el fin real de la funcion (finTurnoMs = inicio + 30 s - margen de cierre)", async () => {
    const { app, turnos, reloj } = await setup(1_000);
    const inicio = reloj();
    expect((await app.request("/v1/restaurantes/whatsapp/webhook", signedPostInit(lote(2)))).status).toBe(200);
    expect(turnos).toHaveLength(2);
    for (const t of turnos) expect(t.finTurnoMs).toBe(inicio + FUNCION_MAX_MS - MARGEN_CIERRE_TURNO_MS);
  });

  it("un lote que cabe completo se responde 200 como siempre", async () => {
    const { app, turnos } = await setup(2_000);
    expect((await app.request("/v1/restaurantes/whatsapp/webhook", signedPostInit(lote(3)))).status).toBe(200);
    expect(turnos).toHaveLength(3);
  });
});
