// KPI de entrega y lectura de los avisos de estado de pedido por WhatsApp (migracion 066) dentro de GET .../admin/whatsapp/kpi.
// Solo conteos; la disponibilidad de `entrega` es independiente de la del KPI de conversaciones (base con la 040 y sin la 066).
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryWhatsappKpiRepository, whatsappEntregaDiaVacia } from "@atiende/domain-restaurantes";
import type { WhatsappEntregaDia } from "@atiende/domain-restaurantes";
import { buildApp } from "../src/app.ts";
import type { AppDeps } from "../src/deps.ts";
import { authedGet, buildRestaurantesKpiTestContext } from "./restaurantes-admin-kpis-fixtures.ts";

afterEach(() => vi.useRealTimers());

async function construir() {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-03-10T18:00:00Z"));
  const ctx = await buildRestaurantesKpiTestContext(buildApp);
  const kpi = new InMemoryWhatsappKpiRepository();
  const deps: AppDeps = { ...ctx.deps, whatsappKpiRepo: () => kpi };
  return { ctx, kpi, app: buildApp(deps), url: `/v1/restaurantes/${ctx.propertyIdA}/admin/whatsapp/kpi` };
}

const dia = (fecha: string, parcial: Partial<WhatsappEntregaDia>): WhatsappEntregaDia => ({ ...whatsappEntregaDiaVacia(fecha), ...parcial });

describe("GET .../admin/whatsapp/kpi: entrega y lectura de los avisos de pedido", () => {
  it("calcula tasa de entrega (entregados/enviados) y de lectura (leidos/entregados) del periodo y suma los fallos por motivo", async () => {
    const { ctx, kpi, app, url } = await construir();
    kpi.entrega.set(`${ctx.organizationId}:${ctx.propertyIdA}`, [
      dia("2026-03-09", { enviados: 4, entregados: 3, leidos: 1, fallidos: 1, sinEstado: 0, fallosPorMotivo: { fuera_de_ventana: 1 } }),
      dia("2026-03-10", { enviados: 6, entregados: 3, leidos: 2, fallidos: 2, sinEstado: 1, fallosPorMotivo: { fuera_de_ventana: 1, numero_no_entregable: 1 } }),
    ]);
    const res = await app.request(`${url}?dias=2`, authedGet(ctx.staff.owner.token));
    expect(res.status).toBe(200);
    const r = (await res.json()) as { disponible: boolean; entrega: { disponible: boolean; resumen: Record<string, unknown>; serie: unknown[] } };
    expect(r.disponible).toBe(true);
    expect(r.entrega.disponible).toBe(true);
    expect(r.entrega.resumen).toEqual({
      dias: 2, enviados: 10, entregados: 6, leidos: 3, fallidos: 3, sinEstado: 1, entregaPct: 60, lecturaPct: 50,
      fallosPorMotivo: { fuera_de_ventana: 2, numero_no_entregable: 1 },
    });
    expect(r.entrega.serie).toHaveLength(2);
  });

  it("sin envios: porcentajes null (no 0%) y dias en cero", async () => {
    const { ctx, app, url } = await construir();
    const r = (await (await app.request(`${url}?dias=3`, authedGet(ctx.staff.owner.token))).json()) as { entrega: { resumen: { enviados: number; entregaPct: number | null; lecturaPct: number | null }; serie: unknown[] } };
    expect(r.entrega.serie).toHaveLength(3);
    expect(r.entrega.resumen).toMatchObject({ enviados: 0, entregaPct: null, lecturaPct: null });
  });

  it("base sin la 066: entrega.disponible=false con serie vacia, y el KPI de conversaciones sigue disponible", async () => {
    const { ctx, kpi, app, url } = await construir();
    kpi.entregaDisponible = false;
    const res = await app.request(url, authedGet(ctx.staff.owner.token));
    expect(res.status).toBe(200);
    const r = (await res.json()) as { disponible: boolean; entrega: { disponible: boolean; serie: unknown[]; resumen: { enviados: number; entregaPct: number | null } } };
    expect(r.disponible).toBe(true);
    expect(r.entrega).toMatchObject({ disponible: false, serie: [], resumen: { enviados: 0, entregaPct: null } });
  });

  it("no expone telefonos, nombres ni texto: solo conteos", async () => {
    const { ctx, kpi, app, url } = await construir();
    kpi.entrega.set(`${ctx.organizationId}:${ctx.propertyIdA}`, [dia("2026-03-10", { enviados: 1, entregados: 1 })]);
    const texto = await (await app.request(`${url}?dias=1`, authedGet(ctx.staff.owner.token))).text();
    expect(texto).not.toMatch(/phone|telefono|wamid|recipient|payload/i);
  });
});
