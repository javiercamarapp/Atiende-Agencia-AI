// GET/POST /notifications con el productor compartido (migracion 0039): filtros, campos nuevos, estado
// leido por usuario y aislamiento entre usuarios. Repositorio en memoria (el SQL real, RLS y dedupe los
// cubre scripts/verify-notificaciones-productor contra Postgres real).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InMemoryCoreRepository } from "@atiende/db";
import { buildApp } from "../src/app.ts";
import { buildTestDeps, jsonRequestInit } from "./fixtures.ts";

async function login() {
  const ctx = await buildTestDeps();
  const app = buildApp(ctx.deps);
  const res = await app.request("/auth/login", jsonRequestInit({ email: ctx.ownerEmail, password: ctx.ownerPassword }));
  const body = (await res.json()) as { token: string };
  const core = ctx.deps.coreRepo as InMemoryCoreRepository;
  const owner = await core.findStaffByEmail(ctx.ownerEmail);
  return { app, core, ownerId: owner!.id, auth: { authorization: `Bearer ${body.token}` } };
}

const base = { vertical: "restaurantes", cuerpo: null, entidadTipo: null, entidadId: null };

describe("GET /notifications", () => {
  it("devuelve los campos del productor y el contador, solo del propio usuario", async () => {
    const { app, core, ownerId, auth } = await login();
    core.addNotification(ownerId, { ...base, id: randomUUID(), titulo: "Pedido nuevo por atender", createdAt: "2026-10-01T10:00:00.000Z", tipo: "restaurantes.pedido.nuevo", categoria: "operacion", severidad: "atencion", enlace: "/restaurantes/los-taquitos-de-pm/pedidos" });
    core.addNotification(randomUUID(), { ...base, id: randomUUID(), titulo: "De otro usuario", createdAt: "2026-10-01T11:00:00.000Z" });
    const res = await app.request("/notifications", { headers: auth });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { notifications: Array<Record<string, unknown>>; unreadCount: number };
    expect(body.unreadCount).toBe(1);
    expect(body.notifications).toHaveLength(1);
    expect(body.notifications[0]).toMatchObject({ tipo: "restaurantes.pedido.nuevo", categoria: "operacion", severidad: "atencion", enlace: "/restaurantes/los-taquitos-de-pm/pedidos", readAt: null });
  });

  it("filtra por categoria, solo no leidas, limite y pagina por fecha", async () => {
    const { app, core, ownerId, auth } = await login();
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    core.addNotification(ownerId, { ...base, id: ids[0]!, titulo: "A", createdAt: "2026-10-01T10:00:00.000Z", categoria: "operacion" });
    core.addNotification(ownerId, { ...base, id: ids[1]!, titulo: "B", createdAt: "2026-10-01T11:00:00.000Z", categoria: "agentes" });
    core.addNotification(ownerId, { ...base, id: ids[2]!, titulo: "C", createdAt: "2026-10-01T12:00:00.000Z", categoria: "operacion" });
    await core.markNotificationRead(ownerId, ids[2]!);

    const titulos = async (qs: string) => ((await (await app.request(`/notifications${qs}`, { headers: auth })).json()) as { notifications: Array<{ titulo: string }> }).notifications.map((n) => n.titulo);
    expect(await titulos("?categoria=operacion")).toEqual(["C", "A"]);
    expect(await titulos("?unread=1")).toEqual(["B", "A"]);
    expect(await titulos("?limit=1")).toEqual(["C"]);
    expect(await titulos("?before=2026-10-01T11:30:00.000Z")).toEqual(["B", "A"]);
  });

  it("rechaza filtros invalidos con 400 en vez de ignorarlos", async () => {
    const { app, auth } = await login();
    for (const qs of ["?limit=0", "?limit=101", "?limit=x", "?before=ayer", "?unread=si", "?categoria=Mal%20Valor"]) {
      expect((await app.request(`/notifications${qs}`, { headers: auth })).status, qs).toBe(400);
    }
  });

  it("exige sesion", async () => {
    const { app } = await login();
    expect((await app.request("/notifications")).status).toBe(401);
  });
});

describe("estado leido por usuario", () => {
  it("marcar una apaga solo la propia y read-all deja el contador en 0 (el punto rojo se apaga al leer)", async () => {
    const { app, core, ownerId, auth } = await login();
    const otro = randomUUID();
    const id1 = randomUUID();
    const id2 = randomUUID();
    core.addNotification(ownerId, { ...base, id: id1, titulo: "A", createdAt: "2026-10-01T10:00:00.000Z" });
    core.addNotification(ownerId, { ...base, id: id2, titulo: "B", createdAt: "2026-10-01T11:00:00.000Z" });
    core.addNotification(otro, { ...base, id: randomUUID(), titulo: "Ajena", createdAt: "2026-10-01T11:00:00.000Z" });

    const una = await app.request(`/notifications/${id1}/read`, { method: "POST", headers: auth });
    expect(await una.json()).toMatchObject({ ok: true, unreadCount: 1 });
    expect(await core.countUnreadNotificationsForStaff(otro)).toBe(1);

    const todas = await app.request("/notifications/read-all", { method: "POST", headers: auth });
    expect(await todas.json()).toMatchObject({ ok: true, markedCount: 1, unreadCount: 0 });
    expect(await core.countUnreadNotificationsForStaff(otro)).toBe(1);
  });

  it("marcar leida una notificacion ajena da 404 y no cambia nada", async () => {
    const { app, core, auth } = await login();
    const otro = randomUUID();
    const ajena = randomUUID();
    core.addNotification(otro, { ...base, id: ajena, titulo: "Ajena", createdAt: "2026-10-01T11:00:00.000Z" });
    expect((await app.request(`/notifications/${ajena}/read`, { method: "POST", headers: auth })).status).toBe(404);
    expect(await core.countUnreadNotificationsForStaff(otro)).toBe(1);
  });
});
