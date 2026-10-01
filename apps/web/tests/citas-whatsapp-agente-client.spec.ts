import { describe, expect, it, vi } from "vitest";
import { conectarNumero, cuerpoDesdeForm, desconectarNumero, fetchPanelAgente, formCambio, formDesdeConfig, guardarAgente, restablecerAgente, vistaPreviaAgente } from "../src/verticals/citas/lib/whatsapp-agente-client.ts";
import type { ConfigAgenteWire } from "../src/verticals/citas/lib/whatsapp-agente-client.ts";

const CONFIG: ConfigAgenteWire = { agentName: null, toneStyle: null, greetingText: null, rulesText: null };
const BASE = "http://api.local/v1/citas/properties/p1/admin/whatsapp-agente";

describe("whatsapp-agente-client", () => {
  it("formDesdeConfig y cuerpoDesdeForm son inversos: vacio = null", () => {
    const config: ConfigAgenteWire = { agentName: "Sofi", toneStyle: "formal_directo", greetingText: "Hola", rulesText: "Una\nDos" };
    expect(cuerpoDesdeForm(formDesdeConfig(config))).toEqual(config);
    expect(cuerpoDesdeForm(formDesdeConfig(CONFIG))).toEqual(CONFIG);
    expect(cuerpoDesdeForm({ agentName: "   ", toneStyle: "", greetingText: "", rulesText: " \n " })).toEqual({ agentName: null, toneStyle: null, greetingText: null, rulesText: null });
  });

  it("formCambio ignora espacios al borde y detecta cada campo", () => {
    const vigente: ConfigAgenteWire = { agentName: "Sofi", toneStyle: null, greetingText: null, rulesText: "Una" };
    const base = formDesdeConfig(vigente);
    expect(formCambio(base, vigente)).toBe(false);
    expect(formCambio({ ...base, agentName: " Sofi " }, vigente)).toBe(false);
    expect(formCambio({ ...base, agentName: "Sofia" }, vigente)).toBe(true);
    expect(formCambio({ ...base, toneStyle: "formal_directo" }, vigente)).toBe(true);
    expect(formCambio({ ...base, greetingText: "Hola" }, vigente)).toBe(true);
    expect(formCambio({ ...base, rulesText: "Una\nDos" }, vigente)).toBe(true);
  });

  it("GET, vista previa, PUT con versionEsperada, restablecer, conectar y desconectar pegan a las rutas correctas", async () => {
    const llamadas: { url: string; method: string; body: unknown }[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      llamadas.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;
    const form = formDesdeConfig({ ...CONFIG, agentName: "Sofi" });
    await fetchPanelAgente(fetchImpl, "http://api.local", "tok", "p1");
    await vistaPreviaAgente(fetchImpl, "http://api.local", "tok", "p1", form);
    await guardarAgente(fetchImpl, "http://api.local", "tok", "p1", form, 3);
    await restablecerAgente(fetchImpl, "http://api.local", "tok", "p1", 4);
    await conectarNumero(fetchImpl, "http://api.local", "tok", "p1", "109876543210987", false);
    await desconectarNumero(fetchImpl, "http://api.local", "tok", "p1");
    expect(llamadas.map((c) => [c.method, c.url])).toEqual([
      ["GET", BASE],
      ["POST", `${BASE}/vista-previa`],
      ["PUT", BASE],
      ["POST", `${BASE}/restablecer`],
      ["PUT", `${BASE}/conexion`],
      ["DELETE", `${BASE}/conexion`],
    ]);
    expect(llamadas[1]!.body).toEqual({ agentName: "Sofi", toneStyle: null, greetingText: null, rulesText: null });
    expect(llamadas[2]!.body).toEqual({ agentName: "Sofi", toneStyle: null, greetingText: null, rulesText: null, versionEsperada: 3 });
    expect(llamadas[3]!.body).toEqual({ versionEsperada: 4 });
    expect(llamadas[4]!.body).toEqual({ phoneNumberId: "109876543210987", activo: false });
  });
});
