import { describe, expect, it, vi } from "vitest";
import {
  aprobarMapeoMigracion,
  clasificarCatalogo,
  editarMapeoMigracion,
  fetchMapeoMigracion,
  fetchMapeosMigracion,
  rechazarMapeoMigracion,
} from "../src/verticals/despachos/lib/migracion-catalogo-client.ts";
import type { MapeoMigracionCuenta } from "../src/verticals/despachos/lib/migracion-catalogo-client.ts";

const MAPEO: MapeoMigracionCuenta = {
  id: "m1",
  origenCuentaId: "o1",
  destinoCuentaId: "d1",
  tipoMatch: "exacto",
  score: 100,
  estado: "aprobado",
  aprobadoPor: null,
  aprobadoEn: null,
  nota: null,
  estrategiaConciliacionSaldos: null,
  createdAt: "2026-03-01T00:00:00Z",
  updatedAt: "2026-03-01T00:00:00Z",
};

describe("clasificarCatalogo", () => {
  it("manda POST .../clasificar con ambos catálogos y devuelve mapeos.mapeos desenvuelto", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/despachos/prop-1/migracion-catalogo/clasificar");
      expect(init?.method).toBe("POST");
      expect(init?.body).toBe(
        JSON.stringify({
          catalogoOrigen: [{ id: "o1", codigo: "101-001", nombre: "Caja" }],
          catalogoDestino: [{ id: "d1", codigo: "101-001", nombre: "Caja" }],
        }),
      );
      return new Response(JSON.stringify({ mapeos: [MAPEO] }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await clasificarCatalogo(fetchImpl, "http://api.local", "tok", "prop-1", {
      catalogoOrigen: [{ id: "o1", codigo: "101-001", nombre: "Caja" }],
      catalogoDestino: [{ id: "d1", codigo: "101-001", nombre: "Caja" }],
    });
    expect(result).toEqual([MAPEO]);
  });
});

describe("fetchMapeosMigracion", () => {
  it("pide GET .../mapeos sin filtro y desenvuelve mapeos.mapeos", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("http://api.local/despachos/prop-1/migracion-catalogo/mapeos");
      return new Response(JSON.stringify({ mapeos: [MAPEO] }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await fetchMapeosMigracion(fetchImpl, "http://api.local", "tok", "prop-1");
    expect(result).toEqual([MAPEO]);
  });

  it("con filtro de estado agrega ?estado= a la query", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("http://api.local/despachos/prop-1/migracion-catalogo/mapeos?estado=pendiente");
      return new Response(JSON.stringify({ mapeos: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    await fetchMapeosMigracion(fetchImpl, "http://api.local", "tok", "prop-1", { estado: "pendiente" });
  });
});

describe("fetchMapeoMigracion", () => {
  it("pide GET .../mapeos/:id y devuelve el objeto tal cual (sin envolver)", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("http://api.local/despachos/prop-1/migracion-catalogo/mapeos/m1");
      return new Response(JSON.stringify(MAPEO), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await fetchMapeoMigracion(fetchImpl, "http://api.local", "tok", "prop-1", "m1");
    expect(result).toEqual(MAPEO);
  });
});

describe("aprobarMapeoMigracion", () => {
  it("manda POST .../mapeos/:id/aprobar con decididoPor/nota/estrategia", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/despachos/prop-1/migracion-catalogo/mapeos/m1/aprobar");
      expect(init?.method).toBe("POST");
      expect(init?.body).toBe(JSON.stringify({ decididoPor: "contador-1", nota: "ok", estrategiaConciliacionSaldos: "promedio" }));
      return new Response(JSON.stringify({ ...MAPEO, aprobadoPor: "contador-1" }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await aprobarMapeoMigracion(fetchImpl, "http://api.local", "tok", "prop-1", "m1", { decididoPor: "contador-1", nota: "ok", estrategiaConciliacionSaldos: "promedio" });
    expect(result.aprobadoPor).toBe("contador-1");
  });

  it("409 (guardia N:1 sin estrategia) -> propaga el mensaje real del servidor", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "se requiere estrategiaConciliacionSaldos" }), { status: 409 })) as unknown as typeof fetch;
    await expect(aprobarMapeoMigracion(fetchImpl, "http://api.local", "tok", "prop-1", "m1", { decididoPor: "contador-1" })).rejects.toThrow("estrategiaConciliacionSaldos");
  });
});

describe("rechazarMapeoMigracion", () => {
  it("manda POST .../mapeos/:id/rechazar con decididoPor/nota", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/despachos/prop-1/migracion-catalogo/mapeos/m1/rechazar");
      expect(init?.body).toBe(JSON.stringify({ decididoPor: "contador-1", nota: "no corresponde" }));
      return new Response(JSON.stringify({ ...MAPEO, estado: "rechazado" }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await rechazarMapeoMigracion(fetchImpl, "http://api.local", "tok", "prop-1", "m1", { decididoPor: "contador-1", nota: "no corresponde" });
    expect(result.estado).toBe("rechazado");
  });
});

describe("editarMapeoMigracion", () => {
  it("manda POST .../mapeos/:id/editar con decididoPor/destinoCuentaId/nota", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/despachos/prop-1/migracion-catalogo/mapeos/m1/editar");
      expect(init?.body).toBe(JSON.stringify({ decididoPor: "contador-1", destinoCuentaId: "d999", nota: "corrección" }));
      return new Response(JSON.stringify({ ...MAPEO, estado: "editado", destinoCuentaId: "d999" }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await editarMapeoMigracion(fetchImpl, "http://api.local", "tok", "prop-1", "m1", { decididoPor: "contador-1", destinoCuentaId: "d999", nota: "corrección" });
    expect(result.estado).toBe("editado");
    expect(result.destinoCuentaId).toBe("d999");
  });

  it("nota vacía -> 500/error de dominio propagado", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "nota obligatoria" }), { status: 500 })) as unknown as typeof fetch;
    await expect(editarMapeoMigracion(fetchImpl, "http://api.local", "tok", "prop-1", "m1", { decididoPor: "contador-1", destinoCuentaId: "d999", nota: "" })).rejects.toThrow("nota obligatoria");
  });
});
