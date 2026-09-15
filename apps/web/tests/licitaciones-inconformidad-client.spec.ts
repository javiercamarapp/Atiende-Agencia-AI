import { describe, expect, it, vi } from "vitest";
import { createInconformidadDraft, fetchInconformidadDrafts, markInconformidadReviewed } from "../src/verticals/licitaciones/lib/inconformidad-client.ts";
import type { InconformidadDraft } from "../src/verticals/licitaciones/lib/inconformidad-client.ts";

const SAMPLE_DRAFT: InconformidadDraft = {
  id: "draft-1",
  tenderId: "t1",
  version: 1,
  status: "borrador",
  contentHash: "hash-abc",
  hechos: ["El fallo desechó nuestra propuesta por un requisito no marcado como obligatorio."],
  agravios: ["El acto viola el principio de máxima concurrencia (Art. 49 LAASSP)."],
  pruebas: ["Copia del fallo publicado."],
  fundamentos: [
    { articulo: "Art. 49", ley: "LAASSP nueva", jurisdiccion: "Federal", fechaDof: "2025-04-16", texto: "..." },
    { articulo: "Art. 95", ley: "LAASSP nueva", jurisdiccion: "Federal", fechaDof: "2025-04-16", texto: "..." },
  ],
  plazo: { diasHabiles: 6, fechaNotificacionFallo: "2026-01-05", fechaLimite: "2026-01-13", fundamentoLegal: "Art. 95 LAASSP", bajoTratados: false },
  viability: "alta",
  viabilityRecommendation: "Se registró al menos una prueba por cada agravio planteado.",
  disclaimer: "BORRADOR — requiere revisión de abogado.",
  reviewedBy: null,
  reviewedAt: null,
  createdBy: "u1",
  createdAt: "2026-01-05T00:00:00Z",
};

describe("fetchInconformidadDrafts", () => {
  it("hace GET .../inconformidad y devuelve el historial completo tal cual", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("http://api.local/licitaciones/prop-1/tenders/t1/inconformidad");
      return new Response(JSON.stringify({ drafts: [SAMPLE_DRAFT] }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await fetchInconformidadDrafts(fetchImpl, "http://api.local", "tok", "prop-1", "t1");
    expect(result).toEqual([SAMPLE_DRAFT]);
  });
});

describe("createInconformidadDraft", () => {
  it("hace POST .../inconformidad con el body exacto -- nunca declara plazo/fundamentos/viability", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/licitaciones/prop-1/tenders/t1/inconformidad");
      expect(init?.method).toBe("POST");
      const body = JSON.parse(init!.body as string);
      expect(body).toEqual({
        hechos: ["h1"],
        agravios: ["a1"],
        pruebas: ["p1"],
        falloNotifiedOn: "2026-01-05",
        bajoTratados: false,
      });
      expect(body.plazo).toBeUndefined();
      expect(body.fundamentos).toBeUndefined();
      return new Response(JSON.stringify(SAMPLE_DRAFT), { status: 201 });
    }) as unknown as typeof fetch;
    const result = await createInconformidadDraft(fetchImpl, "http://api.local", "tok", "prop-1", "t1", {
      hechos: ["h1"],
      agravios: ["a1"],
      pruebas: ["p1"],
      falloNotifiedOn: "2026-01-05",
      bajoTratados: false,
    });
    expect(result).toEqual(SAMPLE_DRAFT);
  });

  it("400 (hechos vacíos) -> propaga el mensaje real del servidor", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "hechos: se esperaba un arreglo de cadenas no vacías." }), { status: 400 })) as unknown as typeof fetch;
    await expect(
      createInconformidadDraft(fetchImpl, "http://api.local", "tok", "prop-1", "t1", { hechos: [], agravios: ["a1"], pruebas: [], falloNotifiedOn: "2026-01-05", bajoTratados: false }),
    ).rejects.toThrow("hechos");
  });

  it("403 (viewer, fuera de WRITE_ROLES) -> propaga el mensaje real", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "No tienes permiso para realizar esta acción." }), { status: 403 })) as unknown as typeof fetch;
    await expect(
      createInconformidadDraft(fetchImpl, "http://api.local", "tok", "prop-1", "t1", { hechos: ["h"], agravios: ["a"], pruebas: [], falloNotifiedOn: "2026-01-05", bajoTratados: false }),
    ).rejects.toThrow("No tienes permiso");
  });
});

describe("markInconformidadReviewed", () => {
  it("hace POST .../inconformidad/:id/mark-reviewed y devuelve el borrador actualizado", async () => {
    const reviewed: InconformidadDraft = { ...SAMPLE_DRAFT, status: "revisado", reviewedBy: "u2", reviewedAt: "2026-01-06T00:00:00Z" };
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/licitaciones/prop-1/tenders/t1/inconformidad/draft-1/mark-reviewed");
      expect(init?.method).toBe("POST");
      return new Response(JSON.stringify(reviewed), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await markInconformidadReviewed(fetchImpl, "http://api.local", "tok", "prop-1", "t1", "draft-1");
    expect(result).toEqual(reviewed);
  });

  it("409 (ya revisado) -> propaga el conflicto real, nunca lo silencia", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "Este borrador ya fue marcado como revisado." }), { status: 409 })) as unknown as typeof fetch;
    await expect(markInconformidadReviewed(fetchImpl, "http://api.local", "tok", "prop-1", "t1", "draft-1")).rejects.toThrow("ya fue marcado como revisado");
  });
});
