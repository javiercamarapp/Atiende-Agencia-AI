// Cliente de `voz-turno` (cerebro suelto) contra un fetch FALSO que imita al servidor segun CONTRATO-HERRAMIENTAS.md. Sin red, sin tiempo real, sin proveedores.
import { describe, expect, it, vi } from "vitest";
import { CerebroVozTurno, FRASE_DEVOLVER_LLAMADA, FRASE_ESPERA, FRASE_PROBLEMA_TECNICO, FRASE_TOPE, TEXTO_SILENCIO, esDespedida, normalizarCallId } from "../src/cerebro-voz-turno.ts";

interface Peticion { readonly url: string; readonly secreto: string | null; readonly cuerpo: { call_id: string; telefono: string; seq: number; texto: string } }
type Respuesta = { estado: number; cuerpo?: unknown; retryAfter?: string } | "red";

function servidor(guion: (p: Peticion, n: number) => Respuesta) {
  const peticiones: Peticion[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    const p: Peticion = { url, secreto: new Headers(init?.headers).get("x-voz-turno-secret"), cuerpo: JSON.parse(String(init?.body)) };
    peticiones.push(p);
    const r = guion(p, peticiones.length);
    if (r === "red") throw new TypeError("fallo de red");
    return new Response(JSON.stringify(r.cuerpo ?? {}), { status: r.estado, headers: r.retryAfter ? { "retry-after": r.retryAfter } : {} });
  }) as unknown as typeof fetch;
  return { fetchFn, peticiones };
}

const ok = (texto: string, extra: Record<string, unknown> = {}): Respuesta => ({ estado: 200, cuerpo: { texto, pedido_id: null, fin: false, turno: 1, ...extra } });

function crear(guion: Parameters<typeof servidor>[0], extra: Partial<ConstructorParameters<typeof CerebroVozTurno>[0]> = {}) {
  const s = servidor(guion);
  const reloj = { t: 0 };
  const esperas: number[] = [];
  const cerebro = new CerebroVozTurno({
    url: "https://ejemplo.invalid/functions/v1/voz-turno",
    secreto: "secreto-de-prueba",
    callId: "CA_prueba_0001",
    telefono: "9991234567",
    fetchFn: s.fetchFn,
    esperar: async (ms) => { esperas.push(ms); reloj.t += ms; },
    temporizador: () => () => undefined,
    ahora: () => reloj.t,
    ...extra,
  });
  return { cerebro, ...s, esperas, reloj };
}

describe("cerebro suelto: voz-turno", () => {
  it("llamada feliz: apertura seq 0 con texto vacio, turnos 1..n, secreto en el header y pedido al final", async () => {
    const { cerebro, peticiones } = crear((p) => (p.cuerpo.seq === 0 ? ok("Buen día, aviso de grabación.", { turno: 0 }) : p.cuerpo.seq === 1 ? ok("¿Cuántos?") : ok("Listo, su pedido quedó registrado. Gracias, buen provecho.", { pedido_id: "ped_1", turno: 2 })));
    const a = await cerebro.apertura();
    expect(a).toMatchObject({ texto: "Buen día, aviso de grabación.", colgar: false });
    expect((await cerebro.turno("quiero tacos")).colgar).toBe(false);
    const f = await cerebro.turno("a domicilio");
    expect(f).toMatchObject({ colgar: true, motivo: "despedida_con_pedido", pedidoId: "ped_1" });
    expect(peticiones.map((p) => p.cuerpo.seq)).toEqual([0, 1, 2]);
    expect(peticiones[0]!.cuerpo).toEqual({ call_id: "CA_prueba_0001", telefono: "9991234567", seq: 0, texto: "" });
    expect(peticiones.every((p) => p.secreto === "secreto-de-prueba")).toBe(true);
  });

  it("5xx y red: reintenta el MISMO seq una vez y sigue; con dos fallos dice la frase tecnica y cuelga", async () => {
    const { cerebro, peticiones } = crear((_p, n) => (n === 1 ? { estado: 502 } : n === 2 ? ok("Hola.") : "red"));
    expect((await cerebro.turno("hola")).texto).toBe("Hola.");
    expect(peticiones.map((p) => p.cuerpo.seq)).toEqual([1, 1]);
    const r = await cerebro.turno("sigo");
    expect(r).toMatchObject({ texto: FRASE_PROBLEMA_TECNICO, colgar: true, motivo: "error_tecnico" });
    expect(peticiones.slice(2).map((p) => p.cuerpo.seq)).toEqual([2, 2]);
  });

  it("409 en proceso: dice la frase de espera, reintenta el mismo seq cada 2 s y devuelve la respuesta guardada", async () => {
    const dichas: string[] = [];
    const { cerebro, peticiones, esperas } = crear((_p, n) => (n < 4 ? { estado: 409, cuerpo: { error: "turno en proceso: reintente en unos segundos" } } : ok("Aquí estoy.")));
    const r = await cerebro.turno("hola", { alEspera: (f) => dichas.push(f) });
    expect(r.texto).toBe("Aquí estoy.");
    expect(dichas).toEqual([FRASE_ESPERA]);
    expect(peticiones.map((p) => p.cuerpo.seq)).toEqual([1, 1, 1, 1]);
    expect(esperas).toEqual([700, 2000, 2000]); // el 1.o espera 0.7 s sin decir nada
  });

  it("409 en proceso que no termina: a los 65 s REALES (reloj) dice que una persona devolvera la llamada y cuelga", async () => {
    const { cerebro, peticiones, reloj } = crear(() => ({ estado: 409, cuerpo: { error: "turno en proceso" } }));
    const r = await cerebro.turno("hola");
    expect(reloj.t).toBeGreaterThanOrEqual(65_000);
    expect(reloj.t).toBeLessThan(65_000 + 2000 + 700);
    expect(r).toMatchObject({ texto: FRASE_DEVOLVER_LLAMADA, colgar: true, motivo: "en_proceso_agotado" });
    expect(peticiones.length).toBeGreaterThanOrEqual(30);
    expect(new Set(peticiones.map((p) => p.cuerpo.seq))).toEqual(new Set([1]));
  });

  it("409 de otro telefono o seq fuera de orden: bug del worker, no reintenta", async () => {
    const { cerebro, peticiones } = crear(() => ({ estado: 409, cuerpo: { error: "call_id ya pertenece a otra llamada" } }));
    expect((await cerebro.turno("hola")).motivo).toBe("error_tecnico");
    expect(peticiones).toHaveLength(1);
  });

  it("429 con Retry-After corto: espera y repite el mismo seq", async () => {
    const { cerebro, peticiones, esperas } = crear((_p, n) => (n === 1 ? { estado: 429, retryAfter: "3", cuerpo: { error: "Demasiadas solicitudes" } } : ok("Va.")));
    expect((await cerebro.turno("hola")).texto).toBe("Va.");
    expect(esperas).toEqual([3000]);
    expect(peticiones.map((p) => p.cuerpo.seq)).toEqual([1, 1]);
  });

  it("429 con Retry-After largo (30): NO reintenta, dice la frase y cuelga", async () => {
    const { cerebro, peticiones } = crear(() => ({ estado: 429, retryAfter: "30", cuerpo: { error: "Demasiadas solicitudes" } }));
    const r = await cerebro.turno("hola");
    expect(r).toMatchObject({ texto: FRASE_TOPE, colgar: true, motivo: "tope" });
    expect(peticiones).toHaveLength(1);
  });

  it("503: interruptor de emergencia (fin:true) habla su texto y cuelga; 503 de contador reintenta", async () => {
    const a = crear(() => ({ estado: 503, cuerpo: { texto: "Por ahora no atendemos.", fin: true } }));
    expect(await a.cerebro.turno("hola")).toMatchObject({ texto: "Por ahora no atendemos.", colgar: true, motivo: "apagado" });
    const b = crear((_p, n) => (n === 1 ? { estado: 503, retryAfter: "3", cuerpo: { error: "Servicio no disponible, reintente" } } : ok("Ya.")));
    expect((await b.cerebro.turno("hola")).texto).toBe("Ya.");
    expect(b.peticiones.map((p) => p.cuerpo.seq)).toEqual([1, 1]);
  });

  it("fin:true cuelga tras hablar y la llamada queda cerrada (no vuelve a llamar al servidor)", async () => {
    const { cerebro, peticiones } = crear(() => ok("Gracias por llamar. Hasta luego.", { fin: true }));
    expect(await cerebro.turno("no gracias")).toMatchObject({ colgar: true, motivo: "fin_servidor" });
    await cerebro.turno("alo");
    expect(peticiones).toHaveLength(1);
  });

  it("dos silencios seguidos: se mandan como texto [silencio]; el 2.o trae fin:true", async () => {
    const { cerebro, peticiones } = crear((p) => (p.cuerpo.seq === 1 ? ok("¿Sigue ahí?") : ok("Gracias por llamar. Hasta luego.", { fin: true })));
    expect((await cerebro.turno(TEXTO_SILENCIO)).colgar).toBe(false);
    expect((await cerebro.turno(TEXTO_SILENCIO)).colgar).toBe(true);
    expect(peticiones.map((p) => p.cuerpo.texto)).toEqual(["[silencio]", "[silencio]"]);
  });

  it("apertura repetida con seq_ultimo continua desde seq_ultimo + 1", async () => {
    const { cerebro, peticiones } = crear((p) => (p.cuerpo.seq === 0 ? ok("Seguimos.", { turno: 0, seq_ultimo: 4 }) : ok("Ok.")));
    await cerebro.apertura();
    await cerebro.turno("hola");
    expect(peticiones.map((p) => p.cuerpo.seq)).toEqual([0, 5]);
  });

  it("barge-in durante un turno lento: NO aborta la peticion; se habla la respuesta de k (pedido) y el texto nuevo va como k+1 sin 409", async () => {
    // Servidor que imita el contrato: mientras k esta "en proceso", cualquier seq mayor recibe 409.
    let liberar: (() => void) | null = null;
    const peticiones: { seq: number; texto: string; abortada: boolean }[] = [];
    let kTerminado = false;
    const fetchFn = (async (_u: string, init?: RequestInit) => {
      const c = JSON.parse(String(init?.body));
      const reg = { seq: c.seq as number, texto: c.texto as string, abortada: false };
      peticiones.push(reg);
      init?.signal?.addEventListener("abort", () => { reg.abortada = true; });
      if (c.seq === 1) {
        await new Promise<void>((r) => { liberar = r; });
        kTerminado = true;
        return new Response(JSON.stringify({ texto: "Su pedido quedó. El total es 250 pesos.", pedido_id: "ped_9", fin: false, turno: 1 }), { status: 200 });
      }
      if (!kTerminado) return new Response(JSON.stringify({ error: "turno en proceso" }), { status: 409 });
      return new Response(JSON.stringify({ texto: "Sí, aquí estoy.", pedido_id: "ped_9", fin: false, turno: 2 }), { status: 200 });
    }) as unknown as typeof fetch;
    const cerebro = new CerebroVozTurno({ url: "https://e.invalid/voz-turno", secreto: "s", callId: "CA_barge_0001", telefono: "9991234567", fetchFn, esperar: async () => undefined, temporizador: () => () => undefined });
    const control = new AbortController();
    const k = cerebro.turno("confirmo el pedido", { senal: control.signal });
    await vi.waitFor(() => expect(peticiones).toHaveLength(1));
    control.abort(); // el cliente dice «¿bueno?» y la cascada aborta el turno
    await expect(k).rejects.toThrow();
    expect(cerebro.ocupado).toBe(true);
    const previas: string[] = [];
    const k1 = cerebro.turno("¿bueno?", { alRespuestaPrevia: (t) => previas.push(t) });
    await Promise.resolve();
    expect(peticiones).toHaveLength(1); // k+1 NO sale mientras k esta en vuelo
    liberar!();
    const r = await k1;
    expect(previas).toEqual(["Su pedido quedó. El total es 250 pesos."]);
    expect(r.texto).toBe("Sí, aquí estoy.");
    expect(r.pedidoId).toBe("ped_9");
    expect(peticiones.map((p) => [p.seq, p.texto, p.abortada])).toEqual([[1, "confirmo el pedido", false], [2, "¿bueno?", false]]);
    expect(cerebro.ocupado).toBe(false);
  });

  it("barge-in cuando k termina en cierre (fin): se habla el cierre y no se manda k+1", async () => {
    let liberar: (() => void) | null = null;
    const vistas: number[] = [];
    const fetchFn = (async (_u: string, init?: RequestInit) => {
      vistas.push(JSON.parse(String(init?.body)).seq);
      await new Promise<void>((r) => { liberar = r; });
      return new Response(JSON.stringify({ texto: "Hasta luego.", pedido_id: "ped_1", fin: true, turno: 1 }), { status: 200 });
    }) as unknown as typeof fetch;
    const cerebro = new CerebroVozTurno({ url: "https://e.invalid/voz-turno", secreto: "s", callId: "CA_barge_0002", telefono: "9991234567", fetchFn, esperar: async () => undefined, temporizador: () => () => undefined });
    const control = new AbortController();
    const k = cerebro.turno("adiós", { senal: control.signal });
    await vi.waitFor(() => expect(vistas).toHaveLength(1));
    control.abort();
    await expect(k).rejects.toThrow();
    const k1 = cerebro.turno("¿bueno?");
    liberar!();
    expect(await k1).toMatchObject({ texto: "Hasta luego.", colgar: true, motivo: "fin_servidor" });
    expect(vistas).toEqual([1]);
  });

  it("relleno temporizado: 1.a frase a los 4 s, repite cada ~15 s hasta 3 frases distintas y se cancela al responder", async () => {
    const programados: { fn: () => void; ms: number; cancelado: boolean }[] = [];
    const dichas: string[] = [];
    let liberar: (() => void) | null = null;
    const fetchFn = (async () => { await new Promise<void>((r) => { liberar = r; }); return new Response(JSON.stringify({ texto: "Listo.", pedido_id: null, fin: false, turno: 1 }), { status: 200 }); }) as unknown as typeof fetch;
    const { cerebro } = crear(() => ok("x"), { fetchFn, temporizador: (fn, ms) => { const t = { fn, ms, cancelado: false }; programados.push(t); return () => { t.cancelado = true; }; } });
    const p = cerebro.turno("hola", { alEspera: (f) => dichas.push(f) });
    expect(programados.map((t) => t.ms)).toEqual([4000]);
    programados[0]!.fn();
    programados[1]!.fn();
    programados[2]!.fn();
    expect(programados.map((t) => t.ms)).toEqual([4000, 15_000, 15_000]); // la 3.a frase ya no programa otra
    expect(dichas).toHaveLength(3);
    expect(new Set(dichas).size).toBe(3);
    expect(dichas[0]).toBe(FRASE_ESPERA);
    liberar!();
    await p;
    expect(programados[2]!.cancelado).toBe(true);
  });

  it("relleno cancelado: si el servidor responde antes de los 4 s no se dice nada", async () => {
    const programados: { cancelado: boolean }[] = [];
    const dichas: string[] = [];
    const { cerebro } = crear(() => ok("Listo."), { temporizador: () => { const t = { cancelado: false }; programados.push(t); return () => { t.cancelado = true; }; } });
    await cerebro.turno("hola", { alEspera: (f) => dichas.push(f) });
    expect(dichas).toEqual([]);
    expect(programados.every((t) => t.cancelado)).toBe(true);
  });

  it("tiempo agotado REAL (fetch que nunca contesta, reloj simulado): aborta a los 35 s, el 2.o intento del mismo seq espera solo 20 s y luego cuelga con error tecnico", async () => {
    vi.useFakeTimers();
    try {
      const limites: number[] = [];
      let pedidas = 0;
      const fetchFn = ((_u: string, init?: RequestInit) => new Promise<Response>((_r, rechazar) => {
        pedidas += 1;
        const inicio = Date.now();
        init?.signal?.addEventListener("abort", () => { limites.push(Date.now() - inicio); rechazar(new DOMException("abortado", "AbortError")); });
      })) as unknown as typeof fetch;
      const cerebro = new CerebroVozTurno({ url: "https://e.invalid/voz-turno", secreto: "s", callId: "CA_timeout_001", telefono: "9991234567", fetchFn, temporizador: () => () => undefined });
      const p = cerebro.turno("hola");
      await vi.advanceTimersByTimeAsync(35_000 + 500 + 20_000 + 10);
      expect(await p).toMatchObject({ colgar: true, motivo: "error_tecnico" });
      expect(pedidas).toBe(2);
      expect(limites).toEqual([35_000, 20_000]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("exige telefono antes de abrir y no admite cambiarlo despues de la apertura", async () => {
    const { cerebro } = crear(() => ok("Hola."), { telefono: null });
    await expect(cerebro.apertura()).rejects.toThrow();
    expect(cerebro.fijarTelefono("123")).toBe(false);
    expect(cerebro.fijarTelefono("9991234567")).toBe(true);
    await cerebro.apertura();
    expect(cerebro.fijarTelefono("9990000000")).toBe(false);
  });

  it("los logs no llevan texto, telefono ni secreto", async () => {
    const lineas: string[] = [];
    const { cerebro } = crear(() => ({ estado: 500, cuerpo: { error: "tacos 9991234567" } }), { log: (e, c) => lineas.push(JSON.stringify({ e, c })) });
    await cerebro.turno("mi direccion es calle 60");
    const todo = lineas.join("\n");
    expect(todo).toContain("voz_turno_http");
    for (const prohibido of ["calle 60", "9991234567", "secreto-de-prueba", "tacos"]) expect(todo).not.toContain(prohibido);
  });

  it("esDespedida: despedida sin pregunta; una pregunta no cuelga", () => {
    expect(esDespedida("Listo. Gracias por llamar, buen provecho.")).toBe(true);
    expect(esDespedida("Gracias. ¿Algo más?")).toBe(false);
    expect(esDespedida("Son 328 pesos.")).toBe(false);
  });

  it("call_id corto o con caracteres raros se normaliza en vez de lanzar (mismo id => mismo resultado, siempre valido)", async () => {
    expect(normalizarCallId("ab1")).toBe("llamada_ab1");
    expect(normalizarCallId("sala/1 x")).toBe("sala_1_x");
    expect(normalizarCallId("x".repeat(300))).toHaveLength(128);
    expect(normalizarCallId("ab1")).toBe(normalizarCallId("ab1"));
    const { cerebro, peticiones } = crear(() => ok("Hola."), { callId: "ab1" });
    await cerebro.turno("hola");
    expect(peticiones[0]!.cuerpo.call_id).toBe("llamada_ab1");
  });
});
