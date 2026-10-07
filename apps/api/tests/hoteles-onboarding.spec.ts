// H-P3-06 -- "Primeros pasos" del hotel: el checklist se calcula con datos reales (nunca un estado guardado a mano), el gate solo bloquea a un
// hotel que aun no opera, y omitirlo deja rastro en la bitacora. HTTP real sobre los repositorios en memoria.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InMemoryMensajeriaConfigRepository } from "@atiende/domain-hoteles";
import { buildApp } from "../src/app.ts";
import { buildHotelesTestContext, authedJson } from "./hoteles-fixtures.ts";

interface Item {
  id: string;
  estado: string;
  obligatorio: boolean;
  detalle: string;
  responsable: string;
  pantalla: string;
}
interface Checklist {
  bloquea: boolean;
  obligatoriosPendientes: number;
  operaConReservas: boolean;
  listoParaOperar: boolean;
  resumen: { hechos: number; total: number; obligatoriosPendientes: number };
  items: Item[];
}

const put = (token: string, body: unknown): RequestInit => ({ ...authedJson(token, body), method: "PUT" });
const get = (token: string): RequestInit => authedJson(token);

async function nuevoHotel(opts: { migrated?: boolean } = {}) {
  const ctx = await buildHotelesTestContext(buildApp);
  const mensajeria = new InMemoryMensajeriaConfigRepository(opts);
  const app = buildApp({ ...ctx.deps, hotelesMensajeriaConfigRepo: () => mensajeria });
  // Property "vacia" del mismo hotel: sin tipos, habitaciones, tarifas, impuestos ni reservas.
  const propertyId = randomUUID();
  (ctx.deps.engine as unknown as { seedProperty(p: object): void }).seedProperty({ id: propertyId, organizationId: ctx.organizationId });
  const checklist = async (token: string = ctx.staff.owner.token, pid: string = propertyId) => {
    const res = await app.request(`/hoteles/${pid}/primeros-pasos`, get(token));
    return { res, body: (await res.json()) as Checklist };
  };
  const item = (c: Checklist, id: string) => c.items.find((i) => i.id === id)!;
  return { ctx, app, propertyId, checklist, item, mensajeria };
}

describe("GET /hoteles/:propertyId/primeros-pasos", () => {
  it("un hotel vacio: los obligatorios estan pendientes, el gate bloquea y cada paso trae su responsable y su pantalla", async () => {
    const { checklist, item } = await nuevoHotel();
    const { res, body } = await checklist();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(body.listoParaOperar).toBe(false);
    expect(body.bloquea).toBe(true);
    expect(body.operaConReservas).toBe(false);
    expect(body.items.map((i) => i.id)).toEqual([
      "tipos_habitacion", "habitaciones", "tarifas", "impuestos", "politica_cancelacion", "zona_horaria", "aviso_privacidad", "whatsapp", "voz", "equipo", "reserva_prueba",
    ]);
    for (const id of ["tipos_habitacion", "habitaciones", "tarifas", "impuestos", "politica_cancelacion"]) expect(item(body, id)).toMatchObject({ estado: "pendiente", obligatorio: true });
    for (const i of body.items) {
      expect(i.responsable, i.id).toMatch(/^(dueno|plataforma|meta)$/);
      expect(i.pantalla, i.id).toMatch(/^(catalogo|configuracion|equipo|privacidad|mensajeria|reservas)$/);
      expect(i.detalle.length, i.id).toBeGreaterThan(10);
    }
    expect(item(body, "whatsapp").responsable).toBe("meta");
    expect(body.resumen.obligatoriosPendientes).toBe(5);
  });

  it("avanza con datos reales: crear tipo, habitacion, tarifas de 30 noches, impuestos y politica van cerrando los pasos y el gate se levanta", async () => {
    const { ctx, app, propertyId, checklist, item } = await nuevoHotel();
    const token = ctx.staff.owner.token;
    const base = `/hoteles/${propertyId}`;

    const tipo = (await (await app.request(`${base}/tipos-habitacion`, authedJson(token, { nombre: "Doble", capacidadMaxima: 2 }))).json()) as { id: string };
    expect(item((await checklist()).body, "tipos_habitacion").estado).toBe("hecho");
    expect(item((await checklist()).body, "tarifas").estado).toBe("pendiente");

    await app.request(`${base}/tipos-habitacion/${tipo.id}/habitaciones`, authedJson(token, { codigo: "101" }));
    expect(item((await checklist()).body, "habitaciones").estado).toBe("hecho");

    // Tarifas solo para 10 noches -> "pendiente" (ningun tipo cubre las 30); la fecha parte de hoy (zona del hotel).
    const hoy = new Date();
    const dia = (n: number) => new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth(), hoy.getUTCDate() + n)).toISOString().slice(0, 10);
    await app.request(`${base}/tarifas`, authedJson(token, { roomTypeId: tipo.id, fechaInicio: dia(-1), fechaFin: dia(9), precio: 1000 }));
    const parcial = item((await checklist()).body, "tarifas");
    expect(parcial.estado).toBe("pendiente");
    expect(parcial.detalle).toMatch(/Doble \(\d+\/30\)/);

    await app.request(`${base}/tarifas`, authedJson(token, { roomTypeId: tipo.id, fechaInicio: dia(-1), fechaFin: dia(40), precio: 1000 }));
    expect(item((await checklist()).body, "tarifas").estado).toBe("hecho");

    await app.request(`${base}/configuracion/impuestos`, put(token, { ivaRate: 0.16, ishRate: 0.03, discountThreshold: 500 }));
    expect(item((await checklist()).body, "impuestos").estado).toBe("hecho");
    await app.request(`${base}/configuracion/politica-cancelacion`, put(token, { freeUntilHours: 24, penaltyPct: 0.5 }));
    const final = (await checklist()).body;
    expect(item(final, "politica_cancelacion").estado).toBe("hecho");
    expect(final.listoParaOperar).toBe(true);
    expect(final.bloquea).toBe(false);
    expect(final.obligatoriosPendientes).toBe(0);
  });

  it("un hotel que ya opera con reservas nunca se bloquea aunque falten obligatorios (solo informativo) y la reserva de prueba se marca hecha", async () => {
    const { ctx, app, checklist, item } = await nuevoHotel();
    const antes = await checklist(ctx.staff.owner.token, ctx.propertyId);
    expect(antes.body.obligatoriosPendientes).toBeGreaterThan(0);
    expect(antes.body.bloquea).toBe(true);
    const crear = await app.request(
      `/hoteles/${ctx.propertyId}/reservas`,
      authedJson(ctx.staff.owner.token, { roomTypeId: ctx.roomTypeId, checkInDate: "2026-12-01", checkOutDate: "2026-12-02" }, { "idempotency-key": "k-onb-1" }),
    );
    expect(crear.status).toBe(201);
    const { body } = await checklist(ctx.staff.owner.token, ctx.propertyId);
    expect(body.operaConReservas).toBe(true);
    expect(body.obligatoriosPendientes).toBeGreaterThan(0);
    expect(body.bloquea).toBe(false);
    expect(item(body, "reserva_prueba").estado).toBe("hecho");
  });

  it("solo owner y gm lo ven: frontdesk, accountant y housekeeping reciben 403", async () => {
    const { ctx, checklist, propertyId } = await nuevoHotel();
    expect((await checklist(ctx.staff.gm.token)).res.status).toBe(200);
    for (const rol of [ctx.staff.frontdesk, ctx.staff.accountant, ctx.staff.housekeeping, ctx.staff.reservations, ctx.staff.fnb]) {
      expect((await checklist(rol.token, propertyId)).res.status).toBe(403);
    }
  });

  it("WhatsApp y voz sin configurar se muestran pendientes con el detalle honesto (no se dan por hechos)", async () => {
    const { checklist, item } = await nuevoHotel();
    const { body } = await checklist();
    expect(item(body, "whatsapp").estado).toBe("pendiente");
    expect(item(body, "whatsapp").detalle).toMatch(/Meta/);
    expect(item(body, "voz").estado).toBe("pendiente");
  });

  it("WhatsApp y voz configurados y habilitados se cierran, y la voz apagada queda parcial", async () => {
    const { ctx, app, propertyId, checklist, item, mensajeria } = await nuevoHotel();
    await mensajeria.saveWhatsAppChannel(propertyId, { phoneNumberId: "123456789012345", enabled: true }, ctx.staff.owner.id);
    await mensajeria.rotateVoiceSecret(propertyId, ctx.organizationId, "secreto-de-prueba-largo-0123456789", false);
    const { body } = await checklist();
    expect(item(body, "whatsapp").estado).toBe("hecho");
    expect(item(body, "voz").estado).toBe("parcial");
    await app.request(`/hoteles/${propertyId}/mensajeria/voz`, put(ctx.staff.owner.token, { habilitado: true }));
    expect(item((await checklist()).body, "voz").estado).toBe("hecho");
  });

  it("base sin migrar (mensajeria y privacidad no disponibles): 200 con esos pasos pendientes, nunca 500", async () => {
    const { checklist, item } = await nuevoHotel({ migrated: false });
    const { res, body } = await checklist();
    expect(res.status).toBe(200);
    expect(item(body, "whatsapp").estado).toBe("pendiente");
    expect(item(body, "voz").estado).toBe("pendiente");
  });

  it("equipo: el fixture trae varios miembros activos, asi que el paso esta hecho", async () => {
    const { checklist, item } = await nuevoHotel();
    expect(item((await checklist()).body, "equipo")).toMatchObject({ estado: "hecho", pantalla: "equipo" });
  });
});

describe("POST /hoteles/:propertyId/primeros-pasos/omitir", () => {
  it("owner y gm omiten el gate y queda registrado en la bitacora; el resto recibe 403", async () => {
    const { ctx, app, propertyId } = await nuevoHotel();
    const base = `/hoteles/${propertyId}`;
    const res = await app.request(`${base}/primeros-pasos/omitir`, authedJson(ctx.staff.owner.token, {}));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ omitido: true, registrada: true });
    for (const rol of [ctx.staff.frontdesk, ctx.staff.accountant]) {
      expect((await app.request(`${base}/primeros-pasos/omitir`, authedJson(rol.token, {}))).status).toBe(403);
    }
    const bitacora = (await (await app.request(`${base}/configuracion/bitacora`, get(ctx.staff.gm.token))).json()) as { entradas: Array<{ area: string; actorUserId: string }> };
    expect(bitacora.entradas).toEqual([expect.objectContaining({ area: "onboarding_omitido", actorUserId: ctx.staff.owner.id })]);
  });
});
