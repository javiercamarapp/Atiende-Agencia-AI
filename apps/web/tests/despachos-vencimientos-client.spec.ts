import { describe, expect, it, vi } from "vitest";
import { calcularVencimientos, completarVencimiento, escalarVencimiento, fetchVencimientos } from "../src/verticals/despachos/lib/vencimientos-client.ts";
import type { FiscalDeadline } from "../src/verticals/despachos/lib/vencimientos-client.ts";

const DEADLINE: FiscalDeadline = {
  id: "d1",
  tipo: "ISR",
  periodo: "2026-03",
  fechaLimite: "2026-04-17",
  prioridad: "media",
  estado: "pendiente",
  fechaPresentacion: null,
  comprobanteUrl: null,
  diasRestantes: 5,
  creadoEn: "2026-03-01T00:00:00Z",
};

describe("fetchVencimientos", () => {
  it("pide GET .../vencimientos sin filtro y devuelve el arreglo tal cual", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("http://api.local/despachos/prop-1/vencimientos");
      return new Response(JSON.stringify([DEADLINE]), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await fetchVencimientos(fetchImpl, "http://api.local", "tok", "prop-1");
    expect(result).toEqual([DEADLINE]);
  });

  it("con filtro de estado agrega ?estado= a la query", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("http://api.local/despachos/prop-1/vencimientos?estado=escalado");
      return new Response(JSON.stringify([]), { status: 200 });
    }) as unknown as typeof fetch;
    await fetchVencimientos(fetchImpl, "http://api.local", "tok", "prop-1", { estado: "escalado" });
  });
});

describe("calcularVencimientos", () => {
  it("manda POST .../vencimientos/calcular con year/month y devuelve los 4 nuevos", async () => {
    const nuevos = [DEADLINE, { ...DEADLINE, id: "d2", tipo: "IVA" as const }];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/despachos/prop-1/vencimientos/calcular");
      expect(init?.method).toBe("POST");
      expect(init?.body).toBe(JSON.stringify({ year: 2026, month: 3 }));
      return new Response(JSON.stringify(nuevos), { status: 201 });
    }) as unknown as typeof fetch;
    const result = await calcularVencimientos(fetchImpl, "http://api.local", "tok", "prop-1", { year: 2026, month: 3 });
    expect(result).toEqual(nuevos);
  });
});

describe("completarVencimiento", () => {
  it("manda POST .../:id/completar sin comprobante -> body {}", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/despachos/prop-1/vencimientos/d1/completar");
      expect(init?.body).toBe(JSON.stringify({}));
      return new Response(JSON.stringify({ ...DEADLINE, estado: "completado" }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await completarVencimiento(fetchImpl, "http://api.local", "tok", "prop-1", "d1");
    expect(result.estado).toBe("completado");
  });

  it("con comprobanteUrl lo incluye en el body", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(init?.body).toBe(JSON.stringify({ comprobanteUrl: "https://ej.mx/c.pdf" }));
      return new Response(JSON.stringify(DEADLINE), { status: 200 });
    }) as unknown as typeof fetch;
    await completarVencimiento(fetchImpl, "http://api.local", "tok", "prop-1", "d1", "https://ej.mx/c.pdf");
  });

  it("409 (ya completado) -> propaga el mensaje real del servidor", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "Este vencimiento ya está marcado como completado." }), { status: 409 })) as unknown as typeof fetch;
    await expect(completarVencimiento(fetchImpl, "http://api.local", "tok", "prop-1", "d1")).rejects.toThrow("ya está marcado como completado");
  });
});

describe("escalarVencimiento", () => {
  it("manda POST .../:id/escalar y devuelve escalamiento+notificacion", async () => {
    const body = {
      escalamiento: { id: "e1", nivel: "nivel_1" as const, enviadoEn: "2026-03-10T00:00:00Z", notas: "Escalamiento automático para 'ISR'." },
      requiereRevisionHumana: true,
      motivoRevisionHumana: "Escalamiento nivel nivel_1 para vencimiento ISR",
      notificacion: { destinatarios: 2, correosEncolados: 2 },
    };
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/despachos/prop-1/vencimientos/d1/escalar");
      expect(init?.method).toBe("POST");
      return new Response(JSON.stringify(body), { status: 201 });
    }) as unknown as typeof fetch;
    const result = await escalarVencimiento(fetchImpl, "http://api.local", "tok", "prop-1", "d1");
    expect(result).toEqual(body);
  });

  it("409 (ya completado) -> propaga el mensaje real", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "No se puede escalar un vencimiento ya completado." }), { status: 409 })) as unknown as typeof fetch;
    await expect(escalarVencimiento(fetchImpl, "http://api.local", "tok", "prop-1", "d1")).rejects.toThrow("No se puede escalar");
  });
});
