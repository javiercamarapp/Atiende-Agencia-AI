// De punta a punta dentro de la API: un evento del ciclo (escalar un vencimiento fiscal, despachos) emite por el productor
// compartido y la campana (GET /notifications, GET /notifications/unread-count, POST /notifications/:id/read, NOTIF-B) lo recibe:
// el punto rojo se enciende al llegar la notificacion, trae tipo/severidad/categoria y el enlace RESUELTO a la pantalla origen, y se
// apaga al leerla; una nueva vuelve a encenderlo. El SQL real (destinatarios por rol, dedupe, RLS) lo cubre
// scripts/verify-notificaciones-productor contra Postgres real; aqui el puente reemplaza `{orgSlug}` como lo hace la base.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { eventoPorId } from "@atiende/db";
import type { InMemoryCoreRepository } from "@atiende/db";
import { buildApp } from "../src/app.ts";
import { authedJson, buildDespachosTestContext } from "./despachos-fixtures.ts";
import { conEmisiones } from "./support/emisiones.ts";

const get = (app: ReturnType<typeof buildApp>, path: string, token: string) => app.request(path, { headers: { authorization: `Bearer ${token}` } });

describe("la campana recibe los eventos del ciclo", () => {
  it("escalar un vencimiento enciende el punto rojo del contador con el enlace a Vencimientos; leerlo lo apaga; otro evento lo enciende de nuevo", async () => {
    const ctx = await buildDespachosTestContext(buildApp);
    const core = ctx.deps.coreRepo as InMemoryCoreRepository;
    const { deps } = conEmisiones(ctx.deps, {
      alRegistrar: (e) => {
        // Puente del productor: los destinatarios (owner/admin + roles del evento) los resuelve la base; aqui el contador.
        if (e.roles?.includes("contador")) {
          core.addNotification(ctx.staff.contador.id, {
            id: randomUUID(),
            vertical: "despachos",
            titulo: e.titulo,
            cuerpo: e.cuerpo,
            entidadTipo: null,
            entidadId: null,
            createdAt: new Date().toISOString(),
            tipo: e.evento,
            categoria: e.categoria,
            severidad: e.severidad as "info" | "atencion" | "critica",
            enlace: e.enlace.replace("{orgSlug}", "despacho-de-prueba"),
            organizationId: e.organizationId,
          });
        }
      },
    });
    const app = buildApp(deps);
    const token = ctx.staff.contador.token;

    expect(((await (await get(app, "/notifications/unread-count", token)).json()) as { unreadCount: number }).unreadCount).toBe(0);

    await app.request(`/despachos/${ctx.propertyId}/vencimientos/calcular`, authedJson(token, { year: 2020, month: 1 }));
    const [primero, segundo] = (await (await get(app, `/despachos/${ctx.propertyId}/vencimientos`, token)).json()) as { id: string }[];
    expect((await app.request(`/despachos/${ctx.propertyId}/vencimientos/${primero!.id}/escalar`, authedJson(token, {}))).status).toBe(201);

    const lista = (await (await get(app, "/notifications", token)).json()) as { notifications: Array<{ id: string; tipo: string; titulo: string; severidad: string; categoria: string; enlace: string; readAt: string | null }>; unreadCount: number };
    expect(lista.unreadCount).toBe(1);
    // Lo que sirve la campana debe ser lo que el CATALOGO define para el evento (titulo, severidad, categoria, enlace con el slug ya
    // resuelto, cuerpo con el nivel numerico), no un literal copiado del puente de este test.
    const catalogo = eventoPorId("despachos.fiscal.vencimiento_escalado")!;
    expect(lista.notifications[0]).toMatchObject({
      tipo: catalogo.id,
      titulo: catalogo.titulo,
      severidad: catalogo.severidad,
      categoria: catalogo.categoria,
      enlace: catalogo.enlace.replace("{orgSlug}", "despacho-de-prueba"),
      readAt: null,
    });
    expect(lista.notifications[0]!.enlace).not.toContain("{orgSlug}");
    expect((lista.notifications[0] as unknown as { cuerpo: string }).cuerpo).toMatch(/^Nivel de escalamiento: \d+\.$/);

    expect((await app.request(`/notifications/${lista.notifications[0]!.id}/read`, { method: "POST", headers: { authorization: `Bearer ${token}` } })).status).toBeLessThan(300);
    expect(((await (await get(app, "/notifications/unread-count", token)).json()) as { unreadCount: number }).unreadCount).toBe(0);

    expect((await app.request(`/despachos/${ctx.propertyId}/vencimientos/${segundo!.id}/escalar`, authedJson(token, {}))).status).toBe(201);
    expect(((await (await get(app, "/notifications/unread-count", token)).json()) as { unreadCount: number }).unreadCount).toBe(1);

    // Otro usuario (el auditor) no recibe lo del contador: la campana es por destinatario.
    expect(((await (await get(app, "/notifications/unread-count", ctx.staff.auditor.token)).json()) as { unreadCount: number }).unreadCount).toBe(0);
  });
});
