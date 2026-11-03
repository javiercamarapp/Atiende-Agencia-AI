// Aviso de «devolver la llamada» cuando el cerebro suelto cuelga por una falla: cliente de `registrar-contacto` y su cableado con CerebroVozTurno (fetch falso, sin red).
import { describe, expect, it } from "vitest";
import { CerebroVozTurno, normalizarCallId } from "../src/cerebro-voz-turno.ts";
import type { AvisoPerdido } from "../src/cerebro-voz-turno.ts";
import { crearRegistroAviso, urlRegistrarContactoDe } from "../src/registrar-contacto.ts";

interface Llamada { url: string; secreto: string | null; cuerpo: Record<string, unknown> }
function fetchRegistro(estados: number[] | "red") {
  const llamadas: Llamada[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    llamadas.push({ url, secreto: new Headers(init?.headers).get("x-atiende-tool-secret"), cuerpo: JSON.parse(String(init?.body)) });
    if (estados === "red") throw new TypeError("red");
    return new Response("{}", { status: estados[Math.min(llamadas.length - 1, estados.length - 1)]! });
  }) as unknown as typeof fetch;
  return { fetchFn, llamadas };
}
const aviso: AvisoPerdido = { motivo: "error_tecnico", causa: "http_502", telefono: "9991234567" };

describe("registrar-contacto: aviso de devolver la llamada", () => {
  it("urlRegistrarContactoDe cambia solo el ultimo segmento", () => {
    expect(urlRegistrarContactoDe("https://x.supabase.co/functions/v1/voz-turno")).toBe("https://x.supabase.co/functions/v1/registrar-contacto");
    expect(urlRegistrarContactoDe("https://x.invalid/otra-ruta")).toBeNull();
  });

  it("manda el cuerpo del contrato (motivo otro, conversation_id = call_id, telefono confirmado) con el secreto de herramientas y es idempotente por llamada", async () => {
    const { fetchFn, llamadas } = fetchRegistro([200]);
    const r = crearRegistroAviso({ url: "https://x.invalid/functions/v1/registrar-contacto", secreto: "tool-secreto", callId: "CA_aviso_0001", fetchFn });
    await Promise.all([r.registrar(aviso), r.registrar(aviso)]);
    expect(llamadas).toHaveLength(1);
    expect(llamadas[0]!.secreto).toBe("tool-secreto");
    expect(llamadas[0]!.cuerpo).toMatchObject({ customer_phone: "9991234567", motivo: "otro", conversation_id: "CA_aviso_0001" });
    expect(typeof llamadas[0]!.cuerpo.customer_name).toBe("string");
  });

  it("conversation_id usa el call_id NORMALIZADO, el mismo que viaja a voz-turno (id corto o con caracteres raros)", async () => {
    for (const crudo of ["ab1", "sala/1 x"]) {
      const { fetchFn, llamadas } = fetchRegistro([200]);
      await crearRegistroAviso({ url: "https://x.invalid/functions/v1/registrar-contacto", secreto: "s", callId: crudo, fetchFn }).registrar(aviso);
      expect(llamadas[0]!.cuerpo.conversation_id).toBe(normalizarCallId(crudo));
      expect(llamadas[0]!.cuerpo.conversation_id).toMatch(/^[A-Za-z0-9_.:-]{6,128}$/);
    }
  });

  it("401: no reintenta y deja un evento propio de configuracion rota (sin secretos en el log)", async () => {
    const { fetchFn, llamadas } = fetchRegistro([401]);
    const eventos: string[] = [];
    const campos: unknown[] = [];
    const r = crearRegistroAviso({ url: "https://x.invalid/registrar-contacto", secreto: "tool-secreto", callId: "CA_aviso_0002", fetchFn, log: (e, c) => { eventos.push(e); campos.push(c); } });
    await r.registrar(aviso);
    expect(llamadas).toHaveLength(1);
    expect(eventos).toEqual(["aviso_devolver_llamada_config_rota"]);
    expect(JSON.stringify(campos)).not.toContain("tool-secreto");
    expect(JSON.stringify(campos)).not.toContain("9991234567");
  });

  it("5xx o red: un reintento y nunca lanza", async () => {
    const a = fetchRegistro([503, 200]);
    await crearRegistroAviso({ url: "https://x.invalid/r", secreto: "s", callId: "CA_aviso_0003", fetchFn: a.fetchFn }).registrar(aviso);
    expect(a.llamadas).toHaveLength(2);
    const b = fetchRegistro("red");
    await expect(crearRegistroAviso({ url: "https://x.invalid/r", secreto: "s", callId: "CA_aviso_0004", fetchFn: b.fetchFn }).registrar(aviso)).resolves.toBeUndefined();
    expect(b.llamadas).toHaveLength(2);
  });

  it("sin telefono confirmado no se puede registrar: no llama y lo deja en el log", async () => {
    const { fetchFn, llamadas } = fetchRegistro([200]);
    const eventos: string[] = [];
    await crearRegistroAviso({ url: "https://x.invalid/r", secreto: "s", callId: "CA_aviso_0005", fetchFn, log: (e) => eventos.push(e) }).registrar({ ...aviso, telefono: null });
    expect(llamadas).toHaveLength(0);
    expect(eventos).toEqual(["aviso_devolver_llamada_sin_telefono"]);
  });
});

describe("CerebroVozTurno avisa cuando dice «una persona le devolvera la llamada»", () => {
  function cerebro(estado: number | "red", avisos: AvisoPerdido[], cuerpo: unknown = {}) {
    const fetchFn = (async () => { if (estado === "red") throw new TypeError("red"); return new Response(JSON.stringify(cuerpo), { status: estado }); }) as unknown as typeof fetch;
    const reloj = { t: 0 };
    return new CerebroVozTurno({ url: "https://e.invalid/voz-turno", secreto: "s", callId: "CA_aviso_0010", telefono: "9991234567", fetchFn, esperar: async (ms) => { reloj.t += ms; }, ahora: () => reloj.t, temporizador: () => () => undefined, alAvisoPerdido: (a) => avisos.push(a) });
  }
  it.each([
    [401, "http_401", {}],
    [400, "http_400", {}],
    [409, "http_409", { error: "call_id de otro telefono" }],
    [502, "http_502", {}],
    ["red", "red", {}],
  ] as const)("estado %s => aviso con causa %s", async (estado, causa, cuerpo) => {
    const avisos: AvisoPerdido[] = [];
    const r = await cerebro(estado, avisos, cuerpo).turno("hola");
    expect(r).toMatchObject({ colgar: true, motivo: "error_tecnico" });
    expect(avisos).toEqual([{ motivo: "error_tecnico", causa, telefono: "9991234567" }]);
  });
  it("409 en proceso agotado => aviso en_proceso_agotado", async () => {
    const avisos: AvisoPerdido[] = [];
    await cerebro(409, avisos, { error: "turno en proceso" }).turno("hola");
    expect(avisos).toEqual([{ motivo: "en_proceso_agotado", causa: "en_proceso", telefono: "9991234567" }]);
  });
  it("tope 429 (Retry-After largo) avisa con causa tope: el cupo por telefono no lo registra el servidor", async () => {
    const avisos: AvisoPerdido[] = [];
    const fetchFn = (async () => new Response("{}", { status: 429, headers: { "retry-after": "30" } })) as unknown as typeof fetch;
    const c = new CerebroVozTurno({ url: "https://e.invalid/voz-turno", secreto: "s", callId: "CA_aviso_0013", telefono: "9991234567", fetchFn, temporizador: () => () => undefined, alAvisoPerdido: (a) => avisos.push(a) });
    expect((await c.turno("hola")).motivo).toBe("tope");
    expect(avisos).toEqual([{ motivo: "tope", causa: "tope", telefono: "9991234567" }]);
  });
  it("un fallo del aviso no impide colgar", async () => {
    const avisos: AvisoPerdido[] = [];
    const fetchFn = (async () => new Response("{}", { status: 429, headers: { "retry-after": "30" } })) as unknown as typeof fetch;
    const c = new CerebroVozTurno({ url: "https://e.invalid/voz-turno", secreto: "s", callId: "CA_aviso_0011", telefono: "9991234567", fetchFn, temporizador: () => () => undefined, alAvisoPerdido: (a) => avisos.push(a) });
    expect((await c.turno("hola")).motivo).toBe("tope");
    expect(avisos).toEqual([{ motivo: "tope", causa: "tope", telefono: "9991234567" }]);
    const c2 = new CerebroVozTurno({ url: "https://e.invalid/voz-turno", secreto: "s", callId: "CA_aviso_0012", telefono: "9991234567", fetchFn: (async () => new Response("{}", { status: 400 })) as unknown as typeof fetch, temporizador: () => () => undefined, alAvisoPerdido: () => { throw new Error("boom"); } });
    expect((await c2.turno("hola")).colgar).toBe(true);
  });
});
