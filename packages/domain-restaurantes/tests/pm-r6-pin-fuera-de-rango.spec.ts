// QA-PM-R6 (T7-041): coordenadas fuera de rango (lng -614100, lat 91) no son un pin: buscar_sucursal_cercana las ignora (como (0,0)) y usa la ubicacion compartida real; sin ella pide el dato.
import { describe, expect, it } from "vitest";
import { invokeAgentTool } from "../src/agent-tools/registry.ts";
import { buildRestaurantFixture } from "./fixtures.ts";

const REAL = { lat: 21.2817, lng: -89.665 };
describe("buscar_sucursal_cercana con coordenadas fuera de rango", () => {
  const ctx = (organizationId: string, sharedLocation?: { lat: number; lng: number }) => ({ organizationId, channel: "whatsapp" as const, phone: "9991234567", ...(sharedLocation ? { sharedLocation } : {}) });
  it.each([
    ["lng -614100", { lat: 21.0211, lng: -614100 }],
    ["lat 91", { lat: 91, lng: -89.6 }],
    ["lng 181", { lat: 21, lng: 181 }],
    ["lat -90.5", { lat: -90.5, lng: 0.5 }],
  ])("%s: usa la ubicacion compartida real en lugar de medir distancias absurdas", async (_n, malas) => {
    const f = buildRestaurantFixture();
    const r = await invokeAgentTool(f.repo, ctx(f.organizationId, REAL), "buscar_sucursal_cercana", malas);
    expect(r.result).toMatchObject({ encontrada: true, estado: "asignada" });
  });
  it.each([[0], [""], [null], [false], [[]], [{}]])("lat/lng %j no valen como pin y no lanzan 500", async (v) => {
    const f = buildRestaurantFixture();
    await expect(invokeAgentTool(f.repo, ctx(f.organizationId, REAL), "buscar_sucursal_cercana", { lat: v, lng: v })).resolves.toMatchObject({ result: { encontrada: true } });
  });
});
