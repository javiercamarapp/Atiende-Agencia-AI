// Telefono DICTADO por el cliente (caller ID no confiable): sirve para el pedido, pero no identifica al cliente. Con un numero ajeno dictado, Cliente 360 debe
// responder como cliente nuevo: sin nombre, direcciones ni pedidos de otra persona. Con el telefono de la telefonia (caso normal) todo sigue igual.
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { signVoiceCallToken, verifyVoiceCallToken, voiceCallTokenKey } from "../src/voice-call-token.ts";
import { buildTestDeps, jsonRequestInit } from "./fixtures.ts";

const ORG = "los-taquitos-de-pm";
const LEGACY = { "x-atiende-tool-secret": "test-voice-tool-secret" };
const AJENO = "9993334444";

async function setup() {
  const ctx = await buildTestDeps();
  const app = buildApp(ctx.deps);
  // El tercero (dueño real del numero) ya pidio antes: nombre, direccion y pedido en la base.
  await app.request(
    `/v1/restaurantes/${ORG}/orders`,
    jsonRequestInit({ branch_slug: "fco-montejo", customer_name: "Tercera Persona", customer_phone: AJENO, customer_address: "Calle Secreta 123", canal: "domicilio", payment_method: "efectivo", items: [{ product_id: ctx.products.cocaCola, requested_quantity: 1 }], source: "voice" }, { "x-atiende-tool-secret": "test-voice-tool-secret" }),
  );
  const mint = async (callId: string, declarado: boolean) => {
    const res = await app.request(`/v1/restaurantes/${ORG}/voice/call-token`, jsonRequestInit({ call_id: callId, caller_phone: AJENO, branch_slug: "fco-montejo", ...(declarado ? { telefono_declarado: true } : {}) }, LEGACY));
    expect(res.status).toBe(200);
    return ((await res.json()) as { call_token: string }).call_token;
  };
  const post = (path: string, body: unknown, token: string) => app.request(`/v1/restaurantes/${ORG}/${path}`, jsonRequestInit(body, { "x-atiende-call-token": token }));
  return { ...ctx, app, mint, post };
}

describe("telefono declarado por el cliente: sin PII de terceros", () => {
  it("control: con el telefono de la telefonia, buscar_cliente e historial_pedidos SI devuelven los datos del numero", async () => {
    const s = await setup();
    const token = await s.mint("call-normal", false);
    const lookup = (await (await s.post("customers/lookup", {}, token)).json()) as { isNew: boolean; name?: string };
    expect(lookup.isNew).toBe(false);
    expect(lookup.name).toBe("Tercera Persona");
    const hist = (await (await s.post("customers/orders", {}, token)).json()) as { total_pedidos_anteriores: number };
    expect(hist.total_pedidos_anteriores).toBeGreaterThan(0);
  });

  it("con telefono_declarado, buscar_cliente responde cliente nuevo sin nombre ni direcciones", async () => {
    const s = await setup();
    const token = await s.mint("call-dictado-1", true);
    const res = await s.post("customers/lookup", {}, token);
    expect(res.status).toBe(200);
    const texto = JSON.stringify(await res.json());
    expect(JSON.parse(texto)).toEqual({ isNew: true });
    expect(texto).not.toContain("Tercera");
    expect(texto).not.toContain("Secreta");
  });

  it("con telefono_declarado, historial_pedidos viene vacio y repetir_pedido no encuentra nada que repetir", async () => {
    const s = await setup();
    const token = await s.mint("call-dictado-2", true);
    const hist = await s.post("customers/orders", {}, token);
    expect(hist.status).toBe(200);
    expect(await hist.json()).toEqual({ pedidos: [], total_pedidos_anteriores: 0 });
    const repetir = await s.post("orders/repeat", { branch_slug: "fco-montejo" }, token);
    expect(repetir.status).toBe(400);
    expect(JSON.stringify(await repetir.json())).not.toContain("Secreta");
  });

  it("el token declarado SI sirve para el pedido (cotizar) y para dejar aviso", async () => {
    const s = await setup();
    const token = await s.mint("call-dictado-3", true);
    const quote = await s.post("orders/quote", { branch_slug: "fco-montejo", items: [{ product_id: s.products.cocaCola, requested_quantity: 1 }], canal: "recoger" }, token);
    expect(quote.status).toBe(200);
  });

  it("la marca va firmada: un token sin `decl` no se vuelve declarado y un `decl` no booleano es invalido", () => {
    const key = voiceCallTokenKey("secreto-de-prueba");
    const base = { org: "o", prop: "p", call: "c1", ph: AJENO, iat: 1, exp: Math.floor(Date.now() / 1000) + 600 };
    const sin = verifyVoiceCallToken(key, signVoiceCallToken(key, base));
    expect(sin.ok && sin.claims.decl).toBeFalsy();
    const con = verifyVoiceCallToken(key, signVoiceCallToken(key, { ...base, decl: true }));
    expect(con.ok && con.claims.decl).toBe(true);
    const malo = verifyVoiceCallToken(key, signVoiceCallToken(key, { ...base, decl: "si" as unknown as boolean }));
    expect(malo.ok).toBe(false);
  });

  it("telefono_declarado no booleano en el alta de la llamada => 400", async () => {
    const s = await setup();
    const res = await s.app.request(`/v1/restaurantes/${ORG}/voice/call-token`, jsonRequestInit({ call_id: "x1", caller_phone: AJENO, branch_slug: "fco-montejo", telefono_declarado: "si" }, LEGACY));
    expect(res.status).toBe(400);
  });
});
