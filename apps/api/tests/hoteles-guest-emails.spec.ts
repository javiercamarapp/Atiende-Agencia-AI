// Fase 12 hoteles (hallazgo ALTA, verificado directamente contra el código):
// "Hoteles no envía ningún correo/notificación al huésped". Estos tests ejercitan
// los 3 puntos REALES del ciclo de vida donde ahora se encola un correo real
// (channel='email' de hoteles.messaging_outbox) — confirmación de reserva, recibo
// de folio, y aviso de CFDI timbrado — a diferencia de los specs existentes de
// reservas/folios/cfdi (que usan huéspedes/reservas de fixture SIN guestId real
// ligado, y por tanto nunca disparaban este correo).
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { authedJson, buildHotelesTestContext } from "./hoteles-fixtures.ts";
import type { HotelesTestContext } from "./hoteles-fixtures.ts";

interface ReservaBody {
  id: string;
}

interface FolioResumenBody {
  id: string;
  esPrincipal: boolean;
}

async function crearReservaConHuesped(ctx: HotelesTestContext, app: ReturnType<typeof buildApp>, key: string) {
  const res = await app.request(
    `/hoteles/${ctx.propertyId}/reservas`,
    authedJson(ctx.staff.owner.token, { roomTypeId: ctx.roomTypeId, checkInDate: "2026-12-01", checkOutDate: "2026-12-03", guestId: ctx.guestId }, { "idempotency-key": key }),
  );
  expect(res.status).toBe(201);
  const reserva = (await res.json()) as ReservaBody;
  const folios = await app.request(`/hoteles/${ctx.propertyId}/reservas/${reserva.id}/folios`, authedJson(ctx.staff.owner.token));
  const [folio] = (await folios.json()) as FolioResumenBody[];
  return { reservationId: reserva.id, folioId: folio!.id };
}

describe("POST /hoteles/:propertyId/reservas — confirmación de reserva real por correo", () => {
  it("con guestId real (con correo en archivo): encola un correo real 'reservation.created'", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const { reservationId } = await crearReservaConHuesped(ctx, app, "k-email-reserva-1");

    const job = ctx.hotelesRepo.getOutbox().find((o) => o.channel === "email" && o.eventType === "reservation.created");
    expect(job).toBeDefined();
    expect(job!.dedupeKey).toBe(`reservation-created:${reservationId}`);
    const payload = job!.payload as { to: string; subject: string; html: string };
    expect(payload.to).toBe("ana.torres@example.com");
    expect(payload.subject).toContain("Reserva confirmada");
    expect(payload.html).toContain("Ana Torres");
    expect(payload.html).toContain("Habitación Doble Vista al Mar");
  });

  it("sin guestId (walk-in): NUNCA encola un correo (no hay a quién mandárselo), y la reserva se crea igual", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(
      `/hoteles/${ctx.propertyId}/reservas`,
      authedJson(ctx.staff.owner.token, { roomTypeId: ctx.roomTypeId, checkInDate: "2026-12-01", checkOutDate: "2026-12-02" }, { "idempotency-key": "k-email-reserva-2" }),
    );
    expect(res.status).toBe(201);
    expect(ctx.hotelesRepo.getOutbox().filter((o) => o.channel === "email")).toHaveLength(0);
  });
});

describe("POST /hoteles/:propertyId/folios/:folioId/cerrar — recibo real de folio por correo", () => {
  it("al cerrar como saldo_cero, encola un correo real 'folio.closed' con los totales reales", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const { folioId } = await crearReservaConHuesped(ctx, app, "k-email-folio-1");

    const cargo = await app.request(
      `/hoteles/${ctx.propertyId}/folios/${folioId}/cargos`,
      authedJson(ctx.staff.owner.token, { descripcion: "Hospedaje", monto: 1000, concepto: "hospedaje" }, { "idempotency-key": "k-email-folio-1-cargo" }),
    );
    expect(cargo.status).toBe(201);
    const cargoBody = (await cargo.json()) as { monto: number; impuesto: number };
    const totalCargo = cargoBody.monto + cargoBody.impuesto;

    const pago = await app.request(
      `/hoteles/${ctx.propertyId}/folios/${folioId}/pagos`,
      authedJson(ctx.staff.owner.token, { monto: totalCargo, metodo: "efectivo" }, { "idempotency-key": "k-email-folio-1-pago" }),
    );
    expect(pago.status).toBe(201);

    const cerrar = await app.request(`/hoteles/${ctx.propertyId}/folios/${folioId}/cerrar`, authedJson(ctx.staff.owner.token, { motivo: "saldo_cero" }));
    expect(cerrar.status).toBe(200);

    const job = ctx.hotelesRepo.getOutbox().find((o) => o.channel === "email" && o.eventType === "folio.closed");
    expect(job).toBeDefined();
    expect(job!.dedupeKey).toBe(`folio-closed:${folioId}`);
    const payload = job!.payload as { to: string; subject: string; html: string };
    expect(payload.to).toBe("ana.torres@example.com");
    expect(payload.subject).toContain("Recibo de tu cuenta");
    expect(payload.html).toContain("Saldo en cero");
  });

  it("el folio de fixture (sin reserva real ligada) NUNCA rompe el cierre -- best-effort real: reservation_not_found se traga en silencio", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const cerrar = await app.request(`/hoteles/${ctx.propertyId}/folios/${ctx.folioId}/cerrar`, authedJson(ctx.staff.owner.token, { motivo: "saldo_cero" }));
    expect(cerrar.status).toBe(200); // el cierre real nunca depende de si el correo se pudo armar.
    expect(ctx.hotelesRepo.getOutbox().filter((o) => o.channel === "email")).toHaveLength(0);
  });
});

describe("POST .../folios/:folioId/cfdi — aviso real de CFDI timbrado por correo", () => {
  it("al timbrar con éxito, encola un correo real 'cfdi.issued' con el UUID fiscal real", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const { folioId } = await crearReservaConHuesped(ctx, app, "k-email-cfdi-1");

    await ctx.hotelesRepo.insertCharge({
      organizationId: ctx.organizationId,
      propertyId: ctx.propertyId,
      folioId,
      description: "Hospedaje noche 1",
      amount: 1000,
      taxAmount: 190,
      concept: "hospedaje",
      stayDate: "2026-12-01",
    });

    const res = await app.request(`/hoteles/${ctx.propertyId}/folios/${folioId}/cfdi`, authedJson(ctx.staff.owner.token, { rfcReceptor: "XAXX010101000", usoCfdi: "G03" }, { "idempotency-key": "k-email-cfdi-1-emitir" }));
    expect(res.status).toBe(201);
    const cfdiBody = (await res.json()) as { uuidFiscal: string };
    expect(cfdiBody.uuidFiscal).toBeTruthy();

    const job = ctx.hotelesRepo.getOutbox().find((o) => o.channel === "email" && o.eventType === "cfdi.issued");
    expect(job).toBeDefined();
    expect(job!.dedupeKey).toBe(`cfdi-issued:${cfdiBody.uuidFiscal}`);
    const payload = job!.payload as { to: string; subject: string; html: string };
    expect(payload.to).toBe("ana.torres@example.com");
    expect(payload.subject).toContain("CFDI disponible");
    expect(payload.html).toContain(cfdiBody.uuidFiscal);
  });
});
