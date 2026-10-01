// H-27 -- cliente de la ficha de huesped: URLs/metodos/cuerpos reales contra apps/api/.../hoteles/huespedes.ts y la regla de
// minimizacion (numeros de tarjeta o documento) que se avisa antes de enviar.
import { describe, expect, it, vi } from "vitest";
import { agregarNota, archivarNota, buscarHuespedes, fetchFicha, notaTieneDatoSensible } from "../src/verticals/hoteles/lib/huespedes-client.ts";

function recorder(body: unknown) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  const impl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body as string) : undefined });
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const B = "http://api.local";
const G = `${B}/hoteles/prop-1/huespedes`;

describe("huespedes-client", () => {
  it("busca en el catalogo con q codificado y sin q", async () => {
    const r = recorder([]);
    await buscarHuespedes(r.impl, B, "tok", "prop-1");
    await buscarHuespedes(r.impl, B, "tok", "prop-1", " Ana Torres ");
    expect(r.calls.map((c) => c.url)).toEqual([G, `${G}?q=Ana%20Torres`]);
  });

  it("ficha, notas y archivado llaman a su ruta", async () => {
    const r = recorder({ id: "n1" });
    await fetchFicha(r.impl, B, "tok", "prop-1", "g1");
    await agregarNota(r.impl, B, "tok", "prop-1", "g1", "preferencia", "Piso alto");
    await archivarNota(r.impl, B, "tok", "prop-1", "g1", "n1");
    expect(r.calls).toEqual([
      { url: `${G}/g1/ficha`, method: "GET", body: undefined },
      { url: `${G}/g1/notas`, method: "POST", body: { tipo: "preferencia", texto: "Piso alto" } },
      { url: `${G}/g1/notas/n1/archivar`, method: "POST", body: {} },
    ]);
  });

  it("un 409 de ARCO se propaga con el mensaje del servidor", async () => {
    const impl = vi.fn(async () => new Response(JSON.stringify({ code: "arco_en_curso", message: "El huesped tiene una solicitud ARCO de cancelacion u oposicion." }), { status: 409 })) as unknown as typeof fetch;
    await expect(agregarNota(impl, B, "tok", "prop-1", "g1", "nota", "x")).rejects.toThrow(/ARCO/);
  });

  it("notaTieneDatoSensible detecta tarjetas y documentos aunque vengan con espacios o guiones", () => {
    expect(notaTieneDatoSensible("Tarjeta 4111 1111 1111 1111")).toBe(true);
    expect(notaTieneDatoSensible("Pasaporte 1234-5678-9012-345")).toBe(true);
    expect(notaTieneDatoSensible("Habitacion 1203, ext 2200")).toBe(false);
  });
});
