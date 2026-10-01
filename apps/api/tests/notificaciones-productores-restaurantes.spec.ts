// Productor `restaurantes.onboarding.listo`: el checklist de Primeros pasos completo avisa UNA vez por organizacion (clave = organizacion)
// a owner/admin con enlace a la pantalla origen; un checklist incompleto no emite, y una emision que falla (base sin 0039) no cambia la
// respuesta. El estado `listoParaOperar` se fuerza sobre `cargarOnboarding` (su calculo ya lo prueba restaurantes-admin-onboarding.spec.ts).
import { describe, expect, it, vi } from "vitest";

const estado = vi.hoisted(() => ({ listo: false }));
vi.mock("@atiende/domain-restaurantes", async (importOriginal) => {
  const real = await importOriginal<typeof import("@atiende/domain-restaurantes")>();
  return {
    ...real,
    cargarOnboarding: async () => ({ items: [], resumen: { hechos: 0, total: 0, obligatoriosPendientes: estado.listo ? 0 : 1 }, listoParaOperar: estado.listo }),
  };
});

import { buildApp } from "../src/app.ts";
import { authedGet, buildRestaurantesKpiTestContext } from "./restaurantes-admin-kpis-fixtures.ts";
import { conEmisiones } from "./support/emisiones.ts";

const urlDe = (propertyId: string) => `/v1/restaurantes/${propertyId}/admin/onboarding`;

describe("restaurantes.onboarding.listo", () => {
  it("checklist completo: emite UN aviso por organizacion, a owner/admin, con enlace a Primeros pasos y sin PII", async () => {
    estado.listo = true;
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const { deps, emisiones } = conEmisiones(ctx.deps);
    const res = await buildApp(deps).request(urlDe(ctx.propertyIdA), authedGet(ctx.staff.owner.token));
    expect(res.status).toBe(200);
    expect(emisiones).toHaveLength(1);
    expect(emisiones[0]).toMatchObject({
      evento: "restaurantes.onboarding.listo",
      organizationId: ctx.organizationId,
      propertyId: null,
      categoria: "onboarding",
      severidad: "info",
      enlace: "/restaurantes/{orgSlug}/primeros-pasos",
      dedupeKey: `restaurantes.onboarding.listo:${ctx.organizationId}`,
      roles: null,
    });
  });

  it("checklist incompleto: no emite", async () => {
    estado.listo = false;
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const { deps, emisiones } = conEmisiones(ctx.deps);
    expect((await buildApp(deps).request(urlDe(ctx.propertyIdA), authedGet(ctx.staff.owner.token))).status).toBe(200);
    expect(emisiones).toHaveLength(0);
  });

  it("una emision que falla (base sin migrar) no cambia el 200 del checklist", async () => {
    estado.listo = true;
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const { deps } = conEmisiones(ctx.deps, {
      alEmitir: () => {
        throw Object.assign(new Error("function core.emit_notification does not exist"), { code: "42883" });
      },
    });
    const res = await buildApp(deps).request(urlDe(ctx.propertyIdA), authedGet(ctx.staff.owner.token));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { listoParaOperar: boolean }).listoParaOperar).toBe(true);
  });
});
