import { describe, expect, it, vi } from "vitest";
import { captureIdentidad, createMigratorio, decidePurga, fetchIdentidades, fetchMigratorios, fetchPurgas, reportMigratorio, requestPurga, revealIdentidad, verifyIdentidad } from "../src/verticals/hoteles/lib/identidad-client.ts";

const API = "http://api.local";
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

describe("identidad-client (hoteles)", () => {
  it("fetchIdentidades pide .../identidad y con filtro agrega ?estado=", async () => {
    const urls: string[] = [];
    const f = vi.fn(async (url: string) => {
      urls.push(url);
      return ok({ disponible: true, llaveConfigurada: true, items: [] });
    }) as unknown as typeof fetch;
    await fetchIdentidades(f, API, "tok", "p1");
    await fetchIdentidades(f, API, "tok", "p1", "activo");
    expect(urls).toEqual([`${API}/hoteles/p1/identidad`, `${API}/hoteles/p1/identidad?estado=activo`]);
  });

  it("captureIdentidad hace POST y NO envia campos vacios/undefined; devuelve la identidad", async () => {
    const f = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe(`${API}/hoteles/p1/identidad`);
      expect(init?.method).toBe("POST");
      expect(JSON.parse(init!.body as string)).toEqual({ guestId: "g1", documentType: "ine", fullName: "Ana", documentNumber: "ABC123" });
      return ok({ identidad: { id: "i1" } });
    }) as unknown as typeof fetch;
    const r = await captureIdentidad(f, API, "tok", "p1", { guestId: "g1", documentType: "ine", fullName: "Ana", documentNumber: "ABC123", nationality: "", birthDate: undefined });
    expect(r.id).toBe("i1");
  });

  it("revealIdentidad manda el motivo y devuelve solo el documento", async () => {
    const f = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe(`${API}/hoteles/p1/identidad/i1/revelar`);
      expect(JSON.parse(init!.body as string)).toEqual({ motivo: "Verificacion en mostrador" });
      return ok({ identidad: { id: "i1" }, documento: { nombreCompleto: "Ana", numeroDocumento: "X1" } });
    }) as unknown as typeof fetch;
    expect(await revealIdentidad(f, API, "tok", "p1", "i1", "Verificacion en mostrador")).toMatchObject({ nombreCompleto: "Ana" });
  });

  it("verify / requestPurga / decidePurga / migratorio usan las rutas reales", async () => {
    const calls: Array<[string, string, unknown]> = [];
    const f = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push([init?.method ?? "GET", url.replace(API, ""), init?.body ? JSON.parse(init.body as string) : undefined]);
      if (url.endsWith("/verificar")) return ok({ identidad: null });
      if (url.endsWith("/solicitar-purga")) return ok({ solicitudId: "s1" });
      if (url.endsWith("/decidir")) return ok({ resultado: "ejecutada" });
      if (url.includes("identidad-purgas")) return ok({ disponible: true, items: [] });
      if (url.endsWith("/reportar")) return ok({ registro: { id: "m1", estado: "reportado" } });
      if (url.endsWith("/registro-migratorio") && init?.method === "POST") return ok({ registro: { id: "m1" } });
      return ok({ disponible: true, items: [] });
    }) as unknown as typeof fetch;
    await verifyIdentidad(f, API, "t", "p1", "i1");
    expect(await requestPurga(f, API, "t", "p1", "i1", "Cancelacion ARCO del titular")).toBe("s1");
    await fetchPurgas(f, API, "t", "p1", "pendiente");
    expect(await decidePurga(f, API, "t", "p1", "s1", true, "ok")).toBe("ejecutada");
    await fetchMigratorios(f, API, "t", "p1", "pendiente");
    await createMigratorio(f, API, "t", "p1", { reservaId: "r1", huespedId: "g1", identidadId: "i1" });
    await reportMigratorio(f, API, "t", "p1", "m1", "INM-1");
    expect(calls).toEqual([
      ["POST", "/hoteles/p1/identidad/i1/verificar", {}],
      ["POST", "/hoteles/p1/identidad/i1/solicitar-purga", { motivo: "Cancelacion ARCO del titular" }],
      ["GET", "/hoteles/p1/identidad-purgas?estado=pendiente", undefined],
      ["POST", "/hoteles/p1/identidad-purgas/s1/decidir", { aprobar: true, nota: "ok" }],
      ["GET", "/hoteles/p1/registro-migratorio?estado=pendiente", undefined],
      ["POST", "/hoteles/p1/registro-migratorio", { reservaId: "r1", huespedId: "g1", identidadId: "i1" }],
      ["POST", "/hoteles/p1/registro-migratorio/m1/reportar", { constancia: "INM-1" }],
    ]);
  });

  it("un error del servidor (doble control) propaga el mensaje real", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ message: "Doble control: quien solicita la purga no puede aprobarla" }), { status: 403 })) as unknown as typeof fetch;
    await expect(decidePurga(f, API, "t", "p1", "s1", true)).rejects.toThrow(/Doble control/);
  });
});
