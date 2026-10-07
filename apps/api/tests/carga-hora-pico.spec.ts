// R-36 — prueba de carga de hora pico del storefront de restaurantes y del webhook de Meta, por HTTP real (app.request)
// sobre repositorios en memoria. Corre en el gate normal con una carga chica (rapida y sin flakiness); para la corrida
// grande de capacidad (docs/CAPACIDAD-Y-COSTO.md):
//     CARGA_CLIENTES=500 CARGA_MENSAJES_META=200 npx vitest run apps/api/tests/carga-hora-pico.spec.ts --maxWorkers=2
// Mide la capa de aplicacion (Hono + reglas + limites de tasa), NO Postgres, red, Vercel ni Meta. Cero envios reales.
import { createHmac, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.ts";
import { buildTestDeps, jsonRequestInit, TEST_ENV } from "./fixtures.ts";
import { configuracionDeCarga, evaluarUmbral, percentil, resumir, type Muestra } from "../../../scripts/load-test-horario-pico/metricas.ts";

const { clientes: CLIENTES, mensajesMeta: MENSAJES_META, reportar: REPORTAR } = configuracionDeCarga();
const UMBRAL = { p95MsMax: 1500, errores5xxMax: 0 };
const BASE = "/v1/restaurantes/los-taquitos-de-pm/storefront";
const ip = (i: number) => `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`;

const reportar = (nombre: string, r: ReturnType<typeof resumir>) => {
  if (REPORTAR) console.log(`${nombre.padEnd(28)} n=${r.total} ok=${r.ok} 429=${r.limitadas429} 5xx=${r.errores5xx} p50=${r.p50.toFixed(0)}ms p95=${r.p95.toFixed(0)}ms p99=${r.p99.toFixed(0)}ms max=${r.max.toFixed(0)}ms rss=${(process.memoryUsage().rss / 1048576).toFixed(0)}MiB`);
};

async function medido(f: () => Response | Promise<Response>) {
  const t = performance.now();
  const res = await f();
  return { muestra: { ms: performance.now() - t, status: res.status } as Muestra, res };
}

function loteMeta(n: number) {
  const payload = {
    entry: [{ changes: [{ value: { metadata: { phone_number_id: "1234567890" }, messages: Array.from({ length: n }, (_, i) => ({ id: `wamid.carga.${i}.${randomUUID()}`, from: `52999${String(2000000 + i)}`, type: "text", text: { body: "Hola" } })) } }] }],
  };
  const raw = JSON.stringify(payload);
  const bytes = new TextEncoder().encode(raw);
  const firma = `sha256=${createHmac("sha256", TEST_ENV.whatsappAppSecret).update(bytes).digest("hex")}`;
  return { method: "POST", body: raw, headers: { "content-type": "application/json", "content-length": String(bytes.byteLength), "x-hub-signature-256": firma, "x-forwarded-for": "198.51.100.7" } } satisfies RequestInit;
}

describe("metricas del arnes", () => {
  it("percentil por rango mas cercano", () => {
    const v = Array.from({ length: 100 }, (_, i) => i + 1);
    expect([percentil(v, 50), percentil(v, 95), percentil(v, 99), percentil([], 95)]).toEqual([50, 95, 99, 0]);
  });
  it("evaluarUmbral marca p95 alto, 5xx y falta de muestras", () => {
    const lento = resumir([{ ms: 3000, status: 200 }, { ms: 10, status: 500 }]);
    expect(evaluarUmbral("x", lento, UMBRAL)).toHaveLength(2);
    expect(evaluarUmbral("x", resumir([]), UMBRAL)).toEqual(["x: sin muestras"]);
    expect(evaluarUmbral("x", resumir([{ ms: 5, status: 200 }, { ms: 6, status: 429 }]), UMBRAL)).toEqual([]);
  });
});

describe(`hora pico: ${CLIENTES} clientes simultaneos, lote Meta de ${MENSAJES_META} mensajes`, () => {
  beforeEach(() => {
    // La bandera de SoftRestaurant no existe en el motor en memoria y su aviso inunda la salida; no es parte de lo medido.
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it("menu y pedidos concurrentes: sin 5xx, p95 dentro de umbral, tokens unicos y total siempre calculado por el servidor", async () => {
    const t = await buildTestDeps();
    const app = buildApp(t.deps);
    const post = (path: string, body: unknown, headers: Record<string, string>) => app.request(`${BASE}${path}`, jsonRequestInit(body, headers));

    const lecturas = await Promise.all(Array.from({ length: CLIENTES }, (_, i) => medido(() => app.request(`${BASE}/fco-montejo/menu`, { headers: { "x-forwarded-for": ip(i + 1) } }))));
    reportar("menu", resumir(lecturas.map((x) => x.muestra)));
    expect(evaluarUmbral("menu", resumir(lecturas.map((x) => x.muestra)), UMBRAL)).toEqual([]);
    expect(lecturas.every((x) => x.muestra.status === 200)).toBe(true);

    const pedidos = await Promise.all(
      Array.from({ length: CLIENTES }, async (_, i) => {
        const headers = { origin: "http://localhost:5173", "x-forwarded-for": ip(i + 1) };
        const session_id = `carga-${i}-${randomUUID().replaceAll("-", "")}`.slice(0, 40);
        const body = { session_id, items: [{ product_id: t.products.cocaCola, requested_quantity: 2 }], canal: "recoger", payment_method: "efectivo" };
        const q = await medido(() => post("/fco-montejo/quote", body, headers));
        const quote = (await q.res.json()) as { quote_hash: string };
        const c = await medido(() => post("/fco-montejo/confirm", { session_id, quote_hash: quote.quote_hash }, headers));
        const o = await medido(() => post("/fco-montejo/orders", { ...body, quote_hash: quote.quote_hash, acepta_aviso_privacidad: true, customer_name: `Cliente ${i}`, customer_phone: `99${String(10000000 + i)}` }, headers));
        const creado = (await o.res.json()) as { rastreo_token?: string; total?: number };
        return { m: [q.muestra, c.muestra, o.muestra], creado };
      }),
    );
    for (const [idx, nombre] of ["cotizar", "confirmar", "crear"].entries()) {
      const r = resumir(pedidos.map((p) => p.m[idx]!));
      reportar(nombre, r);
      expect(evaluarUmbral(nombre, r, UMBRAL)).toEqual([]);
      expect(r.ok).toBe(CLIENTES);
    }
    const tokens = pedidos.map((p) => p.creado.rastreo_token);
    expect(new Set(tokens).size).toBe(CLIENTES);
    expect(pedidos.every((p) => p.creado.total === 90)).toBe(true);
  }, 60_000);

  it("una sola IP insistente recibe 429 y nunca 5xx", async () => {
    const t = await buildTestDeps();
    const app = buildApp(t.deps);
    const r = resumir((await Promise.all(Array.from({ length: 150 }, () => medido(() => app.request(`${BASE}/fco-montejo/menu`, { headers: { "x-forwarded-for": "203.0.113.9" } }))))).map((x) => x.muestra));
    expect(r.limitadas429).toBe(30);
    expect(r.ok).toBe(120);
    expect(r.errores5xx).toBe(0);
  });

  it("IP compartida (wifi de una plaza, CGNAT movil): a partir del pedido 11 en un minuto el storefront responde 429, nunca 5xx", async () => {
    // Caracterizacion del tope vigente (storefront.ts: 10 pedidos/min por IP + restaurante), medido por primera vez en R-36.
    // Si alguien lo sube o lo cambia de llave, este test falla a proposito para actualizar docs/CAPACIDAD-Y-COSTO.md.
    const t = await buildTestDeps();
    const app = buildApp(t.deps);
    const headers = { origin: "http://localhost:5173", "x-forwarded-for": "192.0.2.50" };
    const estados: number[] = [];
    for (let i = 0; i < 12; i++) {
      const session_id = `plaza-${i}-${randomUUID().replaceAll("-", "")}`.slice(0, 40);
      const body = { session_id, items: [{ product_id: t.products.cocaCola, requested_quantity: 1 }], canal: "recoger", payment_method: "efectivo" };
      const q = (await (await app.request(`${BASE}/fco-montejo/quote`, jsonRequestInit(body, headers))).json()) as { quote_hash: string };
      await app.request(`${BASE}/fco-montejo/confirm`, jsonRequestInit({ session_id, quote_hash: q.quote_hash }, headers));
      estados.push((await app.request(`${BASE}/fco-montejo/orders`, jsonRequestInit({ ...body, quote_hash: q.quote_hash, acepta_aviso_privacidad: true, customer_name: `C${i}`, customer_phone: `99${String(30000000 + i)}` }, headers))).status);
    }
    expect(estados.filter((s) => s === 200)).toHaveLength(10);
    expect(estados.filter((s) => s === 429)).toHaveLength(2);
    expect(estados.filter((s) => s >= 500)).toHaveLength(0);
  });

  it("lote de Meta: un POST firmado con N mensajes procesa cada uno exactamente una vez y responde 200", async () => {
    const t = await buildTestDeps();
    let turnos = 0;
    const base = t.deps.turnHandler;
    const app = buildApp({ ...t.deps, turnHandler: { handleInboundMessage: async (a) => { turnos++; return base.handleInboundMessage(a); } } });
    const { muestra } = await medido(() => app.request("/v1/restaurantes/whatsapp/webhook", loteMeta(MENSAJES_META)));
    reportar(`lote Meta ${MENSAJES_META} msgs`, resumir([muestra]));
    expect(muestra.status).toBe(200);
    expect(turnos).toBe(MENSAJES_META);
    expect(muestra.ms).toBeLessThan(UMBRAL.p95MsMax * 4);
  }, 60_000);

  it("los turnos de un lote corren en serie dentro de UN POST: el tiempo crece con (mensajes x latencia del turno)", async () => {
    const t = await buildTestDeps();
    const base = t.deps.turnHandler;
    const LATENCIA_MS = 15;
    const N = 20;
    const app = buildApp({ ...t.deps, turnHandler: { handleInboundMessage: async (a) => { await new Promise((r) => setTimeout(r, LATENCIA_MS)); return base.handleInboundMessage(a); } } });
    const { muestra } = await medido(() => app.request("/v1/restaurantes/whatsapp/webhook", loteMeta(N)));
    expect(muestra.status).toBe(200);
    // Serie: no puede bajar de N x latencia. Si algun dia se paraleliza, este assert falla a proposito y obliga a
    // actualizar docs/CAPACIDAD-Y-COSTO.md (limite de ~30 s por POST => mensajes por lote x latencia del LLM).
    expect(muestra.ms).toBeGreaterThanOrEqual(N * LATENCIA_MS * 0.9);
  });
});
