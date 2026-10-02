// Panel de agentes (SA-L-08) y bitacora de corridas (SA-L-07): rutas de punta a punta contra los repos en memoria.
// La autorizacion real en SQL se verifica en scripts/verify-superadmin-agentes/ (Postgres real).
import { describe, expect, it } from "vitest";
import { InMemoryAgentRunRepository, InMemorySaludRepository } from "@atiende/db";
import type { AgentPanelRow, AgentRunRow } from "@atiende/db";
import { buildApp } from "../src/app.ts";
import { jsonRequestInit } from "./fixtures.ts";
import { bearer, seguridadSetup } from "./superadmin-seguridad-fixtures.ts";

const MOTIVO = "Corte preventivo del agente por incidente verificado en produccion.";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const cuerpo = async (res: Response): Promise<any> => res.json();

function fila(id: string, parche: Partial<AgentPanelRow> = {}): AgentPanelRow {
  return {
    id,
    nombre: `Agente ${id}`,
    vertical: id.split(":")[0]!,
    canal: "whatsapp",
    disparador: "Mensaje entrante",
    modeloRol: id,
    presupuestoDiaMicroUsd: null,
    estado: "vivo",
    ultimaCorridaEn: null,
    ultimaCorridaEstado: null,
    corridas30d: 0,
    corridasOk30d: 0,
    llamadas30d: 0,
    costo30dMicroUsd: 0,
    ...parche,
  };
}

function corrida(parche: Partial<AgentRunRow> = {}): AgentRunRow {
  return {
    id: "r1",
    agente: "restaurantes:whatsapp_agent",
    vertical: "restaurantes",
    organizationId: null,
    disparo: "whatsapp",
    estado: "ok",
    tareasHechas: null,
    tareasTotal: null,
    costoMicroUsd: null,
    error: null,
    iniciadoEn: "2026-10-01T10:00:00.000Z",
    terminadoEn: "2026-10-01T10:00:02.000Z",
    duracionMs: 2000,
    ...parche,
  };
}

async function setup(opciones: { repo?: InMemoryAgentRunRepository | null; sinSwitches?: boolean } = {}) {
  const s = await seguridadSetup();
  const repo = opciones.repo === undefined ? new InMemoryAgentRunRepository() : opciones.repo;
  const deps = { ...s.deps, ...(repo ? { agentRunRepo: () => repo } : {}), ...(opciones.sinSwitches ? { platformSwitchRepo: undefined } : {}) };
  const app = buildApp(deps);
  return {
    s,
    repo,
    app,
    async superadmin() {
      const sa = await s.superadmin();
      repo?.seedSuperadmin(sa.id);
      (deps.saludRepo as InMemorySaludRepository).addPlatformSuperadmin(sa.id);
      return sa;
    },
  };
}
const get = (app: ReturnType<typeof buildApp>, path: string, token: string) => app.request(path, { headers: bearer(token) });

describe("GET /superadmin/agentes", () => {
  it("sin sesion 401 y un staff normal (no superadmin) 403 en ambas rutas", async () => {
    const t = await setup();
    const st = await t.s.staff();
    expect((await t.app.request("/superadmin/agentes")).status).toBe(401);
    expect((await get(t.app, "/superadmin/agentes", st.token)).status).toBe(403);
    expect((await get(t.app, "/superadmin/agentes/corridas", st.token)).status).toBe(403);
  });

  it("base sin migrar: 200 con disponible:false, lista vacia y la razon (nunca 500)", async () => {
    const t = await setup(); // sin sembrar el panel = no_migrado
    const sa = await t.superadmin();
    const res = await get(t.app, "/superadmin/agentes", sa.token);
    expect(res.status).toBe(200);
    const b = await cuerpo(res);
    expect(b).toMatchObject({ disponible: false, agentes: [] });
    expect(b.razon).toContain("0044_superadmin_corridas_y_panel_agentes");
  });

  it("sin repositorio configurado tambien responde 200 con disponible:false", async () => {
    const t = await setup({ repo: null });
    const sa = await t.superadmin();
    const res = await get(t.app, "/superadmin/agentes", sa.token);
    expect(res.status).toBe(200);
    expect(await cuerpo(res)).toMatchObject({ disponible: false, agentes: [] });
  });

  it("un error de lectura (no de migracion) tambien es 200 disponible:false con otra razon", async () => {
    const t = await setup();
    t.repo!.seedPanel({ ok: false, razon: "error" });
    const sa = await t.superadmin();
    const b = await cuerpo(await get(t.app, "/superadmin/agentes", sa.token));
    expect(b.disponible).toBe(false);
    expect(b.razon).not.toContain("0044");
  });

  it("exito y costo de 30 dias cuadran con las fuentes sembradas; sin corridas el exito es null (no 0 %)", async () => {
    const t = await setup();
    t.repo!.seedPanel({
      ok: true,
      data: [
        fila("restaurantes:whatsapp_agent", { corridas30d: 3, corridasOk30d: 2, costo30dMicroUsd: 20_000, llamadas30d: 2, ultimaCorridaEn: "2026-10-01T10:00:00.000Z", ultimaCorridaEstado: "fallo", presupuestoDiaMicroUsd: 5_000_000 }),
        fila("citas:data_chat", { canal: "panel" }),
      ],
    });
    const sa = await t.superadmin();
    const b = await cuerpo(await get(t.app, "/superadmin/agentes", sa.token));
    expect(b.disponible).toBe(true);
    const a = b.agentes.find((x: { id: string }) => x.id === "restaurantes:whatsapp_agent");
    expect(a).toMatchObject({
      exito30d: { corridas: 3, ok: 2, porcentaje: 66.7 },
      costo30dUsd: 0.02,
      llamadas30d: 2,
      presupuestoDiaUsd: 5,
      ultimaCorrida: { en: "2026-10-01T10:00:00.000Z", estado: "fallo" },
      insumos: "fuera de alcance",
    });
    const vacio = b.agentes.find((x: { id: string }) => x.id === "citas:data_chat");
    expect(vacio).toMatchObject({ exito30d: { corridas: 0, ok: 0, porcentaje: null }, costo30dUsd: 0, ultimaCorrida: null, presupuestoDiaUsd: null });
  });

  it("el modelo sale de la ruta vigente del rol (no de un texto fijo): el rol sin ruta propia cae al perfil economico", async () => {
    const t = await setup();
    t.repo!.seedPanel({ ok: true, data: [fila("restaurantes:whatsapp_agent")] });
    const sa = await t.superadmin();
    const modelo = (await cuerpo(await get(t.app, "/superadmin/agentes", sa.token))).agentes[0].modelo;
    expect(typeof modelo).toBe("string");
    expect(modelo).toMatch(/^[a-z0-9.-]+\/[A-Za-z0-9._:-]+$/);
  });

  it("la palanca refleja el estado REAL de platform_switch: bloqueado con su motivo, y el resto libre", async () => {
    const t = await setup();
    t.repo!.seedPanel({ ok: true, data: [fila("restaurantes:whatsapp_agent"), fila("hoteles:whatsapp_agent")] });
    const sa = await t.superadmin();
    const antes = await cuerpo(await get(t.app, "/superadmin/agentes", sa.token));
    expect(antes.interruptoresDisponible).toBe(true);
    expect(antes.agentes.map((a: { interruptor: unknown }) => a.interruptor)).toEqual([
      { bloqueado: false, motivo: null, actualizadoEnMs: null },
      { bloqueado: false, motivo: null, actualizadoEnMs: null },
    ]);

    const put = await t.app.request("/superadmin/interruptores", { ...jsonRequestInit({ scope: "agente", target: "restaurantes:whatsapp_agent", bloqueado: true, motivo: MOTIVO }, bearer(sa.token)), method: "PUT" });
    expect(put.status).toBe(200);

    const despues = await cuerpo(await get(t.app, "/superadmin/agentes", sa.token));
    const r = despues.agentes.find((a: { id: string }) => a.id === "restaurantes:whatsapp_agent");
    const h = despues.agentes.find((a: { id: string }) => a.id === "hoteles:whatsapp_agent");
    expect(r.interruptor).toMatchObject({ bloqueado: true, motivo: MOTIVO });
    expect(h.interruptor.bloqueado).toBe(false);
  });

  it("apagar un agente SIN motivo (o con motivo corto) no ejecuta: el panel sigue mostrando el interruptor libre", async () => {
    const t = await setup();
    t.repo!.seedPanel({ ok: true, data: [fila("restaurantes:whatsapp_agent")] });
    const sa = await t.superadmin();
    for (const motivo of [undefined, "", "corto"]) {
      const res = await t.app.request("/superadmin/interruptores", { ...jsonRequestInit({ scope: "agente", target: "restaurantes:whatsapp_agent", bloqueado: true, ...(motivo === undefined ? {} : { motivo }) }, bearer(sa.token)), method: "PUT" });
      expect(res.status).toBe(400);
    }
    const b = await cuerpo(await get(t.app, "/superadmin/agentes", sa.token));
    expect(b.agentes[0].interruptor.bloqueado).toBe(false);
  });

  it("sin repositorio de interruptores el interruptor es null (no 'libre' por omision) y el panel sigue", async () => {
    const t = await setup({ sinSwitches: true });
    t.repo!.seedPanel({ ok: true, data: [fila("restaurantes:whatsapp_agent")] });
    const sa = await t.superadmin();
    const b = await cuerpo(await get(t.app, "/superadmin/agentes", sa.token));
    expect(b).toMatchObject({ disponible: true, interruptoresDisponible: false });
    expect(b.agentes[0].interruptor).toBeNull();
  });
});

describe("GET /superadmin/agentes/corridas", () => {
  it("lista las corridas, serializa costo en USD y conserva el error redactado y la duracion", async () => {
    const t = await setup();
    t.repo!.seedCorridas({ ok: true, data: [corrida({ estado: "fallo", error: "timeout del proveedor", costoMicroUsd: 1_500_000, tareasHechas: 3, tareasTotal: 4 })] });
    const sa = await t.superadmin();
    const res = await get(t.app, "/superadmin/agentes/corridas", sa.token);
    expect(res.status).toBe(200);
    const b = await cuerpo(res);
    expect(b.disponible).toBe(true);
    expect(b.corridas[0]).toMatchObject({ estado: "fallo", error: "timeout del proveedor", costoUsd: 1.5, tareasHechas: 3, tareasTotal: 4, duracionMs: 2000 });
  });

  it("pasa los filtros validados al repositorio y el limite por defecto es 50", async () => {
    const t = await setup();
    t.repo!.seedCorridas({ ok: true, data: [] });
    const sa = await t.superadmin();
    await get(t.app, "/superadmin/agentes/corridas?agente=hoteles:whatsapp_agent&vertical=hoteles&estado=fallo&limite=10", sa.token);
    await get(t.app, "/superadmin/agentes/corridas", sa.token);
    expect(t.repo!.llamadasListar[0]).toMatchObject({ agente: "hoteles:whatsapp_agent", vertical: "hoteles", estado: "fallo", limite: 10 });
    expect(t.repo!.llamadasListar[1]).toMatchObject({ agente: null, vertical: null, estado: null, limite: 50 });
  });

  it("rechaza filtros invalidos con 400 (estado desconocido, limite fuera de rango, vertical o agente con caracteres raros)", async () => {
    const t = await setup();
    const sa = await t.superadmin();
    for (const q of ["estado=roto", "limite=0", "limite=201", "limite=abc", "vertical=Hoteles;drop", "agente=a b", "agente=x"]) {
      expect((await get(t.app, `/superadmin/agentes/corridas?${q}`, sa.token)).status, q).toBe(400);
    }
    expect(t.repo!.llamadasListar).toHaveLength(0);
  });

  it("base sin migrar: 200 con disponible:false y lista vacia", async () => {
    const t = await setup();
    t.repo!.sinMigrar = true;
    const sa = await t.superadmin();
    const res = await get(t.app, "/superadmin/agentes/corridas", sa.token);
    expect(res.status).toBe(200);
    expect(await cuerpo(res)).toMatchObject({ disponible: false, corridas: [] });
  });

  it("sin repositorio configurado: 200 con disponible:false", async () => {
    const t = await setup({ repo: null });
    const sa = await t.superadmin();
    expect(await cuerpo(await get(t.app, "/superadmin/agentes/corridas", sa.token))).toMatchObject({ disponible: false, corridas: [] });
  });
});
