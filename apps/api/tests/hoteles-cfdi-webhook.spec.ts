// Segunda mitad del hallazgo P1 de la auditoría de 22 rubros ("wirear el webhook
// del PAC de CFDI") — POST /hoteles/cfdi/webhook. Firma real (HMAC) del adaptador
// simulado (`FakeFinkokAdapter`), nunca requiere una API key real de Finkok/SW
// Sapien. Mismo estilo que whatsapp-webhook.spec.ts (firma sobre bytes crudos,
// rate-limit real, ack idempotente ante reintento).
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { DualPacCfdiPort, FakeFinkokAdapter, FinkokAdapter, SwSapienAdapter } from "@atiende/mcp-cfdi";
import { buildApp } from "../src/app.ts";
import { authedJson, buildHotelesTestContext } from "./hoteles-fixtures.ts";
import type { HotelesTestContext } from "./hoteles-fixtures.ts";

let ctx: HotelesTestContext;

beforeEach(async () => {
  ctx = await buildHotelesTestContext(buildApp);
});

interface CfdiResponse {
  id: string;
  uuidFiscal: string | null;
  estado: string;
}

async function seedHospedajeCharges(context: HotelesTestContext, nights: number) {
  for (let i = 0; i < nights; i++) {
    await context.hotelesRepo.insertCharge({
      organizationId: context.organizationId,
      propertyId: context.propertyId,
      folioId: context.folioId,
      description: `Hospedaje noche ${i + 1}`,
      amount: 1000,
      taxAmount: 190,
      concept: "hospedaje",
      stayDate: `2026-12-0${i + 1}`,
    });
  }
}

/** Timbra un CFDI real (dual-PAC simulado de `ctx.deps`) y devuelve su
 *  `id`/`uuidFiscal` -- el PAC primario simulado de ese fixture es
 *  `FakeFinkokAdapter` (ver hoteles-fixtures.ts), así que cualquier evento
 *  firmado con `FAKE_FINKOK_WEBHOOK_SECRET` (el default de `FakeFinkokAdapter`,
 *  ver fake-pac-adapter.ts) referenciando este `uuidFiscal` es "del mismo PAC que
 *  lo timbró". */
async function emitirCfdiReal(context: HotelesTestContext, app: ReturnType<typeof buildApp>): Promise<CfdiResponse> {
  await seedHospedajeCharges(context, 1);
  const res = await app.request(
    `/hoteles/${context.propertyId}/folios/${context.folioId}/cfdi`,
    authedJson(context.staff.owner.token, { rfcReceptor: "XAXX010101000", usoCfdi: "G03" }, { "idempotency-key": `cfdi-webhook-seed-${randomUUID()}` }),
  );
  expect(res.status).toBe(201);
  return (await res.json()) as CfdiResponse;
}

function pacWebhookPayload(overrides: { eventId?: string; type?: string; uuid: string; status: string; occurredAt?: string }) {
  return {
    event_id: overrides.eventId ?? randomUUID(),
    type: overrides.type ?? "cfdi.cancelado",
    uuid: overrides.uuid,
    status: overrides.status,
    occurred_at: overrides.occurredAt ?? new Date().toISOString(),
  };
}

function signedPacPostInit(payload: Record<string, unknown>, signatureOverride?: string): RequestInit {
  const pac = new FakeFinkokAdapter();
  const { rawBody, signature } = pac.signWebhookFixture(payload);
  const bytes = new TextEncoder().encode(rawBody);
  return {
    method: "POST",
    body: rawBody,
    headers: { "content-type": "application/json", "content-length": String(bytes.byteLength), "x-pac-signature": signatureOverride ?? signature },
  };
}

describe("POST /hoteles/cfdi/webhook -- sin credenciales reales (Finkok/SW Sapien) responde 503 honesto", () => {
  it("con el CfdiPort real (sin env vars de credenciales/secreto) -> 503, nunca 500", async () => {
    const deps = { ...ctx.deps, hotelesCfdiPort: new DualPacCfdiPort(new FinkokAdapter(), new SwSapienAdapter()) };
    const app = buildApp(deps);
    const payload = pacWebhookPayload({ uuid: randomUUID(), status: "cancelado" });
    const res = await app.request("/hoteles/cfdi/webhook", signedPacPostInit(payload));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe("service_unavailable");
    expect(body.message.toLowerCase()).toContain("pac");
  });
});

describe("POST /hoteles/cfdi/webhook -- verificación de firma ANTES de cualquier efecto", () => {
  it("401 con firma inválida, y el CFDI referenciado queda intacto (cero efectos)", async () => {
    const app = buildApp(ctx.deps);
    const emitido = await emitirCfdiReal(ctx, app);

    const payload = pacWebhookPayload({ uuid: emitido.uuidFiscal!, status: "cancelado" });
    const res = await app.request("/hoteles/cfdi/webhook", signedPacPostInit(payload, "sha256=firma-que-no-es"));
    expect(res.status).toBe(401);

    const stillThere = await ctx.hotelesRepo.findCfdiEmision(ctx.propertyId, emitido.id);
    expect(stillThere!.status).toBe("timbrado");
    expect(stillThere!.canceledAt).toBeNull();
  });

  it("401 sin ningún header de firma", async () => {
    const app = buildApp(ctx.deps);
    const emitido = await emitirCfdiReal(ctx, app);
    const payload = pacWebhookPayload({ uuid: emitido.uuidFiscal!, status: "cancelado" });
    const raw = JSON.stringify(payload);
    const res = await app.request("/hoteles/cfdi/webhook", {
      method: "POST",
      body: raw,
      headers: { "content-type": "application/json", "content-length": String(new TextEncoder().encode(raw).byteLength) },
    });
    expect(res.status).toBe(401);
  });
});

describe("POST /hoteles/cfdi/webhook -- evento válido aplica la MISMA transición que consultar-estado", () => {
  it("cfdi.cancelado con firma válida -> 200, actualiza el estado local y sella canceledAt", async () => {
    const app = buildApp(ctx.deps);
    const emitido = await emitirCfdiReal(ctx, app);

    const payload = pacWebhookPayload({ uuid: emitido.uuidFiscal!, status: "cancelado", type: "cfdi.cancelado" });
    const res = await app.request("/hoteles/cfdi/webhook", signedPacPostInit(payload));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; procesado: boolean; estado: string };
    expect(body.ok).toBe(true);
    expect(body.procesado).toBe(true);
    expect(body.estado).toBe("cancelado");

    const stored = await ctx.hotelesRepo.findCfdiEmision(ctx.propertyId, emitido.id);
    expect(stored!.status).toBe("cancelado");
    expect(stored!.canceledAt).not.toBeNull();
  });

  it("cfdi.cancelacion_rechazada NO se persiste (misma decisión deliberada que consultar-estado: nunca inventa una transición que el motivo conocido no sustenta)", async () => {
    const app = buildApp(ctx.deps);
    const emitido = await emitirCfdiReal(ctx, app);

    const payload = pacWebhookPayload({ uuid: emitido.uuidFiscal!, status: "rechazado", type: "cfdi.cancelacion_rechazada" });
    const res = await app.request("/hoteles/cfdi/webhook", signedPacPostInit(payload));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; procesado: boolean; motivo: string };
    expect(body.procesado).toBe(false);
    expect(body.motivo).toBe("transicion_no_persistida");

    const stored = await ctx.hotelesRepo.findCfdiEmision(ctx.propertyId, emitido.id);
    expect(stored!.status).toBe("timbrado");
  });
});

describe("POST /hoteles/cfdi/webhook -- UUID fiscal desconocido no rompe nada", () => {
  it("200 con ack sin efecto para un UUID que esta plataforma nunca vio", async () => {
    const app = buildApp(ctx.deps);
    const payload = pacWebhookPayload({ uuid: randomUUID(), status: "cancelado" });
    const res = await app.request("/hoteles/cfdi/webhook", signedPacPostInit(payload));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; procesado: boolean; motivo: string };
    expect(body.ok).toBe(true);
    expect(body.procesado).toBe(false);
    expect(body.motivo).toBe("uuid_desconocido");
  });
});

describe("POST /hoteles/cfdi/webhook -- idempotencia: el MISMO evento dos veces no duplica efectos", () => {
  it("reenviar el mismo event_id/firma no vuelve a mover canceledAt ni re-cancela", async () => {
    const app = buildApp(ctx.deps);
    const emitido = await emitirCfdiReal(ctx, app);
    const payload = pacWebhookPayload({ uuid: emitido.uuidFiscal!, status: "cancelado", eventId: "evt-replay-1" });
    const init = signedPacPostInit(payload);

    const first = await app.request("/hoteles/cfdi/webhook", init);
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { procesado: boolean };
    expect(firstBody.procesado).toBe(true);
    const afterFirst = await ctx.hotelesRepo.findCfdiEmision(ctx.propertyId, emitido.id);
    const canceledAtFirst = afterFirst!.canceledAt;
    expect(canceledAtFirst).not.toBeNull();

    // Reintento real del PAC del MISMO evento -- el replay guard del propio
    // CfdiPort (InMemoryReplayGuard) lo detecta: ack idempotente, sin volver a
    // tocar la base de datos.
    const second = await app.request("/hoteles/cfdi/webhook", init);
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { ok: boolean; procesado: boolean; motivo: string };
    expect(secondBody.procesado).toBe(false);
    expect(secondBody.motivo).toBe("evento_repetido");

    const afterSecond = await ctx.hotelesRepo.findCfdiEmision(ctx.propertyId, emitido.id);
    expect(afterSecond!.status).toBe("cancelado");
    expect(afterSecond!.canceledAt).toBe(canceledAtFirst);
  });

  it("dos eventos DISTINTOS (event_id distinto) para el mismo status SÍ son ambos no-ops seguros a nivel de datos (nunca mueven canceledAt dos veces)", async () => {
    const app = buildApp(ctx.deps);
    const emitido = await emitirCfdiReal(ctx, app);

    const first = await app.request("/hoteles/cfdi/webhook", signedPacPostInit(pacWebhookPayload({ uuid: emitido.uuidFiscal!, status: "cancelado", eventId: "evt-a" })));
    expect(first.status).toBe(200);
    const canceledAtFirst = (await ctx.hotelesRepo.findCfdiEmision(ctx.propertyId, emitido.id))!.canceledAt;

    // Un SEGUNDO evento del PAC, con `event_id` DISTINTO pero el MISMO status
    // (p. ej. una notificación de confirmación repetida por el PAC) -- el replay
    // guard del puerto NO lo detiene (event_id distinto), pero la transición de
    // `applyCfdiWebhookStatus` sigue siendo idempotente a nivel de datos: nunca
    // vuelve a mover `canceledAt` porque el status YA era 'cancelado'.
    const second = await app.request("/hoteles/cfdi/webhook", signedPacPostInit(pacWebhookPayload({ uuid: emitido.uuidFiscal!, status: "cancelado", eventId: "evt-b" })));
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { procesado: boolean };
    expect(secondBody.procesado).toBe(true);

    const canceledAtSecond = (await ctx.hotelesRepo.findCfdiEmision(ctx.propertyId, emitido.id))!.canceledAt;
    expect(canceledAtSecond).toBe(canceledAtFirst);
  });
});

// El backend en memoria de @atiende/core-ratelimit se resetea antes de cada test
// (ver test-setup/reset-rate-limiter.ts) para que este límite no interfiera con
// el resto de la suite de este archivo.
describe("POST /hoteles/cfdi/webhook -- rate limiting real (conversation:inbound-webhook, por IP)", () => {
  it("más de 60 notificaciones válidas en la misma ventana desde la misma IP responde 429", async () => {
    const app = buildApp(ctx.deps);

    let lastStatus = 0;
    for (let i = 0; i < 61; i += 1) {
      // UUID desconocido a propósito en cada intento -- lo único que importa aquí
      // es que el conteo del rate limiter ocurre para tráfico YA verificado
      // (firma válida), nunca antes.
      const payload = pacWebhookPayload({ uuid: randomUUID(), status: "cancelado", eventId: `evt-ratelimit-${i}` });
      const res = await app.request("/hoteles/cfdi/webhook", signedPacPostInit(payload));
      lastStatus = res.status;
      if (i < 60) expect(res.status).toBe(200);
    }
    expect(lastStatus).toBe(429);
  });
});
