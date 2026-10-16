// REGLA DURA de compatibilidad con la base SIN migrar (migración 055): el repositorio corre dentro de la transaccion unica del request y del turno
// de WhatsApp. `AbortAwareFakeSession` reproduce el estado abortado de Postgres (25P02): cada caso verifica el vacio honesto / el error correcto Y que
// la MISMA sesion sigue viva para la consulta siguiente.
import { describe, expect, it } from "vitest";
import { AJUSTES_AGENTE_POR_DEFECTO, AjustesNoDisponiblesError, AjustesRechazadosError, InMemoryAjustesAgenteRepository, PostgresAjustesAgenteRepository } from "../src/index.ts";
import { AbortAwareFakeSession, type FakeSessionHandler } from "./support/aborting-fake-session.ts";

const ORG = "00000000-0000-4000-8000-0000000000b1";
const ACTOR = "00000000-0000-4000-8000-0000000000d1";
const SIGUIENTE: FakeSessionHandler = { match: /select 1 as siguiente_query_del_request/, respond: () => [{ ok: true }] };

function pgError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}
async function sesionSigueViva(session: AbortAwareFakeSession) {
  await expect(session.query("select 1 as siguiente_query_del_request;")).resolves.toEqual({ rows: [{ ok: true }] });
  expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
}

const FILA = {
  whatsapp_model: "google/gemini-2.5-flash-lite",
  whatsapp_temperature: "0.30",
  voice_cascade_model: null,
  voice_temperature: null,
  voice_pace: "pausado",
  voice_style: "calido",
  voice_background: true,
  voice_background_volume: 9,
  updated_at: new Date("2026-10-04T10:00:00Z"),
};

describe("lectura", () => {
  it("base sin migrar (42P01): vacio honesto con los valores de siempre y la sesion sigue viva", async () => {
    const s = new AbortAwareFakeSession([{ match: /from restaurantes\.agent_runtime_settings/i, respond: () => pgError("42P01", 'relation "restaurantes.agent_runtime_settings" does not exist') }, SIGUIENTE]);
    expect(await new PostgresAjustesAgenteRepository(s).leer(ORG)).toEqual({ disponible: false, configurados: false, valor: AJUSTES_AGENTE_POR_DEFECTO, actualizadoEn: null, ambienteDisponible: false });
    await sesionSigueViva(s);
  });

  it("columna inexistente (42703) tambien degrada; un error real se repropaga y la sesion sigue viva", async () => {
    const s1 = new AbortAwareFakeSession([{ match: /agent_runtime_settings/i, respond: () => pgError("42703", "column does not exist") }, SIGUIENTE]);
    expect((await new PostgresAjustesAgenteRepository(s1).leer(ORG)).disponible).toBe(false);
    const s2 = new AbortAwareFakeSession([{ match: /agent_runtime_settings/i, respond: () => pgError("57014", "statement timeout") }, SIGUIENTE]);
    await expect(new PostgresAjustesAgenteRepository(s2).leer(ORG)).rejects.toMatchObject({ code: "57014" });
    await sesionSigueViva(s2);
  });

  it("sin fila: disponible pero no configurados (valores por omision); con fila: la mapea (numeric llega como texto)", async () => {
    const vacia = new AbortAwareFakeSession([{ match: /agent_runtime_settings/i, respond: () => [] }]);
    expect(await new PostgresAjustesAgenteRepository(vacia).leer(ORG)).toMatchObject({ disponible: true, configurados: false, valor: AJUSTES_AGENTE_POR_DEFECTO });
    const con = new AbortAwareFakeSession([{ match: /agent_runtime_settings/i, respond: () => [FILA] }]);
    const l = await new PostgresAjustesAgenteRepository(con).leer(ORG);
    expect(l).toMatchObject({ disponible: true, configurados: true, actualizadoEn: "2026-10-04T10:00:00.000Z" });
    expect(l.valor).toEqual({ whatsappModelo: "google/gemini-2.5-flash-lite", whatsappTemperatura: 0.3, vozModeloCascada: null, vozTemperatura: null, vozRitmo: "pausado", vozEstilo: "calido", vozFondoActivo: true, vozFondoVolumen: 9, vozFondoPreset: "cocina-taqueria", vozTecleoActivo: false, vozTecleoVolumen: 12, vozHumanizar: false });
  });

  it("una fila con ritmo/estilo fuera de la lista (escrita directo en la base) cae al valor por omision, no rompe", async () => {
    const s = new AbortAwareFakeSession([{ match: /agent_runtime_settings/i, respond: () => [{ ...FILA, voice_pace: "ultrarapido", voice_style: "gritado" }] }]);
    const l = await new PostgresAjustesAgenteRepository(s).leer(ORG);
    expect(l.valor.vozRitmo).toBe("normal");
    expect(l.valor.vozEstilo).toBe("neutro");
  });
});

describe("lectura con la 055 pero SIN la 087 (columnas de ambiente/tecleo inexistentes)", () => {
  const SIN_087 = { match: /voice_typing/i, respond: () => pgError("42703", 'column "voice_typing" does not exist') };

  it("lee los ajustes de siempre con la consulta anterior, marca ambienteDisponible=false y la sesion sigue viva", async () => {
    const s = new AbortAwareFakeSession([SIN_087, { match: /from restaurantes\.agent_runtime_settings/i, respond: () => [FILA] }, SIGUIENTE]);
    const l = await new PostgresAjustesAgenteRepository(s).leer(ORG);
    expect(l).toMatchObject({ disponible: true, configurados: true, ambienteDisponible: false });
    expect(l.valor).toMatchObject({ vozRitmo: "pausado", vozFondoVolumen: 9, vozTecleoActivo: false, vozHumanizar: false });
    await sesionSigueViva(s);
  });

  it("con la 087 aplicada lee todo y ambienteDisponible=true", async () => {
    const s = new AbortAwareFakeSession([{ match: /agent_runtime_settings/i, respond: () => [{ ...FILA, voice_background_preset: "calle-ocupada", voice_typing: true, voice_typing_volume: 15, voice_humanize: true }] }]);
    const l = await new PostgresAjustesAgenteRepository(s).leer(ORG);
    expect(l.ambienteDisponible).toBe(true);
    expect(l.valor).toMatchObject({ vozFondoPreset: "calle-ocupada", vozTecleoActivo: true, vozTecleoVolumen: 15, vozHumanizar: true });
  });

  it("escritura sin la 087: lo de siempre se guarda con la consulta anterior; si se pide lo nuevo, 503 honesto y NADA se pierde en silencio", async () => {
    const solo = { ...AJUSTES_AGENTE_POR_DEFECTO, whatsappModelo: "google/gemini-2.5-flash-lite", whatsappTemperatura: 0.3 };
    const s = new AbortAwareFakeSession([SIN_087, { match: /insert into restaurantes\.agent_runtime_settings/i, respond: () => [FILA] }, SIGUIENTE]);
    const l = await new PostgresAjustesAgenteRepository(s).guardar(ORG, ACTOR, solo);
    expect(l).toMatchObject({ configurados: true, ambienteDisponible: false });
    expect(l.valor.whatsappModelo).toBe("google/gemini-2.5-flash-lite");
    await sesionSigueViva(s);
    const s2 = new AbortAwareFakeSession([SIN_087, SIGUIENTE]);
    await expect(new PostgresAjustesAgenteRepository(s2).guardar(ORG, ACTOR, { ...solo, vozTecleoActivo: true })).rejects.toThrow(/migración 087/);
    await sesionSigueViva(s2);
  });
});

describe("escritura", () => {
  const ajustes = { ...AJUSTES_AGENTE_POR_DEFECTO, whatsappModelo: "google/gemini-2.5-flash-lite", whatsappTemperatura: 0.3 };

  it("base sin migrar: AjustesNoDisponiblesError (503 honesto) y la sesion sigue viva", async () => {
    const s = new AbortAwareFakeSession([{ match: /insert into restaurantes\.agent_runtime_settings/i, respond: () => pgError("42P01", "relation does not exist") }, SIGUIENTE]);
    await expect(new PostgresAjustesAgenteRepository(s).guardar(ORG, ACTOR, ajustes)).rejects.toBeInstanceOf(AjustesNoDisponiblesError);
    await sesionSigueViva(s);
  });

  it("RLS niega la escritura (42501): AjustesRechazadosError y la sesion sigue viva; un error desconocido se repropaga", async () => {
    const s = new AbortAwareFakeSession([{ match: /insert into restaurantes\.agent_runtime_settings/i, respond: () => pgError("42501", "new row violates row-level security policy") }, SIGUIENTE]);
    await expect(new PostgresAjustesAgenteRepository(s).guardar(ORG, ACTOR, ajustes)).rejects.toBeInstanceOf(AjustesRechazadosError);
    await sesionSigueViva(s);
    const s2 = new AbortAwareFakeSession([{ match: /insert into restaurantes\.agent_runtime_settings/i, respond: () => pgError("23514", "check violation") }, SIGUIENTE]);
    await expect(new PostgresAjustesAgenteRepository(s2).guardar(ORG, ACTOR, ajustes)).rejects.toMatchObject({ code: "23514" });
    await sesionSigueViva(s2);
  });

  it("exito: devuelve lo guardado mapeado", async () => {
    const s = new AbortAwareFakeSession([{ match: /insert into restaurantes\.agent_runtime_settings/i, respond: () => [FILA] }]);
    const l = await new PostgresAjustesAgenteRepository(s).guardar(ORG, ACTOR, ajustes);
    expect(l.configurados).toBe(true);
    expect(l.valor.whatsappModelo).toBe("google/gemini-2.5-flash-lite");
  });
});

describe("adaptador en memoria (doble de las pruebas de rutas)", () => {
  it("reproduce sin migrar, rechazo y guardado", async () => {
    const m = new InMemoryAjustesAgenteRepository();
    expect((await m.leer(ORG)).configurados).toBe(false);
    await m.guardar(ORG, ACTOR, AJUSTES_AGENTE_POR_DEFECTO);
    expect((await m.leer(ORG)).configurados).toBe(true);
    m.rechazar = true;
    await expect(m.guardar(ORG, ACTOR, AJUSTES_AGENTE_POR_DEFECTO)).rejects.toBeInstanceOf(AjustesRechazadosError);
    m.migrada = false;
    expect((await m.leer(ORG)).disponible).toBe(false);
    await expect(m.guardar(ORG, ACTOR, AJUSTES_AGENTE_POR_DEFECTO)).rejects.toBeInstanceOf(AjustesNoDisponiblesError);
  });
});
