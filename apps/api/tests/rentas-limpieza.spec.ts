// Test de integración end-to-end (HTTP real vía app.request, sin mockear el motor de
// dominio) de Fase 17 -- panel operativo del rol `limpieza`. Cierra el hallazgo de
// auditoría ALTA "el rol `limpieza` sigue sin ninguna vista funcional": el motor
// transaccional (asignarTarea/completarChecklistItem/completarTarea/
// registrarIncidencia, Fase 8) llevaba desde entonces sin un solo HTTP route que lo
// expusiera. Las tareas/inventario de la mayoría de los tests se siembran directo
// con `rentasRepo.seedTareaOperativa`/`seedItemInventario` (ver el comentario de
// cabecera de InMemoryRentasCalendarStore.seedTareaOperativa) -- salvo el bloque
// "POST .../tareas (creación manual)" de abajo, que SÍ ejercita el motor real
// (`crearTareaOperativaManual`) de punta a punta. `procesarCheckoutsPendientes`
// (creación automática al checkout) tiene su propio cron interno y su propio spec,
// ver apps/api/tests/rentas-checkout-sweep-cron.spec.ts.
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { authedJson, buildRentasTestContext } from "./rentas-fixtures.ts";

describe("GET /rentas/:propertyId/tareas", () => {
  it("asignadoA=me lista solo las tareas asignadas a quien llama", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const propia = ctx.rentasRepo.seedTareaOperativa({
      organizationId: ctx.organizationId,
      propertyId: ctx.propertyId,
      unidadId: ctx.unidadId,
      programadaPara: "2026-07-01",
      asignadoA: ctx.staff.limpieza.id,
      estado: "asignada",
      checklist: ["Tender camas", "Limpiar baño"],
    });
    ctx.rentasRepo.seedTareaOperativa({
      organizationId: ctx.organizationId,
      propertyId: ctx.propertyId,
      unidadId: ctx.unidadId,
      programadaPara: "2026-07-02",
      asignadoA: ctx.staff.adminGestora.id,
      estado: "asignada",
    });

    const res = await app.request(`/rentas/${ctx.propertyId}/tareas?asignadoA=me`, authedJson(ctx.staff.limpieza.token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tareas: Array<{ id: string; unidadNombre: string; estado: string }> };
    expect(body.tareas).toHaveLength(1);
    expect(body.tareas[0]!.id).toBe(propia.id);
    expect(body.tareas[0]!.unidadNombre).toBe("Depa de Prueba");
  });

  it("asignadoA=sin_asignar lista solo tareas sin asignar", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const sinAsignar = ctx.rentasRepo.seedTareaOperativa({ organizationId: ctx.organizationId, propertyId: ctx.propertyId, unidadId: ctx.unidadId, programadaPara: "2026-07-01" });
    ctx.rentasRepo.seedTareaOperativa({ organizationId: ctx.organizationId, propertyId: ctx.propertyId, unidadId: ctx.unidadId, programadaPara: "2026-07-02", asignadoA: ctx.staff.limpieza.id });

    const res = await app.request(`/rentas/${ctx.propertyId}/tareas?asignadoA=sin_asignar`, authedJson(ctx.staff.limpieza.token));
    const body = (await res.json()) as { tareas: Array<{ id: string }> };
    expect(body.tareas).toHaveLength(1);
    expect(body.tareas[0]!.id).toBe(sinAsignar.id);
  });

  it("un rol contador (fuera de LIMPIEZA_OPERACION_ROLES) no puede ver tareas -- 403", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/rentas/${ctx.propertyId}/tareas`, authedJson(ctx.staff.contador.token));
    expect(res.status).toBe(403);
  });
});

describe("POST /rentas/:propertyId/tareas (creación manual, crearTareaOperativaManual)", () => {
  it("admin_gestora crea una tarea de mantenimiento SIN ocupación/buffer de calendario, con la plantilla de checklist de su tipo", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const res = await app.request(
      `/rentas/${ctx.propertyId}/tareas`,
      authedJson(ctx.staff.adminGestora.token, { unidadId: ctx.unidadId, tipo: "mantenimiento", programadaPara: "2026-07-15" }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { tarea: { id: string; tipo: string; estado: string; prioridad: string; checklist: Array<{ descripcion: string }> } };
    expect(body.tarea.tipo).toBe("mantenimiento");
    expect(body.tarea.estado).toBe("pendiente");
    expect(body.tarea.prioridad).toBe("media");
    expect(body.tarea.checklist.length).toBeGreaterThan(0);

    // Visible por la MISMA ruta de listado que usa MisTareas.tsx.
    const listado = await app.request(`/rentas/${ctx.propertyId}/tareas`, authedJson(ctx.staff.limpieza.token));
    const listadoBody = (await listado.json()) as { tareas: Array<{ id: string }> };
    expect(listadoBody.tareas.some((t) => t.id === body.tarea.id)).toBe(true);
  });

  it("operador:acceso_total puede crear, y respeta la prioridad explícita", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(
      `/rentas/${ctx.propertyId}/tareas`,
      authedJson(ctx.staff.operadorAccesoTotal.token, { unidadId: ctx.unidadId, tipo: "limpieza", prioridad: "urgente", programadaPara: "2026-07-15" }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { tarea: { prioridad: string } };
    expect(body.tarea.prioridad).toBe("urgente");
  });

  it("el rol limpieza (opera tareas, pero no decide darlas de alta) recibe 403", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(
      `/rentas/${ctx.propertyId}/tareas`,
      authedJson(ctx.staff.limpieza.token, { unidadId: ctx.unidadId, tipo: "limpieza", programadaPara: "2026-07-15" }),
    );
    expect(res.status).toBe(403);
  });

  it("un rol contador recibe 403", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(
      `/rentas/${ctx.propertyId}/tareas`,
      authedJson(ctx.staff.contador.token, { unidadId: ctx.unidadId, tipo: "limpieza", programadaPara: "2026-07-15" }),
    );
    expect(res.status).toBe(403);
  });

  it("un tipo fuera del catálogo -> 400", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(
      `/rentas/${ctx.propertyId}/tareas`,
      authedJson(ctx.staff.adminGestora.token, { unidadId: ctx.unidadId, tipo: "reparacion_urgente", programadaPara: "2026-07-15" }),
    );
    expect(res.status).toBe(400);
  });

  it("una unidad que no pertenece a esta property -> 404", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(
      `/rentas/${ctx.propertyId}/tareas`,
      authedJson(ctx.staff.adminGestora.token, { unidadId: "00000000-0000-4000-8000-000000000000", tipo: "limpieza", programadaPara: "2026-07-15" }),
    );
    expect(res.status).toBe(404);
  });
});

describe("GET /rentas/:propertyId/tareas/:tareaId", () => {
  it("trae el detalle con el checklist completo", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const tarea = ctx.rentasRepo.seedTareaOperativa({
      organizationId: ctx.organizationId,
      propertyId: ctx.propertyId,
      unidadId: ctx.unidadId,
      programadaPara: "2026-07-01",
      checklist: ["Tender camas", "Limpiar baño"],
    });

    const res = await app.request(`/rentas/${ctx.propertyId}/tareas/${tarea.id}`, authedJson(ctx.staff.limpieza.token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tarea: { id: string; checklist: Array<{ descripcion: string; completado: boolean }> } };
    expect(body.tarea.checklist).toHaveLength(2);
    expect(body.tarea.checklist.every((c) => !c.completado)).toBe(true);
  });

  it("una tarea que no pertenece a esta property -> 404", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/rentas/${ctx.propertyId}/tareas/00000000-0000-4000-8000-000000000000`, authedJson(ctx.staff.limpieza.token));
    expect(res.status).toBe(404);
  });
});

describe("POST /rentas/:propertyId/tareas/:tareaId/asignar", () => {
  it("sin asignadoA en el body, se autoasigna a quien llama", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const tarea = ctx.rentasRepo.seedTareaOperativa({ organizationId: ctx.organizationId, propertyId: ctx.propertyId, unidadId: ctx.unidadId, programadaPara: "2026-07-01" });

    const res = await app.request(`/rentas/${ctx.propertyId}/tareas/${tarea.id}/asignar`, authedJson(ctx.staff.limpieza.token, {}));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tarea: { asignadoA: string; estado: string } };
    expect(body.tarea.asignadoA).toBe(ctx.staff.limpieza.id);
    expect(body.tarea.estado).toBe("asignada");
  });

  it("una tarea inexistente -> 404", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/rentas/${ctx.propertyId}/tareas/00000000-0000-4000-8000-000000000000/asignar`, authedJson(ctx.staff.limpieza.token, {}));
    expect(res.status).toBe(404);
  });
});

describe("POST /rentas/:propertyId/tareas/:tareaId/checklist/:itemId/completar y .../completar", () => {
  it("completar la tarea con el checklist incompleto -> 409 (checklist_incompleto), y bloquea la tarea", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const tarea = ctx.rentasRepo.seedTareaOperativa({
      organizationId: ctx.organizationId,
      propertyId: ctx.propertyId,
      unidadId: ctx.unidadId,
      programadaPara: "2026-07-01",
      checklist: ["Tender camas", "Limpiar baño"],
    });

    const res = await app.request(`/rentas/${ctx.propertyId}/tareas/${tarea.id}/completar`, authedJson(ctx.staff.limpieza.token, {}));
    expect(res.status).toBe(409);

    const detalle = await app.request(`/rentas/${ctx.propertyId}/tareas/${tarea.id}`, authedJson(ctx.staff.limpieza.token));
    const body = (await detalle.json()) as { tarea: { estado: string } };
    expect(body.tarea.estado).toBe("bloqueada");
  });

  it("un ítem de checklist que no pertenece a la tarea -> 404", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const tarea = ctx.rentasRepo.seedTareaOperativa({ organizationId: ctx.organizationId, propertyId: ctx.propertyId, unidadId: ctx.unidadId, programadaPara: "2026-07-01", checklist: ["Tender camas"] });

    const res = await app.request(
      `/rentas/${ctx.propertyId}/tareas/${tarea.id}/checklist/00000000-0000-4000-8000-000000000000/completar`,
      authedJson(ctx.staff.limpieza.token, {}),
    );
    expect(res.status).toBe(404);
  });

  it("marca cada ítem del checklist y luego completa la tarea con consumo real de inventario", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const tarea = ctx.rentasRepo.seedTareaOperativa({
      organizationId: ctx.organizationId,
      propertyId: ctx.propertyId,
      unidadId: ctx.unidadId,
      programadaPara: "2026-07-01",
      checklist: ["Tender camas", "Limpiar baño"],
    });
    const item = ctx.rentasRepo.seedItemInventario({
      organizationId: ctx.organizationId,
      propertyId: ctx.propertyId,
      unidadId: ctx.unidadId,
      nombre: "Toallas",
      categoria: "ropa_blanca",
      cantidadActual: 10,
      umbralMinimo: 5,
    });

    const detalleInicial = await app.request(`/rentas/${ctx.propertyId}/tareas/${tarea.id}`, authedJson(ctx.staff.limpieza.token));
    const { tarea: tareaInicial } = (await detalleInicial.json()) as { tarea: { checklist: Array<{ id: string }> } };

    for (const c of tareaInicial.checklist) {
      const r = await app.request(`/rentas/${ctx.propertyId}/tareas/${tarea.id}/checklist/${c.id}/completar`, authedJson(ctx.staff.limpieza.token, {}));
      expect(r.status).toBe(200);
    }

    const completar = await app.request(
      `/rentas/${ctx.propertyId}/tareas/${tarea.id}/completar`,
      authedJson(ctx.staff.limpieza.token, { consumos: [{ itemInventarioId: item.id, cantidad: 4 }] }),
    );
    expect(completar.status).toBe(200);
    const completarBody = (await completar.json()) as { estado: string; alertasStockBajo: string[] };
    expect(completarBody.estado).toBe("completada");
    // 10 -> 6 no cruza el umbral mínimo (5) todavía.
    expect(completarBody.alertasStockBajo).toEqual([]);

    const inventario = await app.request(`/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/inventario`, authedJson(ctx.staff.limpieza.token));
    const inventarioBody = (await inventario.json()) as { items: Array<{ id: string; cantidadActual: number }> };
    expect(inventarioBody.items.find((i) => i.id === item.id)!.cantidadActual).toBe(6);
  });
});

describe("POST/GET /rentas/:propertyId/unidades/:unidadId/incidencias", () => {
  it("reporta una incidencia leve (no requiere confirmación humana) y la lista después", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const res = await app.request(
      `/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/incidencias`,
      authedJson(ctx.staff.limpieza.token, { severidad: "leve", titulo: "Foco fundido en la sala" }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; requiereConfirmacionHumana: boolean };
    expect(body.requiereConfirmacionHumana).toBe(false);

    const listado = await app.request(`/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/incidencias`, authedJson(ctx.staff.limpieza.token));
    const listadoBody = (await listado.json()) as { incidencias: Array<{ id: string; severidad: string; titulo: string }> };
    expect(listadoBody.incidencias).toHaveLength(1);
    expect(listadoBody.incidencias[0]!.id).toBe(body.id);
    expect(listadoBody.incidencias[0]!.titulo).toBe("Foco fundido en la sala");
  });

  it("una incidencia GRAVE requiere confirmación humana", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(
      `/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/incidencias`,
      authedJson(ctx.staff.limpieza.token, { severidad: "grave", titulo: "Fuga de gas" }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { requiereConfirmacionHumana: boolean };
    expect(body.requiereConfirmacionHumana).toBe(true);
  });

  it("severidad fuera del catálogo -> 400", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(
      `/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/incidencias`,
      authedJson(ctx.staff.limpieza.token, { severidad: "catastrofica", titulo: "x" }),
    );
    expect(res.status).toBe(400);
  });

  it("una unidad que no pertenece a esta property -> 404", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(
      `/rentas/${ctx.propertyId}/unidades/00000000-0000-4000-8000-000000000000/incidencias`,
      authedJson(ctx.staff.limpieza.token, { severidad: "leve", titulo: "x" }),
    );
    expect(res.status).toBe(404);
  });
});
