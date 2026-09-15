import { describe, expect, it, vi } from "vitest";
import { aprobarRevision, fetchRevision, fetchRevisionesPendientes, rechazarRevision } from "../src/verticals/despachos/lib/revisiones-client.ts";

const SAMPLE_REVISION = {
  id: "rev1",
  invoiceId: "inv1",
  motivo: "El motor no pudo clasificar automáticamente el CFDI de tipo Egreso.",
  estado: "pendiente",
  notaDecision: null,
  resueltoPor: null,
  resueltoEn: null,
  creadoEn: "2026-03-01T00:00:00Z",
};

describe("fetchRevisionesPendientes", () => {
  it("pide GET .../revisiones y devuelve el arreglo tal cual", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("http://api.local/despachos/prop-1/revisiones");
      return new Response(JSON.stringify([SAMPLE_REVISION]), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await fetchRevisionesPendientes(fetchImpl, "http://api.local", "tok", "prop-1");
    expect(result).toEqual([SAMPLE_REVISION]);
  });
});

describe("fetchRevision", () => {
  it("pide GET .../revisiones/:id y devuelve la revisión completa", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("http://api.local/despachos/prop-1/revisiones/rev1");
      return new Response(JSON.stringify(SAMPLE_REVISION), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await fetchRevision(fetchImpl, "http://api.local", "tok", "prop-1", "rev1");
    expect(result).toEqual(SAMPLE_REVISION);
  });

  it("404 -> propaga el mensaje real del servidor", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "Revisión no encontrada." }), { status: 404 })) as unknown as typeof fetch;
    await expect(fetchRevision(fetchImpl, "http://api.local", "tok", "prop-1", "no-existe")).rejects.toThrow("Revisión no encontrada.");
  });
});

describe("aprobarRevision", () => {
  it("manda POST .../aprobar sin nota -> body {}", async () => {
    const resuelta = { ...SAMPLE_REVISION, estado: "aprobado", resueltoPor: "u1", resueltoEn: "2026-03-02T00:00:00Z" };
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/despachos/prop-1/revisiones/rev1/aprobar");
      expect(init?.method).toBe("POST");
      expect(init?.body).toBe(JSON.stringify({}));
      return new Response(JSON.stringify(resuelta), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await aprobarRevision(fetchImpl, "http://api.local", "tok", "prop-1", "rev1");
    expect(result).toEqual(resuelta);
  });

  it("manda POST .../aprobar con nota -> body {nota}", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(init?.body).toBe(JSON.stringify({ nota: "Verificado contra el estado de cuenta." }));
      return new Response(JSON.stringify({ ...SAMPLE_REVISION, estado: "aprobado" }), { status: 200 });
    }) as unknown as typeof fetch;
    await aprobarRevision(fetchImpl, "http://api.local", "tok", "prop-1", "rev1", "Verificado contra el estado de cuenta.");
  });

  it("409 (ya resuelta) -> propaga el mensaje real del servidor", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "Esta revisión ya fue resuelta anteriormente." }), { status: 409 })) as unknown as typeof fetch;
    await expect(aprobarRevision(fetchImpl, "http://api.local", "tok", "prop-1", "rev1")).rejects.toThrow("ya fue resuelta anteriormente");
  });
});

describe("rechazarRevision", () => {
  it("manda POST .../rechazar y devuelve la revisión resuelta", async () => {
    const resuelta = { ...SAMPLE_REVISION, estado: "rechazado", resueltoPor: "u1", resueltoEn: "2026-03-02T00:00:00Z", notaDecision: "RFC receptor no coincide." };
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/despachos/prop-1/revisiones/rev1/rechazar");
      expect(init?.body).toBe(JSON.stringify({ nota: "RFC receptor no coincide." }));
      return new Response(JSON.stringify(resuelta), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await rechazarRevision(fetchImpl, "http://api.local", "tok", "prop-1", "rev1", "RFC receptor no coincide.");
    expect(result).toEqual(resuelta);
  });

  it("403 (rol sin permiso) -> propaga el mensaje real del servidor", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "No tienes permiso para esta acción." }), { status: 403 })) as unknown as typeof fetch;
    await expect(rechazarRevision(fetchImpl, "http://api.local", "tok", "prop-1", "rev1")).rejects.toThrow("No tienes permiso");
  });
});
