// Turno de voz del cerebro v2: funciones puras del texto para TTS (port de canal-voz.ts / voz-turno.ts del repo suelto), repositorio Postgres de hilos
// contra la base sin la 191 (SAVEPOINT real con AbortAwareFakeSession) y el adaptador de voz sobre el gateway y el repositorio del turno de WhatsApp.
import { describe, expect, it } from "vitest";
import type { LlmGateway } from "@atiende/agent-core";
import {
  AVISO_VOZ_INICIAL,
  BLOQUE_CANAL_VOZ,
  DEVOLUCION_OFRECIDA_VOZ,
  esDespedidaDelCliente,
  esSilencioVoz,
  gatewayDeVoz,
  limpiarParaVoz,
  modeloDeVoz,
  montoEnPalabras,
  numeroEnPalabras,
  PostgresHilosVozRepository,
  preciosEnPalabras,
  prometeTransferenciaVoz,
  quitarTransferenciaVoz,
  recortarRespuestaVoz,
  repoDeVoz,
  respuestaParaVoz,
  saludoVoz,
  TEXTO_REPETIR,
  validarEntradaVoz,
  VozTurnoInvalidoError,
  VozTurnoNoDisponibleError,
} from "../src/voz/cerebro-v2-voz/index.ts";
import type { NewOrderRecord, RestaurantesRepository } from "../src/repository.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

describe("texto para voz (puro)", () => {
  it("numeros y montos en palabras, con apocope ante pesos", () => {
    expect(numeroEnPalabras(126)).toBe("ciento veintiséis");
    expect(numeroEnPalabras(1250)).toBe("mil doscientos cincuenta");
    expect(numeroEnPalabras(21_000)).toBe("veintiún mil");
    expect(numeroEnPalabras(100)).toBe("cien");
    expect(montoEnPalabras(21)).toBe("veintiún pesos");
    expect(montoEnPalabras(1)).toBe("un peso");
    expect(montoEnPalabras(180.5)).toBe("ciento ochenta pesos con cincuenta centavos");
  });

  it("solo los montos de dinero pasan a palabras; cantidades, horas y minutos se quedan", () => {
    expect(preciosEnPalabras("Son $1,250.00 en total")).toBe("Son mil doscientos cincuenta pesos en total");
    expect(preciosEnPalabras("El total es 180 pesos")).toBe("El total es ciento ochenta pesos");
    expect(preciosEnPalabras("$95 MXN")).toBe("noventa y cinco pesos");
    expect(preciosEnPalabras("2 órdenes, listas en 25 minutos a las 8")).toBe("2 órdenes, listas en 25 minutos a las 8");
  });

  it("limpiarParaVoz quita emojis, markdown, vinetas, enlaces y saltos de linea", () => {
    expect(limpiarParaVoz("**Claro** 😊\n- Pastor: $25\n- Bistec: $30\nMenú: https://ejemplo.mx/menu")).toBe("Claro. Pastor: veinticinco pesos. Bistec: treinta pesos. Menú:");
  });

  it("silencio y despedida: solo la marca exacta y la frase completa", () => {
    expect(esSilencioVoz("[silencio]")).toBe(true);
    expect(esSilencioVoz(" [Silencio] ")).toBe(true);
    expect(esSilencioVoz("silencio")).toBe(false);
    expect(esDespedidaDelCliente("No, gracias. Es todo.")).toBe(true);
    expect(esDespedidaDelCliente("bye")).toBe(true);
    expect(esDespedidaDelCliente("es todo lo de pastor y una coca")).toBe(false);
  });

  it("sin transferencia en vivo: la promesa se cambia por la devolucion de llamada y se conserva el resto", () => {
    expect(prometeTransferenciaVoz("Un momento, le paso con el gerente.")).toBe(true);
    expect(prometeTransferenciaVoz("Lo pongo en espera.")).toBe(true);
    expect(prometeTransferenciaVoz("Le paso su total: son 250 pesos.")).toBe(false);
    expect(prometeTransferenciaVoz("Con gusto le ayudo con su pedido.")).toBe(false);
    expect(quitarTransferenciaVoz("Su total es de 250 pesos. Le comunico con la sucursal. No cuelgue.")).toBe(`Su total es de 250 pesos. ${DEVOLUCION_OFRECIDA_VOZ}`);
  });

  it("recorta solo cortesia pura de un turno largo; nunca la frase con dinero ni la confirmacion de un pedido creado", () => {
    const largo = `Perfecto. ¡Con gusto! ${"La orden de pastor trae cinco tacos con su salsa. ".repeat(4)}Son 180 pesos. ¿Lo confirma?`;
    const r = recortarRespuestaVoz(largo);
    expect(r.startsWith("La orden")).toBe(true);
    expect(r).toMatch(/180 pesos\. ¿Lo confirma\?$/);
    expect(recortarRespuestaVoz(largo, { pedidoCreado: true })).toBe(largo);
    expect(respuestaParaVoz("😊")).toBe(TEXTO_REPETIR);
  });

  it("saludo por hora local con el aviso de grabacion; corto con aviso_dado", () => {
    const noche = saludoVoz({ ahora: new Date("2026-11-07T02:00:00Z"), zonaHoraria: "America/Merida", nombreNegocio: "Los Taquitos de PM" });
    expect(noche).toBe(`Buenas noches, le atiende el asistente virtual de Los Taquitos de PM. ${AVISO_VOZ_INICIAL} ¿En qué le puedo ayudar?`);
    expect(saludoVoz({ ahora: new Date("2026-11-06T15:00:00Z"), zonaHoraria: "America/Merida", nombreNegocio: null })).toMatch(/^Buenos días, le atiende el asistente virtual\. /);
    expect(saludoVoz({ ahora: new Date(), zonaHoraria: "America/Merida", nombreNegocio: "X", avisoDado: true })).toBe("Gracias. ¿En qué le puedo ayudar?");
  });

  it("validarEntradaVoz: canoniza el telefono (+52) y aviso_dado solo cuenta en la apertura", () => {
    expect(validarEntradaVoz({ call_id: "CA-1234567", telefono: "+52 999 123 4567", seq: 0, texto: "", aviso_dado: true })).toEqual({ callId: "CA-1234567", telefono: "9991234567", texto: "", seq: 0, avisoDado: true });
    expect(validarEntradaVoz({ call_id: "CA-1234567", telefono: "9991234567", seq: 3, texto: "hola", aviso_dado: true }).avisoDado).toBe(false);
    expect(() => validarEntradaVoz({ call_id: "CA-1234567", telefono: "9991234567", seq: -1, texto: "" })).toThrow(VozTurnoInvalidoError);
    expect(() => validarEntradaVoz({ call_id: "CA 1234567", telefono: "9991234567", seq: 1, texto: "" })).toThrow(VozTurnoInvalidoError);
    expect(() => validarEntradaVoz({ call_id: "CA-1234567", telefono: "9991234567", seq: 1, texto: "x", aviso_dado: "si" })).toThrow(VozTurnoInvalidoError);
  });

  it("modelo de voz: Luna por omision, Flash-Lite con «rapido», Haiku con «respaldo»", () => {
    expect(modeloDeVoz(undefined)).toBe("openai/gpt-6-luna");
    expect(modeloDeVoz("rapido")).toBe("google/gemini-3.5-flash-lite");
    expect(modeloDeVoz("respaldo")).toBe("anthropic/claude-haiku-5.5");
  });
});

describe("PostgresHilosVozRepository contra la base sin la 191", () => {
  it("42P01 -> VozTurnoNoDisponibleError y la MISMA sesion sigue viva (SAVEPOINT real)", async () => {
    const sinTabla = Object.assign(new Error('relation "restaurantes.voz_turno_hilo" does not exist'), { code: "42P01" });
    const s = new AbortAwareFakeSession([
      { match: /voz_turno_hilo/, respond: () => sinTabla },
      { match: /select 1 as siguiente/, respond: () => [{ ok: 1 }] },
    ]);
    const repo = new PostgresHilosVozRepository(s);
    await expect(repo.leer("org", "llamada-1")).rejects.toBeInstanceOf(VozTurnoNoDisponibleError);
    expect(await s.query("select 1 as siguiente")).toEqual({ rows: [{ ok: 1 }] });
    expect(s.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
  });

  it("un error que no es de base sin migrar se propaga tal cual", async () => {
    const otro = Object.assign(new Error("deadlock"), { code: "40P01" });
    const repo = new PostgresHilosVozRepository(new AbortAwareFakeSession([{ match: /voz_turno_hilo/, respond: () => otro }]));
    await expect(repo.leer("org", "llamada-1")).rejects.toBe(otro);
  });

  it("lee la fila y la convierte (mensajes validos, respuesta, marca en proceso)", async () => {
    const s = new AbortAwareFakeSession([
      {
        match: /from restaurantes\.voz_turno_hilo/,
        respond: () => [
          {
            organization_id: "org", call_id: "llamada-1", property_id: "p1", telefono: "9991234567",
            mensajes: [{ role: "assistant", content: "Hola" }, { role: "tool", content: "x" }, { role: "user", content: "pastor" }],
            pedido_id: null, turnos: 1, seq_ultimo: 1, respuesta_ultima: { texto: "Hola", pedido_id: null, fin: false, turno: 1 }, version: 3,
            fallos_seguidos: 0, en_proceso_seq: 2, en_proceso_desde: "2026-11-06T10:00:00.000Z",
          },
        ],
      },
    ]);
    const h = await new PostgresHilosVozRepository(s).leer("org", "llamada-1");
    expect(h).toMatchObject({ telefono: "9991234567", turnos: 1, seqUltimo: 1, version: 3, enProcesoSeq: 2, respuestaUltima: { texto: "Hola", turno: 1 } });
    expect(h!.mensajes.map((m) => m.role)).toEqual(["assistant", "user"]);
    expect(h!.enProcesoDesde!.toISOString()).toBe("2026-11-06T10:00:00.000Z");
  });
});

describe("adaptador de voz sobre el turno de WhatsApp", () => {
  it("gatewayDeVoz agrega el bloque de la llamada al final del sistema y exige ZDR, sin tocar el gateway original", async () => {
    const vistas: unknown[] = [];
    const base = { complete: async (o: unknown) => (vistas.push(o), { text: "ok" }) } as unknown as LlmGateway;
    const voz = gatewayDeVoz(base);
    await voz.complete({ tenantId: "org", runId: "r", lane: "interactive", role: "restaurantes:whatsapp_agent", preferredModel: "anthropic/claude-haiku-5.5", request: { system: "PROMPT BASE", messages: [] } } as never);
    expect(vistas[0]).toMatchObject({ zdrEstricto: true, preferredModel: "anthropic/claude-haiku-5.5", request: { system: `PROMPT BASE\n\n${BLOQUE_CANAL_VOZ}` } });
    await base.complete({ request: { system: "SOLO" } } as never);
    expect(vistas[1]).toEqual({ request: { system: "SOLO" } });
  });

  it("repoDeVoz: pedido con source voice, flujo con la llave de la llamada, contadores sin escribir; lo demas pasa tal cual", async () => {
    const llamadas: Array<[string, unknown[]]> = [];
    const base = {
      createOrderIdempotent: async (...a: unknown[]) => (llamadas.push(["create", a]), { id: "o1" }),
      readOrderFlow: async (...a: unknown[]) => (llamadas.push(["read", a]), null),
      writeOrderFlow: async (...a: unknown[]) => (llamadas.push(["write", a]), { status: "ok" }),
      contadorAgenteWhatsApp: async () => {
        throw new Error("no debe llamarse");
      },
      nombre: "real",
      findBranchById(this: { nombre: string }) {
        return this.nombre;
      },
    } as unknown as RestaurantesRepository;
    const repo = repoDeVoz(base, { telefono: "9991234567", callId: "CA-1234567" });
    await repo.createOrderIdempotent({ source: "whatsapp", total: 100 } as unknown as NewOrderRecord, "huella", null);
    await repo.readOrderFlow("org", "wa:9991234567");
    await repo.readOrderFlow("org", "wa:9990000000");
    await repo.writeOrderFlow("org", "wa:9991234567", 0, { state: "cotizado", context: {} } as never, 60);
    expect(await repo.contadorAgenteWhatsApp("org", "9991234567", "no_entendi" as never, "incrementar")).toBeNull();
    expect(llamadas).toEqual([
      ["create", [{ source: "voice", total: 100 }, "huella", null]],
      ["read", ["org", "call:CA-1234567"]],
      ["read", ["org", "wa:9990000000"]],
      ["write", ["org", "call:CA-1234567", 0, { state: "cotizado", context: {} }, 60]],
    ]);
    expect((repo as unknown as { findBranchById: () => string }).findBranchById()).toBe("real");
  });
});
