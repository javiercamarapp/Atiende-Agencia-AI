// Copiloto de superadmin multi-negocio (seguimiento de CHAT-17): lecturas POR ORGANIZACION (operaciones_organizacion, ranking_actividad,
// agentes_organizacion). Cubre: alcance (una organizacion resuelta por id, nunca adivinada), organizaciones SIN actividad con 0, bitacora por
// organizacion ANTES de leer (falla cerrado), ausencia de datos personales, rol finanzas sin las herramientas y compatibilidad con la base sin
// migrar (estado abortado de Postgres: AbortAwareFakeSession). El SQL real lo prueba scripts/verify-copiloto-multi-negocio.
import { describe, expect, it } from "vitest";
import { parseArgs, type DataChatToolResult } from "@atiende/agent-core/data-chat";
import { AbortAwareFakeSession } from "../../../packages/db/tests/support/aborting-fake-session.ts";
import type { AppDeps } from "../src/deps.ts";
import { buildCatalogoPlataforma } from "../src/superadmin-copiloto/catalogo.ts";
import { fuentesDeProduccion, type FuentesPlataforma } from "../src/superadmin-copiloto/fuentes.ts";
import { SCOPE_FINANZAS, SCOPE_SUPERADMIN, ctxHerramienta, fuentesFalsas, ok, volcado } from "./superadmin-copiloto-fixtures.ts";

async function correr(f: FuentesPlataforma, nombre: string, args: Record<string, unknown> = {}): Promise<DataChatToolResult> {
  const t = buildCatalogoPlataforma(f, SCOPE_SUPERADMIN).tools.find((x) => x.name === nombre);
  if (!t) throw new Error(`herramienta ${nombre} no existe`);
  const parsed = parseArgs(t.params, args);
  if (!parsed.ok) throw new Error(`argumentos invalidos: ${parsed.error}`);
  return t.run(ctxHerramienta(SCOPE_SUPERADMIN), parsed.value);
}

const valores = (r: DataChatToolResult): Record<string, number> => Object.fromEntries(r.rows.map((x) => [String((x as Record<string, unknown>)["metrica"]), Number((x as Record<string, unknown>)["valor"])]));

describe("operaciones_organizacion", () => {
  it("resuelve la organizacion por nombre, deja UNA fila de bitacora con su id y devuelve las cifras de su vertical", async () => {
    const f = fuentesFalsas();
    const r = await correr(f, "operaciones_organizacion", { organizacion: "Taquería Don Beto", periodo: "este_mes" });
    expect(r.status).toBe("ok");
    expect(f.accesosOrg).toEqual([{ ids: ["org-a"], herramienta: "operaciones_organizacion", filtros: expect.objectContaining({ periodo: "este_mes" }) }]);
    expect(f.llamadasOperaciones).toEqual([{ desde: "2026-10-01", hasta: "2026-10-02", hoy: "2026-10-02", organizationId: "org-a" }]);
    expect(valores(r)).toEqual({ "Pedidos (sin cancelados)": 40, "Ventas de esos pedidos (MXN)": 12500.5, "Escalaciones a una persona": 3, "Pedidos abiertos ahora": 2 });
    expect(r.scopeLabel).toContain("Taquería Don Beto");
    expect(r.source).toContain("Taquería Don Beto");
  });

  it("acepta una palabra de vertical y una parte del nombre («hotel Bahía») y usa las etiquetas de hoteles", async () => {
    const f = fuentesFalsas();
    const r = await correr(f, "operaciones_organizacion", { organizacion: "hotel bahia", periodo: "este_mes" });
    expect(r.status).toBe("ok");
    expect(Object.keys(valores(r))).toEqual(["Reservas creadas", "Importe de esas reservas (MXN)", "Estancias vigentes hoy"]);
    expect(f.accesosOrg[0]?.ids).toEqual(["org-b"]);
  });

  it("una organizacion SIN actividad responde con 0 y lo dice (no «sin dato»)", async () => {
    const f = fuentesFalsas();
    const r = await correr(f, "operaciones_organizacion", { organizacion: "Posada Sol", periodo: "este_mes" });
    expect(r.status).toBe("ok");
    expect(valores(r)["Reservas creadas"]).toBe(0);
    expect(r.summary).toContain("Sin actividad en el periodo");
  });

  it("un nombre ambiguo pide aclarar, lista las coincidencias y NO consulta ni registra acceso a ninguna", async () => {
    const f = fuentesFalsas();
    const r = await correr(f, "operaciones_organizacion", { organizacion: "hoteles", periodo: "este_mes" });
    expect(r.status).toBe("needs_clarification");
    expect(r.message).toContain("Hotel Bahía");
    expect(r.message).toContain("Posada Sol");
    expect(f.accesosOrg).toEqual([]);
    expect(f.llamadasOperaciones).toEqual([]);
  });

  it("un nombre que no existe pide aclarar y no consulta nada; sin nombre pregunta de cual organizacion", async () => {
    const f = fuentesFalsas();
    const nada = await correr(f, "operaciones_organizacion", { organizacion: "Cantina Fantasma", periodo: "este_mes" });
    expect(nada.status).toBe("needs_clarification");
    const sinNombre = await correr(f, "operaciones_organizacion", { periodo: "este_mes" });
    expect(sinNombre.status).toBe("needs_clarification");
    expect(sinNombre.message).toContain("¿De qué organización?");
    expect(f.accesosOrg).toEqual([]);
    expect(f.llamadasOperaciones).toEqual([]);
  });

  it("la bitacora se escribe ANTES de leer y, si falla, la consulta no se ejecuta (falla cerrado)", async () => {
    const orden: string[] = [];
    const base = fuentesFalsas();
    const f = fuentesFalsas({
      registrarAccesoOrganizaciones: async () => {
        orden.push("bitacora");
        return "error";
      },
      operacionesPorOrganizacion: async (...a) => {
        orden.push("lectura");
        return base.operacionesPorOrganizacion(...a);
      },
    });
    const r = await correr(f, "operaciones_organizacion", { organizacion: "Taquería Don Beto", periodo: "este_mes" });
    expect(r.status).toBe("unavailable");
    expect(r.message).toContain("no pude registrar la consulta por organización en la bitácora");
    expect(orden).toEqual(["bitacora"]);
    // y en el camino feliz el orden es bitacora -> lectura
    const orden2: string[] = [];
    const g = fuentesFalsas({
      registrarAccesoOrganizaciones: async () => {
        orden2.push("bitacora");
        return "ok";
      },
      operacionesPorOrganizacion: async (...a) => {
        orden2.push("lectura");
        return base.operacionesPorOrganizacion(...a);
      },
    });
    await correr(g, "operaciones_organizacion", { organizacion: "Taquería Don Beto", periodo: "este_mes" });
    expect(orden2).toEqual(["bitacora", "lectura"]);
  });

  it("base sin migrar: la bitacora o la funcion faltantes dan «no tengo el dato», nunca una cifra", async () => {
    const sinBitacora = await correr(fuentesFalsas({ registrarAccesoOrganizaciones: async () => "no_migrado" }), "operaciones_organizacion", { organizacion: "Taquería Don Beto", periodo: "este_mes" });
    expect(sinBitacora.status).toBe("unavailable");
    expect(sinBitacora.message).toContain("No tengo el dato");
    const sinFuncion = await correr(fuentesFalsas({ operacionesPorOrganizacion: async () => ({ ok: false, razon: "no_migrado" }) }), "operaciones_organizacion", { organizacion: "Taquería Don Beto", periodo: "este_mes" });
    expect(sinFuncion.status).toBe("unavailable");
    expect(sinFuncion.rows).toEqual([]);
  });

  it("una vertical sin su actualizacion de datos aplicada se declara, no se muestra como 0", async () => {
    const base = fuentesFalsas();
    const f = fuentesFalsas({
      organizaciones: async () => ok([{ id: "org-d", vertical: "despachos", name: "Despacho Norte", slug: "despacho-norte", status: "active" as const, createdAt: "2026-02-01T10:00:00.000Z", staffCount: 2 }]),
      operacionesPorOrganizacion: base.operacionesPorOrganizacion,
    });
    const r = await correr(f, "operaciones_organizacion", { organizacion: "Despacho Norte", periodo: "este_mes" });
    expect(r.status).toBe("unavailable");
    expect(r.message).toContain("falta aplicar");
  });

  it("no hay datos personales en el resultado: solo etiquetas y cifras", async () => {
    const r = await correr(fuentesFalsas(), "operaciones_organizacion", { organizacion: "Taquería Don Beto", periodo: "este_mes" });
    expect(r.columns.map((c) => c.key)).toEqual(["metrica", "valor"]);
    expect(volcado(r)).not.toMatch(/@|\+52|tel[eé]fono|direcci[oó]n|correo/i);
  });
});

describe("ranking_actividad", () => {
  it("ordena TODAS las organizaciones, incluye las sin actividad con 0 y separa «N organizaciones, M con actividad»", async () => {
    const f = fuentesFalsas();
    const r = await correr(f, "ranking_actividad", { periodo: "este_mes" });
    expect(r.status).toBe("ok");
    expect(r.rows.map((x) => (x as Record<string, unknown>)["organizacion"])).toEqual(["Taquería Don Beto", "Hotel Bahía", "Posada Sol"]);
    expect(r.rows.map((x) => (x as Record<string, unknown>)["valor"])).toEqual([40, 12, 0]);
    expect(r.summary).toContain("3 organizaciones, 2 con actividad");
    expect(f.llamadasOperaciones).toHaveLength(1);
  });

  it("deja una fila de bitacora por organizacion del alcance (todas, o solo las de la vertical pedida)", async () => {
    const f = fuentesFalsas();
    await correr(f, "ranking_actividad", { periodo: "este_mes" });
    expect(f.accesosOrg[0]).toMatchObject({ herramienta: "ranking_actividad", ids: ["org-a", "org-b", "org-c"] });
    const g = fuentesFalsas();
    await correr(g, "ranking_actividad", { periodo: "este_mes", vertical: "hoteles" });
    expect(g.accesosOrg[0]?.ids).toEqual(["org-b", "org-c"]);
  });

  it("las organizaciones cuya vertical no guarda la metrica se cuentan aparte y NO se comparan como 0", async () => {
    const f = fuentesFalsas();
    const r = await correr(f, "ranking_actividad", { periodo: "este_mes", metrica: "escalaciones" });
    expect(r.rows).toHaveLength(1);
    expect((r.rows[0] as Record<string, unknown>)["organizacion"]).toBe("Taquería Don Beto");
    expect(r.summary).toContain("1 organización, 1 con actividad");
    expect(r.summary).toContain("2 organizaciones no guardan ese dato");
  });

  it("ingresos: ordena por MXN entre restaurantes y hoteles y respeta el limite", async () => {
    const r = await correr(fuentesFalsas(), "ranking_actividad", { periodo: "este_mes", metrica: "ingresos", limite: 1 });
    expect(r.rows).toHaveLength(1);
    expect((r.rows[0] as Record<string, unknown>)["organizacion"]).toBe("Hotel Bahía");
    expect(r.columns.find((c) => c.key === "valor")?.kind).toBe("mxn");
  });

  it("una organizacion con la fuente sin migrar no entra al ranking pero se declara", async () => {
    const base = fuentesFalsas();
    const f = fuentesFalsas({
      organizaciones: async () => {
        const r = await base.organizaciones();
        if (!r.ok) return r;
        return ok([...r.data, { id: "org-d", vertical: "despachos", name: "Despacho Norte", slug: "despacho-norte", status: "active" as const, createdAt: "2026-02-01T10:00:00.000Z", staffCount: 2 }]);
      },
    });
    const r = await correr(f, "ranking_actividad", { periodo: "este_mes" });
    expect(r.rows.map((x) => (x as Record<string, unknown>)["organizacion"])).not.toContain("Despacho Norte");
    expect(r.summary).toContain("1 organización no guarda ese dato");
  });

  it("falla cerrado sin bitacora y degrada con honestidad sin la funcion", async () => {
    const f = fuentesFalsas({ registrarAccesoOrganizaciones: async () => "error" });
    const r = await correr(f, "ranking_actividad", { periodo: "este_mes" });
    expect(r.status).toBe("unavailable");
    expect(f.llamadasOperaciones).toEqual([]);
    const g = await correr(fuentesFalsas({ operacionesPorOrganizacion: async () => ({ ok: false, razon: "no_migrado" }) }), "ranking_actividad", { periodo: "este_mes" });
    expect(g.status).toBe("unavailable");
    expect(g.message).toContain("No tengo el dato");
  });

  it("sin datos personales ni identificadores internos en columnas ni filas", async () => {
    const r = await correr(fuentesFalsas(), "ranking_actividad", { periodo: "este_mes" });
    expect(volcado(r)).not.toMatch(/@|\+52|org-a|org-b/);
  });
});

describe("agentes_organizacion", () => {
  it("suma llamadas, fallbacks y costo por agente de UNA organizacion y reporta sus escalaciones", async () => {
    const f = fuentesFalsas();
    const r = await correr(f, "agentes_organizacion", { organizacion: "Taquería Don Beto", periodo: "este_mes" });
    expect(r.status).toBe("ok");
    expect(r.rows).toEqual([{ rol: "restaurantes:data_chat", llamadas: 6, fallbacks: 1, costo_usd: 2 }]);
    expect(r.summary).toContain("3 escalaciones a una persona");
    expect(f.accesosOrg[0]).toMatchObject({ ids: ["org-a"], herramienta: "agentes_organizacion" });
  });

  it("para una vertical que no guarda escalaciones lo dice en vez de inventar un 0", async () => {
    const r = await correr(fuentesFalsas(), "agentes_organizacion", { organizacion: "Hotel Bahía", periodo: "este_mes" });
    expect(r.rows).toHaveLength(2);
    expect(r.summary).toContain("no se guardan para esta vertical");
  });

  it("una organizacion sin uso de IA responde vacio honesto, no un error", async () => {
    const r = await correr(fuentesFalsas(), "agentes_organizacion", { organizacion: "Posada Sol", periodo: "este_mes" });
    expect(r.status).toBe("empty");
    expect(r.summary).toContain("no usó agentes de IA");
  });
});

describe("rol finanzas", () => {
  it("el rol finanzas NO recibe ninguna herramienta por organizacion (solo las financieras)", () => {
    const nombres = buildCatalogoPlataforma(fuentesFalsas(), SCOPE_FINANZAS).tools.map((t) => t.name);
    for (const n of ["operaciones_organizacion", "ranking_actividad", "agentes_organizacion"]) expect(nombres).not.toContain(n);
  });
});

describe("compatibilidad con la base sin migrar (transaccion abortada de Postgres)", () => {
  const USER = "00000000-0000-0000-0000-0000000000a1";
  const pgError = (code: string, message: string): Error => Object.assign(new Error(message), { code });

  it("operacionesPorOrganizacion: la funcion que falta (42883) se traduce a no_migrado y la sesion del turno sigue utilizable", async () => {
    const db = new AbortAwareFakeSession([
      { match: /get_operaciones_por_organizacion_for_superadmin/, respond: () => pgError("42883", "function core.get_operaciones_por_organizacion_for_superadmin(uuid, date, date, date, uuid) does not exist") },
      { match: /select 1/, respond: () => [{ x: 1 }] },
    ]);
    const f = fuentesDeProduccion({} as AppDeps, db, USER);
    const r = await f.operacionesPorOrganizacion("2026-10-01", "2026-10-02", "2026-10-02", null);
    expect(r).toEqual({ ok: false, razon: "no_migrado" });
    // una consulta posterior en la misma sesion NO falla con 25P02 (se hizo ROLLBACK TO SAVEPOINT)
    await expect(db.query("select 1")).resolves.toBeDefined();
  });

  it("operacionesPorOrganizacion: convierte NULL a null y numericos a numero (sin inventar ceros)", async () => {
    const db = new AbortAwareFakeSession([
      {
        match: /get_operaciones_por_organizacion_for_superadmin/,
        respond: () => [{ organization_id: "o1", vertical: "hoteles", operaciones: "3", ingresos: "1500.50", escalaciones: null, abiertos: "1", vencidos: null, razon: null }],
      },
    ]);
    const f = fuentesDeProduccion({} as AppDeps, db, USER);
    const r = await f.operacionesPorOrganizacion("2026-10-01", "2026-10-02", "2026-10-02", "o1");
    expect(r).toEqual({ ok: true, data: [{ organizationId: "o1", vertical: "hoteles", operaciones: 3, ingresos: 1500.5, escalaciones: null, abiertos: 1, vencidos: null, razon: null }] });
  });

  it("registrarAccesoOrganizaciones: usa su PROPIA transaccion; 42883 = no_migrado, otro error = error, y manda 1000 ids por llamada como maximo", async () => {
    const llamadas: unknown[][] = [];
    const montar = (falla: Error | null): AppDeps =>
      ({
        engine: {
          withAppSession: async (_a: unknown, fn: (s: { query: (sql: string, p: unknown[]) => Promise<{ rows: unknown[] }> }) => Promise<unknown>) =>
            fn({
              query: async (_sql: string, p: unknown[]) => {
                llamadas.push(p);
                if (falla) throw falla;
                return { rows: [] };
              },
            }),
        },
      }) as unknown as AppDeps;
    const ids = Array.from({ length: 2500 }, (_, i) => `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`);
    const db = new AbortAwareFakeSession([]);
    expect(await fuentesDeProduccion(montar(null), db, USER).registrarAccesoOrganizaciones(ids, "ranking_actividad", { periodo: "este_mes" })).toBe("ok");
    expect(llamadas.map((p) => (p[1] as string[]).length)).toEqual([1000, 1000, 500]);
    expect(llamadas[0]?.[0]).toBe(USER);
    expect(llamadas[0]?.[2]).toBe("ranking_actividad");
    expect(await fuentesDeProduccion(montar(pgError("42883", "function core.log_superadmin_org_access(uuid, uuid[], text, jsonb) does not exist")), db, USER).registrarAccesoOrganizaciones(["a"], "x", {})).toBe("no_migrado");
    expect(await fuentesDeProduccion(montar(pgError("42501", "no es superadmin")), db, USER).registrarAccesoOrganizaciones(["a"], "x", {})).toBe("error");
    expect(await fuentesDeProduccion(montar(null), db, USER).registrarAccesoOrganizaciones([], "x", {})).toBe("ok");
  });
});
