// Herramientas del Copiloto de superadmin (CHAT-16), una por una, contra fuentes EN MEMORIA: datos que devuelven, columnas, que NO exponen (PII, contacto,
// texto de conversaciones) y el "no tengo el dato" honesto cuando falta la fuente. El LLM guionado y las reglas de seguridad del turno completo van en
// superadmin-copiloto.spec.ts.
import { describe, expect, it } from "vitest";
import { parseArgs, type DataChatTool, type DataChatToolResult } from "@atiende/agent-core/data-chat";
import { buildCatalogoPlataforma, HERRAMIENTAS_FINANCIERAS, HERRAMIENTAS_OPERATIVAS } from "../src/superadmin-copiloto/catalogo.ts";
import type { FuentesPlataforma, RazonFuente } from "../src/superadmin-copiloto/fuentes.ts";
import { AHORA, FILA_CFO, SCOPE_FINANZAS, SCOPE_SUPERADMIN, ctxHerramienta, fuentesFalsas, ok, volcado } from "./superadmin-copiloto-fixtures.ts";

function herramienta(f: FuentesPlataforma, nombre: string, scope = SCOPE_SUPERADMIN, opciones?: Parameters<typeof buildCatalogoPlataforma>[2]): DataChatTool {
  const t = buildCatalogoPlataforma(f, scope, opciones).tools.find((x) => x.name === nombre);
  if (!t) throw new Error(`herramienta ${nombre} no existe en el catalogo`);
  return t;
}

async function correr(f: FuentesPlataforma, nombre: string, args: Record<string, unknown> = {}, scope = SCOPE_SUPERADMIN, opciones?: Parameters<typeof buildCatalogoPlataforma>[2]): Promise<DataChatToolResult> {
  const t = herramienta(f, nombre, scope, opciones);
  const parsed = parseArgs(t.params, args);
  if (!parsed.ok) throw new Error(`argumentos invalidos: ${parsed.error}`);
  return t.run(ctxHerramienta(scope), parsed.value);
}

const fila = (r: DataChatToolResult, i = 0): Record<string, string | number | null> => r.rows[i] as Record<string, string | number | null>;
const columna = (r: DataChatToolResult, key: string): (string | number | null)[] => r.rows.map((x) => (x as Record<string, string | number | null>)[key] ?? null);

describe("catalogo de plataforma", () => {
  it("el superadmin ve las 17 operativas y las 5 financieras; finanzas SOLO las financieras", () => {
    const f = fuentesFalsas();
    const sa = buildCatalogoPlataforma(f, SCOPE_SUPERADMIN);
    expect(sa.vertical).toBe("plataforma");
    expect(sa.tools.map((t) => t.name).sort()).toEqual([...HERRAMIENTAS_OPERATIVAS, ...HERRAMIENTAS_FINANCIERAS].sort());
    const fin = buildCatalogoPlataforma(f, SCOPE_FINANZAS);
    expect(fin.tools.map((t) => t.name).sort()).toEqual([...HERRAMIENTAS_FINANCIERAS].sort());
  });

  it("toda herramienta tiene parametros TODOS opcionales (se puede correr directo, sin modelo) y nombre y etiqueta validos", () => {
    for (const t of buildCatalogoPlataforma(fuentesFalsas(), SCOPE_SUPERADMIN).tools) {
      expect(t.name, t.name).toMatch(/^[a-z0-9_]{1,60}$/);
      expect(t.label.length, t.name).toBeGreaterThan(3);
      expect(t.description.length, t.name).toBeGreaterThan(20);
      for (const [k, p] of Object.entries(t.params)) expect(p.optional, `${t.name}.${k}`).toBe(true);
      expect(parseArgs(t.params, {}).ok, t.name).toBe(true);
    }
  });

  it("el catalogo trae su propio texto de fuera de catalogo ('no tengo el dato') y describe el alcance sin datos", async () => {
    const c = buildCatalogoPlataforma(fuentesFalsas(), SCOPE_SUPERADMIN);
    expect(c.outOfCatalogMessage).toMatch(/^No tengo el dato/);
    await expect(c.describeScope!({ organizationId: "plataforma", userId: "u", vertical: "plataforma", verticalRole: "superadmin", allowedPropertyIds: null, timezone: "America/Mexico_City" }, new AbortController().signal)).resolves.toMatch(/Plataforma completa/);
    const fin = buildCatalogoPlataforma(fuentesFalsas(), SCOPE_FINANZAS);
    await expect(fin.describeScope!({ organizationId: "plataforma", userId: "u", vertical: "plataforma", verticalRole: "finanzas", allowedPropertyIds: null, timezone: "America/Mexico_City" }, new AbortController().signal)).resolves.toMatch(/solo lectura/);
  });
});

describe("alcance multi-organizacion", () => {
  const fuentesPm = () =>
    fuentesFalsas({
      organizaciones: async () =>
        ok([
          { id: "org-pm1", vertical: "restaurantes", name: "Los Taquitos de PM", slug: "los-taquitos-de-pm", status: "active" as const, createdAt: "2026-03-01T10:00:00.000Z", staffCount: 3 },
          { id: "org-h1", vertical: "hoteles", name: "Hotel Mérida Centro", slug: "hotel-merida-centro", status: "active" as const, createdAt: "2026-04-01T10:00:00.000Z", staffCount: 2 },
          { id: "org-h2", vertical: "hoteles", name: "Hotel Mérida Norte", slug: "hotel-merida-norte", status: "trial" as const, createdAt: "2026-05-01T10:00:00.000Z", staffCount: 1 },
          { id: "org-r1", vertical: "restaurantes", name: "Cafe Merida", slug: "cafe-merida", status: "active" as const, createdAt: "2026-05-01T10:00:00.000Z", staffCount: 1 },
        ]),
    });

  it("buscar_organizacion: «PM» resuelve la organizacion sin importar mayusculas y no expone ids ni contacto", async () => {
    const r = await correr(fuentesPm(), "buscar_organizacion", { nombre: "PM" });
    expect(columna(r, "organizacion")).toEqual(["Los Taquitos de PM"]);
    expect(r.summary).toMatch(/^Una organización coincide/);
    expect(r.columns.map((c) => c.key)).toEqual(["organizacion", "vertical", "estado", "personal", "alta"]);
    expect(JSON.stringify(r)).not.toMatch(/org-pm1|slug|@|telefono/i);
  });

  it("buscar_organizacion: «el hotel de Mérida» acota la vertical por la palabra y es insensible a acentos; varias coincidencias piden elegir", async () => {
    const r = await correr(fuentesPm(), "buscar_organizacion", { nombre: "el hotel de Merida" });
    expect(columna(r, "organizacion")).toEqual(["Hotel Mérida Centro", "Hotel Mérida Norte"]);
    expect(r.summary).toMatch(/pide al usuario que elija/);
    const una = await correr(fuentesPm(), "buscar_organizacion", { nombre: "hotel Mérida", estado: "trial" });
    expect(columna(una, "organizacion")).toEqual(["Hotel Mérida Norte"]);
  });

  it("buscar_organizacion: sin coincidencias dice que ninguna coincide (no inventa) y sin fuente es 'no tengo el dato'", async () => {
    const r = await correr(fuentesPm(), "buscar_organizacion", { nombre: "Inexistente" });
    expect(r.status).toBe("empty");
    expect(r.summary).toMatch(/^Ninguna organización coincide/);
    const sin = await correr(fuentesFalsas({ organizaciones: async () => ({ ok: false, razon: "no_migrado" as RazonFuente }) }), "buscar_organizacion", { nombre: "PM" });
    expect(sin.status).toBe("unavailable");
    expect(sin.message).toMatch(/^No tengo el dato/);
  });

  it("ranking_organizaciones: ordena por costo de IA, por llamadas o por personal, totaliza por vertical y respeta el limite", async () => {
    const f = fuentesFalsas();
    const costo = await correr(f, "ranking_organizaciones", { periodo: "este_mes" });
    // Posada Sol existe pero no tiene gasto de IA: aparece con 0 y el resumen separa "organizaciones" de "con gasto de IA".
    expect(columna(costo, "organizacion")).toEqual(["Taquería Don Beto", "Hotel Bahía", "Posada Sol"]);
    expect(columna(costo, "posicion")).toEqual([1, 2, 3]);
    expect(fila(costo, 2)["costo_usd"]).toBe(0);
    expect(fila(costo, 2)["llamadas_ia"]).toBe(0);
    expect(costo.summary).toBe("3 organizaciones, 2 con gasto de IA en el periodo. Por vertical: restaurantes: 3.5 USD en 1 organización; hoteles: 1.5 USD en 2 organizaciones.");
    const personal = await correr(f, "ranking_organizaciones", { periodo: "este_mes", ordenar_por: "personal", limite: 1 });
    expect(columna(personal, "organizacion")).toEqual(["Taquería Don Beto"]);
    const hoteles = await correr(f, "ranking_organizaciones", { periodo: "este_mes", vertical: "hoteles" });
    expect(columna(hoteles, "organizacion")).toEqual(["Hotel Bahía", "Posada Sol"]);
    expect(JSON.stringify(costo)).not.toMatch(/org-a|org-b/);
  });

  it("ranking_organizaciones: sin la lista de organizaciones dice 'no tengo el dato' (no ofrece un ranking parcial)", async () => {
    const r = await correr(fuentesFalsas({ organizaciones: async () => ({ ok: false, razon: "no_migrado" as RazonFuente }) }), "ranking_organizaciones", { periodo: "este_mes" });
    expect(r.status).toBe("unavailable");
  });

  it("buscar_organizacion: la palabra de vertical tambien cuenta como nombre cuando esta en el nombre de otra vertical", async () => {
    const f = fuentesFalsas({
      organizaciones: async () =>
        ok([
          { id: "o1", vertical: "restaurantes", name: "Hotel Rosa Café", slug: "hotel-rosa-cafe", status: "active" as const, createdAt: "2026-03-01T10:00:00.000Z", staffCount: 1 },
          { id: "o2", vertical: "hoteles", name: "Casa Rosa", slug: "casa-rosa", status: "active" as const, createdAt: "2026-03-02T10:00:00.000Z", staffCount: 1 },
          { id: "o3", vertical: "restaurantes", name: "Rosa Taqueria", slug: "rosa-taqueria", status: "active" as const, createdAt: "2026-03-03T10:00:00.000Z", staffCount: 1 },
        ]),
    });
    const r = await correr(f, "buscar_organizacion", { nombre: "hotel Rosa" });
    expect(columna(r, "organizacion")).toEqual(["Casa Rosa", "Hotel Rosa Café"]);
    const explicita = await correr(f, "buscar_organizacion", { nombre: "hotel Rosa", vertical: "hoteles" });
    expect(columna(explicita, "organizacion")).toEqual(["Casa Rosa"]);
  });

  it("ranking_organizaciones: sin la fuente de gasto dice 'no tengo el dato'", async () => {
    const r = await correr(fuentesFalsas({ llmPorOrganizacion: async () => ({ ok: false, razon: "error" as RazonFuente }) }), "ranking_organizaciones", { periodo: "este_mes" });
    expect(r.status).toBe("unavailable");
  });

  it("el rol finanzas no ve las herramientas multi-organizacion", () => {
    const nombres = buildCatalogoPlataforma(fuentesFalsas(), SCOPE_FINANZAS).tools.map((t) => t.name);
    expect(nombres).not.toContain("buscar_organizacion");
    expect(nombres).not.toContain("ranking_organizaciones");
  });
});

describe("herramientas operativas", () => {
  it("organizaciones: lista con vertical, estado y personal; filtra por vertical y estado; resume el conteo", async () => {
    const todas = await correr(fuentesFalsas(), "organizaciones");
    expect(todas.status).toBe("ok");
    expect(todas.rows).toHaveLength(3);
    expect(todas.summary).toBe("3 organizaciones, 1 activas.");
    expect(fila(todas)).toMatchObject({ organizacion: "Hotel Bahía", vertical: "hoteles", estado: "trial", personal: 2, alta: "2026-09-10" });
    const hoteles = await correr(fuentesFalsas(), "organizaciones", { vertical: "hoteles", estado: "suspended" });
    expect(columna(hoteles, "organizacion")).toEqual(["Posada Sol"]);
  });

  it("costos_ia: agrupa por organizacion, vertical, rol y modelo con los totales de la fuente (USD)", async () => {
    const f = fuentesFalsas();
    const org = await correr(f, "costos_ia", { periodo: "este_mes" });
    expect(columna(org, "organizacion")).toEqual(["Taquería Don Beto", "Hotel Bahía"]);
    expect(columna(org, "costo_usd")).toEqual([3.5, 1.5]);
    expect(org.summary).toBe("Gasto de IA total: 5 USD en 2 organizaciones.");
    expect(org.periodLabel).toMatch(/este mes|octubre|oct/i);
    const vertical = await correr(f, "costos_ia", { periodo: "este_mes", agrupar: "vertical" });
    expect(Object.fromEntries(vertical.rows.map((r) => [(r as { vertical: string }).vertical, (r as { costo_usd: number }).costo_usd]))).toEqual({ restaurantes: 3.5, hoteles: 1.5 });
    const rol = await correr(f, "costos_ia", { periodo: "este_mes", agrupar: "rol" });
    expect(Object.fromEntries(rol.rows.map((r) => [(r as { rol: string }).rol, (r as { costo_usd: number }).costo_usd]))).toEqual({ "restaurantes:data_chat": 3, "hoteles:whatsapp_agent": 0.5 });
    const modelo = await correr(f, "costos_ia", { periodo: "este_mes", agrupar: "modelo" });
    expect(modelo.rows).toHaveLength(2);
    expect(columna(modelo, "modelo")).toEqual(["deepseek/deepseek-v4.1-flash", "anthropic/claude-sonnet-5.5"]);
    expect(columna(modelo, "llamadas")).toEqual([10, 2]);
  });

  it("costos_ia: pide el periodo cuando es ambiguo (no lo adivina) y 'no tengo el dato' si falta la fuente", async () => {
    const sinPeriodo = await correr(fuentesFalsas(), "costos_ia", { desde: "2026-10-01" });
    expect(sinPeriodo.status).not.toBe("ok");
    const roto = await correr(fuentesFalsas({ llmPorRolMes: async () => ({ ok: false, razon: "no_migrado" }) }), "costos_ia", { periodo: "este_mes", agrupar: "rol" });
    expect(roto.status).toBe("unavailable");
    expect(roto.message).toMatch(/^No tengo el dato: falta aplicar una actualización/);
    expect(roto.rows).toEqual([]);
  });

  it("consumo_vs_tope: plataforma, Copiloto propio y organizaciones con su porcentaje; el gasto del Copiloto sin medir sale vacio, no inventado", async () => {
    const r = await correr(fuentesFalsas(), "consumo_vs_tope", {}, SCOPE_SUPERADMIN, { topeCopilotoMicroUsd: 25_000_000 });
    expect(columna(r, "ambito")).toEqual(["Plataforma (tope global)", "Copiloto de superadmin", "Hotel Bahía", "Taquería Don Beto"]);
    expect(fila(r, 0)).toMatchObject({ gasto_usd: 25, tope_usd: 100, uso_pct: 25 });
    expect(fila(r, 1)).toMatchObject({ gasto_usd: 2, tope_usd: 25, uso_pct: 8 });
    expect(fila(r, 2)).toMatchObject({ uso_pct: 90 });
    const sinMedir = await correr(fuentesFalsas({ copilotoGastoMes: async () => ({ ok: false, razon: "no_migrado" }) }), "consumo_vs_tope", {}, SCOPE_SUPERADMIN, { topeCopilotoMicroUsd: 25_000_000 });
    expect(fila(sinMedir, 1)).toMatchObject({ ambito: "Copiloto de superadmin", gasto_usd: null, uso_pct: null });
    const sinNada = await correr(
      fuentesFalsas({ llmPorOrganizacion: async () => ({ ok: false, razon: "error" }), presupuestoPlataforma: async () => ({ ok: false, razon: "error" }) }),
      "consumo_vs_tope",
    );
    expect(sinNada.status).toBe("unavailable");
  });

  it("uso_por_vertical: organizaciones, operaciones del periodo, WhatsApp y actividad de IA por vertical; una fuente caida deja su columna vacia", async () => {
    const r = await correr(fuentesFalsas(), "uso_por_vertical", { periodo: "ultimos_7_dias" });
    const restaurantes = r.rows.find((x) => (x as { vertical: string }).vertical === "restaurantes") as Record<string, number | null>;
    expect(restaurantes).toMatchObject({ organizaciones: 5, activas: 4, demo: 1, operaciones: 65, conversaciones_wa: 120, llamadas_ia_30d: 60, costo_ia_30d_usd: 3 });
    const hoteles = r.rows.find((x) => (x as { vertical: string }).vertical === "hoteles") as Record<string, number | null>;
    expect(hoteles["operaciones"]).toBeNull();
    expect(hoteles["conversaciones_wa"]).toBeNull();
    expect(r.rows).toHaveLength(6);
    const parcial = await correr(fuentesFalsas({ consolaAgentesActividad: async () => ({ ok: false, razon: "no_migrado" }) }), "uso_por_vertical", { periodo: "hoy" });
    expect(parcial.status).toBe("ok");
    expect(columna(parcial, "llamadas_ia_30d").every((v) => v === null)).toBe(true);
    expect(parcial.source).toMatch(/Sin dato de: actividad de agentes/);
    const nada = await correr(
      fuentesFalsas({
        consolaOrganizaciones: async () => ({ ok: false, razon: "error" }),
        consolaOperaciones: async () => ({ ok: false, razon: "error" }),
        consolaConversacionesWa: async () => ({ ok: false, razon: "error" }),
        consolaAgentesActividad: async () => ({ ok: false, razon: "error" }),
      }),
      "uso_por_vertical",
      { periodo: "hoy" },
    );
    expect(nada.status).toBe("unavailable");
  });

  it("agentes_interruptores: cada rol apagable con su estado y su actividad de 30 dias", async () => {
    const r = await correr(fuentesFalsas(), "agentes_interruptores");
    const hoteles = r.rows.find((x) => (x as { rol: string }).rol === "hoteles:whatsapp_agent") as Record<string, string | number | null>;
    expect(hoteles).toMatchObject({ estado: "apagado", motivo: "Pausado por revisión de costos del trimestre", llamadas_30d: 10, costo_30d_usd: 0.9 });
    const copiloto = r.rows.find((x) => (x as { rol: string }).rol === "superadmin:copiloto") as Record<string, string | number | null>;
    expect(copiloto).toMatchObject({ estado: "activo", motivo: null });
    // El interruptor de un cron no apaga ningun agente.
    expect(r.rows.filter((x) => (x as { estado: string }).estado === "apagado")).toHaveLength(1);
    expect(r.summary).toMatch(/1 apagados/);
    const globalApagado = await correr(fuentesFalsas({ interruptores: async () => ok([{ scope: "global" as const, target: "llm", blocked: true, reason: "Pausa global por incidente del proveedor", updatedBy: null, updatedAtMs: 1 }]) }), "agentes_interruptores");
    expect(globalApagado.rows.every((x) => (x as { estado: string }).estado === "apagado")).toBe(true);
    const sinActividad = await correr(fuentesFalsas({ consolaAgentesActividad: async () => ({ ok: false, razon: "error" }) }), "agentes_interruptores");
    expect(columna(sinActividad, "llamadas_30d").every((v) => v === null)).toBe(true);
  });

  it("ultimas_corridas: ultimo latido de cada cron, el mas reciente primero, con filtro por estado", async () => {
    const r = await correr(fuentesFalsas(), "ultimas_corridas");
    expect(columna(r, "cron")).toEqual(["/internal/whatsapp/dispatch", "/internal/hoteles/night-audit"].reverse().reverse());
    expect(fila(r, 1)).toMatchObject({ estado: "error", fallos_seguidos: 3, ultima_corrida: "2026-10-02 08:00" });
    expect(r.summary).toBe("2 crons con latido, 1 con su última corrida en error.");
    const soloError = await correr(fuentesFalsas(), "ultimas_corridas", { estado: "error" });
    expect(columna(soloError, "cron")).toEqual(["/internal/hoteles/night-audit"]);
  });

  it("errores: crons en error, mensajes muertos, fuentes de licitaciones en falla y denegaciones; sin PII, sin IP, sin ids de usuario", async () => {
    const r = await correr(fuentesFalsas(), "errores");
    const fuentes = columna(r, "fuente");
    expect(fuentes).toEqual(expect.arrayContaining(["cron", "cola", "mensaje muerto", "licitaciones", "acceso denegado"]));
    const denegado = r.rows.find((x) => (x as { fuente: string }).fuente === "acceso denegado") as Record<string, string | number | null>;
    expect(denegado).toMatchObject({ elemento: "GET /superadmin/organizations", cantidad: 2 });
    const muerto = r.rows.find((x) => (x as { fuente: string }).fuente === "mensaje muerto") as Record<string, string | number | null>;
    expect(muerto["cantidad"]).toBe(2);
    // not_configured no es una falla; down si.
    const lic = r.rows.filter((x) => (x as { fuente: string }).fuente === "licitaciones");
    expect(lic).toHaveLength(1);
    const todo = volcado(r);
    expect(todo).not.toMatch(/juan@ejemplo\.com|10\.0\.0\.|u-1|u-2|999 123 4567|https?:\/\//);
    expect(todo).toContain("[correo]");
  });

  it("errores: puede pedir una sola fuente y declara las que no pudo leer", async () => {
    const soloCrons = await correr(fuentesFalsas(), "errores", { fuente: "crons" });
    expect(columna(soloCrons, "fuente")).toEqual(["cron"]);
    const parcial = await correr(fuentesFalsas({ fuentesLicitaciones: async () => ({ ok: false, razon: "error" }) }), "errores");
    expect(parcial.status).toBe("ok");
    expect(parcial.source).toMatch(/Sin dato de: licitaciones/);
    const nada = await correr(fuentesFalsas({ heartbeats: async () => ({ ok: false, razon: "no_migrado" }) }), "errores", { fuente: "crons" });
    expect(nada.status).toBe("unavailable");
  });

  it("salud_colas: una fila por cola con sus contadores y 'sin pendiente' como vacio", async () => {
    const r = await correr(fuentesFalsas(), "salud_colas");
    expect(r.rows).toHaveLength(2);
    expect(fila(r)).toMatchObject({ cola: "restaurantes", pendientes: 4, muertos: 1, pendiente_mas_viejo_seg: 120 });
    expect(fila(r, 1)).toMatchObject({ cola: "citas", pendiente_mas_viejo_seg: null, ultimo_envio: null });
    expect(r.summary).toBe("2 colas, 1 mensajes muertos en total.");
  });

  it("planes_y_topes: planes con precios en MXN y limites, o las asignaciones recientes", async () => {
    const planes = await correr(fuentesFalsas(), "planes_y_topes");
    expect(fila(planes)).toMatchObject({ plan: "Restaurantes Estándar", precio_base_mxn: 0, precio_asiento_mxn: 799, asientos: 1, activo: "sí", organizaciones: 4, limites: "mensajes_mes 5000 (avisar)" });
    const asign = await correr(fuentesFalsas(), "planes_y_topes", { ver: "asignaciones" });
    expect(fila(asign)).toMatchObject({ organizacion: "Taquería Don Beto", plan: "restaurantes-estandar", estado: "pending" });
    const sin = await correr(fuentesFalsas({ planes: async () => ({ ok: false, razon: "sin_repositorio" }) }), "planes_y_topes");
    expect(sin.message).toMatch(/^No tengo el dato: esa fuente no está configurada/);
  });

  it("eventos_seguridad: cuando, area y evento; sin ids de usuario ni detalle", async () => {
    const r = await correr(fuentesFalsas(), "eventos_seguridad");
    expect(r.rows).toHaveLength(2);
    expect(fila(r)).toMatchObject({ area: "switch", evento: "interruptor_apagado" });
    expect(volcado(r)).not.toMatch(/u-1|objetivo/);
    const mfa = await correr(fuentesFalsas(), "eventos_seguridad", { area: "mfa" });
    expect(columna(mfa, "evento")).toEqual(["mfa_activado"]);
  });

  it("prospectos: conteos por estado, por vertical o lista; NUNCA nombre de contacto, telefono, correo ni notas", async () => {
    const porEstado = await correr(fuentesFalsas(), "prospectos");
    expect(Object.fromEntries(porEstado.rows.map((r) => [(r as { grupo: string }).grupo, (r as { prospectos: number }).prospectos]))).toEqual({ nuevo: 2, demo: 1 });
    const porVertical = await correr(fuentesFalsas(), "prospectos", { agrupar: "vertical" });
    expect(Object.fromEntries(porVertical.rows.map((r) => [(r as { grupo: string }).grupo, (r as { prospectos: number }).prospectos]))).toEqual({ hoteles: 2, restaurantes: 1 });
    const lista = await correr(fuentesFalsas(), "prospectos", { agrupar: "lista", estado: "demo" });
    expect(fila(lista)).toMatchObject({ empresa: "Cafetería Luna", vertical: "restaurantes", ciudad: "Mérida", estado: "demo", actualizado: "2026-09-30" });
    const todo = volcado(await correr(fuentesFalsas(), "prospectos", { agrupar: "lista" }));
    expect(todo).not.toMatch(/Ana Pérez|Luis Soto|ana@luna|luis@brisa|999 111|998 333|descuento|calle 5/);
  });

  it("uso_copiloto: consultas y costo por vertical, resultado y ruta, sin texto ni usuarios", async () => {
    const r = await correr(fuentesFalsas(), "uso_copiloto", { periodo: "este_mes" });
    expect(r.rows).toHaveLength(2);
    expect(fila(r)).toMatchObject({ vertical: "plataforma", resultado: "ok", ruta: "llm", consultas: 5, costo_usd: 2 });
    expect(r.summary).toBe("35 registros de consulta y 2 USD de costo en el periodo.");
    const sin = await correr(fuentesFalsas({ copilotoUso: async () => ({ ok: false, razon: "no_migrado" }) }), "uso_copiloto", { periodo: "este_mes" });
    expect(sin.status).toBe("unavailable");
  });

  it("una fuente que lanza algo inesperado NO tumba el turno ni se disfraza de cifra: 'no tengo el dato'", async () => {
    const f = fuentesFalsas({
      organizaciones: async () => {
        throw new Error("boom");
      },
    });
    const r = await correr(f, "organizaciones");
    expect(r.status).toBe("unavailable");
    expect(r.message).toMatch(/^No tengo el dato/);
    expect(r.rows).toEqual([]);
  });

  it("cada herramienta operativa dice 'no tengo el dato' (con su razon) cuando su fuente principal no existe, sin filas inventadas", async () => {
    const razones: RazonFuente[] = ["no_migrado", "error", "sin_repositorio"];
    const rota = async () => ({ ok: false as const, razon: razones[0]! });
    const f = fuentesFalsas({
      organizaciones: rota,
      llmPorOrganizacion: rota,
      llmPorModelo: rota,
      llmPorRolMes: rota,
      presupuestoPlataforma: rota,
      copilotoUso: rota,
      consolaOrganizaciones: rota,
      consolaOperaciones: rota,
      consolaConversacionesWa: rota,
      consolaAgentesActividad: rota,
      interruptores: rota,
      heartbeats: rota,
      colas: rota,
      colasMuertos: rota,
      fuentesLicitaciones: rota,
      denegaciones: rota,
      eventosSeguridad: rota,
      planes: rota,
      asignaciones: rota,
      prospectos: rota,
    });
    for (const nombre of HERRAMIENTAS_OPERATIVAS) {
      const conPeriodo = ["costos_ia", "uso_por_vertical", "uso_copiloto", "ranking_organizaciones", "ranking_actividad", "operaciones_organizacion", "agentes_organizacion"].includes(nombre);
      const r = await correr(f, nombre, { ...(conPeriodo ? { periodo: "hoy" } : {}), ...(nombre === "operaciones_organizacion" || nombre === "agentes_organizacion" ? { organizacion: "Taquería Don Beto" } : {}) });
      expect(r.status, nombre).toBe("unavailable");
      expect(r.message, nombre).toMatch(/^No tengo el dato/);
      expect(r.rows, nombre).toEqual([]);
    }
  });
});

describe("herramientas financieras (Copiloto CFO)", () => {
  it("mrr del mes en curso: MRR, ARR y clientes por vertical con las mismas definiciones del dashboard CFO; cita la consulta", async () => {
    const f = fuentesFalsas();
    const r = await correr(f, "mrr");
    expect(r.status).toBe("ok");
    const total = r.rows[r.rows.length - 1] as Record<string, string | number>;
    expect(total["vertical"]).toBe("Total");
    // 3 sucursales con 1 asiento incluido = 2 asientos facturables x 799 = 1,598; el hotel (1 sucursal) no factura asientos extra: no aporta MRR.
    expect(total["mrr_mxn"]).toBe(1598);
    expect(total["clientes"]).toBe(1);
    expect(r.summary).toMatch(/MRR de 2026-10/);
    expect(r.source).toMatch(/^Consulta «mrr»: MRR esperado/);
    expect(f.accesosCfo).toEqual([{ accion: "consulta", recurso: "copiloto/mrr", filtros: { herramienta: "mrr", _ruta: "/superadmin/copiloto" } }]);
  });

  it("mrr de un mes cerrado usa la foto mensual guardada; sin foto: 'no tengo el dato'; un mes futuro pide aclaracion", async () => {
    const conFoto = fuentesFalsas({
      cfoFotos: async () =>
        ok([
          { organizationId: "org-a", mes: "2026-09-01", vertical: "restaurantes", orgStatus: "active", planId: "p", billingStatus: null, mrrCentavos: 79_900, mrrRazon: null },
          { organizationId: "org-b", mes: "2026-09-01", vertical: "hoteles", orgStatus: "active", planId: null, billingStatus: null, mrrCentavos: null, mrrRazon: "sin_plan" as const },
          { organizationId: "org-c", mes: "2026-09-01", vertical: "hoteles", orgStatus: "suspended", planId: "p", billingStatus: null, mrrCentavos: 50_000, mrrRazon: null },
        ]),
    });
    const r = await correr(conFoto, "mrr", { mes: "2026-09" });
    expect(r.rows[r.rows.length - 1]).toMatchObject({ vertical: "Total", mrr_mxn: 799, clientes: 1, sin_precio: 1 });
    expect(conFoto.accesosCfo[0]?.filtros).toMatchObject({ herramienta: "mrr", mes: "2026-09" });
    const sinFoto = await correr(fuentesFalsas(), "mrr", { mes: "2026-08" });
    expect(sinFoto.status).toBe("unavailable");
    expect(sinFoto.message).toMatch(/^No tengo el dato: no hay foto mensual/);
    const futuro = await correr(fuentesFalsas(), "mrr", { mes: "2027-01" });
    expect(futuro.status).toBe("needs_clarification");
    const mal = await correr(fuentesFalsas(), "mrr", { mes: "2026-13" });
    expect(mal.status).toBe("needs_clarification");
    // Un texto largo ni siquiera llega a la herramienta: lo rechaza la validacion del esquema de parametros.
    expect(parseArgs(herramienta(fuentesFalsas(), "mrr").params, { mes: "septiembre" }).ok).toBe(false);
  });

  it("margen_costos_unitarios: por organizacion, el menor margen primero, con costo de IA por mensaje", async () => {
    const r = await correr(fuentesFalsas(), "margen_costos_unitarios");
    // El hotel no factura nada y cuesta 1,800 MXN: la mayor perdida va primero.
    expect(columna(r, "organizacion")).toEqual(["Hotel Bahía", "Taquería Don Beto"]);
    expect(fila(r, 0)["margen_mxn"]).toBeLessThan(0);
    const beto = r.rows.find((x) => (x as { organizacion: string }).organizacion === "Taquería Don Beto") as Record<string, number | null>;
    expect(beto["llm_por_mensaje_usd"]).toBe(0.01);
    expect(beto["voz_por_minuto_usd"]).toBeNull();
    expect(beto["margen_pct"]).not.toBeNull();
    expect(r.summary).toMatch(/^2 organizaciones; \d+ con margen menor a 30%\.$/);
  });

  it("margen_costos_unitarios sin tipo de cambio: costos y margenes en MXN quedan vacios y la fuente lo dice", async () => {
    const r = await correr(fuentesFalsas({ cfoFilas: async () => ok([{ ...FILA_CFO, mxnPorUsd: null, fxFecha: null, fxFuente: null }]) }), "margen_costos_unitarios");
    expect(fila(r)["costo_mxn"]).toBeNull();
    expect(fila(r)["margen_mxn"]).toBeNull();
    expect(r.source).toMatch(/Sin tipo de cambio configurado/);
  });

  it("pyl: por vertical con el total; la infraestructura capturada entra; sin infra o sin tipo de cambio las columnas quedan vacias y se declara", async () => {
    const r = await correr(fuentesFalsas(), "pyl");
    expect(r.rows[r.rows.length - 1]).toMatchObject({ vertical: "Total" });
    const resto = r.rows.find((x) => (x as { vertical: string }).vertical === "restaurantes") as Record<string, number | null>;
    expect(resto["ingreso_mxn"]).toBe(1598);
    expect(resto["costo_directo_mxn"]).toBe(80);
    expect(resto["contribucion_mxn"]).toBe(1518);
    expect(resto["infra_mxn"]).not.toBeNull();
    const sinInfra = await correr(fuentesFalsas({ infra: async () => ({ ok: false, razon: "no_migrado" }) }), "pyl");
    expect(sinInfra.status).toBe("ok");
    expect(sinInfra.source).toMatch(/Sin dato: .*infraestructura/);
    expect((sinInfra.rows[0] as Record<string, number | null>)["infra_mxn"]).toBeNull();
    const rota = await correr(fuentesFalsas({ cfoFilas: async () => ({ ok: false, razon: "no_migrado" }) }), "pyl");
    expect(rota.status).toBe("unavailable");
  });

  it("contratos_por_vencer: solo la version vigente de cada contrato dentro de la ventana, con dias restantes; sin vigencia final no vence", async () => {
    const r = await correr(fuentesFalsas(), "contratos_por_vencer", { dias: 30 });
    // c1 v1 vence el 20-oct pero su version 2 (vigente) llega a 2027; c2 vence el 25-oct; c3 no tiene fin.
    expect(r.rows).toHaveLength(1);
    expect(fila(r)).toMatchObject({ organizacion: "Hotel Bahía", vigente_hasta: "2026-10-25", dias_restantes: 23, base_mxn: 2500, version: 1 });
    expect(r.summary).toBe("1 contratos vencen en los próximos 30 días.");
    expect(r.source).toMatch(/dias=30/);
    const vacio = await correr(fuentesFalsas(), "contratos_por_vencer", { dias: 5 });
    expect(vacio.rows).toEqual([]);
    expect(AHORA.getUTCFullYear()).toBe(2026);
    const rota = await correr(fuentesFalsas({ contratos: async () => ({ ok: false, razon: "no_migrado" }) }), "contratos_por_vencer");
    expect(rota.message).toMatch(/^No tengo el dato/);
  });

  it("facturacion_cobranza: cuenta por estado de cobro, pone primero el pago pendiente y NO expone correos ni ids de Stripe", async () => {
    const r = await correr(fuentesFalsas(), "facturacion_cobranza");
    expect(r.status).toBe("ok");
    expect(r.summary).toBe("3 organizaciones: 1 con suscripción activa, 1 con pago pendiente, 0 canceladas y 1 sin suscripción.");
    expect(r.rows).toHaveLength(3);
    expect(fila(r)).toMatchObject({ organizacion: "Hotel Bahía", estado_cobro: "pago_pendiente", asientos: 1, periodo_hasta: "2026-10-05" });
    expect(r.columns.map((c) => c.key)).toEqual(["organizacion", "vertical", "estado_cobro", "asientos", "periodo_hasta"]);
    expect(JSON.stringify(r)).not.toMatch(/cus_|sub_|price_/);
    const morosas = await correr(fuentesFalsas(), "facturacion_cobranza", { estado: "pago_pendiente" });
    expect(morosas.rows).toHaveLength(1);
    expect(morosas.source).toMatch(/estado=pago_pendiente/);
    const rota = await correr(fuentesFalsas({ facturacion: async () => ({ ok: false, razon: "no_migrado" }) }), "facturacion_cobranza");
    expect(rota.status).toBe("unavailable");
    expect(rota.message).toMatch(/^No tengo el dato/);
  });

  it("SIN step-up ninguna herramienta financiera devuelve cifras: deja una fila 'denegado' y NO una de 'consulta'", async () => {
    const f = fuentesFalsas();
    const sinStepUp = { ...SCOPE_SUPERADMIN, stepUp: false };
    for (const nombre of HERRAMIENTAS_FINANCIERAS) {
      const r = await correr(f, nombre, {}, sinStepUp);
      expect(r.status, nombre).toBe("unavailable");
      expect(r.message, nombre).toMatch(/^No tengo el dato: las consultas financieras exigen verificar tu código MFA/);
      expect(r.rows, nombre).toEqual([]);
    }
    expect(f.accesosCfo.map((a) => a.accion)).toEqual(HERRAMIENTAS_FINANCIERAS.map(() => "denegado"));
    expect(f.accesosCfo.map((a) => a.recurso)).toEqual(HERRAMIENTAS_FINANCIERAS.map((n) => `copiloto/${n} (sin step-up)`));
  });

  it("cada llamada financiera con step-up deja EXACTAMENTE una fila de 'consulta' ANTES de leer el dato", async () => {
    const orden: string[] = [];
    const f = fuentesFalsas({
      registrarAccesoCfo: async (accion, recurso) => {
        orden.push(`log:${accion}:${recurso}`);
        return "ok";
      },
      cfoFilas: async () => {
        orden.push("lee:cfoFilas");
        return ok([FILA_CFO]);
      },
      contratos: async () => {
        orden.push("lee:contratos");
        return ok([]);
      },
    });
    await correr(f, "mrr");
    await correr(f, "contratos_por_vencer");
    expect(orden).toEqual(["log:consulta:copiloto/mrr", "lee:cfoFilas", "log:consulta:copiloto/contratos_por_vencer", "lee:contratos"]);
  });

  it("si NO se puede registrar la huella (error de bitacora) la consulta financiera NO se ejecuta", async () => {
    let leyo = false;
    const f = fuentesFalsas({
      registrarAccesoCfo: async () => "error",
      cfoFilas: async () => {
        leyo = true;
        return ok([FILA_CFO]);
      },
    });
    const r = await correr(f, "mrr");
    expect(r.status).toBe("unavailable");
    expect(r.message).toMatch(/no pude registrar la consulta financiera/);
    expect(leyo).toBe(false);
  });

  it("con la zona CFO sin migrar (sin bitacora posible) la consulta sigue el comportamiento anterior: se ejecuta", async () => {
    const f = fuentesFalsas({ registrarAccesoCfo: async () => "no_migrado" });
    const r = await correr(f, "mrr");
    expect(r.status).toBe("ok");
  });

  it("el rol finanzas corre las financieras igual (mismas cifras que el superadmin)", async () => {
    const a = await correr(fuentesFalsas(), "mrr", {}, SCOPE_SUPERADMIN);
    const b = await correr(fuentesFalsas(), "mrr", {}, SCOPE_FINANZAS);
    expect(b.rows).toEqual(a.rows);
  });

describe("mes en curso de las herramientas CFO", () => {
  it("usa la zona de la plataforma: a las 03:00 UTC del 1 de octubre en Mexico todavia es septiembre", async () => {
    const ctx = { ...ctxHerramienta(SCOPE_SUPERADMIN, new Date("2026-10-01T03:00:00.000Z")) };
    const t = herramienta(fuentesFalsas(), "mrr");
    const r = await t.run(ctx, {});
    expect(JSON.stringify(r)).toMatch(/2026-09/);
    expect(JSON.stringify(r)).not.toMatch(/2026-10/);
  });
});

});
