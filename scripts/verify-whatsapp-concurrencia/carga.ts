// Prueba de carga REPRODUCIBLE del webhook de WhatsApp de restaurantes (P0 "6+ mensajes simultaneos -> HTTP 500 tras 10 s").
//
// Corre la API REAL de produccion (`buildProductionDeps` + `buildApp`, con el MISMO motor de pool, el turn handler real y el
// gateway de LLM real con su presupuesto/uso en Postgres) contra un Postgres real efimero con las migraciones reales. Solo se
// SIMULAN las dos salidas de red: OpenRouter (respuesta fija con latencia configurable) y la Graph API de Meta (servidor local).
// Mide el pico de conexiones del pool y exige: todos los webhooks responden 200, ningun mensaje se pierde ni se duplica, y el
// reenvio del mismo `message.id` no responde dos veces.
//
// Uso: DATABASE_URL=postgres://... vite-node scripts/verify-whatsapp-concurrencia/carga.ts [LLM_MS]
import { createHmac, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import pg from "pg";

const LLM_MS = Number(process.argv[2] ?? process.env.LLM_MS ?? 600);
const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) throw new Error("falta DATABASE_URL (Postgres efimero del verify)");
const APP_SECRET = "verify-whatsapp-app-secret-local";
const PHONE_NUMBER_ID = "5550009999";
const ORG_ID = "00000000-0000-0000-0000-0000000e0a01";

Object.assign(process.env, {
  JWT_SECRET: "verify-jwt-secret-local-0123456789abcdef", VOICE_TOOL_SECRET: "verify-voice-tool-secret-local", WHATSAPP_VERIFY_TOKEN: "verify-token",
  WHATSAPP_APP_SECRET: APP_SECRET, INTERNAL_SECRET: "verify-internal-secret-local", RENTAS_OWNER_JWT_SECRET: "verify-rentas-owner-secret-local-0123456789",
  WHATSAPP_ACCESS_TOKEN: "verify-graph-token-local", NODE_ENV: "development", VOICE_PREVIEW_TOKEN_SECRET: "verify-voice-preview-secret-local",
  ALLOWED_ORIGINS: "http://localhost:5173", OPENROUTER_API_KEY: "verify-fake-openrouter-key",
});

// Pico de conexiones simultaneas del pool (instrumenta `pg.Pool.connect` sin tocar el motor).
let activas = 0;
let pico = 0;
const connectOriginal = (pg.Pool.prototype as unknown as { connect: (...a: unknown[]) => Promise<pg.PoolClient> | void }).connect;
(pg.Pool.prototype as unknown as { connect: unknown }).connect = function (this: pg.Pool, ...a: unknown[]) {
  if (a.length) return connectOriginal.apply(this, a);
  return (connectOriginal.call(this) as Promise<pg.PoolClient>).then((c) => {
    activas += 1;
    pico = Math.max(pico, activas);
    const liberar = c.release.bind(c);
    let hecho = false;
    c.release = ((e?: Error | boolean) => {
      if (!hecho) {
        hecho = true;
        activas -= 1;
      }
      return liberar(e as never);
    }) as typeof c.release;
    return c;
  });
};

// OpenRouter SIMULADO: respuesta fija tras `LLM_MS`. Cualquier otro destino pasa al fetch real (solo el Graph local).
let llamadasLlm = 0;
const fetchReal = globalThis.fetch;
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!url.includes("openrouter.ai")) return fetchReal(input, init);
  llamadasLlm += 1;
  await new Promise((r) => setTimeout(r, LLM_MS));
  return new Response(
    JSON.stringify({ id: "gen-verify", model: "verify/modelo", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "Hola, con gusto te ayudo con tu pedido." } }], usage: { prompt_tokens: 1000, completion_tokens: 20, total_tokens: 1020 } }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}) as typeof fetch;

// Meta SIMULADO (Graph API): acepta todo y cuenta lo saliente.
let salientes = 0;
const graph = createServer((req, res) => {
  req.on("data", () => undefined);
  req.on("end", () => {
    salientes += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ messaging_product: "whatsapp", messages: [{ id: `wamid.OUT${randomUUID().slice(0, 8)}` }] }));
  });
});
await new Promise<void>((r) => graph.listen(0, "127.0.0.1", r));
const graphUrl = `http://127.0.0.1:${(graph.address() as AddressInfo).port}`;

process.env.DATABASE_URL = DB_URL;
const { buildApp } = await import("../../apps/api/src/app.ts");
const { buildProductionDeps } = await import("../../apps/api/src/production/deps.ts");
const { MetaGraphWhatsAppClient, WhatsAppOutboundDispatcher } = await import("../../packages/whatsapp-gateway/src/index.ts");
const prod = buildProductionDeps();
const app = buildApp({ ...prod, whatsAppDispatcher: new WhatsAppOutboundDispatcher({ graphClient: new MetaGraphWhatsAppClient({ accessToken: "x", baseUrl: graphUrl }) }) } as never);

const firmar = (raw: string) => `sha256=${createHmac("sha256", APP_SECRET).update(raw).digest("hex")}`;
const telefono = () => `5219${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`;
interface Envio { readonly id: string; readonly raw: string; readonly firma: string }
function armar(from: string, body: string, id = `wamid.VF${randomUUID().slice(0, 12)}`): Envio {
  const payload = { object: "whatsapp_business_account", entry: [{ id: "W", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { display_phone_number: "5219990000000", phone_number_id: PHONE_NUMBER_ID }, contacts: [{ profile: { name: "Cliente" }, wa_id: from }], messages: [{ id, from, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body } }] } }] }] };
  const raw = JSON.stringify(payload);
  return { id, raw, firma: firmar(raw) };
}
async function enviar(e: Envio): Promise<{ status: number; ms: number }> {
  const bytes = new TextEncoder().encode(e.raw);
  const t0 = Date.now();
  const r = await app.fetch(new Request("http://local/v1/restaurantes/whatsapp/webhook", { method: "POST", headers: { "content-type": "application/json", "content-length": String(bytes.byteLength), "x-hub-signature-256": e.firma }, body: bytes }));
  await r.text();
  return { status: r.status, ms: Date.now() - t0 };
}

const cliente = new pg.Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
await cliente.connect();
const contar = async (sql: string): Promise<number> => Number((await cliente.query(sql)).rows[0].n);

let fallos = 0;
const exigir = (ok: boolean, mensaje: string) => {
  console.log(`${ok ? "OK   " : "FALLA"} ${mensaje}`);
  if (!ok) fallos += 1;
};

const NIVELES = [1, 4, 6, 10, 20];
for (const n of NIVELES) {
  const antesProcesados = await contar(`select count(*)::int as n from restaurantes.whatsapp_inbound_events where organization_id = '${ORG_ID}' and status = 'processed'`);
  const antesOutbox = await contar(`select count(*)::int as n from restaurantes.messaging_outbox where organization_id = '${ORG_ID}'`);
  pico = 0;
  const envios = Array.from({ length: n }, () => armar(telefono(), "hola, cuanto cuesta el taco de pastor?"));
  const t0 = Date.now();
  const resultados = await Promise.all(envios.map(enviar));
  const total = Date.now() - t0;
  const no200 = resultados.filter((r) => r.status !== 200);
  exigir(no200.length === 0, `${n} mensajes simultaneos: ${resultados.length - no200.length}/${n} con HTTP 200 (total ${total} ms, pico ${pico} conexiones, LLM simulado ${LLM_MS} ms)${no200.length ? ` -- estados no-200: ${[...new Set(no200.map((r) => r.status))].join(",")}` : ""}`);
  const procesados = (await contar(`select count(*)::int as n from restaurantes.whatsapp_inbound_events where organization_id = '${ORG_ID}' and status = 'processed'`)) - antesProcesados;
  const outbox = (await contar(`select count(*)::int as n from restaurantes.messaging_outbox where organization_id = '${ORG_ID}'`)) - antesOutbox;
  exigir(procesados === n, `${n} mensajes simultaneos: ${procesados}/${n} procesados exactamente una vez (ninguno perdido)`);
  exigir(outbox === n, `${n} mensajes simultaneos: ${outbox}/${n} respuestas encoladas (ninguna perdida ni duplicada)`);
}

// Reenvio de Meta (at-least-once): el MISMO message.id enviado dos veces responde 200 y NO genera otra respuesta.
{
  const e = armar(telefono(), "hola, una sola respuesta por favor");
  const primero = await enviar(e);
  const antes = await contar(`select count(*)::int as n from restaurantes.messaging_outbox where organization_id = '${ORG_ID}'`);
  const reenvios = await Promise.all([enviar(e), enviar(e), enviar(e)]);
  const despues = await contar(`select count(*)::int as n from restaurantes.messaging_outbox where organization_id = '${ORG_ID}'`);
  exigir(primero.status === 200 && reenvios.every((r) => r.status === 200), `reenvio del mismo message.id: 200 en el primero y en los 3 reintentos simultaneos`);
  exigir(despues === antes, `reenvio del mismo message.id: ninguna respuesta duplicada (${despues - antes} nuevas)`);
}

// Fase 2: pedido de punta a punta por canal con el rol y la sesion EXACTOS de produccion (authenticated, auth.uid() NULL).
// Antes de la migracion 043 cada uno de estos pasos fallaba con "permission denied for table customers".
{
  const ORG_SLUG = "carga-whatsapp";
  const PRODUCTO = "00000000-0000-4000-8000-0000000e0d01";
  const VOZ = { "x-atiende-tool-secret": process.env.VOICE_TOOL_SECRET ?? "", "content-type": "application/json" };
  const pedir = async (headers: Record<string, string>, body: Record<string, unknown>): Promise<{ status: number; json: RespuestaPedido }> => {
    const r = await app.fetch(new Request(`http://local/v1/restaurantes/${ORG_SLUG}/orders`, { method: "POST", headers, body: JSON.stringify({ branch_slug: "sucursal-carga", items: [{ product_id: PRODUCTO, requested_quantity: 2 }], ...body }) }));
    return { status: r.status, json: (await r.json().catch(() => ({}))) as RespuestaPedido };
  };
  interface RespuestaPedido { readonly order?: { readonly id?: string } }
  const telCliente = `99${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
  const telVoz = `99${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;

  // Canal voz (el checkout web ya no existe): cliente NUEVO a domicilio registra order_count = 1.
  const w1 = await pedir(VOZ, { customer_name: "Cliente Recurrente", customer_phone: telCliente, customer_address: "Calle 10 #100", payment_method: "efectivo", source: "voice", canal: "domicilio" });
  exigir(w1.status === 200 && Boolean(w1.json.order?.id), `canal voz, cliente nuevo a domicilio (alta): HTTP ${w1.status} con pedido creado${w1.status !== 200 ? ` (${JSON.stringify(w1.json).slice(0, 160)})` : ""}`);
  const cw = await cliente.query("select id, order_count from restaurantes.customers where organization_id = $1 and phone like $2", [ORG_ID, `%${telCliente}`]);
  exigir(cw.rowCount === 1 && cw.rows[0].order_count === 1, "canal voz: el cliente nuevo quedo registrado con order_count = 1");
  // Canal voz: cliente EXISTENTE con otra direccion.
  const w2 = await pedir(VOZ, { customer_name: "Cliente Recurrente", customer_phone: telCliente, customer_address: "Calle 20 #200", payment_method: "tarjeta", source: "voice", canal: "domicilio", notes: "segundo pedido" });
  exigir(w2.status === 200 && Boolean(w2.json.order?.id), `canal voz, cliente existente con otra direccion: HTTP ${w2.status}`);
  const direcciones = await contar(`select count(*)::int as n from restaurantes.customer_addresses a join restaurantes.customers c on c.id = a.customer_id where c.organization_id = '${ORG_ID}' and c.phone like '%${telCliente}'`);
  const clientes = await contar(`select count(*)::int as n from restaurantes.customers where organization_id = '${ORG_ID}' and phone like '%${telCliente}'`);
  exigir(clientes === 1 && direcciones === 2, `canal voz: un solo cliente con 2 direcciones (${clientes} cliente(s), ${direcciones} direccion(es))`);

  // Canal voz (secreto de herramienta): cliente nuevo, domicilio.
  const v1 = await pedir(VOZ, { customer_name: "Cliente Voz", customer_phone: telVoz, customer_address: "Calle 30 #300", payment_method: "efectivo", source: "voice", canal: "domicilio" });
  exigir(v1.status === 200 && Boolean(v1.json.order?.id), `canal voz, cliente nuevo a domicilio: HTTP ${v1.status}${v1.status !== 200 ? ` (${JSON.stringify(v1.json).slice(0, 160)})` : ""}`);
  const pedidosVoz = await contar(`select count(*)::int as n from restaurantes.orders where organization_id = '${ORG_ID}' and source = 'voice' and customer_phone like '%${telVoz}'`);
  exigir(pedidosVoz === 1, "canal voz: exactamente un pedido guardado");

  // Aviso "devolver la llamada" / escalar a humano (agentes de voz y WhatsApp) por el repositorio real y su sesion de sistema.
  const { registerCallbackRequest } = await import("../../packages/domain-restaurantes/src/index.ts");
  const aviso = await prod.engine.withAppSession({ userId: null }, (db) =>
    registerCallbackRequest(prod.restaurantesRepo(db), { organizationId: ORG_ID, propertyId: "00000000-0000-0000-0000-0000000e0b01", customerName: "Cliente Aviso", customerPhone: "+529990001234", reason: "queja", message: "Prueba de aviso", source: "whatsapp" }),
  );
  exigir(Boolean(aviso.id), "aviso (escalar_a_humano / registrar_contacto): creado por la sesion de sistema");
  exigir((await contar(`select count(*)::int as n from restaurantes.callback_requests where organization_id = '${ORG_ID}' and customer_phone = '+529990001234'`)) === 1, "aviso: una sola fila guardada");
}

console.log(`llamadas al LLM simulado: ${llamadasLlm}; mensajes enviados a la Graph simulada: ${salientes}`);
await cliente.end();
console.log(fallos === 0 ? "verify-whatsapp-concurrencia: TODO OK" : `verify-whatsapp-concurrencia: ${fallos} comprobaciones FALLARON`);
process.exit(fallos === 0 ? 0 : 1);
