import { describe, expect, it, vi } from "vitest";
import { FORM_PLANTILLA_VACIO, cuerpoDesdeFormPlantilla, eliminarPlantilla, fetchPlantillas, formDesdePlantilla, guardarPlantilla, variablesDesdeTexto } from "../src/verticals/citas/lib/whatsapp-plantillas-client.ts";

const BASE = "http://api.local/v1/citas/properties/p1/admin/whatsapp-plantillas";

describe("whatsapp-plantillas-client", () => {
  it("variablesDesdeTexto: separa por comas, recorta y descarta vacios, en el orden escrito", () => {
    expect(variablesDesdeTexto("nombre, fecha ,, hora")).toEqual(["nombre", "fecha", "hora"]);
    expect(variablesDesdeTexto("   ")).toEqual([]);
  });

  it("formDesdePlantilla y cuerpoDesdeFormPlantilla son inversos; sin plantilla el formulario arranca en borrador es_MX", () => {
    const p = { evento: "appointment.reminder_24h", nombre: "recordatorio_cita_24h", idioma: "es_MX", variables: ["nombre", "hora"], estado: "aprobada" as const, aprobadaEn: null, actualizadaEn: "2026-09-01T00:00:00.000Z" };
    expect(cuerpoDesdeFormPlantilla(formDesdePlantilla(p))).toEqual({ nombre: "recordatorio_cita_24h", idioma: "es_MX", variables: ["nombre", "hora"], estado: "aprobada" });
    expect(formDesdePlantilla(null)).toEqual(FORM_PLANTILLA_VACIO);
    expect(FORM_PLANTILLA_VACIO).toMatchObject({ idioma: "es_MX", estado: "borrador" });
  });

  it("un nombre ilegible NO se arregla en silencio (solo se recorta): el servidor lo rechaza", () => {
    expect(cuerpoDesdeFormPlantilla({ ...FORM_PLANTILLA_VACIO, nombre: "  Nombre Malo  " }).nombre).toBe("Nombre Malo");
  });

  it("GET, PUT y DELETE pegan a las rutas correctas con el evento codificado", async () => {
    const llamadas: { url: string; method: string; body: unknown }[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      llamadas.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return new Response(JSON.stringify({ disponible: true, eventos: [], plantilla: null, ok: true }), { status: 200 });
    }) as unknown as typeof fetch;
    await fetchPlantillas(fetchImpl, "http://api.local", "tok", "p1");
    await guardarPlantilla(fetchImpl, "http://api.local", "tok", "p1", "waitlist.slot_offered", { nombre: "hueco", idioma: "es_MX", variables: "nombre, negocio", estado: "aprobada" });
    await eliminarPlantilla(fetchImpl, "http://api.local", "tok", "p1", "waitlist.slot_offered");
    expect(llamadas.map((c) => [c.method, c.url])).toEqual([["GET", BASE], ["PUT", `${BASE}/waitlist.slot_offered`], ["DELETE", `${BASE}/waitlist.slot_offered`]]);
    expect(llamadas[1]!.body).toEqual({ nombre: "hueco", idioma: "es_MX", variables: ["nombre", "negocio"], estado: "aprobada" });
  });

  it("un error del servidor llega como mensaje legible", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "nombre: usa minúsculas." }), { status: 400 })) as unknown as typeof fetch;
    await expect(guardarPlantilla(fetchImpl, "http://api.local", "tok", "p1", "waitlist.slot_offered", { nombre: "X", idioma: "es_MX", variables: "", estado: "borrador" })).rejects.toThrow(/minúsculas/);
  });
});
