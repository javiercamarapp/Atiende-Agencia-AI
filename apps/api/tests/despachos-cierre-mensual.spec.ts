// Hallazgo de seguridad (despachos): "completar tarea" y "cerrar período" (acción
// IRREVERSIBLE sobre un período fiscal) registraban quién tomó la decisión usando un
// campo `userId` que el CLIENTE mandaba en el body, en vez de tomarlo de la sesión
// autenticada del servidor (`c.get("userId")`). Esto permitía que cualquier cliente
// atribuyera la acción a otro usuario, o la dejara vacía (la UI mandaba ""). Este
// spec verifica end-to-end vía HTTP que el actor persistido es SIEMPRE el de la
// sesión autenticada y que un intento de spoofear `userId` en el body es ignorado --
// mismo patrón de fixtures que despachos-migracion-catalogo.spec.ts.
import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryAuditSink } from "@atiende/core-authz";
import { getTemplate } from "@atiende/domain-despachos";
import { buildApp } from "../src/app.ts";
import { authedJson, buildDespachosTestContext } from "./despachos-fixtures.ts";
import type { DespachosTestContext } from "./despachos-fixtures.ts";

let ctx: DespachosTestContext;

beforeEach(async () => {
  ctx = await buildDespachosTestContext(buildApp);
});

/** Abre un período de cierre real (vía repo, mismo criterio que
 * despachos-migracion-catalogo.spec.ts para la guardia 1:N) usando la plantilla
 * default -- devuelve el período y sus tareas ya insertadas. */
async function abrirPeriodo() {
  const { periodo, tareas } = await ctx.despachosRepo.insertPeriodoCierre({
    organizationId: ctx.organizationId,
    propertyId: ctx.propertyId,
    anio: 2026,
    mes: 3,
    template: getTemplate(),
  });
  return { periodo, tareas };
}

describe("POST /despachos/:propertyId/cierre-mensual/periodos/:periodoId/tareas/:tareaId/completar", () => {
  it("persiste completedBy = actor de la sesión autenticada (contador), no un valor del body", async () => {
    const app = buildApp(ctx.deps);
    const { periodo, tareas } = await abrirPeriodo();
    // "cfdi_verificado" no depende de nada -- se puede completar de inmediato.
    const tarea = tareas.find((t) => t.title === "Verificar CFDIs del mes procesados")!;

    const res = await app.request(
      `/despachos/${ctx.propertyId}/cierre-mensual/periodos/${periodo.id}/tareas/${tarea.id}/completar`,
      authedJson(ctx.staff.contador.token, {}),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tareas: Array<{ id: string; completedBy: string | null; status: string }> };
    const actualizada = body.tareas.find((t) => t.id === tarea.id)!;
    expect(actualizada.status).toBe("done");
    expect(actualizada.completedBy).toBe(ctx.staff.contador.id);
  });

  it("hallazgo de seguridad -- un 'userId' spoofeado en el body es IGNORADO; completedBy sigue siendo el actor de la sesión", async () => {
    const app = buildApp(ctx.deps);
    const { periodo, tareas } = await abrirPeriodo();
    const tarea = tareas.find((t) => t.title === "Verificar CFDIs del mes procesados")!;

    const res = await app.request(
      `/despachos/${ctx.propertyId}/cierre-mensual/periodos/${periodo.id}/tareas/${tarea.id}/completar`,
      // El cliente autenticado como "contador" intenta atribuir la tarea al admin --
      // el servidor debe ignorarlo por completo.
      authedJson(ctx.staff.contador.token, { userId: ctx.staff.admin.id }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tareas: Array<{ id: string; completedBy: string | null }> };
    const actualizada = body.tareas.find((t) => t.id === tarea.id)!;
    expect(actualizada.completedBy).toBe(ctx.staff.contador.id);
    expect(actualizada.completedBy).not.toBe(ctx.staff.admin.id);

    const sink = ctx.deps.despachosAuditSink as InstanceType<typeof InMemoryAuditSink>;
    const entrada = sink.entries.find((e) => e.action === "despachos.cierre-mensual:completar-tarea" && e.metadata?.tareaId === tarea.id);
    expect(entrada).toBeDefined();
    expect(entrada?.actorUserId).toBe(ctx.staff.contador.id);
  });

  it("body vacío ('' en la UI histórica) también persiste el actor real, nunca una cadena vacía", async () => {
    const app = buildApp(ctx.deps);
    const { periodo, tareas } = await abrirPeriodo();
    const tarea = tareas.find((t) => t.title === "Verificar CFDIs del mes procesados")!;

    const res = await app.request(
      `/despachos/${ctx.propertyId}/cierre-mensual/periodos/${periodo.id}/tareas/${tarea.id}/completar`,
      authedJson(ctx.staff.contador.token, { userId: "" }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tareas: Array<{ id: string; completedBy: string | null }> };
    const actualizada = body.tareas.find((t) => t.id === tarea.id)!;
    expect(actualizada.completedBy).toBe(ctx.staff.contador.id);
    expect(actualizada.completedBy).not.toBe("");
    expect(actualizada.completedBy).not.toBeNull();
  });
});

describe("POST /despachos/:propertyId/cierre-mensual/periodos/:periodoId/cerrar", () => {
  /** Marca TODAS las tareas del período como `done` directamente vía repo -- las 15
   * tareas de la plantilla default son `required: true` (ver templates.ts), así que
   * `cerrarPeriodo` exige las 15 completas; completar cada una vía HTTP respetando
   * el orden de dependencias no aporta nada a ESTE hallazgo (el actor del cierre),
   * que ya se prueba de forma aislada en "completar tarea" arriba -- mismo criterio
   * que la guardia 1:N de despachos-migracion-catalogo.spec.ts (estado simulado
   * directo en el repo para probar la ruta HTTP en aislamiento).
   */
  async function abrirPeriodoListoParaCerrar() {
    const { periodo, tareas } = await abrirPeriodo();
    const completas = tareas.map((t) => ({ ...t, status: "done" as const, completedAt: new Date().toISOString(), completedBy: "seed-test" }));
    await ctx.despachosRepo.replaceTareasCierre(periodo.id, completas);
    return periodo;
  }

  it("persiste closedBy = actor de la sesión autenticada (admin, único rol con permiso), no un valor del body", async () => {
    const app = buildApp(ctx.deps);
    const periodo = await abrirPeriodoListoParaCerrar();

    const res = await app.request(`/despachos/${ctx.propertyId}/cierre-mensual/periodos/${periodo.id}/cerrar`, authedJson(ctx.staff.admin.token, {}));
    expect(res.status).toBe(200);
    const cerrado = (await res.json()) as { status: string; closedBy: string | null };
    expect(cerrado.status).toBe("closed");
    expect(cerrado.closedBy).toBe(ctx.staff.admin.id);
  });

  it("hallazgo de seguridad -- un 'userId' spoofeado en el body es IGNORADO en una acción IRREVERSIBLE; closedBy sigue siendo el actor de la sesión", async () => {
    const app = buildApp(ctx.deps);
    const periodo = await abrirPeriodoListoParaCerrar();

    const res = await app.request(
      `/despachos/${ctx.propertyId}/cierre-mensual/periodos/${periodo.id}/cerrar`,
      // El cliente autenticado como "admin" intenta atribuir el cierre a otro
      // usuario (o a un id inventado) -- el servidor debe ignorarlo por completo.
      authedJson(ctx.staff.admin.token, { userId: "usuario-inventado-no-existe" }),
    );
    expect(res.status).toBe(200);
    const cerrado = (await res.json()) as { closedBy: string | null };
    expect(cerrado.closedBy).toBe(ctx.staff.admin.id);
    expect(cerrado.closedBy).not.toBe("usuario-inventado-no-existe");

    const sink = ctx.deps.despachosAuditSink as InstanceType<typeof InMemoryAuditSink>;
    const entrada = sink.entries.find((e) => e.action === "despachos.cierre-mensual:cerrar-periodo" && e.metadata?.periodoId === periodo.id);
    expect(entrada).toBeDefined();
    expect(entrada?.actorUserId).toBe(ctx.staff.admin.id);
  });

  it("contador (sin CERRAR_PERIODO_ROLES) no puede cerrar -- 403, sin importar qué userId mande en el body", async () => {
    const app = buildApp(ctx.deps);
    const periodo = await abrirPeriodoListoParaCerrar();

    const res = await app.request(
      `/despachos/${ctx.propertyId}/cierre-mensual/periodos/${periodo.id}/cerrar`,
      authedJson(ctx.staff.contador.token, { userId: ctx.staff.admin.id }),
    );
    expect(res.status).toBe(403);
  });
});
