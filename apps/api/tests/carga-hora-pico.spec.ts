// R-36 — prueba de carga de hora pico del webhook de Meta, por HTTP real (app.request)
// sobre repositorios en memoria. Corre en el gate normal con una carga chica (rapida y sin flakiness); para la corrida
// grande de capacidad (docs/CAPACIDAD-Y-COSTO.md):
//     CARGA_CLIENTES=500 CARGA_MENSAJES_META=200 npx vitest run apps/api/tests/carga-hora-pico.spec.ts --maxWorkers=2
// Mide la capa de aplicacion (Hono + reglas + limites de tasa), NO Postgres, red, Vercel ni Meta. Cero envios reales.
import { createHmac, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.ts";
import { buildTestDeps, TEST_ENV } from "./fixtures.ts";
import { configuracionDeCarga, evaluarUmbral, percentil, resumir, type Muestra } from "../../../scripts/load-test-horario-pico/metricas.ts";

const { clientes: CLIENTES, mensajesMeta: MENSAJES_META, reportar: REPORTAR } = configuracionDeCarga();
const UMBRAL = { p95MsMax: 1500, errores5xxMax: 0 };

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
