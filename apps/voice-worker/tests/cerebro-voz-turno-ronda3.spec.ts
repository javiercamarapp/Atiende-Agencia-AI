// Ronda 3 del ataque al cerebro suelto: cierre blando (`despedida_con_pedido`), respuesta retenida tras un aborto por ruido, pendiente repetido y union de textos.
// La `sesion` imita el patron real de SesionCascadaV2: un final nuevo aborta el turno anterior y los turnos corren encadenados.
import { describe, expect, it } from "vitest";
import { advertenciasConfig, cargarConfig } from "../src/config.ts";
import { CerebroSuelto } from "../src/cerebro-suelto.ts";
import { CerebroVozTurno, TEXTO_PENDIENTE, versionCortaDePendiente } from "../src/cerebro-voz-turno.ts";

const dormir = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Peticion { seq: number; texto: string }

function crear(manejar: (p: Peticion) => Promise<Record<string, unknown>>, extra: Partial<ConstructorParameters<typeof CerebroVozTurno>[0]> = {}) {
  const peticiones: Peticion[] = [];
  const fetchFn = (async (_u: string, init?: RequestInit) => {
    const b = JSON.parse(String(init?.body)) as Peticion;
    peticiones.push({ seq: b.seq, texto: b.texto });
    return new Response(JSON.stringify(await manejar(b)), { status: 200 });
  }) as unknown as typeof fetch;
  const cerebro = new CerebroVozTurno({ url: "https://x.invalid/voz-turno", secreto: "s", callId: "llamada-123", telefono: "9991234567", fetchFn, esperar: async () => undefined, temporizador: () => () => undefined, ...extra });
  return { cerebro, peticiones };
}

function sesion(c: CerebroVozTurno) {
  let ctl: AbortController | null = null;
  const hablado: string[] = [];
  let cadena: Promise<void> = Promise.resolve();
  const final = (texto: string): void => {
    ctl?.abort();
    const mio = new AbortController();
    ctl = mio;
    cadena = cadena.then(async () => {
      try {
        const r = await c.turno(texto, { senal: mio.signal, alRespuestaPrevia: (t) => hablado.push(`PREV:${t}`), alEspera: (t) => hablado.push(`ESP:${t}`) });
        hablado.push(`${r.colgar ? "COLGAR:" : ""}${r.texto}`);
      } catch {
        hablado.push(`ABORT(${texto})`);
      }
    });
  };
  return { final, hablado, fin: () => cadena };
}

describe("cierre blando: despedida_con_pedido no es pegajosa (P1)", () => {
  it("carrera: A lento crea el pedido y B «agrega una coca» llega mientras: B se envia con seq 2 y no se cuelga", async () => {
    const { cerebro, peticiones } = crear(async (p) => {
      if (p.seq === 1) { await dormir(40); return { texto: "Listo, pedido confirmado, total 100. Hasta luego.", pedido_id: "P1", turno: 1 }; }
      return { texto: `Agregué: ${p.texto}. Su nuevo total es 120.`, pedido_id: "P1", turno: p.seq };
    }, { rellenoMs: 99_999 });
    const s = sesion(cerebro);
    s.final("sí, confirmo");
    await dormir(5);
    s.final("ah, y agrega una coca");
    await s.fin();
    expect(peticiones.map((p) => [p.seq, p.texto])).toEqual([[1, "sí, confirmo"], [2, "ah, y agrega una coca"]]);
    expect(s.hablado.some((h) => h.startsWith("COLGAR:"))).toBe(false);
    expect(s.hablado.join(" | ")).toContain("total 100");
    expect(s.hablado.at(-1)).toContain("nuevo total es 120");
    expect(cerebro.cerrada).toBe(false);
  });

  it("el cliente interrumpe la despedida ya cerrada con algo que no es cierre: el cierre se retira, se avisa al worker y el texto se envia", async () => {
    let reabierto = 0;
    const { cerebro, peticiones } = crear(async (p) => (p.seq === 1 ? { texto: "Listo, su pedido quedó. Gracias, buen provecho.", pedido_id: "P1" } : { texto: "Dígame, ¿qué le falta?", pedido_id: "P1" }), { alReabrir: () => { reabierto += 1; } });
    expect(await cerebro.turno("a domicilio")).toMatchObject({ colgar: true, motivo: "despedida_con_pedido" });
    const r = await cerebro.turno("espera, falta algo");
    expect(r).toMatchObject({ colgar: false, texto: "Dígame, ¿qué le falta?" });
    expect(peticiones.map((p) => p.seq)).toEqual([1, 2]);
    expect(reabierto).toBe(1);
    expect(cerebro.cerrada).toBe(false);
  });

  it("si el cliente solo se despide, el cierre blando se mantiene y no se manda nada", async () => {
    const { cerebro, peticiones } = crear(async () => ({ texto: "Listo, su pedido quedó. Hasta luego.", pedido_id: "P1" }));
    await cerebro.turno("a domicilio");
    expect(await cerebro.turno("gracias, hasta luego")).toMatchObject({ colgar: true });
    expect(peticiones).toHaveLength(1);
  });

  it("los cierres duros siguen pegajosos aunque el cliente siga hablando", async () => {
    const { cerebro, peticiones } = crear(async () => ({ texto: "Gracias por llamar.", fin: true, pedido_id: null }));
    expect(await cerebro.turno("hola")).toMatchObject({ colgar: true, motivo: "fin_servidor" });
    expect(await cerebro.turno("espera, agrega una coca")).toMatchObject({ colgar: true });
    expect(peticiones).toHaveLength(1);
  });
});

describe("cierre blando a traves del puerto del cerebro suelto (P1)", () => {
  it("tras la despedida con pedido, «espera, falta algo» retira el colgado y la llamada sigue; despues un «gracias» la cierra", async () => {
    const cuerpos: Peticion[] = [];
    const fetchFn = (async (_u: string, init?: RequestInit) => {
      const b = JSON.parse(String(init?.body)) as Peticion;
      cuerpos.push(b);
      const texto = b.seq === 1 ? "Listo, su pedido quedó. Gracias, buen provecho." : b.seq === 2 ? "Dígame, ¿qué falta?" : "Con gusto. Hasta luego.";
      return new Response(JSON.stringify({ texto, pedido_id: "P1", fin: false, turno: b.seq }), { status: 200 });
    }) as unknown as typeof fetch;
    const eventos: string[] = [];
    const c = new CerebroSuelto({
      url: "https://x.invalid/voz-turno", secreto: "s", callId: "llamada-123", telefono: "9991234567", fetchFn, esperar: async () => undefined, temporizador: () => () => undefined,
      disparadorApertura: "(saludo)", alColgar: (m) => eventos.push(`colgar:${m}`), alReabrir: () => eventos.push("reabrir"),
    });
    const pide = (t: string) => c.puerto.completar({ system: "", mensajes: [{ role: "user", content: t }], herramientas: [] });
    expect((await pide("a domicilio")).texto).toContain("buen provecho");
    expect(c.cierre?.motivo).toBe("despedida_con_pedido");
    expect((await pide("espera, falta algo")).texto).toBe("Dígame, ¿qué falta?");
    expect(c.cierre).toBeNull();
    expect((await pide("no, gracias")).texto).toContain("Hasta luego");
    expect(c.cierre?.motivo).toBe("despedida_con_pedido");
    expect(cuerpos.map((b) => b.seq)).toEqual([1, 2, 3]);
    expect(eventos).toEqual(["colgar:despedida_con_pedido", "reabrir", "colgar:despedida_con_pedido"]);
  });
});

describe("union de textos de turnos abortados (P3)", () => {
  it("une con «. » cuando el anterior no termina en puntuacion y con espacio cuando si", async () => {
    const { cerebro, peticiones } = crear(async (p) => { if (p.seq === 1) await dormir(30); return { texto: `R${p.seq}`, turno: p.seq }; });
    const s = sesion(cerebro);
    s.final("uno");
    await dormir(2);
    s.final("dos tacos");
    await dormir(2);
    s.final("de bistec");
    await s.fin();
    expect(peticiones.map((p) => p.texto)).toEqual(["uno", "dos tacos. de bistec"]);
    const otro = crear(async (p) => { if (p.seq === 1) await dormir(30); return { texto: `R${p.seq}`, turno: p.seq }; });
    const s2 = sesion(otro.cerebro);
    s2.final("uno");
    await dormir(2);
    s2.final("dos tacos.");
    await dormir(2);
    s2.final("de bistec");
    await s2.fin();
    expect(otro.peticiones.map((p) => p.texto)).toEqual(["uno", "dos tacos. de bistec"]);
  });
});

describe("pendiente hablado y luego abortado no se repite completo (P2-3)", () => {
  it("la segunda vez que se habla el mismo pendiente va en version corta («como le decia, su total es ...»)", async () => {
    const { cerebro } = crear(async (p) => {
      if (p.seq === 1) { await dormir(25); return { texto: "Su total es 100 pesos. Le anoto dos tacos de bistec con todo. ¿Algo más?", turno: 1 }; }
      if (p.seq === 2) { await dormir(80); return { texto: "Listo, anotado.", turno: 2 }; }
      return { texto: "Perfecto.", turno: 3 };
    });
    const ctlA = new AbortController();
    const pA = cerebro.turno("uno", { senal: ctlA.signal }).catch(() => "abort");
    await dormir(2);
    ctlA.abort();
    await pA;
    const habladoB: string[] = [];
    const ctlB = new AbortController();
    const pB = cerebro.turno("dos", { senal: ctlB.signal, alRespuestaPrevia: (t) => habladoB.push(t) }).catch(() => "abort");
    await dormir(50);
    expect(habladoB).toEqual(["Su total es 100 pesos. Le anoto dos tacos de bistec con todo. ¿Algo más?"]);
    ctlB.abort();
    await pB;
    const habladoC: string[] = [];
    const rC = await cerebro.turno("tres", { alRespuestaPrevia: (t) => habladoC.push(t) });
    expect(rC.texto).toBe("Perfecto.");
    expect(habladoC).toEqual(["Como le decía, su total es 100 pesos. Le anoto dos tacos de bistec con todo.", "Listo, anotado."]);
  });
  it("versionCortaDePendiente descarta las preguntas y conserva las oraciones (ronda 4: hasta tres sin pregunta, todas)", () => {
    expect(versionCortaDePendiente("Anotado. Su total es 85 pesos. ¿Algo más?")).toBe("Como le decía, anotado. Su total es 85 pesos.");
    expect(versionCortaDePendiente("Claro que sí. ¿Algo más?")).toBe("Como le decía, claro que sí.");
  });
});

describe("respuesta retenida tras un aborto por ruido sin texto final (P2-2)", () => {
  function conReloj() {
    const timers: { fn: () => void; ms: number }[] = [];
    return { timers, temporizador: (fn: () => void, ms: number) => { timers.push({ fn, ms }); return () => undefined; } };
  }
  it("pasados ~1.5 s del aborto, sin turno nuevo, avisa al worker y hablarPendiente entrega el total retenido", async () => {
    const r = conReloj();
    let avisos = 0;
    const { cerebro, peticiones } = crear(async () => { await dormir(10); return { texto: "Son dos tacos, su total es 80 pesos.", turno: 1 }; }, { temporizador: r.temporizador, rellenoMs: 99_999, alPendienteHuerfano: () => { avisos += 1; } });
    const ctl = new AbortController();
    const p = cerebro.turno("dos tacos", { senal: ctl.signal }).catch(() => "abort");
    await dormir(2);
    ctl.abort();
    await p;
    const t = r.timers.find((x) => x.ms === 1500)!;
    expect(t).toBeDefined();
    t.fn();
    await dormir(30);
    expect(avisos).toBe(1);
    expect(await cerebro.hablarPendiente()).toMatchObject({ texto: "Son dos tacos, su total es 80 pesos.", colgar: false });
    expect(await cerebro.hablarPendiente()).toBeNull();
    expect(peticiones).toHaveLength(1);
  });
  it("si llega un turno nuevo antes, no avisa", async () => {
    const r = conReloj();
    let avisos = 0;
    const { cerebro } = crear(async (p) => { await dormir(10); return { texto: `R${p.seq}`, turno: p.seq }; }, { temporizador: r.temporizador, rellenoMs: 99_999, alPendienteHuerfano: () => { avisos += 1; } });
    const ctl = new AbortController();
    const p = cerebro.turno("dos", { senal: ctl.signal }).catch(() => "abort");
    await dormir(2);
    ctl.abort();
    await p;
    const siguiente = cerebro.turno("tres");
    r.timers.find((x) => x.ms === 1500)!.fn();
    await siguiente;
    await dormir(20);
    expect(avisos).toBe(0);
  });
  it("por el puerto: el turno interno TEXTO_PENDIENTE habla lo retenido sin mandar nada al servidor", async () => {
    const cuerpos: Peticion[] = [];
    const fetchFn = (async (_u: string, init?: RequestInit) => {
      const b = JSON.parse(String(init?.body)) as Peticion;
      cuerpos.push(b);
      await dormir(10);
      return new Response(JSON.stringify({ texto: "Su total es 80 pesos.", pedido_id: null, fin: false, turno: b.seq }), { status: 200 });
    }) as unknown as typeof fetch;
    const c = new CerebroSuelto({ url: "https://x.invalid/voz-turno", secreto: "s", callId: "llamada-123", telefono: "9991234567", fetchFn, esperar: async () => undefined, temporizador: () => () => undefined, disparadorApertura: "(saludo)" });
    const ctl = new AbortController();
    const p = c.puerto.completar({ system: "", mensajes: [{ role: "user", content: "dos tacos" }], herramientas: [], senal: ctl.signal }).catch(() => "abort");
    await dormir(2);
    ctl.abort();
    await p;
    await dormir(20);
    const r = await c.puerto.completar({ system: "", mensajes: [{ role: "user", content: TEXTO_PENDIENTE }], herramientas: [] });
    expect(r.texto).toBe("Su total es 80 pesos.");
    expect(cuerpos).toHaveLength(1);
  });
});

describe("VOICE_TOOL_SECRET ausente con el cerebro suelto (P2-1)", () => {
  const base = { VOZ_CEREBRO: "suelto", VOZ_TURNO_URL: "https://p.supabase.invalid/functions/v1/voz-turno", VOZ_TURNO_SECRET: "x", DEEPGRAM_API_KEY: "d" };
  it("advierte al arrancar sin imprimir secretos; con el secreto o con el cerebro actual no hay advertencia", () => {
    const sin = advertenciasConfig(cargarConfig(base));
    expect(sin.map((a) => a.codigo)).toEqual(["voice_tool_secret_ausente"]);
    expect(JSON.stringify(sin)).not.toContain("\"x\"");
    expect(advertenciasConfig(cargarConfig({ ...base, VOICE_TOOL_SECRET: "t" }))).toEqual([]);
    expect(advertenciasConfig(cargarConfig({ VOZ_CEREBRO: "actual" }))).toEqual([]);
    expect(advertenciasConfig(cargarConfig({}))).toEqual([]);
  });
});
