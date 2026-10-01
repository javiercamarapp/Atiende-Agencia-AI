import { describe, expect, it, vi } from "vitest";
import { agregarNota, fetchBandeja, fetchCallbacks, guardarTurnos, liberarHandoff, registrarIntento, responderWhatsapp, textoEscalacion, tomarConversacion } from "../src/verticals/restaurantes/lib/conversaciones-client.ts";

const B = "http://api.local/v1/restaurantes/property-1/admin";


describe("conversaciones-client (restaurantes)", () => {
  it("bandeja: arma limit/offset y los filtros solo si vienen; disponible:false se propaga", async () => {
    const f = vi.fn(async (url: string) => {
      const u = new URL(url);
      expect(u.pathname).toBe("/v1/restaurantes/property-1/admin/conversaciones");
      expect(u.searchParams.get("estado")).toBe("pendiente");
      expect(u.searchParams.get("canal")).toBeNull();
      expect(u.searchParams.get("limit")).toBe("25");
      return new Response(JSON.stringify({ disponible: false, total: 0, nextOffset: null, cobertura: { sinCobertura: true, turnosVigentes: [], guardia: [] }, items: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await fetchBandeja(f, "http://api.local", "tok", "property-1", { estado: "pendiente", canal: "" });
    expect(r.disponible).toBe(false);
  });

  it("tomar / devolver / cerrar / nota / responder pegan a la ruta y metodo correctos con el cuerpo esperado", async () => {
    const llamadas: Array<[string, string, unknown]> = [];
    const f = vi.fn(async (url: string, init?: RequestInit) => {
      llamadas.push([init?.method ?? "GET", url, init?.body ? JSON.parse(String(init.body)) : undefined]);
      return new Response(JSON.stringify({ handoffId: "h1", estado: "x", cambio: true, id: "n1", encolado: true }), { status: 200 });
    }) as unknown as typeof fetch;
    await tomarConversacion(f, "http://api.local", "tok", "property-1", "whatsapp", "c-1");
    await liberarHandoff(f, "http://api.local", "tok", "property-1", "h1", "devolver");
    await liberarHandoff(f, "http://api.local", "tok", "property-1", "h1", "cerrar");
    await agregarNota(f, "http://api.local", "tok", "property-1", "h1", "Pide factura");
    await responderWhatsapp(f, "http://api.local", "tok", "property-1", "h1", "Ya le atiendo");
    expect(llamadas).toEqual([
      ["POST", `${B}/conversaciones/whatsapp/c-1/tomar`, {}],
      ["POST", `${B}/handoffs/h1/devolver`, {}],
      ["POST", `${B}/handoffs/h1/cerrar`, {}],
      ["POST", `${B}/handoffs/h1/notas`, { texto: "Pide factura" }],
      ["POST", `${B}/handoffs/h1/responder`, { texto: "Ya le atiendo" }],
    ]);
  });

  it("guardarTurnos manda solo userId/orden de los miembros (nunca el nombre) por PUT", async () => {
    let cuerpo: unknown;
    const f = vi.fn(async (_url: string, init?: RequestInit) => {
      cuerpo = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ disponible: true }), { status: 200 });
    }) as unknown as typeof fetch;
    await guardarTurnos(f, "http://api.local", "tok", "property-1", [{ id: "t1", nombre: "T1", dias: [1], inicia: "12:00", termina: "18:00", miembros: [{ userId: "u1", nombre: "Ana", orden: 1 }] }]);
    expect(cuerpo).toEqual({ turnos: [{ nombre: "T1", dias: [1], inicia: "12:00", termina: "18:00", miembros: [{ userId: "u1", orden: 1 }] }] });
  });

  it("callbacks: soloAbiertos agrega el filtro; registrarIntento manda resultado y nota", async () => {
    const f1 = vi.fn(async (url: string) => {
      expect(url).toBe(`${B}/callbacks?soloAbiertos=1`);
      return new Response(JSON.stringify({ disponible: true, items: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    await fetchCallbacks(f1, "http://api.local", "tok", "property-1", { soloAbiertos: true });
    let cuerpo: unknown;
    const f2 = vi.fn(async (_u: string, init?: RequestInit) => {
      cuerpo = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ id: "i1" }), { status: 200 });
    }) as unknown as typeof fetch;
    await registrarIntento(f2, "http://api.local", "tok", "property-1", "cb1", { resultado: "buzon", nota: "dejo mensaje" });
    expect(cuerpo).toEqual({ resultado: "buzon", nota: "dejo mensaje" });
  });

  it("un 409 real (ya la tiene otra persona) se propaga como error legible", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ message: "Esta conversación ya la tiene otra persona." }), { status: 409 })) as unknown as typeof fetch;
    await expect(tomarConversacion(f, "http://api.local", "tok", "property-1", "whatsapp", "c-1")).rejects.toThrow(/otra persona/);
  });

  it("textoEscalacion: nivel 0 sin aviso, nivel 1 respaldo, nivel 2 administracion, sin cobertura", () => {
    const base = { minutosEspera: 6, destinatarios: [], avisarAdministracion: false };
    expect(textoEscalacion(null)).toBeNull();
    expect(textoEscalacion({ ...base, nivel: 0, sinCobertura: false })).toBeNull();
    expect(textoEscalacion({ ...base, nivel: 1, sinCobertura: false })).toMatch(/respaldo/);
    expect(textoEscalacion({ ...base, nivel: 2, sinCobertura: false, minutosEspera: 12 })).toMatch(/12 min.*administración/);
    expect(textoEscalacion({ ...base, nivel: 2, sinCobertura: true })).toMatch(/Sin personal de guardia/);
  });

});
