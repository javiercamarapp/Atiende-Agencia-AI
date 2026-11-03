// Puerto LLM del cerebro suelto: numero oculto (aviso + pedir y confirmar telefono antes de la apertura), traduccion de la apertura, silencio y config.
import { describe, expect, it } from "vitest";
import { AVISO_GRABACION_POR_OMISION, CerebroSuelto, PREAMBULO_POR_OMISION, SALUDO_SIN_AVISO, VigiaSilencio, extraerTelefonoDictado, quitarFrasesDichas, telefonoEnGrupos } from "../src/cerebro-suelto.ts";
import { cargarConfig } from "../src/config.ts";

const DISPARO = "(disparador de saludo)";
const peticion = (texto: string, onTextDelta?: (d: string) => void) => ({ system: "", mensajes: [{ role: "user" as const, content: "viejo" }, { role: "assistant" as const, content: "x" }, { role: "user" as const, content: texto }], herramientas: [], ...(onTextDelta ? { onTextDelta } : {}) });

function montar(telefono: string | null, confirmar?: (t: string) => Promise<{ ok: boolean }>, aperturaServidor = "Buen día.") {
  const cuerpos: { telefono: string; seq: number; texto: string; aviso_dado?: boolean }[] = [];
  const fetchFn = (async (_u: string, init?: RequestInit) => {
    const c = JSON.parse(String(init?.body));
    cuerpos.push(c);
    return new Response(JSON.stringify({ texto: c.seq === 0 ? aperturaServidor : "Ok.", pedido_id: null, fin: false, turno: c.seq }), { status: 200 });
  }) as unknown as typeof fetch;
  const cierres: string[] = [];
  const c = new CerebroSuelto({ url: "https://x.invalid/voz-turno", secreto: "s", callId: "CA_oculto_01", telefono, fetchFn, temporizador: () => () => undefined, disparadorApertura: DISPARO, ...(confirmar ? { confirmarTelefono: confirmar } : {}), alColgar: (m) => cierres.push(m) });
  return { c, cuerpos, cierres };
}

describe("cerebro suelto: puerto y telefono oculto", () => {
  it("con telefono confiable la apertura del disparador va como seq 0 y el texto del cliente como seq 1; sin herramientas ni costo", async () => {
    const { c, cuerpos } = montar("9991234567");
    const deltas: string[] = [];
    const a = await c.puerto.completar(peticion(DISPARO, (d) => deltas.push(d)));
    expect(a).toMatchObject({ texto: "Buen día.", toolCalls: [], costoMicroUsd: 0 });
    expect(deltas.join("")).toContain("Buen día.");
    await c.puerto.completar(peticion("quiero tacos"));
    expect(cuerpos.map((x) => [x.seq, x.texto])).toEqual([[0, ""], [1, "quiero tacos"]]);
  });

  it("numero oculto: dice el aviso y pide el numero SIN llamar al servidor; lo repite en grupos; con el si confirma y recien ahi abre (seq 0)", async () => {
    const registrados: string[] = [];
    const { c, cuerpos } = montar(null, async (t) => (registrados.push(t), { ok: true }));
    const a = await c.puerto.completar(peticion(DISPARO));
    expect(a.texto).toContain("se graba");
    expect(a.texto).toContain("número de teléfono");
    expect(cuerpos).toHaveLength(0);
    const b = await c.puerto.completar(peticion("mi número es nueve nueve nueve uno dos tres cuatro cinco seis siete"));
    expect(b.texto).toContain("9 9 9, 1 2 3, 4 5 6 7");
    expect(cuerpos).toHaveLength(0);
    const f = await c.puerto.completar(peticion("sí, es correcto"));
    expect(f.texto).toBe("Buen día.");
    expect(registrados).toEqual(["9991234567"]);
    expect(cuerpos).toEqual([{ call_id: "CA_oculto_01", telefono: "9991234567", seq: 0, texto: "", aviso_dado: true }]);
    await c.puerto.completar(peticion("hola"));
    expect(cuerpos[1]).toMatchObject({ seq: 1, telefono: "9991234567" });
  });

  it("numero oculto + servidor viejo (ignora aviso_dado y repite preambulo y aviso): el aviso se detecta y se quita, el cliente no lo oye dos veces", async () => {
    const repetido = `${PREAMBULO_POR_OMISION} ${AVISO_GRABACION_POR_OMISION} Buen día, ¿qué se le ofrece?`;
    const { c, cuerpos } = montar(null, async () => ({ ok: true }), repetido);
    const inicial = await c.puerto.completar(peticion(DISPARO));
    await c.puerto.completar(peticion("9991234567"));
    const f = await c.puerto.completar(peticion("sí"));
    expect(cuerpos[0]).toMatchObject({ seq: 0, aviso_dado: true });
    expect(f.texto).toBe("Buen día, ¿qué se le ofrece?");
    expect(`${inicial.texto} ${f.texto}`.split("se graba")).toHaveLength(2); // el aviso suena UNA vez en toda la llamada
  });

  it("numero oculto + servidor viejo que solo repite el aviso: queda un saludo corto, no un texto vacio", () => {
    expect(quitarFrasesDichas(`${AVISO_GRABACION_POR_OMISION}`, [AVISO_GRABACION_POR_OMISION])).toBe(SALUDO_SIN_AVISO);
    expect(quitarFrasesDichas("Un AVISO   propio. Hola.", ["un aviso propio."])).toBe("Hola.");
  });

  it("con telefono confiable la apertura NO manda aviso_dado (el servidor si debe dar el aviso)", async () => {
    const { c, cuerpos } = montar("9991234567");
    await c.puerto.completar(peticion(DISPARO));
    expect(cuerpos[0]).not.toHaveProperty("aviso_dado");
  });

  it("numero oculto: si el cliente corrige, lo vuelve a pedir; numero de la sucursal rechazado; tres fallos = cuelga", async () => {
    const { c, cuerpos, cierres } = montar(null, async () => ({ ok: false }));
    await c.puerto.completar(peticion(DISPARO));
    await c.puerto.completar(peticion("9991234567"));
    const x = await c.puerto.completar(peticion("sí"));
    expect(x.texto).toContain("otro número");
    await c.puerto.completar(peticion("no sé"));
    const ult = await c.puerto.completar(peticion("no sé"));
    expect(ult.texto).toContain("Una persona le devolverá la llamada");
    expect(cierres).toEqual(["telefono_no_obtenido"]);
    expect(cuerpos).toHaveLength(0);
  });

  it("numero oculto + dos silencios: pregunta de nuevo y luego cuelga sin llamar al servidor", async () => {
    const { c, cuerpos, cierres } = montar(null);
    await c.puerto.completar(peticion(DISPARO));
    expect((await c.puerto.completar(peticion("[silencio]"))).texto).toContain("Sigue ahí");
    await c.puerto.completar(peticion("[silencio]"));
    expect(cierres).toEqual(["silencio"]);
    expect(cuerpos).toHaveLength(0);
  });

  it("extraerTelefonoDictado y telefonoEnGrupos", () => {
    expect(extraerTelefonoDictado("es el 999 123 45 67")).toBe("9991234567");
    expect(extraerTelefonoDictado("+52 1 999 123 4567")).toBe("9991234567");
    expect(extraerTelefonoDictado("nueve nueve nueve")).toBeNull();
    expect(telefonoEnGrupos("9991234567")).toBe("9 9 9, 1 2 3, 4 5 6 7");
  });
});

describe("VigiaSilencio", () => {
  const armar = (umbralMs = 8000) => {
    const est = { ocupado: false, actividad: 0, t: 100_000, n: 0 };
    const v = new VigiaSilencio({ umbralMs, ocupado: () => est.ocupado, ultimaActividad: () => est.actividad, ahora: () => est.t, disparar: () => { est.n += 1; } });
    return { v, est };
  };
  it("dispara una vez a los 8 s y se rearma cuando el silencio vuelve a empezar (2 silencios = 2 disparos)", () => {
    const { v, est } = armar();
    for (const ms of [1000, 7000, 8000, 9000, 10000]) v.registrar(ms);
    expect(est.n).toBe(1);
    v.registrar(1000);
    v.registrar(8500);
    expect(est.n).toBe(2);
  });
  it("no dispara mientras hay un turno en curso ni si el servidor acaba de contestar", () => {
    const { v, est } = armar();
    est.ocupado = true;
    v.registrar(20_000);
    expect(est.n).toBe(0);
    est.ocupado = false;
    est.actividad = est.t - 500;
    v.registrar(21_000);
    expect(est.n).toBe(0);
  });
});

describe("config: VOZ_CEREBRO", () => {
  const base = { LIVEKIT_URL: "wss://x", LIVEKIT_API_KEY: "k", LIVEKIT_API_SECRET: "s", ATIENDE_API_URL: "https://api.invalid", INTERNAL_SECRET: "i" };
  it("por omision es el cerebro actual y no pide nada de voz-turno", () => {
    const c = cargarConfig({ ...base });
    expect(c.cerebro).toBe("actual");
    expect(c.vozTurno).toBeNull();
    expect(c.motivos.join(" ")).not.toContain("VOZ_TURNO");
  });
  it("suelto exige URL (o SUPABASE_URL), VOZ_TURNO_SECRET y DEEPGRAM_API_KEY, y ya no exige Gemini/OpenRouter", () => {
    const falta = cargarConfig({ ...base, VOZ_CEREBRO: "suelto" });
    expect(falta.motivos.join(" ")).toMatch(/VOZ_TURNO_URL.*VOZ_TURNO_SECRET.*DEEPGRAM_API_KEY/);
    expect(falta.motivos.join(" ")).not.toContain("GEMINI_API_KEY u OPENROUTER");
    const c = cargarConfig({ ...base, VOZ_CEREBRO: "suelto", SUPABASE_URL: "https://p.supabase.invalid/", VOZ_TURNO_SECRET: "secreto", DEEPGRAM_API_KEY: "d" });
    expect(c.vozTurno).toMatchObject({ url: "https://p.supabase.invalid/functions/v1/voz-turno", silencioMs: 8000, timeoutMs: 35000 });
    expect(JSON.stringify(c.motivos)).not.toContain("secreto");
  });
  it("valor invalido de VOZ_CEREBRO se reporta", () => {
    expect(cargarConfig({ ...base, VOZ_CEREBRO: "otro" }).motivos.join(" ")).toContain("VOZ_CEREBRO debe ser");
  });

  it("VOZ_TURNO_URL exige https salvo localhost", () => {
    const con = (url: string) => cargarConfig({ ...base, VOZ_CEREBRO: "suelto", VOZ_TURNO_URL: url, VOZ_TURNO_SECRET: "x", DEEPGRAM_API_KEY: "d" }).motivos.join(" ");
    expect(con("http://ejemplo.com/functions/v1/voz-turno")).toContain("https");
    expect(con("http://localhost.evil.com/voz-turno")).toContain("https");
    expect(con("https://ejemplo.com/functions/v1/voz-turno")).not.toContain("VOZ_TURNO_URL");
    expect(con("http://localhost:54321/functions/v1/voz-turno")).not.toContain("VOZ_TURNO_URL");
    expect(con("http://127.0.0.1:54321/functions/v1/voz-turno")).not.toContain("VOZ_TURNO_URL");
  });

  it("registrar-contacto: se arma solo con VOICE_TOOL_SECRET y la URL se deriva de voz-turno", () => {
    const e = { ...base, VOZ_CEREBRO: "suelto", VOZ_TURNO_URL: "https://x.supabase.co/functions/v1/voz-turno", VOZ_TURNO_SECRET: "x", DEEPGRAM_API_KEY: "d" };
    expect(cargarConfig(e).vozTurno?.registrarContacto).toBeNull();
    expect(cargarConfig({ ...e, VOICE_TOOL_SECRET: "t" }).vozTurno?.registrarContacto).toEqual({ url: "https://x.supabase.co/functions/v1/registrar-contacto", secreto: "t" });
  });

  it("VOZ_REGISTRAR_CONTACTO_URL exige https salvo localhost; con VOICE_TOOL_SECRET y sin URL derivable ni configurada falla al arrancar", () => {
    const e = { ...base, VOZ_CEREBRO: "suelto", VOZ_TURNO_URL: "https://x.supabase.co/functions/v1/voz-turno", VOZ_TURNO_SECRET: "x", DEEPGRAM_API_KEY: "d", VOICE_TOOL_SECRET: "t" };
    const con = (url: string) => cargarConfig({ ...e, VOZ_REGISTRAR_CONTACTO_URL: url }).motivos.join(" ");
    expect(con("http://ejemplo.com/functions/v1/registrar-contacto")).toContain("VOZ_REGISTRAR_CONTACTO_URL debe usar https");
    expect(con("ftp://x/registrar")).toContain("VOZ_REGISTRAR_CONTACTO_URL");
    expect(con("https://ejemplo.com/functions/v1/registrar-contacto")).not.toContain("VOZ_REGISTRAR_CONTACTO_URL");
    expect(con("http://localhost:54321/functions/v1/registrar-contacto")).not.toContain("VOZ_REGISTRAR_CONTACTO_URL");
    // URL de voz-turno sin el sufijo /voz-turno: no se puede derivar
    const sinDerivar = { ...e, VOZ_TURNO_URL: "https://x.supabase.co/otra-ruta" };
    expect(cargarConfig(sinDerivar).motivos.join(" ")).toContain("VOZ_REGISTRAR_CONTACTO_URL");
    expect(cargarConfig({ ...sinDerivar, VOZ_REGISTRAR_CONTACTO_URL: "https://x.supabase.co/functions/v1/registrar-contacto" }).motivos.join(" ")).not.toContain("VOZ_REGISTRAR_CONTACTO_URL");
    // sin VOICE_TOOL_SECRET no se arma el aviso y no es error
    expect(cargarConfig({ ...sinDerivar, VOICE_TOOL_SECRET: "" }).motivos.join(" ")).not.toContain("VOZ_REGISTRAR_CONTACTO_URL");
  });
});

describe("cerebro suelto: despedida repetida al interrumpir un cierre", () => {
  it("el cierre se dice completo la 1.a vez y, si el cliente lo interrumpe, la 2.a solo una version corta", async () => {
    const { c } = montar(null);
    await c.puerto.completar(peticion(DISPARO));
    const a = await c.puerto.completar(peticion("no sé"));
    const b = await c.puerto.completar(peticion("ni idea"));
    const c3 = await c.puerto.completar(peticion("nada"));
    expect(c3.texto).toContain("No logré registrar su número");
    expect(a.texto).not.toContain("No logré");
    expect(b.texto).not.toContain("No logré");
    const repetido = await c.puerto.completar(peticion("¿bueno?"));
    expect(repetido.texto).toBe("Hasta luego.");
  });
});
