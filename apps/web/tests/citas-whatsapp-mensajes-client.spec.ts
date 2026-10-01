import { describe, expect, it, vi } from "vitest";
import { cuerpoDesdeForm, fetchHistorialMensajes, fetchMensajes, formDesdeConfig, guardarMensajes, restablecerMensajes, vistaPreviaMensajes } from "../src/verticals/citas/lib/whatsapp-mensajes-client.ts";
import type { ConfigMensajesWire } from "../src/verticals/citas/lib/whatsapp-mensajes-client.ts";

const CONFIG: ConfigMensajesWire = {
  reminderEnabled: true, reminderText: null, reminderLeadHours: 24, confirmationEnabled: false, confirmationText: null,
  cancellationEnabled: false, cancellationText: null, rescheduleEnabled: false, rescheduleText: null, sendWindowStart: null, sendWindowEnd: null,
};
const BASE = "http://api.local/v1/citas/properties/p1/admin/whatsapp-mensajes";

describe("whatsapp-mensajes-client", () => {
  it("formDesdeConfig y cuerpoDesdeForm son inversos: texto vacio = null, hora vacia = sin horario", () => {
    const form = formDesdeConfig({ ...CONFIG, reminderText: "Hola {{hora}}", reminderLeadHours: 12, sendWindowStart: 9, sendWindowEnd: 20 });
    expect(form).toMatchObject({ reminderText: "Hola {{hora}}", reminderLeadHours: "12", sendWindowStart: "9", sendWindowEnd: "20", confirmationText: "" });
    expect(cuerpoDesdeForm(form)).toEqual({ ...CONFIG, reminderText: "Hola {{hora}}", reminderLeadHours: 12, sendWindowStart: 9, sendWindowEnd: 20 });
    expect(cuerpoDesdeForm(formDesdeConfig(CONFIG))).toEqual(CONFIG);
  });

  it("un texto en blanco viaja como null y un numero ilegible NO se arregla en silencio (el servidor lo rechaza)", () => {
    const form = { ...formDesdeConfig(CONFIG), confirmationText: "   ", reminderLeadHours: "abc" };
    const cuerpo = cuerpoDesdeForm(form);
    expect(cuerpo.confirmationText).toBeNull();
    expect(Number.isNaN(cuerpo.reminderLeadHours)).toBe(true);
  });

  it("GET, historial, vista previa, PUT con versionEsperada y restablecer pegan a las rutas correctas", async () => {
    const llamadas: { url: string; method: string; body: unknown }[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      llamadas.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return new Response(JSON.stringify({ disponible: true, version: 1, config: CONFIG, vistaPrevia: [], diferencias: [], entradas: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    const form = formDesdeConfig(CONFIG);
    await fetchMensajes(fetchImpl, "http://api.local", "tok", "p1");
    await fetchHistorialMensajes(fetchImpl, "http://api.local", "tok", "p1");
    await vistaPreviaMensajes(fetchImpl, "http://api.local", "tok", "p1", form);
    await guardarMensajes(fetchImpl, "http://api.local", "tok", "p1", form, 3);
    await restablecerMensajes(fetchImpl, "http://api.local", "tok", "p1", 4);
    expect(llamadas.map((c) => [c.method, c.url])).toEqual([
      ["GET", BASE],
      ["GET", `${BASE}/historial?limite=20`],
      ["POST", `${BASE}/vista-previa`],
      ["PUT", BASE],
      ["POST", `${BASE}/restablecer`],
    ]);
    expect(llamadas[3]!.body).toMatchObject({ versionEsperada: 3, reminderLeadHours: 24 });
    expect(llamadas[4]!.body).toEqual({ versionEsperada: 4 });
  });

  it("un error del servidor (409) llega como mensaje legible", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "La configuración cambió mientras la editabas." }), { status: 409 })) as unknown as typeof fetch;
    await expect(guardarMensajes(fetchImpl, "http://api.local", "tok", "p1", formDesdeConfig(CONFIG), 1)).rejects.toThrow(/cambió mientras/);
  });
});
