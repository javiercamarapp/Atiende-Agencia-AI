// Fase 12 — hallazgo de auditoría (severidad ALTA, "asignar repartidor a un pedido no
// tiene UI"): cliente real de GET .../admin/staff/repartidores (admin-staff.ts).
import { describe, expect, it, vi } from "vitest";
import { fetchRepartidores } from "../src/verticals/restaurantes/lib/staff-client.ts";

describe("fetchRepartidores", () => {
  it("hace GET real al endpoint de repartidores de la organización", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("http://api.local/v1/restaurantes/prop-1/admin/staff/repartidores");
      return new Response(
        JSON.stringify({
          repartidores: [
            { id: "rep-1", email: "rep1@x.mx", fullName: "Repartidor Uno", propertyIds: null },
            { id: "rep-2", email: "rep2@x.mx", fullName: "Repartidor Dos", propertyIds: ["prop-1"] },
          ],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const result = await fetchRepartidores(fetchImpl, "http://api.local", "tok", "prop-1");
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ id: "rep-1", fullName: "Repartidor Uno" });
  });

  it("un 403 (ej. token de un repartidor, MANAGER_ROLES) -> error real", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "rol de plataforma insuficiente" }), { status: 403 })) as unknown as typeof fetch;
    await expect(fetchRepartidores(fetchImpl, "http://api.local", "tok", "prop-1")).rejects.toThrow();
  });
});
