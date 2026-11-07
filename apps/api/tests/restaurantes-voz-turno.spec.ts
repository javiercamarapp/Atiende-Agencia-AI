// POST /v1/restaurantes/voz/turno (turno de voz del cerebro v2, contrato del cliente `apps/voice-worker/src/cerebro-voz-turno.ts`): autenticacion por
// secreto de sucursal, apagado por bandera e interruptor, apertura con aviso de grabacion, silencio, idempotencia por (call_id, seq), 409 «en proceso»,
// 429 con Retry-After y la base sin migrar (503 con fin, nunca 500). Dobles en memoria: hilos (`InMemoryHilosVozRepository`) y agente falso.
import { describe, expect, it } from "vitest";
import { InMemoryHilosVozRepository, TEXTO_APAGADO_VOZ } from "@atiende/domain-restaurantes/voz-turno";
import type { AgenteVoz, MensajeHiloVoz } from "@atiende/domain-restaurantes/voz-turno";
import { buildApp } from "../src/app.ts";
import type { AppDeps } from "../src/deps.ts";
import type { ResultadoAuthVozTurno, VozTurnoPuertos } from "../src/routes/verticals/restaurantes/voz-turno.ts";
import { hashVoiceSecret } from "../src/routes/verticals/restaurantes/voice-auth.ts";
import { buildRestaurantesKpiTestContext } from "./restaurantes-admin-kpis-fixtures.ts";
import type { LlmGateway } from "@atiende/agent-core";
import type { TenancyEngine } from "@atiende/core-tenancy";
import { buildVozTurnoPuertos } from "../src/production/voz-turno-deps.ts";
import { buildRestaurantesTurnHandlerForSession } from "../src/production/deps.ts";
import { AbortAwareFakeSession, type FakeSessionHandler } from "../../../packages/domain-restaurantes/tests/support/aborting-fake-session.ts";

const RUTA = "/v1/restaurantes/voz/turno";
const SECRETO = "secreto-de-sucursal-de-prueba";
const TEL = "9991234567";

interface Opciones {
  cerebroV2?: boolean;
  apagado?: boolean;
  autenticacion?: "ok" | "no_disponible";
  cupo?: boolean;
}

async function construir(o: Opciones = {}) {
  const ctx = await buildRestaurantesKpiTestContext(buildApp);
  const hilos = new InMemoryHilosVozRepository();
  const llamadasAgente: Array<readonly MensajeHiloVoz[]> = [];
  const estado: { agente: AgenteVoz; cupo: boolean } = {
    agente: async () => ({ reply: "¡Con gusto! 😊 La orden de pastor cuesta $180.\n- ¿Algo más?", orderId: null }),
    cupo: o.cupo ?? true,
  };
  const puertos: VozTurnoPuertos = {
    apagado: () => o.apagado === true,
    autenticar: async (hash): Promise<ResultadoAuthVozTurno> => {
      if (o.autenticacion === "no_disponible") return { estado: "no_disponible" };
      if (hash !== hashVoiceSecret(SECRETO)) return { estado: "no_coincide" };
      return { estado: "ok", organizationId: ctx.organizationId, propertyId: ctx.propertyIdA, cerebroV2: o.cerebroV2 ?? true };
    },
    enTransaccion: async (_llamada, fn) =>
      fn({
        hilos,
        agente: async (a) => {
          llamadasAgente.push(a.mensajes);
          return estado.agente(a);
        },
        consumirCupo: async () => estado.cupo,
        contextoSaludo: async () => ({ zonaHoraria: "America/Merida", nombreNegocio: "Los Taquitos de PM" }),
      }),
  };
  const deps: AppDeps = { ...ctx.deps, vozTurno: puertos };
  const app = buildApp(deps);
  const turno = async (cuerpo: Record<string, unknown>, secreto: string | null = SECRETO) => {
    const r = await app.request(RUTA, { method: "POST", headers: { "content-type": "application/json", ...(secreto ? { "x-voz-turno-secret": secreto } : {}) }, body: JSON.stringify(cuerpo) });
    return { status: r.status, retryAfter: r.headers.get("retry-after"), json: (await r.json()) as Record<string, unknown> };
  };
  return { ctx, hilos, llamadasAgente, estado, turno };
}

const llamada = (seq: number, texto: string, extra: Record<string, unknown> = {}) => ({ call_id: "llamada-prueba-01", telefono: TEL, seq, texto, ...extra });

describe("POST /v1/restaurantes/voz/turno", () => {
  it("sin el header o con un secreto que no es de ninguna sucursal responde 401 sin tocar el hilo", async () => {
    const t = await construir();
    expect((await t.turno(llamada(0, ""), null)).status).toBe(401);
    expect((await t.turno(llamada(0, ""), "otro-secreto")).status).toBe(401);
    expect(t.hilos.filas.size).toBe(0);
  });

  it("organizacion sin cerebro_v2: 503 con fin y la frase de apagado (ningun otro tenant cambia)", async () => {
    const t = await construir({ cerebroV2: false });
    const r = await t.turno(llamada(0, ""));
    expect(r.status).toBe(503);
    expect(r.json).toEqual({ texto: TEXTO_APAGADO_VOZ, pedido_id: null, fin: true, turno: 0 });
    expect(t.hilos.filas.size).toBe(0);
  });

  it("interruptor VOZ_TURNO_APAGADO: 503 con fin sin autenticar ni tocar la base", async () => {
    const t = await construir({ apagado: true });
    const r = await t.turno(llamada(0, ""));
    expect(r.status).toBe(503);
    expect(r.json.fin).toBe(true);
  });

  it("apertura (seq 0, texto vacio): saludo con el aviso de grabacion, turno 0, sin modelo; con aviso_dado el saludo es corto", async () => {
    const t = await construir();
    const r = await t.turno(llamada(0, ""));
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ pedido_id: null, fin: false, turno: 0 });
    expect(String(r.json.texto)).toMatch(/asistente virtual de Los Taquitos de PM/);
    expect(String(r.json.texto)).toMatch(/se graba/);
    expect(t.llamadasAgente).toHaveLength(0);

    const corta = await t.turno({ ...llamada(0, "", { aviso_dado: true }), call_id: "llamada-oculta-02" });
    expect(corta.json.texto).toBe("Gracias. ¿En qué le puedo ayudar?");
  });

  it("turno con modelo: texto limpio para TTS (sin emoji ni lista, precio en palabras) y el historial de la llamada llega al agente", async () => {
    const t = await construir();
    await t.turno(llamada(0, ""));
    const r = await t.turno(llamada(1, "quiero una orden de pastor"));
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ pedido_id: null, fin: false, turno: 1 });
    expect(r.json.texto).toBe("¡Con gusto! La orden de pastor cuesta ciento ochenta pesos. ¿Algo más?");
    expect(t.llamadasAgente[0]!.map((m) => m.role)).toEqual(["assistant", "user"]);
    expect(t.llamadasAgente[0]!.at(-1)!.content).toBe("quiero una orden de pastor");
  });

  it("idempotencia por (call_id, seq): el mismo seq devuelve la respuesta guardada sin volver a llamar al modelo; un seq viejo es 409 sin «en proceso»", async () => {
    const t = await construir();
    t.estado.agente = async () => ({ reply: "Listo, su pedido quedó registrado.", orderId: "00000000-0000-0000-0000-00000000a001" });
    await t.turno(llamada(0, ""));
    const r1 = await t.turno(llamada(1, "si confirmo"));
    const r2 = await t.turno(llamada(1, "si confirmo"));
    expect(r2.status).toBe(200);
    expect(r2.json).toEqual(r1.json);
    expect(r1.json.pedido_id).toBe("00000000-0000-0000-0000-00000000a001");
    expect(t.llamadasAgente).toHaveLength(1);

    await t.turno(llamada(2, "gracias"));
    const viejo = await t.turno(llamada(1, "otra cosa"));
    expect(viejo.status).toBe(409);
    expect(String(viejo.json.error)).not.toMatch(/en proceso|se adelant/);
  });

  it("apertura repetida (reconexion del worker): la ultima frase y seq_ultimo para continuar", async () => {
    const t = await construir();
    await t.turno(llamada(0, ""));
    await t.turno(llamada(1, "quiero pastor"));
    const r = await t.turno(llamada(0, ""));
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ seq_ultimo: 1, turno: 1, fin: false });
    expect(t.llamadasAgente).toHaveLength(1);
  });

  it("409 «en proceso»: un reintento del mismo seq mientras el modelo piensa no gasta modelo dos veces; al terminar, el reintento recibe la respuesta", async () => {
    const t = await construir();
    let soltar: () => void = () => undefined;
    t.estado.agente = () => new Promise((ok) => (soltar = () => ok({ reply: "Su total es de 250 pesos.", orderId: null })));
    await t.turno(llamada(0, ""));
    const enVuelo = t.turno(llamada(1, "dos de pastor"));
    await new Promise((r) => setTimeout(r, 10));
    const choque = await t.turno(llamada(1, "dos de pastor"));
    expect(choque.status).toBe(409);
    expect(String(choque.json.error)).toMatch(/en proceso/);
    // Un seq MAYOR tambien espera a que termine el turno en vuelo.
    expect((await t.turno(llamada(2, "y una coca"))).status).toBe(409);
    soltar();
    expect((await enVuelo).json.texto).toBe("Su total es de doscientos cincuenta pesos.");
    const repetido = await t.turno(llamada(1, "dos de pastor"));
    expect(repetido.status).toBe(200);
    expect(t.llamadasAgente).toHaveLength(1);
  });

  it("si el turno del agente falla se libera la marca: el reintento del mismo seq procede", async () => {
    const t = await construir();
    t.estado.agente = async () => {
      throw new Error("proveedor caido");
    };
    await t.turno(llamada(0, ""));
    expect((await t.turno(llamada(1, "hola"))).status).toBe(500);
    t.estado.agente = async () => ({ reply: "¿Qué le gustaría pedir?", orderId: null });
    const r = await t.turno(llamada(1, "hola"));
    expect(r.status).toBe(200);
    expect(r.json.texto).toBe("¿Qué le gustaría pedir?");
  });

  it("[silencio]: el primero se repregunta sin modelo; el segundo seguido cierra la llamada (fin)", async () => {
    const t = await construir();
    await t.turno(llamada(0, ""));
    const s1 = await t.turno(llamada(1, "[silencio]"));
    expect(s1.json).toMatchObject({ fin: false, turno: 1 });
    expect(String(s1.json.texto)).toMatch(/Sigue ahí/);
    const s2 = await t.turno(llamada(2, "[silencio]"));
    expect(s2.json).toMatchObject({ fin: true, turno: 2 });
    expect(t.llamadasAgente).toHaveLength(0);
  });

  it("despedida sin pedido en curso cierra sin modelo", async () => {
    const t = await construir();
    await t.turno(llamada(0, ""));
    const r = await t.turno(llamada(1, "no gracias es todo"));
    expect(r.json.fin).toBe(true);
    expect(t.llamadasAgente).toHaveLength(0);
  });

  it("un call_id es de UN telefono: otro numero recibe 409 y no lee el hilo", async () => {
    const t = await construir();
    await t.turno(llamada(0, ""));
    const r = await t.turno({ ...llamada(1, "hola"), telefono: "9990000000" });
    expect(r.status).toBe(409);
    expect(r.json.texto).toBeUndefined();
  });

  it("entrada invalida: 400 (seq ausente, call_id corto, telefono sin 10 digitos, texto con seq 0 es 409)", async () => {
    const t = await construir();
    expect((await t.turno({ call_id: "llamada-prueba-01", telefono: TEL, texto: "" })).status).toBe(400);
    expect((await t.turno(llamada(0, "", { call_id: "corto" }))).status).toBe(400);
    expect((await t.turno(llamada(0, "", { telefono: "123" }))).status).toBe(400);
    expect((await t.turno(llamada(0, "hola"))).status).toBe(409);
  });

  it("tope de cupos: 429 con Retry-After corto (rafaga de la llamada)", async () => {
    const t = await construir({ cupo: false });
    await t.turno(llamada(0, ""));
    const r = await t.turno(llamada(1, "hola"));
    expect(r.status).toBe(429);
    expect(r.retryAfter).toBe("3");
  });

  it("base sin migrar: sin la 191 (o sin la funcion del secreto) responde 503 con fin y la frase de apagado, nunca 500", async () => {
    const sinHilos = await construir();
    sinHilos.hilos.migrada = false;
    const r = await sinHilos.turno(llamada(0, ""));
    expect(r.status).toBe(503);
    expect(r.json).toMatchObject({ fin: true, texto: TEXTO_APAGADO_VOZ });

    const sinFuncion = await construir({ autenticacion: "no_disponible" });
    const r2 = await sinFuncion.turno(llamada(0, ""));
    expect(r2.status).toBe(503);
    expect(r2.json.fin).toBe(true);
  });

  it("dos fallos seguidos del proveedor: deriva a una persona y cierra", async () => {
    const t = await construir();
    t.estado.agente = async () => ({ reply: "Ahorita tenemos un problema técnico, por favor inténtelo de nuevo en un momento.", orderId: null });
    await t.turno(llamada(0, ""));
    expect((await t.turno(llamada(1, "hola"))).json.fin).toBe(false);
    const r = await t.turno(llamada(2, "hola?"));
    expect(r.json.fin).toBe(true);
    expect(String(r.json.texto)).toMatch(/devolverá la llamada/);
  });
});

describe("puertos de produccion del turno de voz (autenticacion contra la base)", () => {
  const ORG = "00000000-0000-0000-0000-0000000a0001";
  const PROP = "00000000-0000-0000-0000-0000000b0001";
  const SIGUIENTE: FakeSessionHandler = { match: /select 1 as siguiente/, respond: () => [{ ok: 1 }] };
  const puertosCon = (handlers: FakeSessionHandler[], env: NodeJS.ProcessEnv = {}) => {
    const sesion = new AbortAwareFakeSession([...handlers, SIGUIENTE]);
    const engine = { withAppSession: (_o: unknown, fn: (db: AbortAwareFakeSession) => Promise<unknown>) => fn(sesion) } as unknown as TenancyEngine;
    return { sesion, puertos: buildVozTurnoPuertos(engine, {} as LlmGateway, buildRestaurantesTurnHandlerForSession, env) };
  };

  it("secreto de una sucursal con la bandera encendida: organizacion y sucursal del secreto", async () => {
    const { puertos } = puertosCon([
      { match: /voz_turno_resolver_secreto/, respond: () => [{ organization_id: ORG, property_id: PROP }] },
      { match: /select cerebro_v2/, respond: () => [{ cerebro_v2: true }] },
    ]);
    expect(await puertos.autenticar(hashVoiceSecret(SECRETO))).toEqual({ estado: "ok", organizationId: ORG, propertyId: PROP, cerebroV2: true });
  });

  it("secreto que no es de ninguna sucursal: no_coincide", async () => {
    const { puertos } = puertosCon([{ match: /voz_turno_resolver_secreto/, respond: () => [] }]);
    expect(await puertos.autenticar(hashVoiceSecret("otro"))).toEqual({ estado: "no_coincide" });
  });

  it("base sin la 191 (funcion inexistente, 42883): no_disponible y la sesion sigue viva", async () => {
    const sinFuncion = Object.assign(new Error("function restaurantes.voz_turno_resolver_secreto(text) does not exist"), { code: "42883" });
    const { puertos, sesion } = puertosCon([{ match: /voz_turno_resolver_secreto/, respond: () => sinFuncion }]);
    expect(await puertos.autenticar(hashVoiceSecret(SECRETO))).toEqual({ estado: "no_disponible" });
    expect(await sesion.query("select 1 as siguiente")).toEqual({ rows: [{ ok: 1 }] });
  });

  it("base sin la 190 (columna cerebro_v2 inexistente): la bandera cuenta como apagada", async () => {
    const sinColumna = Object.assign(new Error("column cerebro_v2 does not exist"), { code: "42703" });
    const { puertos } = puertosCon([
      { match: /voz_turno_resolver_secreto/, respond: () => [{ organization_id: ORG, property_id: PROP }] },
      { match: /select cerebro_v2/, respond: () => sinColumna },
    ]);
    expect(await puertos.autenticar(hashVoiceSecret(SECRETO))).toMatchObject({ estado: "ok", cerebroV2: false });
  });

  it("interruptor VOZ_TURNO_APAGADO", () => {
    expect(puertosCon([], { VOZ_TURNO_APAGADO: "1" }).puertos.apagado()).toBe(true);
    expect(puertosCon([], {}).puertos.apagado()).toBe(false);
  });
});
