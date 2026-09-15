// Fase 12 — hallazgo de auditoría (severidad ALTA, "asignar repartidor a un pedido no
// tiene UI"): cliente real de GET .../admin/staff/repartidores (admin-staff.ts).
//
// Fase 14 — hallazgo de auditoría (severidad ALTA, "Invitaciones de staff sin
// ninguna UI"): cliente real de POST/GET/DELETE .../admin/staff/invitaciones
// (mismo admin-staff.ts).
import { describe, expect, it, vi } from "vitest";
import { createStaffInvite, fetchRepartidores, fetchStaffInvites, revokeStaffInvite } from "../src/verticals/restaurantes/lib/staff-client.ts";

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

describe("createStaffInvite", () => {
  it("hace POST real con email/verticalRole y devuelve la invitación con su inviteToken", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/v1/restaurantes/prop-1/admin/staff/invitaciones");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(init!.body as string)).toEqual({ email: "nuevo@x.mx", verticalRole: "staff" });
      return new Response(
        JSON.stringify({
          id: "inv-1",
          email: "nuevo@x.mx",
          verticalRole: "staff",
          propertyIds: null,
          status: "pending",
          expiresAt: "2026-09-21T00:00:00.000Z",
          createdAt: "2026-09-14T00:00:00.000Z",
          inviteToken: "token-plano-largo-de-verdad",
        }),
        { status: 201 },
      );
    }) as unknown as typeof fetch;

    const result = await createStaffInvite(fetchImpl, "http://api.local", "tok", "prop-1", { email: "nuevo@x.mx", verticalRole: "staff" });
    expect(result.id).toBe("inv-1");
    expect(result.inviteToken).toBe("token-plano-largo-de-verdad");
  });

  it("un correo que ya es staff de esta organización (409) -> error real, nunca una invitación fantasma", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "Ese correo ya es staff de esta organización." }), { status: 409 })) as unknown as typeof fetch;
    await expect(createStaffInvite(fetchImpl, "http://api.local", "tok", "prop-1", { email: "x@x.mx", verticalRole: "staff" })).rejects.toThrow(
      "Ese correo ya es staff de esta organización.",
    );
  });
});

describe("fetchStaffInvites", () => {
  it("hace GET real y nunca expone un inviteToken (el listado no lo trae)", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("http://api.local/v1/restaurantes/prop-1/admin/staff/invitaciones");
      return new Response(
        JSON.stringify({
          invitations: [
            { id: "inv-1", email: "a@x.mx", verticalRole: "staff", propertyIds: null, status: "pending", expiresAt: "2026-09-21T00:00:00.000Z", createdAt: "2026-09-14T00:00:00.000Z" },
          ],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const result = await fetchStaffInvites(fetchImpl, "http://api.local", "tok", "prop-1");
    expect(result).toHaveLength(1);
    expect(result[0]).not.toHaveProperty("inviteToken");
  });
});

describe("revokeStaffInvite", () => {
  it("hace DELETE real al item de la invitación", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/v1/restaurantes/prop-1/admin/staff/invitaciones/inv-1");
      expect(init?.method).toBe("DELETE");
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;

    await expect(revokeStaffInvite(fetchImpl, "http://api.local", "tok", "prop-1", "inv-1")).resolves.toBeUndefined();
  });

  it("invitación inexistente/ya usada/ya revocada (404) -> error real", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "Invitación no encontrada, ya fue usada, o ya estaba revocada." }), { status: 404 })) as unknown as typeof fetch;
    await expect(revokeStaffInvite(fetchImpl, "http://api.local", "tok", "prop-1", "inv-nope")).rejects.toThrow(
      "Invitación no encontrada, ya fue usada, o ya estaba revocada.",
    );
  });
});
