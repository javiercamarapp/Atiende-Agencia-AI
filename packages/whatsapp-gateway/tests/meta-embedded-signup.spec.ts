// Embedded Signup (Meta) sin red: fetch falso que hace de Graph API. Orden de los 5 pasos, el token del negocio solo en el header
// Authorization (nunca en la URL), errores redactados y el numero que no es del WABA se rechaza antes de tocar nada mas.
import { describe, expect, it } from "vitest";
import { EmbeddedSignupError, MetaEmbeddedSignupClient } from "../src/providers/meta-embedded-signup.ts";

const TOKEN = "EAAB" + "x".repeat(40);

function graphFalso(opciones: { numeros?: string[]; fallaEn?: string; mensajeError?: string } = {}) {
  const llamadas: Array<{ metodo: string; url: string; auth: string | null; body: string | null }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const headers = new Headers(init?.headers);
    llamadas.push({ metodo: init?.method ?? "GET", url: u, auth: headers.get("authorization"), body: typeof init?.body === "string" ? init.body : null });
    const ruta = new URL(u).pathname;
    if (opciones.fallaEn && ruta.endsWith(opciones.fallaEn)) return new Response(JSON.stringify({ error: { message: opciones.mensajeError ?? "fallo", code: 100 } }), { status: 400 });
    if (ruta.endsWith("/oauth/access_token")) return new Response(JSON.stringify({ access_token: TOKEN }), { status: 200 });
    if (ruta.endsWith("/phone_numbers")) return new Response(JSON.stringify({ data: (opciones.numeros ?? ["555000111"]).map((id) => ({ id, display_phone_number: "+52 999 123 4567", verified_name: "Taquería Lupita" })) }), { status: 200 });
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  }) as typeof fetch;
  return { fetchImpl, llamadas };
}

const ENTRADA = { code: "codigo-de-meta-123", wabaId: "1234567", phoneNumberId: "555000111", systemUserId: "998877", pin: "123456" };

describe("MetaEmbeddedSignupClient.conectar", () => {
  it("canje -> numeros -> asignar usuario de sistema -> suscribir -> registrar; token solo en Authorization", async () => {
    const g = graphFalso();
    const cliente = new MetaEmbeddedSignupClient({ appId: "111", appSecret: "secreto-app", apiVersion: "v23.0", fetchImpl: g.fetchImpl, baseUrl: "https://graph.test" });
    const r = await cliente.conectar(ENTRADA);
    expect(r).toEqual({ phoneNumberId: "555000111", wabaId: "1234567", displayPhoneNumber: "+52 999 123 4567", verifiedName: "Taquería Lupita" });
    expect(g.llamadas.map((l) => `${l.metodo} ${new URL(l.url).pathname}`)).toEqual([
      "GET /v23.0/oauth/access_token",
      "GET /v23.0/1234567/phone_numbers",
      "POST /v23.0/1234567/assigned_users",
      "POST /v23.0/1234567/subscribed_apps",
      "POST /v23.0/555000111/register",
    ]);
    for (const l of g.llamadas.slice(1)) {
      expect(l.auth).toBe(`Bearer ${TOKEN}`);
      expect(l.url).not.toContain(TOKEN);
    }
    expect(new URL(g.llamadas[2]!.url).searchParams.get("user")).toBe("998877");
    expect(new URL(g.llamadas[2]!.url).searchParams.get("tasks")).toBe('["MANAGE"]');
    expect(JSON.parse(g.llamadas[4]!.body!)).toEqual({ messaging_product: "whatsapp", pin: "123456" });
  });

  it("numero que no es del WABA: falla en 'numeros' y no asigna ni registra nada", async () => {
    const g = graphFalso({ numeros: ["999"] });
    const cliente = new MetaEmbeddedSignupClient({ appId: "111", appSecret: "s", fetchImpl: g.fetchImpl, baseUrl: "https://graph.test" });
    await expect(cliente.conectar(ENTRADA)).rejects.toMatchObject({ name: "EmbeddedSignupError", paso: "numeros" });
    expect(g.llamadas).toHaveLength(2);
  });

  it("el error de Meta sale redactado (token y client_secret nunca en el mensaje)", async () => {
    const g = graphFalso({ fallaEn: "/register", mensajeError: `token invalido ${TOKEN} access_token=${TOKEN}` });
    const cliente = new MetaEmbeddedSignupClient({ appId: "111", appSecret: "s", fetchImpl: g.fetchImpl, baseUrl: "https://graph.test" });
    const err = (await cliente.conectar(ENTRADA).catch((e: unknown) => e)) as EmbeddedSignupError;
    expect(err).toBeInstanceOf(EmbeddedSignupError);
    expect(err.paso).toBe("registrar");
    expect(err.graphCode).toBe(100);
    expect(err.message).not.toContain(TOKEN);
    const canje = graphFalso({ fallaEn: "/oauth/access_token", mensajeError: "client_secret=secreto-app invalido" });
    const e2 = (await new MetaEmbeddedSignupClient({ appId: "111", appSecret: "secreto-app", fetchImpl: canje.fetchImpl, baseUrl: "https://graph.test" }).conectar(ENTRADA).catch((e: unknown) => e)) as EmbeddedSignupError;
    expect(e2.paso).toBe("canje");
    expect(e2.message).not.toContain("secreto-app");
  });

  it("ids con formato invalido no salen a la red", async () => {
    const g = graphFalso();
    const cliente = new MetaEmbeddedSignupClient({ appId: "111", appSecret: "s", fetchImpl: g.fetchImpl, baseUrl: "https://graph.test" });
    await expect(cliente.conectar({ ...ENTRADA, wabaId: "../me" })).rejects.toBeInstanceOf(EmbeddedSignupError);
    expect(g.llamadas).toHaveLength(0);
  });
});
