// Test de integración end-to-end (Fase 1 despachos §7, obligatorio): ingesta real de
// un CFDI vía HTTP -> `requiresHumanReview=true` real (no simulado) -> aparece en la
// cola de revisión -> un rol autorizado la resuelve -> la decisión queda auditada vía
// `@atiende/core-authz::AuditSink` (sin tabla de auditoría propia de despachos).
import { beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { authedJson, buildDespachosTestContext } from "./despachos-fixtures.ts";
import type { DespachosTestContext } from "./despachos-fixtures.ts";

let ctx: DespachosTestContext;

beforeEach(async () => {
  ctx = await buildDespachosTestContext(buildApp);
});

function cfdiIngresoConDiot(overrides: Record<string, unknown> = {}) {
  return {
    folioFiscal: "11111111-2222-3333-4444-555555555555",
    tipo: "I",
    subtotal: 1000,
    total: 1160,
    descuento: 0,
    iva: 160,
    conceptos: [{ cantidad: 1, valorUnitario: 1000, importe: 1000 }],
    usoCfdi: "G03",
    formaPago: "03",
    metodoPago: "PUE",
    regimenFiscalEmisor: "601",
    rfcEmisor: "CON950820K12",
    rfcReceptor: "XAXX010101000",
    emisorNombre: "PROVEEDOR DE PRUEBA SA DE CV",
    tieneSello: true,
    noCertificado: "00001000000504465028",
    fecha: "2026-07-01T10:00:00",
    fechaTimbrado: "2026-07-01T10:05:00",
    ...overrides,
  };
}

describe("POST /despachos/:propertyId/cfdi — ingesta y validación (end-to-end)", () => {
  it("ingesta un CFDI real, calcula requiresHumanReview=true (DIOT reportable) y crea la revisión pendiente automáticamente", async () => {
    const app = buildApp(ctx.deps);
    const res = await app.request(`/despachos/${ctx.propertyId}/cfdi`, authedJson(ctx.staff.contador.token, cfdiIngresoConDiot()));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; requiereRevisionHumana: boolean; diot: { reportable: boolean } };
    expect(body.requiereRevisionHumana).toBe(true);
    expect(body.diot.reportable).toBe(true);

    // La revisión debe existir de verdad en el repositorio -- no un flag suelto.
    const pendientes = await ctx.despachosRepo.listPendingReviews(ctx.propertyId);
    expect(pendientes).toHaveLength(1);
    expect(pendientes[0]!.invoiceId).toBe(body.id);
  });

  it("REQ: reingestar el mismo folio fiscal (mismo UUID de timbre) nunca duplica el CFDI -- 409 conflict", async () => {
    const app = buildApp(ctx.deps);
    const first = await app.request(`/despachos/${ctx.propertyId}/cfdi`, authedJson(ctx.staff.contador.token, cfdiIngresoConDiot()));
    expect(first.status).toBe(201);

    const second = await app.request(`/despachos/${ctx.propertyId}/cfdi`, authedJson(ctx.staff.contador.token, cfdiIngresoConDiot()));
    expect(second.status).toBe(409);

    const invoices = await ctx.despachosRepo.listInvoices(ctx.propertyId);
    expect(invoices).toHaveLength(1);
  });

  it("un CFDI limpio de tipo Traslado (T), sin DIOT ni nómina, NO exige revisión humana", async () => {
    const app = buildApp(ctx.deps);
    const res = await app.request(
      `/despachos/${ctx.propertyId}/cfdi`,
      authedJson(
        ctx.staff.contador.token,
        cfdiIngresoConDiot({ tipo: "T", folioFiscal: "22222222-2222-3333-4444-555555555555" }),
      ),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { requiereRevisionHumana: boolean };
    expect(body.requiereRevisionHumana).toBe(false);
    expect(await ctx.despachosRepo.listPendingReviews(ctx.propertyId)).toHaveLength(0);
  });

  it("un rol readonly no puede ingestar CFDI (403)", async () => {
    const app = buildApp(ctx.deps);
    const res = await app.request(`/despachos/${ctx.propertyId}/cfdi`, authedJson(ctx.staff.readonly.token, cfdiIngresoConDiot()));
    expect(res.status).toBe(403);
  });

  // Migración 006 (hallazgo de auditoría): la ingesta ya recibía `fecha` (usada
  // para el bloqueo de período cerrado) pero nunca la persistía en
  // `despachos.invoice` -- la única fecha que sobrevivía era `createdAt` (fecha de
  // INGESTA), rompiendo conciliación bancaria/DIOT/devolución de IVA/declaraciones.
  it("REQ: la ingesta persiste la fecha REAL de emisión del CFDI (columna 'fecha', no createdAt)", async () => {
    const app = buildApp(ctx.deps);
    const res = await app.request(`/despachos/${ctx.propertyId}/cfdi`, authedJson(ctx.staff.contador.token, cfdiIngresoConDiot({ fecha: "2026-07-01T10:00:00" })));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; fecha: string };
    // Persistida como fecha (YYYY-MM-DD), truncando la hora del CFDI.
    expect(body.fecha).toBe("2026-07-01");

    const invoice = await ctx.despachosRepo.findInvoice(ctx.propertyId, body.id);
    expect(invoice?.fecha).toBe("2026-07-01");
    // Nunca igual a `createdAt` (fecha de ingesta, "ahora") salvo coincidencia --
    // aquí la fecha real del CFDI es muy anterior al momento en que corre el test.
    expect(invoice?.createdAt.slice(0, 10)).not.toBe("2026-07-01");
  });

  it("REQ: sin 'fecha' en el body, la ingesta se rechaza con 400 (la columna es NOT NULL, nunca se inventa una fecha)", async () => {
    const app = buildApp(ctx.deps);
    const sinFecha: Record<string, unknown> = cfdiIngresoConDiot();
    delete sinFecha.fecha;
    const res = await app.request(`/despachos/${ctx.propertyId}/cfdi`, authedJson(ctx.staff.contador.token, sinFecha));
    expect(res.status).toBe(400);
  });
});

describe("cola de revisión humana — flujo 2, gateado por requiresHumanReview", () => {
  it("un contador aprueba una revisión pendiente real, y la decisión queda auditada vía core-authz::AuditSink", async () => {
    const app = buildApp(ctx.deps);
    const ingesta = await app.request(`/despachos/${ctx.propertyId}/cfdi`, authedJson(ctx.staff.contador.token, cfdiIngresoConDiot()));
    expect(ingesta.status).toBe(201);

    const listado = await app.request(`/despachos/${ctx.propertyId}/revisiones`, authedJson(ctx.staff.contador.token));
    expect(listado.status).toBe(200);
    const revisiones = (await listado.json()) as { id: string; estado: string }[];
    expect(revisiones).toHaveLength(1);
    expect(revisiones[0]!.estado).toBe("pendiente");

    const aprobar = await app.request(
      `/despachos/${ctx.propertyId}/revisiones/${revisiones[0]!.id}/aprobar`,
      authedJson(ctx.staff.contador.token, { nota: "CFDI de honorarios revisado, coincide con contrato." }),
    );
    expect(aprobar.status).toBe(200);
    const resuelto = (await aprobar.json()) as { estado: string; resueltoPor: string };
    expect(resuelto.estado).toBe("aprobado");
    expect(resuelto.resueltoPor).toBe(ctx.staff.contador.id);

    // No queda pendiente.
    expect(await ctx.despachosRepo.listPendingReviews(ctx.propertyId)).toHaveLength(0);

    // Auditoría real -- no una tabla propia de despachos, ver diseño Fase 1 §3.
    const auditEntries = (ctx.deps.despachosAuditSink as unknown as { entries: { action: string; decision: string }[] }).entries;
    expect(auditEntries.some((e) => e.action === "despachos.revision:aprobado" && e.decision === "allowed")).toBe(true);
  });

  it("resolver dos veces la misma revisión da 409 conflict, nunca sobreescribe la decisión original", async () => {
    const app = buildApp(ctx.deps);
    await app.request(`/despachos/${ctx.propertyId}/cfdi`, authedJson(ctx.staff.contador.token, cfdiIngresoConDiot()));
    const revisiones = (await (await app.request(`/despachos/${ctx.propertyId}/revisiones`, authedJson(ctx.staff.contador.token))).json()) as { id: string }[];

    const primera = await app.request(`/despachos/${ctx.propertyId}/revisiones/${revisiones[0]!.id}/aprobar`, authedJson(ctx.staff.contador.token, {}));
    expect(primera.status).toBe(200);

    const segunda = await app.request(`/despachos/${ctx.propertyId}/revisiones/${revisiones[0]!.id}/rechazar`, authedJson(ctx.staff.admin.token, {}));
    expect(segunda.status).toBe(409);
  });

  it("un rol readonly no puede resolver revisiones (403)", async () => {
    const app = buildApp(ctx.deps);
    await app.request(`/despachos/${ctx.propertyId}/cfdi`, authedJson(ctx.staff.contador.token, cfdiIngresoConDiot()));
    const revisiones = (await (await app.request(`/despachos/${ctx.propertyId}/revisiones`, authedJson(ctx.staff.contador.token))).json()) as { id: string }[];
    const res = await app.request(`/despachos/${ctx.propertyId}/revisiones/${revisiones[0]!.id}/aprobar`, authedJson(ctx.staff.readonly.token, {}));
    expect(res.status).toBe(403);
  });
});

describe("vencimientos fiscales — flujo 3", () => {
  it("calcula los 4 vencimientos estándar del período y calcularlos dos veces no duplica filas", async () => {
    const app = buildApp(ctx.deps);
    const primero = await app.request(`/despachos/${ctx.propertyId}/vencimientos/calcular`, authedJson(ctx.staff.contador.token, { year: 2026, month: 6 }));
    expect(primero.status).toBe(201);
    const creados = (await primero.json()) as { tipo: string; fechaLimite: string }[];
    expect(creados.map((d) => d.tipo).sort()).toEqual(["DIOT", "IVA", "ISR", "Nómina"].sort());
    expect(creados.every((d) => d.fechaLimite === "2026-07-17")).toBe(true);

    const segundo = await app.request(`/despachos/${ctx.propertyId}/vencimientos/calcular`, authedJson(ctx.staff.contador.token, { year: 2026, month: 6 }));
    expect(segundo.status).toBe(201);

    const listado = await app.request(`/despachos/${ctx.propertyId}/vencimientos`, authedJson(ctx.staff.contador.token));
    const todos = (await listado.json()) as unknown[];
    expect(todos).toHaveLength(4); // no 8: la segunda llamada reutiliza las filas existentes
  });

  it("escala un vencimiento vencido a nivel_4, exige revisión humana (CFF art. 89) y notifica por correo real al staff owner/admin", async () => {
    const app = buildApp(ctx.deps);
    // Hallazgo de auditoría (severidad ALTA), cierre de gap real: hasta esta fase,
    // escalar un vencimiento solo insertaba la fila en BD sin notificar a nadie.
    // Mismo criterio que licitaciones-alert-notifications.spec.ts: `despachosRepo`
    // (el repo del DOMINIO) necesita su propio seed de destinatarios, aparte de
    // coreRepo.addMembership que ya sembró buildDespachosTestContext.
    ctx.despachosRepo.seedNotificationRecipient(ctx.organizationId, { email: ctx.staff.admin.email, fullName: "admin" });

    // Un período muy antiguo garantiza fecha_limite ya vencida sin importar cuándo
    // corra el test.
    await app.request(`/despachos/${ctx.propertyId}/vencimientos/calcular`, authedJson(ctx.staff.contador.token, { year: 2020, month: 1 }));
    const listado = await app.request(`/despachos/${ctx.propertyId}/vencimientos`, authedJson(ctx.staff.contador.token));
    const [deadline] = (await listado.json()) as { id: string }[];

    const escalar = await app.request(`/despachos/${ctx.propertyId}/vencimientos/${deadline!.id}/escalar`, authedJson(ctx.staff.contador.token, {}));
    expect(escalar.status).toBe(201);
    const body = (await escalar.json()) as { escalamiento: { nivel: string }; requiereRevisionHumana: boolean; notificacion: { destinatarios: number; correosEncolados: number } };
    expect(body.escalamiento.nivel).toBe("nivel_4");
    expect(body.requiereRevisionHumana).toBe(true);
    expect(body.notificacion).toEqual({ destinatarios: 1, correosEncolados: 1 });

    const outbox = ctx.despachosRepo.getMessagingOutbox();
    expect(outbox.some((j) => j.eventType === "vencimiento.escalado" && j.payload.to === ctx.staff.admin.email)).toBe(true);
  });

  it("marcar completado un vencimiento ya completado da 409 conflict", async () => {
    const app = buildApp(ctx.deps);
    await app.request(`/despachos/${ctx.propertyId}/vencimientos/calcular`, authedJson(ctx.staff.contador.token, { year: 2026, month: 6 }));
    const listado = await app.request(`/despachos/${ctx.propertyId}/vencimientos`, authedJson(ctx.staff.contador.token));
    const [deadline] = (await listado.json()) as { id: string }[];

    const primero = await app.request(`/despachos/${ctx.propertyId}/vencimientos/${deadline!.id}/completar`, authedJson(ctx.staff.contador.token, { comprobanteUrl: "https://ejemplo.mx/acuse.pdf" }));
    expect(primero.status).toBe(200);

    const segundo = await app.request(`/despachos/${ctx.propertyId}/vencimientos/${deadline!.id}/completar`, authedJson(ctx.staff.contador.token, {}));
    expect(segundo.status).toBe(409);
  });
});
