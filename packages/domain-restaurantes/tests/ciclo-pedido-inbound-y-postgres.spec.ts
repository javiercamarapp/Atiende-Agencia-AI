// F4b -- (1) la respuesta a la encuesta entra por el inbound de WhatsApp SIN pasar por el agente (y un texto de alto riesgo o un toque de boton NO se toma como
// respuesta); (2) el adaptador Postgres degrada con SAVEPOINT contra la base sin migrar y traduce los SQLSTATE de las funciones 170 a 172.
import { describe, expect, it } from "vitest";
import { PostgresCicloPedidoRepository } from "../src/ciclo-pedido/postgres-repository.ts";
import { CicloAccesoError, CicloConflictoError, CicloNoDisponibleError, CicloNoEncontradoError, CicloValidacionError } from "../src/ciclo-pedido/tipos.ts";
import { handleInboundWhatsAppMessage } from "../src/whatsapp/inbound.ts";
import type { WhatsAppTurnHandler } from "../src/whatsapp/turn-handler.ts";
import { buildRestaurantFixture } from "./fixtures.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

const PHONE = "+5219991234567";

function setupInbound(respuesta: string | null) {
  const fixture = buildRestaurantFixture();
  let turnos = 0;
  const llamadas: string[] = [];
  const turnHandler: WhatsAppTurnHandler = {
    async handleInboundMessage() {
      turnos += 1;
      return { reply: "Respuesta del agente", orderId: null, propertyId: null };
    },
  };
  const enviar = (messageId: string, body: string, extra: { botonId?: string } = {}) =>
    handleInboundWhatsAppMessage(fixture.repo, turnHandler, {
      organizationId: fixture.organizationId,
      messageId,
      phone: PHONE,
      body,
      phoneNumberId: "PNID",
      propertyId: fixture.propertyId,
      encuesta: async (_org, _phone, texto) => {
        llamadas.push(texto);
        return respuesta;
      },
      ...extra,
    });
  return { fixture, enviar, turnos: () => turnos, llamadas };
}

describe("encuesta en el inbound de WhatsApp", () => {
  it("si el mensaje es respuesta de la encuesta se contesta con texto fijo, SIN llamar al agente, y queda en el hilo y en el outbox", async () => {
    const t = setupInbound("¡Gracias por su calificación!");
    const out = await t.enviar("e1", "5");
    expect(out).toMatchObject({ ok: true, reply: "¡Gracias por su calificación!" });
    expect(t.turnos()).toBe(0);
    const fila = t.fixture.repo.getOutbox().find((x) => x.dedupeKey === "inbound-reply:e1")!;
    expect(fila.payload).toMatchObject({ to: PHONE, phone_number_id: "PNID", body: "¡Gracias por su calificación!" });
  });

  it("si no es de la encuesta (null) el turno sigue al agente como siempre", async () => {
    const t = setupInbound(null);
    const out = await t.enviar("e2", "Hola, ¿tienen tacos?");
    expect(out).toMatchObject({ ok: true, reply: "Respuesta del agente" });
    expect(t.turnos()).toBe(1);
    expect(t.llamadas).toEqual(["Hola, ¿tienen tacos?"]);
  });

  it("un texto de alto riesgo (queja con alergia) o un toque de boton nunca se ofrece a la encuesta", async () => {
    const t = setupInbound("no debe usarse");
    const out = await t.enviar("e3", "Me dio una reacción alérgica con la salsa, estoy en el hospital");
    expect(out).toMatchObject({ ok: true });
    expect(t.llamadas).toEqual([]);
    expect((out as { reply?: string }).reply).not.toBe("no debe usarse");
    await t.enviar("e4", "Confirmar pedido", { botonId: "resumen:abc" });
    expect(t.llamadas).toEqual([]);
  });

  it("si la funcion de encuesta lanza, el mensaje NO se pierde: pasa al agente", async () => {
    const fixture = buildRestaurantFixture();
    const turnHandler: WhatsAppTurnHandler = { async handleInboundMessage() { return { reply: "Respuesta del agente", orderId: null, propertyId: null }; } };
    const out = await handleInboundWhatsAppMessage(fixture.repo, turnHandler, {
      organizationId: fixture.organizationId,
      messageId: "e5",
      phone: PHONE,
      body: "4",
      phoneNumberId: "PNID",
      propertyId: fixture.propertyId,
      encuesta: async () => {
        throw new Error("falla de la encuesta");
      },
    });
    expect(out).toMatchObject({ ok: true, reply: "Respuesta del agente" });
  });
});

function pgError(code: string, message = code === "42883" ? "function restaurantes.funcion_de_prueba(uuid) does not exist" : "error de prueba"): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}
const ORG = "00000000-0000-0000-0000-00000000a001";
const PROP = "00000000-0000-0000-0000-00000000c001";
const ORD = "6129984c-4f5e-4a0f-9b7e-0d4d8a1b2c01";

describe("PostgresCicloPedidoRepository contra la base sin migrar y errores de regla", () => {
  it("las lecturas degradan a 'no disponible' con funcion o tabla ausente (42883 / 42P01) y la sesion sigue utilizable", async () => {
    const s = new AbortAwareFakeSession([
      { match: /operacion_tiempos/, respond: () => pgError("42883") },
      { match: /encuesta_metricas/, respond: () => pgError("42P01") },
      { match: /recordatorios_pedido_candidatos/, respond: () => pgError("42703") },
      { match: /select 1 as vivo/, respond: () => [{ vivo: 1 }] },
    ]);
    const repo = new PostgresCicloPedidoRepository(s);
    expect(await repo.tiempos(ORG, PROP, new Date(0), new Date(1000))).toEqual({ disponible: false, valor: null });
    expect(await repo.metricasEncuesta(ORG, PROP, new Date(0), new Date(1000))).toEqual({ disponible: false, valor: null });
    expect(await repo.candidatosRecordatorio(new Date(0))).toEqual({ disponible: false, valor: [] });
    // sin ROLLBACK TO SAVEPOINT la transaccion habria quedado abortada (25P02)
    await expect(s.query("select 1 as vivo")).resolves.toEqual({ rows: [{ vivo: 1 }] });
  });

  it("las escrituras contra la base sin migrar lanzan CicloNoDisponibleError (503), no un 500", async () => {
    const s = new AbortAwareFakeSession([{ match: /pedido_aceptar/, respond: () => pgError("42883") }, { match: /encuesta_reservar/, respond: () => pgError("42P01") }]);
    const repo = new PostgresCicloPedidoRepository(s);
    await expect(repo.aceptar(ORG, ORD, 30)).rejects.toBeInstanceOf(CicloNoDisponibleError);
    await expect(repo.reservarEncuesta(ORG, ORD, "a".repeat(64), "enviada", null, "texto")).rejects.toBeInstanceOf(CicloNoDisponibleError);
  });

  it("traduce 42501 / P0404 / P0409 / 22023 / P0422 a errores tipados y deja la sesion utilizable", async () => {
    const s = new AbortAwareFakeSession([
      { match: /pedido_aceptar/, respond: () => pgError("42501") },
      { match: /pedido_rechazar/, respond: () => pgError("P0404") },
      { match: /pedido_entregar_staff/, respond: () => pgError("P0409") },
      { match: /encuesta_responder/, respond: () => pgError("22023") },
      { match: /despachar_pedido/, respond: () => pgError("P0422") },
      { match: /select 1 as vivo/, respond: () => [{ vivo: 1 }] },
    ]);
    const repo = new PostgresCicloPedidoRepository(s);
    await expect(repo.aceptar(ORG, ORD, 30)).rejects.toBeInstanceOf(CicloAccesoError);
    await expect(repo.rechazar(ORG, ORD, "otro", null)).rejects.toBeInstanceOf(CicloNoEncontradoError);
    await expect(repo.entregarStaff(ORG, ORD, null, null)).rejects.toBeInstanceOf(CicloConflictoError);
    await expect(repo.responderEncuesta(ORG, "a".repeat(64), 9, new Date(0))).rejects.toBeInstanceOf(CicloValidacionError);
    await expect(repo.despachar(ORG, ORD, ORD, 30)).rejects.toBeInstanceOf(CicloValidacionError);
    await expect(s.query("select 1 as vivo")).resolves.toEqual({ rows: [{ vivo: 1 }] });
  });

  it("mapea la respuesta de las funciones: aceptar, candidatas de encuesta y candidatos de recordatorio", async () => {
    const s = new AbortAwareFakeSession([
      { match: /pedido_aceptar/, respond: () => [{ r: { resultado: "aceptado", estado: "preparando", aceptado_at: "2026-10-20T18:00:00.000Z", tiempo_prometido_min: 45 } }] },
      {
        match: /encuesta_candidatas/,
        respond: () => [
          {
            order_id: ORD, organization_id: ORG, property_id: PROP, customer_phone: "9991230001", delivered_at: "2026-10-20T15:00:00.000Z", zona_horaria: "America/Merida",
            phone_hash: "b".repeat(64), ultimo_entrante_at: null, ultima_encuesta_at: null, opt_out: false, consentimiento: true,
          },
        ],
      },
      { match: /recordatorios_pedido_candidatos/, respond: () => [{ order_id: ORD, organization_id: ORG, property_id: PROP, order_number: "101", numero_recordatorio: 2, maximo: 3, minutos: 21 }] },
    ]);
    const repo = new PostgresCicloPedidoRepository(s);
    expect(await repo.aceptar(ORG, ORD, 45)).toEqual({ resultado: "aceptado", aceptadoAt: "2026-10-20T18:00:00.000Z", tiempoPrometidoMin: 45 });
    const c = await repo.candidatasEncuesta(new Date(0), 10);
    expect(c.disponible).toBe(true);
    expect(c.valor[0]).toMatchObject({ orderId: ORD, customerPhone: "9991230001", consentimiento: true, optOut: false, ultimoEntranteAt: null });
    const r = await repo.candidatosRecordatorio(new Date(0));
    expect(r.valor[0]).toEqual({ orderId: ORD, organizationId: ORG, propertyId: PROP, orderNumber: 101, numeroRecordatorio: 2, maximo: 3, minutos: 21 });
  });
});
