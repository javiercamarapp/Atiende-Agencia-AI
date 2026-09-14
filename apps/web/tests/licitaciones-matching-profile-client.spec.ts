import { describe, expect, it, vi } from "vitest";
import { fetchMatchingProfile, saveMatchingProfile } from "../src/verticals/licitaciones/lib/matching-profile-client.ts";

const PROFILE = {
  organizationId: "org1",
  keywords: ["mantenimiento de flotilla"],
  excludedKeywords: ["obra pública"],
  classifierCodes: ["50111100"],
  entities: ["Secretaría de Movilidad"],
  states: ["Jalisco"],
  budgetMin: 100_000,
  budgetMax: 2_000_000,
  updatedBy: "user1",
  updatedAt: "2026-01-02T00:00:00Z",
};

const EMPTY_PROFILE = {
  organizationId: "org1",
  keywords: [],
  excludedKeywords: [],
  classifierCodes: [],
  entities: [],
  states: [],
  budgetMin: null,
  budgetMax: null,
  updatedBy: null,
  updatedAt: null,
};

describe("fetchMatchingProfile", () => {
  it("pide GET .../matching-profile y devuelve el perfil tal cual", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("http://api.local/licitaciones/prop-1/matching-profile");
      return new Response(JSON.stringify(PROFILE), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await fetchMatchingProfile(fetchImpl, "http://api.local", "tok", "prop-1");
    expect(result).toEqual(PROFILE);
  });

  it("perfil sin configurar -> 200 con el perfil vacío explícito (nunca 404)", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(EMPTY_PROFILE), { status: 200 })) as unknown as typeof fetch;
    const result = await fetchMatchingProfile(fetchImpl, "http://api.local", "tok", "prop-1");
    expect(result).toEqual(EMPTY_PROFILE);
  });
});

describe("saveMatchingProfile", () => {
  it("hace PUT .../matching-profile con los 7 campos del perfil", async () => {
    const input = {
      keywords: ["mantenimiento de flotilla"],
      excludedKeywords: ["obra pública"],
      classifierCodes: ["50111100"],
      entities: ["Secretaría de Movilidad"],
      states: ["Jalisco"],
      budgetMin: 100_000,
      budgetMax: 2_000_000,
    };
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/licitaciones/prop-1/matching-profile");
      expect(init?.method).toBe("PUT");
      expect(JSON.parse(init!.body as string)).toEqual(input);
      return new Response(JSON.stringify(PROFILE), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await saveMatchingProfile(fetchImpl, "http://api.local", "tok", "prop-1", input);
    expect(result).toEqual(PROFILE);
  });

  it("403 (rol sin WRITE_ROLES) -> propaga el mensaje real del servidor", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "No tienes permiso para editar el perfil de matching." }), { status: 403 })) as unknown as typeof fetch;
    await expect(
      saveMatchingProfile(fetchImpl, "http://api.local", "tok", "prop-1", { keywords: [], excludedKeywords: [], classifierCodes: [], entities: [], states: [], budgetMin: null, budgetMax: null }),
    ).rejects.toThrow("No tienes permiso para editar el perfil de matching.");
  });

  it("400 (budgetMin > budgetMax) -> propaga el mensaje de validación real", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "budgetMin no puede ser mayor que budgetMax." }), { status: 400 })) as unknown as typeof fetch;
    await expect(
      saveMatchingProfile(fetchImpl, "http://api.local", "tok", "prop-1", { keywords: [], excludedKeywords: [], classifierCodes: [], entities: [], states: [], budgetMin: 500, budgetMax: 100 }),
    ).rejects.toThrow("budgetMin no puede ser mayor que budgetMax.");
  });
});
