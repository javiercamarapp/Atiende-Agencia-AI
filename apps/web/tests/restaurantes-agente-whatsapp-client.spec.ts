// R-10: cliente del editor del agente de WhatsApp (contrato real: admin-config.ts) y helpers puros del formulario.
import { describe, expect, it, vi } from "vitest";
import {
  camposCambiados,
  cuerpoDesdeForm,
  esperaDesdeTexto,
  fetchHistorialAgente,
  formDesdeFoto,
  formDesdeWire,
  guardarAgenteWhatsapp,
  restablecerAgente,
  vistaPreviaAgente,
} from "../src/verticals/restaurantes/lib/agente-whatsapp-client.ts";
import type { ConfigAgenteForm } from "../src/verticals/restaurantes/lib/agente-whatsapp-client.ts";

const B = "http://api.local/v1/restaurantes/prop-1/admin/config/agente-whatsapp";
const FORM: ConfigAgenteForm = {
  perfil: "taqueria_pm",
  agentName: " Lupita ",
  businessName: "",
  toneStyle: "",
  deliveryTimeText: "de 40 a 50 minutos",
  greetingText: "Hola",
  salsasText: "   ",
  promosText: "martes de nachos",
  escalationReasonsOff: ["pedido_grande"],
  largeOrderText: "  más de $5,000  ",
  replyDebounceSeconds: " 6 ",
};

describe("cuerpoDesdeForm", () => {
  it("recorta, manda null para vacio y agrega versionEsperada solo cuando se conoce", () => {
    expect(cuerpoDesdeForm(FORM, "organizacion", 3)).toEqual({
      alcance: "organizacion",
      perfil: "taqueria_pm",
      agentName: "Lupita",
      businessName: null,
      toneStyle: null,
      deliveryTimeText: "de 40 a 50 minutos",
      greetingText: "Hola",
      salsasText: null,
      promosText: "martes de nachos",
      escalationReasonsOff: ["pedido_grande"],
      largeOrderText: "más de $5,000",
      replyDebounceSeconds: 6,
      versionEsperada: 3,
    });
    expect(cuerpoDesdeForm(FORM, "sucursal", null)).not.toHaveProperty("versionEsperada");
    expect(cuerpoDesdeForm(FORM, "sucursal", 0)).toHaveProperty("versionEsperada", 0);
  });

  it("el perfil generico no manda los campos que solo existen en el PM (el servidor los rechazaria)", () => {
    expect(cuerpoDesdeForm({ ...FORM, perfil: "generico" }, "organizacion")).toMatchObject({ greetingText: null, salsasText: null, promosText: null, escalationReasonsOff: [], largeOrderText: null, replyDebounceSeconds: null });
  });

  it("espera de rafagas: vacio = apagada (null), entero = segundos, cualquier otra cosa llega como NaN para que el servidor la rechace con su mensaje", () => {
    expect(esperaDesdeTexto("")).toBeNull();
    expect(esperaDesdeTexto("   ")).toBeNull();
    expect(esperaDesdeTexto("0")).toBe(0);
    expect(esperaDesdeTexto(" 30 ")).toBe(30);
    for (const raro of ["1.5", "-1", "seis", "6s"]) expect(Number.isNaN(esperaDesdeTexto(raro)), raro).toBe(true);
    expect(cuerpoDesdeForm({ ...FORM, largeOrderText: "", replyDebounceSeconds: "" }, "organizacion")).toMatchObject({ largeOrderText: null, replyDebounceSeconds: null });
  });
});

describe("llamadas HTTP", () => {
  it("guardar: PUT con el cuerpo y la version esperada; un 409 real se propaga como error legible", async () => {
    let cuerpo: Record<string, unknown> = {};
    const ok = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe(B);
      expect(init?.method).toBe("PUT");
      cuerpo = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ perfil: "taqueria_pm", version: 4 }), { status: 200 });
    }) as unknown as typeof fetch;
    await guardarAgenteWhatsapp(ok, "http://api.local", "tok", "prop-1", FORM, "organizacion", 3);
    expect(cuerpo).toMatchObject({ alcance: "organizacion", versionEsperada: 3, agentName: "Lupita" });
    const conflicto = vi.fn(async () => new Response(JSON.stringify({ message: "La configuración del agente cambió mientras la editaba." }), { status: 409 })) as unknown as typeof fetch;
    await expect(guardarAgenteWhatsapp(conflicto, "http://api.local", "tok", "prop-1", FORM, "organizacion", 3)).rejects.toThrow(/cambió mientras/);
  });

  it("vista previa: POST .../vista-previa sin versionEsperada; historial: GET con alcance y limite; restablecer: POST con la version", async () => {
    const llamadas: Array<[string, string, unknown]> = [];
    const f = vi.fn(async (url: string, init?: RequestInit) => {
      llamadas.push([String(url), init?.method ?? "GET", init?.body ? JSON.parse(String(init.body)) : undefined]);
      return new Response(JSON.stringify(String(url).includes("/historial") ? { entradas: [{ version: 1 }] } : { ok: true }), { status: 200 });
    }) as unknown as typeof fetch;
    await vistaPreviaAgente(f, "http://api.local", "tok", "prop-1", FORM, "sucursal");
    expect(await fetchHistorialAgente(f, "http://api.local", "tok", "prop-1", "sucursal")).toEqual([{ version: 1 }]);
    await restablecerAgente(f, "http://api.local", "tok", "prop-1", "organizacion", 2);
    await restablecerAgente(f, "http://api.local", "tok", "prop-1", "organizacion", null);
    expect(llamadas[0]![0]).toBe(`${B}/vista-previa`);
    expect(llamadas[0]![2]).not.toHaveProperty("versionEsperada");
    expect(llamadas[1]).toEqual([`${B}/historial?alcance=sucursal&limite=20`, "GET", undefined]);
    expect(llamadas[2]).toEqual([`${B}/restablecer`, "POST", { alcance: "organizacion", versionEsperada: 2 }]);
    expect(llamadas[3]![2]).toEqual({ alcance: "organizacion" });
  });
});

describe("formularios desde datos", () => {
  it("formDesdeWire: sin config parte del perfil PM en blanco; con config copia los valores", () => {
    expect(formDesdeWire(null)).toMatchObject({ perfil: "taqueria_pm", agentName: "", toneStyle: "", escalationReasonsOff: [] });
    expect(formDesdeWire({ perfil: "generico", agentName: "Ana", businessName: null, toneStyle: "calido_cercano", deliveryTimeText: null, greetingText: null, salsasText: null, promosText: null, escalationReasonsOff: [], version: 2 })).toMatchObject({
      perfil: "generico",
      agentName: "Ana",
      toneStyle: "calido_cercano",
    });
  });

  it("formDesdeFoto tolera fotos incompletas o con valores raros", () => {
    expect(formDesdeFoto({ perfil: "raro", toneStyle: "grosero", escalationReasonsOff: "no-lista", agentName: 5 })).toEqual({
      perfil: "taqueria_pm",
      agentName: "",
      businessName: "",
      toneStyle: "",
      deliveryTimeText: "",
      greetingText: "",
      salsasText: "",
      promosText: "",
      escalationReasonsOff: [],
      largeOrderText: "",
      replyDebounceSeconds: "",
    });
    expect(formDesdeFoto({ perfil: "taqueria_pm", largeOrderText: "más de $5,000", replyDebounceSeconds: 6 })).toMatchObject({ largeOrderText: "más de $5,000", replyDebounceSeconds: "6" });
    expect(formDesdeWire({ perfil: "taqueria_pm", agentName: null, businessName: null, toneStyle: null, deliveryTimeText: null, greetingText: null, salsasText: null, promosText: null, escalationReasonsOff: [], largeOrderText: "más de $5,000", replyDebounceSeconds: 0, version: 4 })).toMatchObject({ largeOrderText: "más de $5,000", replyDebounceSeconds: "0" });
  });

  it("camposCambiados: etiquetas de lo que cambia; primera configuracion cuenta lo no vacio", () => {
    expect(camposCambiados({ agentName: "A", escalationReasonsOff: ["x"] }, { agentName: "B", escalationReasonsOff: ["x"] })).toEqual(["Nombre del agente"]);
    expect(camposCambiados(null, { perfil: "taqueria_pm", agentName: null, escalationReasonsOff: [] })).toEqual(["Perfil"]);
    expect(camposCambiados({ a: 1 }, { a: 1 })).toEqual([]);
    expect(camposCambiados({ largeOrderText: null, replyDebounceSeconds: null }, { largeOrderText: "más de $5,000", replyDebounceSeconds: 6 })).toEqual(["Umbral de pedido grande", "Espera de ráfagas (segundos)"]);
  });
});
