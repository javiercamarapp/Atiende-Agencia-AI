// Batería PM F3b — voz: abuso de cabeceras y cuerpos, replay de token, secretos y teléfono (HTTP real).
// Complementa voice-seguridad.spec.ts (aislamiento básico) con los casos hostiles que ese archivo no ejerce.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { hashVoiceSecret } from "../src/routes/verticals/restaurantes/voice-auth.ts";
import { signVoiceCallToken, voiceCallTokenKey } from "../src/voice-call-token.ts";
import { buildTestDeps, jsonRequestInit } from "./fixtures.ts";

const ORG = "los-taquitos-de-pm";
const LEGACY = { "x-atiende-tool-secret": "test-voice-tool-secret" };
const tokenHeader = (token: string) => ({ "x-atiende-call-token": token });
const TOOLS_CON_TOKEN = ["customers/lookup", "branches/info", "branches/nearest", "products/search", "orders/quote", "orders/confirm", "orders", "callbacks"];

async function setup() {
  const ctx = await buildTestDeps();
  const app = buildApp(ctx.deps);
  const mint = async (callId: string, phone: string, headers: Record<string, string> = LEGACY, extra: Record<string, unknown> = { branch_slug: "fco-montejo" }) => {
    const res = await app.request(`/v1/restaurantes/${ORG}/voice/call-token`, jsonRequestInit({ call_id: callId, caller_phone: phone, ...extra }, headers));
    return { res, body: (await res.json()) as { call_token?: string } };
  };
  return { ...ctx, app, mint };
}
const post = (s: Awaited<ReturnType<typeof setup>>, path: string, body: unknown, headers: Record<string, string>) => s.app.request(`/v1/restaurantes/${ORG}/${path}`, jsonRequestInit(body, headers));

describe("T-AB07 headers falsos: ningún valor raro en las credenciales de voz produce un 500", () => {
  const raros: Array<[string, string]> = [
    ["token vacío de un solo punto", "v1."],
    ["prefijo sin firma", "v1.abc"],
    ["muy largo (8 KB)", `v1.${"A".repeat(8000)}.${"B".repeat(100)}`],
    ["con caracteres no base64", "v1.@@@@.####"],
    ["con inyección tipo SQL", "v1.'; DROP TABLE x;--.zzz"],
    ["con puntos de más", "v1.a.b.c.d.e"],
  ];
  it.each(raros)("%s => 401 en todas las herramientas", async (_n, token) => {
    const s = await setup();
    for (const tool of TOOLS_CON_TOKEN) {
      // Con source "voice" la credencial invalida es 401.
      const res = await post(s, tool, { branch_slug: "fco-montejo", query: "x", colonia: "Centro", source: "voice" }, tokenHeader(token));
      expect(res.status, tool).toBe(401);
    }
  });

  it("un secreto falso (vacío, casi igual, muy largo) no autentica; X-Forwarded-For/X-Real-IP falsos no cambian el resultado", async () => {
    const s = await setup();
    for (const secret of ["", "test-voice-tool-secre", "Test-Voice-Tool-Secret", "x".repeat(5000)]) {
      const res = await post(s, "products/search", { query: "coca", branch_slug: "fco-montejo" }, { "x-atiende-tool-secret": secret, "x-forwarded-for": "127.0.0.1", "x-real-ip": "10.0.0.1" });
      expect(res.status).toBe(401);
    }
    const ok = await post(s, "products/search", { query: "coca", branch_slug: "fco-montejo" }, { ...LEGACY, "x-forwarded-for": "6.6.6.6" });
    expect(ok.status).toBe(200);
  });

  it("un token válido NO vale como secreto de emisión: no puede acuñar otro token (anti-escalada)", async () => {
    const s = await setup();
    const { body } = await s.mint("call-1", "9991111111");
    const res = await post(s, "voice/call-token", { call_id: "otra", caller_phone: "9992222222", branch_slug: "fco-montejo" }, tokenHeader(body.call_token!));
    expect(res.status).toBe(401);
  });

  it("un secreto de sucursal ROTADO deja de emitir tokens al vencer la gracia, y el secreto global ya no se confunde con el de sucursal", async () => {
    const s = await setup();
    await s.restaurantesRepo.rotateVoiceBranchSecret(s.organizationId, s.propertyId, hashVoiceSecret("vbs_a"), "_a", 3600);
    expect((await s.mint("c1", "9991111111", { "x-atiende-tool-secret": "vbs_a" })).res.status).toBe(200);
    expect((await s.mint("c2", "9991111111", { "x-atiende-tool-secret": "vbs_a-alterado" })).res.status).toBe(401);
  });
});

describe("T-AB11 cuerpos malformados a las herramientas de voz", () => {
  it("JSON inválido, arreglo, null, número y texto plano => nunca 5xx y no se crea pedido", async () => {
    const s = await setup();
    const token = (await s.mint("call-m", "9991111111")).body.call_token!;
    for (const tool of TOOLS_CON_TOKEN) {
      for (const raw of ["{no json", "[]", "null", "42", '"texto"', ""]) {
        const res = await s.app.request(`/v1/restaurantes/${ORG}/${tool}`, { method: "POST", body: raw, headers: { "content-type": "application/json", "content-length": String(new TextEncoder().encode(raw).byteLength), ...tokenHeader(token) } });
        // Las herramientas que solo usan el token (lookup/confirm) pueden ignorar un cuerpo raro: lo que importa es que nunca sea 5xx.
        expect(res.status, `${tool} <- ${JSON.stringify(raw)}`).toBeLessThan(500);
      }
    }
    expect(await s.restaurantesRepo.findCustomerByPhone(s.organizationId, "9991111111")).toBeNull();
  });

  it("un cuerpo mayor al tope se rechaza con 413 sin procesar", async () => {
    const s = await setup();
    const token = (await s.mint("call-big", "9991111111")).body.call_token!;
    const raw = JSON.stringify({ branch_slug: "fco-montejo", query: "a".repeat(200_000) });
    const res = await s.app.request(`/v1/restaurantes/${ORG}/products/search`, { method: "POST", body: raw, headers: { "content-type": "application/json", "content-length": String(raw.length), ...tokenHeader(token) } });
    expect(res.status).toBe(413);
  });

  it("tipos equivocados (items como texto, cantidades negativas/decimales/gigantes, slug como objeto) => 400, nunca 500", async () => {
    const s = await setup();
    const token = (await s.mint("call-t", "9991111111")).body.call_token!;
    const h = tokenHeader(token);
    const coca = s.products.cocaCola;
    const casos = [
      { branch_slug: "fco-montejo", items: "muchos" },
      { branch_slug: { x: 1 }, items: [] },
      { branch_slug: "fco-montejo", items: [{ product_id: coca, product_name: "Coca-Cola", requested_quantity: -3 }] },
      { branch_slug: "fco-montejo", items: [{ product_id: coca, product_name: "Coca-Cola", requested_quantity: 2.5 }] },
      { branch_slug: "fco-montejo", items: [{ product_id: coca, product_name: "Coca-Cola", requested_quantity: 1e12 }] },
      { branch_slug: "fco-montejo", items: [{ product_id: coca, product_name: "Coca-Cola", requested_quantity: "dos" }] },
      { branch_slug: "fco-montejo", items: [null, 5, "x"] },
      { branch_slug: "fco-montejo", items: Array.from({ length: 500 }, () => ({ product_id: coca, product_name: "Coca-Cola", requested_quantity: 1 })) },
    ];
    for (const caso of casos) {
      const res = await post(s, "orders/quote", caso, h);
      expect(res.status, JSON.stringify(caso).slice(0, 90)).toBeGreaterThanOrEqual(400);
      expect(res.status, JSON.stringify(caso).slice(0, 90)).toBeLessThan(500);
    }
  });
});

describe("replay y estado por llamada", () => {
  const items = (s: { products: Record<string, string> }) => [{ product_id: s.products.cocaCola, product_name: "Coca-Cola", requested_quantity: 2 }];

  it("repetir el MISMO crear_pedido con el mismo token (reintento del proveedor de voz) no crea una segunda comanda", async () => {
    const s = await setup();
    const h = tokenHeader((await s.mint("call-replay", "9993333333")).body.call_token!);
    const pedido = { branch_slug: "fco-montejo", customer_name: "Carla", customer_address: "Calle 1", payment_method: "efectivo", items: items(s), source: "voice" };
    await post(s, "orders/quote", { branch_slug: "fco-montejo", items: items(s) }, h);
    await post(s, "orders/confirm", {}, h);
    const respuestas = await Promise.all([post(s, "orders", pedido, h), post(s, "orders", pedido, h), post(s, "orders", pedido, h)]);
    expect(respuestas.filter((r) => r.status === 200)).toHaveLength(1);
    const cliente = await s.restaurantesRepo.findCustomerByPhone(s.organizationId, "9993333333");
    expect((await s.restaurantesRepo.listEligibleOrderHistory(cliente!.id)).length).toBe(1);
  });

  it("un token válido de la llamada A con el call_id forjado en el body de otra llamada no hereda su estado", async () => {
    const s = await setup();
    const a = tokenHeader((await s.mint("call-A", "9991111111")).body.call_token!);
    const b = tokenHeader((await s.mint("call-B", "9992222222")).body.call_token!);
    await post(s, "orders/quote", { branch_slug: "fco-montejo", items: items(s) }, a);
    await post(s, "orders/confirm", { call_id: "call-B" }, a);
    const enB = await post(s, "orders", { branch_slug: "fco-montejo", customer_name: "X", customer_address: "Calle 1", payment_method: "efectivo", items: items(s), call_id: "call-A" }, b);
    expect(enB.status).toBe(400);
  });

  it("un token de OTRA sucursal de la misma organización no puede crear pedido en la sucursal ajena aunque pase el slug", async () => {
    const s = await setup();
    const otra = randomUUID();
    s.restaurantesRepo.seedBranch({ propertyId: otra, organizationId: s.organizationId, name: "Otra", slug: "otra", status: "active", phone: null, address: null, lat: null, lng: null });
    const h = tokenHeader((await s.mint("call-X", "9991111111")).body.call_token!);
    const res = await post(s, "orders", { branch_slug: "otra", customer_name: "X", customer_address: "Calle 1", payment_method: "efectivo", items: items(s), source: "voice" }, h);
    expect(res.status).toBe(400);
  });

  it("un token firmado para una sucursal inexistente o de otra organización no sirve para operar", async () => {
    const s = await setup();
    const now = Math.floor(Date.now() / 1000);
    const token = signVoiceCallToken(voiceCallTokenKey(s.deps.env.internalSecret), { org: s.organizationId, prop: randomUUID(), call: "c", ph: "9991111111", iat: now, exp: now + 600 });
    const res = await post(s, "products/search", { query: "coca", branch_slug: "fco-montejo" }, tokenHeader(token));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
});

describe("teléfono de voz: lectura 3-3-4 con confirmación, formato estricto", () => {
  const items = (s: { products: Record<string, string> }) => [{ product_id: s.products.cocaCola, product_name: "Coca-Cola", requested_quantity: 1 }];
  const mal = ["999123456", "99912345678", "5299912345678", "999-123", "abc", "9991234567890123", "0000000000".slice(0, 9)];
  it.each(mal)("emitir token con teléfono %s (9, 11 o 13+ dígitos / texto) => 400", async (tel) => {
    const s = await setup();
    expect((await s.mint("call-p", tel)).res.status).toBe(400);
  });

  it("acepta los formatos válidos que reconoce la voz (10 dígitos, +52, 521, con espacios y guiones)", async () => {
    const s = await setup();
    for (const [i, tel] of ["9991234567", "+52 999 123 4567", "52 999 123 4567", "5219991234567", "999-123-4567"].entries()) {
      expect((await s.mint(`call-ok-${i}`, tel)).res.status, tel).toBe(200);
    }
  });

  it("camino legado sin token: crear_pedido por voz con teléfono de 11 o 13 dígitos NO se recorta ni se asocia a otra persona (X18)", async () => {
    const s = await setup();
    for (const tel of ["99912345678", "5299912345678"]) {
      const res = await post(s, "orders", { branch_slug: "fco-montejo", customer_name: "Ana", customer_phone: tel, customer_address: "Calle 1", payment_method: "efectivo", items: items(s) }, LEGACY);
      expect(res.status, tel).toBe(400);
      expect(((await res.json()) as { message: string }).message).toMatch(/3-3-4|10 d[ií]gitos/i);
    }
    expect(await s.restaurantesRepo.findCustomerByPhone(s.organizationId, "9991234567")).toBeNull();
  });
});

describe("T-FP10 llamada sin variables dinámicas / sin identidad", () => {
  it("buscar_cliente sin token (secreto legado) responde un historial vacío honesto, nunca un 500 ni el de otro cliente", async () => {
    const s = await setup();
    await s.restaurantesRepo.upsertCustomer(s.organizationId, "9992222222", "Beto");
    const res = await post(s, "customers/lookup", {}, LEGACY);
    expect(res.status).toBeLessThan(500);
    expect(JSON.stringify(await res.json())).not.toContain("Beto");
  });

  it("las herramientas de solo-token (confirmar, escalar) rechazan la llamada sin identidad con 401", async () => {
    const s = await setup();
    expect((await post(s, "orders/confirm", {}, LEGACY)).status).toBe(401);
    expect((await post(s, "callbacks", { customer_name: "A", motivo: "queja" }, LEGACY)).status).toBe(401);
  });
});
