// Tests del script de verificacion de solo lectura (scripts/verificar-meta-whatsapp/verificar.ts), siempre con fetch falso.
import { describe, expect, it } from "vitest";
import { PLANTILLAS_AUTOPILOTO } from "../../domain-restaurantes/src/autopiloto/servicio.ts";
import { PLANTILLAS_ESTADO_PEDIDO } from "../../domain-restaurantes/src/order-notifications.ts";
import { PLANTILLAS_ESPERADAS, ejecutar, parseArgs, type Informe } from "../../../scripts/verificar-meta-whatsapp/verificar.ts";

const TOKEN = "EAAFAKEscripttoken0987654321zyxwvu-never-real";
const APP = "555";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

type Rutas = Record<string, unknown | { status: number; body: unknown }>;

/** Fetch falso que enruta por path (sin query). Registra metodo y cuerpo de cada llamada. */
function red(rutas: Rutas) {
  const llamadas: { url: string; method: string | undefined; body: unknown }[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    llamadas.push({ url: String(url), method: init?.method, body: init?.body });
    const ruta = new URL(String(url)).pathname.replace(/^\/v\d+\.0/, "");
    const hit = rutas[ruta];
    if (hit === undefined) return json({ error: { message: `Unsupported get request ${ruta}`, code: 100 } }, 400);
    if (typeof hit === "object" && hit !== null && "status" in hit && "body" in hit) return json((hit as { body: unknown }).body, (hit as { status: number }).status);
    return json(hit);
  }) as unknown as typeof fetch;
  return { fetchImpl, llamadas };
}

const todasAprobadas = PLANTILLAS_ESPERADAS.map((name) => ({ name, language: "es_MX", status: "APPROVED", category: "UTILITY" }));
const numeroVerde = { id: "1", display_phone_number: "+52 999 518 2637", verified_name: "Los Taquitos de PM", quality_rating: "GREEN", platform_type: "CLOUD_API", is_on_biz_app: true, throughput: { level: "STANDARD" }, status: "CONNECTED", name_status: "APPROVED" };

const RUTAS_VERDES: Rutas = {
  "/1": numeroVerde,
  "/100": { id: "100", name: "PM", whatsapp_business_manager_messaging_limit: "TIER_1K" },
  "/100/message_templates": { data: todasAprobadas },
  "/100/subscribed_apps": { data: [{ whatsapp_business_api_data: { id: APP, name: "Atiende" } }] },
};

const ARGS = ["--waba", "100", "--numero", "1=T7 Garcia Lavin", "--json"];

async function correr(rutas: Rutas, argv: readonly string[] = ARGS, entorno: Record<string, string | undefined> = {}) {
  const { fetchImpl, llamadas } = red(rutas);
  const salida: string[] = [];
  const r = await ejecutar(argv, { WHATSAPP_ACCESS_TOKEN: TOKEN, META_APP_ID: APP, ...entorno }, (t) => salida.push(t), fetchImpl);
  return { ...r, salida: salida.join("\n"), llamadas };
}

describe("verificar-meta-whatsapp: semaforo (--json)", () => {
  it("VERDE: codigo 0 y el JSON trae numero, limite, plantillas y app suscrita", async () => {
    const r = await correr(RUTAS_VERDES);
    expect(r.codigo).toBe(0);
    const informe = JSON.parse(r.salida) as Informe;
    expect(informe.semaforo).toBe("verde");
    expect(informe.codigo).toBe(0);
    expect(informe.version_graph).toBe("v21.0");
    expect(informe.numeros[0]).toMatchObject({ etiqueta: "T7 Garcia Lavin", display_phone_number: "+52 999 518 2637", quality_rating: "GREEN", is_on_biz_app: true, throughput: "STANDARD", status: "CONNECTED", name_status: "APPROVED" });
    expect(informe.wabas[0]).toMatchObject({ waba_id: "100", limite_mensajeria: "TIER_1K", app_suscrita: true, plantillas_total: PLANTILLAS_ESPERADAS.length });
    expect(informe.motivos).toEqual([]);
  });

  it("AMARILLO: calidad YELLOW, sin coexistencia y plantillas sin aprobar -> codigo 1", async () => {
    const r = await correr({
      ...RUTAS_VERDES,
      "/1": { ...numeroVerde, quality_rating: "YELLOW", is_on_biz_app: false },
      "/100/message_templates": { data: todasAprobadas.map((p) => (p.name === "pedido_en_camino" ? { ...p, status: "PENDING" } : p)).filter((p) => p.name !== "pedido_recibido") },
    });
    expect(r.codigo).toBe(1);
    const informe = JSON.parse(r.salida) as Informe;
    expect(informe.semaforo).toBe("amarillo");
    const textos = informe.motivos.map((m) => m.texto).join("\n");
    expect(textos).toContain("calidad YELLOW");
    expect(textos).toContain("is_on_biz_app");
    expect(textos).toContain("pedido_en_camino (PENDING)");
    expect(textos).toContain("pedido_recibido (FALTA)");
    expect(informe.motivos.every((m) => m.nivel === "amarillo")).toBe(true);
  });

  it("--sin-coexistencia no exige is_on_biz_app", async () => {
    const r = await correr({ ...RUTAS_VERDES, "/1": { ...numeroVerde, is_on_biz_app: false } }, [...ARGS, "--sin-coexistencia"]);
    expect(r.codigo).toBe(0);
  });

  it("AMARILLO: sin META_APP_ID no se puede comprobar la suscripcion", async () => {
    const r = await correr(RUTAS_VERDES, ARGS, { META_APP_ID: undefined });
    expect(r.codigo).toBe(1);
    expect((JSON.parse(r.salida) as Informe).wabas[0]!.app_suscrita).toBeNull();
  });

  it("ROJO: calidad RED -> codigo 2", async () => {
    const r = await correr({ ...RUTAS_VERDES, "/1": { ...numeroVerde, quality_rating: "RED" } });
    expect(r.codigo).toBe(2);
    expect((JSON.parse(r.salida) as Informe).motivos.map((m) => m.texto).join()).toContain("calidad RED");
  });

  it("ROJO: app no suscrita -> codigo 2", async () => {
    const r = await correr({ ...RUTAS_VERDES, "/100/subscribed_apps": { data: [{ whatsapp_business_api_data: { id: "999", name: "Otra" } }] } });
    expect(r.codigo).toBe(2);
    const informe = JSON.parse(r.salida) as Informe;
    expect(informe.wabas[0]!.app_suscrita).toBe(false);
    expect(informe.motivos.map((m) => m.texto).join()).toContain("no aparece en subscribed_apps");
  });

  it("ROJO: numero inexistente (Graph 400/100) -> codigo 2", async () => {
    const r = await correr({ ...RUTAS_VERDES, "/1": { status: 400, body: { error: { message: "Unsupported get request", code: 100 } } } });
    expect(r.codigo).toBe(2);
    const informe = JSON.parse(r.salida) as Informe;
    expect(informe.numeros[0]!.leido).toBe(false);
    expect(informe.numeros[0]!.semaforo).toBe("rojo");
  });

  it("ROJO: token invalido (190) corta la verificacion y no lo imprime", async () => {
    const r = await correr({ "/1": { status: 400, body: { error: { message: `Invalid OAuth access token ${TOKEN}`, code: 190 } } } });
    expect(r.codigo).toBe(2);
    expect((JSON.parse(r.salida) as Informe).motivos[0]!.texto).toContain("token invalido");
    expect(r.salida).not.toContain(TOKEN);
    expect(r.llamadas).toHaveLength(1);
  });

  it("AMARILLO: 5xx / 429 en el numero es 'no se pudo verificar', no 'inexistente'", async () => {
    for (const status of [429, 503]) {
      const r = await correr({ ...RUTAS_VERDES, "/1": { status, body: { error: { message: "busy", code: 4 } } } });
      expect(r.codigo).toBe(1);
      expect((JSON.parse(r.salida) as Informe).motivos.map((m) => m.texto).join()).toContain("no se pudo verificar");
    }
  });

  it("campos faltantes: la WABA sin limite ni nombre no rompe y se informa como no informado", async () => {
    const r = await correr({ ...RUTAS_VERDES, "/100": { id: "100" }, "/1": { id: "1" } }, ["--waba", "100", "--numero", "1=T7"]);
    expect(r.codigo).toBe(1);
    expect(r.salida).toContain("limite de mensajeria: no informado");
    expect(r.salida).toContain("SEMAFORO: AMARILLO");
  });

  it("toma las WABA de WHATSAPP_WABA_IDS y la version de WHATSAPP_GRAPH_API_VERSION / --version", async () => {
    const a = await correr(RUTAS_VERDES, ["--numero", "1=T7", "--json"], { WHATSAPP_WABA_IDS: "100", WHATSAPP_GRAPH_API_VERSION: "v22.0" });
    expect((JSON.parse(a.salida) as Informe).version_graph).toBe("v22.0");
    expect(a.llamadas.every((l) => l.url.includes("/v22.0/"))).toBe(true);
    expect(a.llamadas.some((l) => l.url.includes("/100/"))).toBe(true);
    const b = await correr(RUTAS_VERDES, [...ARGS, "--version", "v23.0"], { WHATSAPP_GRAPH_API_VERSION: "v22.0" });
    expect((JSON.parse(b.salida) as Informe).version_graph).toBe("v23.0");
  });
});

describe("verificar-meta-whatsapp: solo lectura y secretos", () => {
  it("cero POST/PUT/DELETE: toda llamada es GET y sin cuerpo (verde, amarillo y rojo)", async () => {
    const corridas = [
      await correr(RUTAS_VERDES),
      await correr({ ...RUTAS_VERDES, "/1": { ...numeroVerde, quality_rating: "YELLOW" } }),
      await correr({ ...RUTAS_VERDES, "/1": { ...numeroVerde, quality_rating: "RED" } }),
      await correr({ "/1": { status: 401, body: {} } }),
    ];
    const llamadas = corridas.flatMap((c) => c.llamadas);
    expect(llamadas.length).toBeGreaterThan(8);
    for (const l of llamadas) {
      expect(l.method).toBe("GET");
      expect(l.body).toBeUndefined();
    }
    const metodos = new Set(llamadas.map((l) => l.method));
    expect([...metodos]).toEqual(["GET"]);
  });

  it("solo consulta los endpoints documentados", async () => {
    const r = await correr(RUTAS_VERDES);
    const paths = r.llamadas.map((l) => new URL(l.url).pathname.replace(/^\/v\d+\.0/, ""));
    expect(new Set(paths)).toEqual(new Set(["/1", "/100", "/100/message_templates", "/100/subscribed_apps"]));
  });

  it("el texto humano tampoco imprime el token, aun si Graph lo devuelve en un error", async () => {
    const r = await correr(
      { ...RUTAS_VERDES, "/100/message_templates": { status: 500, body: { error: { message: `fallo con ${TOKEN}`, code: 1 } } } },
      ["--waba", "100", "--numero", "1=T7"],
    );
    expect(r.salida).toContain("SEMAFORO");
    expect(r.salida).not.toContain(TOKEN);
  });

  it("el texto humano incluye la tabla por numero, el limite y el semaforo", async () => {
    const r = await correr(RUTAS_VERDES, ["--waba", "100", "--numero", "1=T7"]);
    expect(r.salida).toContain("T7");
    expect(r.salida).toContain("Los Taquitos de PM");
    expect(r.salida).toContain("GREEN");
    expect(r.salida).toContain("limite de mensajeria: TIER_1K");
    expect(r.salida).toContain("app suscrita: si");
    expect(r.salida).toContain("SEMAFORO: VERDE");
  });
});

describe("verificar-meta-whatsapp: uso", () => {
  it("sin WHATSAPP_ACCESS_TOKEN: codigo 3 y no llama a la red", async () => {
    const { fetchImpl, llamadas } = red({});
    const salida: string[] = [];
    const r = await ejecutar(ARGS, {}, (t) => salida.push(t), fetchImpl);
    expect(r.codigo).toBe(3);
    expect(salida.join()).toContain("WHATSAPP_ACCESS_TOKEN");
    expect(llamadas).toHaveLength(0);
  });

  it("argumentos invalidos: codigo 3", async () => {
    for (const argv of [["--nada"], ["--version", "21"], ["--waba"], ["--numero", "=x"], []]) {
      const r = await correr(RUTAS_VERDES, argv);
      expect(r.codigo).toBe(3);
      expect(r.llamadas).toHaveLength(0);
    }
  });

  it("--help: codigo 0", async () => {
    expect((await correr({}, ["--help"])).codigo).toBe(0);
  });

  it("parseArgs: repetibles, etiqueta con '=' y valor por defecto de la etiqueta", () => {
    const o = parseArgs(["--waba", "1", "--waba", "2", "--numero", "10=T1 a=b", "--numero", "11"]);
    expect(o.wabas).toEqual(["1", "2"]);
    expect(o.numeros).toEqual([{ id: "10", etiqueta: "T1 a=b" }, { id: "11", etiqueta: "11" }]);
  });
});

describe("verificar-meta-whatsapp: plantillas esperadas", () => {
  it("coincide con PLANTILLAS_ESTADO_PEDIDO y PLANTILLAS_AUTOPILOTO del producto", () => {
    const delProducto = [...Object.values(PLANTILLAS_ESTADO_PEDIDO).map((p) => p!.name), ...Object.values(PLANTILLAS_AUTOPILOTO).map((p) => p.name)];
    expect([...PLANTILLAS_ESPERADAS].sort()).toEqual([...delProducto].sort());
  });
});
