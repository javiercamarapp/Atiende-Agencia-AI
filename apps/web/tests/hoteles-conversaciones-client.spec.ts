// H-20 -- cliente de la bandeja de conversaciones de hoteles: URLs, metodos y cuerpos exactos contra
// apps/api/.../hoteles/conversaciones.ts, y las reglas puras (etiquetas, tonos, datos sensibles).
import { describe, expect, it, vi } from "vitest";
import {
  agregarNota,
  cerrarConversacion,
  devolverAlAgente,
  etiquetaEstado,
  fetchBandeja,
  fetchDetalle,
  marcarLeida,
  responderConversacion,
  textoTieneDatoSensible,
  tomarConversacion,
  tonoEstado,
} from "../src/verticals/hoteles/lib/conversaciones-client.ts";

const API = "https://api.test";
function respuesta(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as unknown as Response;
}
function fakeFetch(body: unknown = {}, status = 200) {
  return vi.fn(async (_url: string, _init?: RequestInit) => respuesta(body, status)) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}
const ultima = (f: ReturnType<typeof fakeFetch>) => (f as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1) as [string, RequestInit];

describe("cliente de conversaciones de hoteles", () => {
  it("fetchBandeja arma la query solo con los filtros activos", async () => {
    const f = fakeFetch({ disponible: true, total: 0, siguiente: null, sinTelefono: false, items: [] });
    await fetchBandeja(f, API, "tok", "p1", { estado: "", soloNoLeidas: false });
    expect(ultima(f)[0]).toBe(`${API}/hoteles/p1/conversaciones`);
    await fetchBandeja(f, API, "tok", "p1", { estado: "por_atender", soloNoLeidas: true, huespedId: "g1", offset: 25 });
    expect(ultima(f)[0]).toBe(`${API}/hoteles/p1/conversaciones?estado=por_atender&noLeidas=1&huespedId=g1&offset=25`);
    expect((ultima(f)[1].headers as Record<string, string>).authorization).toBe("Bearer tok");
  });

  it("detalle y acciones usan la ruta y el metodo del servidor", async () => {
    const f = fakeFetch({ id: "c1" });
    await fetchDetalle(f, API, "tok", "p1", "c1");
    expect(ultima(f)[0]).toBe(`${API}/hoteles/p1/conversaciones/c1`);
    const casos: [() => Promise<unknown>, string, unknown][] = [
      [() => marcarLeida(f, API, "tok", "p1", "c1"), "/c1/leer", {}],
      [() => tomarConversacion(f, API, "tok", "p1", "c1"), "/c1/tomar", {}],
      [() => tomarConversacion(f, API, "tok", "p1", "c1", true), "/c1/tomar", { reasignar: true }],
      [() => devolverAlAgente(f, API, "tok", "p1", "c1"), "/c1/devolver-al-agente", {}],
      [() => cerrarConversacion(f, API, "tok", "p1", "c1"), "/c1/cerrar", {}],
      [() => agregarNota(f, API, "tok", "p1", "c1", "hola"), "/c1/notas", { texto: "hola" }],
      [() => responderConversacion(f, API, "tok", "p1", "c1", "gracias"), "/c1/responder", { texto: "gracias" }],
    ];
    for (const [llamar, sufijo, cuerpo] of casos) {
      await llamar();
      const [url, init] = ultima(f);
      expect(url).toBe(`${API}/hoteles/p1/conversaciones${sufijo}`);
      expect(init.method).toBe("POST");
      expect(JSON.parse(String(init.body))).toEqual(cuerpo);
    }
  });

  it("un rechazo del servidor (409 ya_tomada) llega como Error con el mensaje real, sin inventar uno", async () => {
    const f = fakeFetch({ code: "ya_tomada", message: "Otra persona ya tomó esta conversación." }, 409);
    await expect(tomarConversacion(f, API, "tok", "p1", "c1")).rejects.toThrow("Otra persona ya tomó esta conversación.");
  });

  it("etiquetas y tonos: 'por atender' manda sobre el estado", () => {
    expect(etiquetaEstado({ estado: "humano", porAtender: true })).toBe("Por atender");
    expect(etiquetaEstado({ estado: "humano", porAtender: false })).toBe("En atención humana");
    expect(etiquetaEstado({ estado: "agente", porAtender: false })).toBe("Con el agente");
    expect(etiquetaEstado({ estado: "cerrada", porAtender: false })).toBe("Cerrada");
    expect(tonoEstado({ estado: "humano", porAtender: true })).toBe("warning");
    expect(tonoEstado({ estado: "humano", porAtender: false })).toBe("info");
    expect(tonoEstado({ estado: "agente", porAtender: false })).toBe("success");
    expect(tonoEstado({ estado: "cerrada", porAtender: false })).toBe("neutral");
  });

  it("detecta tarjeta/documento (13 a 19 digitos con espacios o guiones)", () => {
    expect(textoTieneDatoSensible("4111 1111 1111 1111")).toBe(true);
    expect(textoTieneDatoSensible("4111-1111-1111-1111")).toBe(true);
    expect(textoTieneDatoSensible("cuarto 410, dos noches")).toBe(false);
  });
});
