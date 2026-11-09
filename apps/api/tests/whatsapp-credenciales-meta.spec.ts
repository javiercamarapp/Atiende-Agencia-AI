// Credenciales de Meta por organizacion (migracion 0090): cifrado en reposo, firma del webhook contra varias apps, verify token por
// app y resolucion por numero con cache. Sin credenciales todo cae a las variables de plataforma (comportamiento de siempre).
import { createHmac, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  aadCredencialMeta,
  autorizarWebhookMeta,
  CredencialesMetaLlaveInvalidaError,
  crearCifradorCredencialesMeta,
  crearResolutorCredencialesMeta,
  hashVerifyToken,
  numeroAutorizado,
  parsearLlaveCredencialesMeta,
  verificarFirmaConCandidatos,
  type FilaCredencialSistema,
} from "../src/whatsapp-credenciales/index.ts";

const LLAVE = randomBytes(32);
const cifrador = crearCifradorCredencialesMeta(LLAVE, 1);
const firmar = (body: Uint8Array, secreto: string) => `sha256=${createHmac("sha256", secreto).update(body).digest("hex")}`;
const cuerpo = (obj: unknown) => new TextEncoder().encode(JSON.stringify(obj));

function fila(id: string, org: string, secreto: string, token: string, numeros: string[], verifyToken: string | null = null): FilaCredencialSistema {
  return {
    id,
    organization_id: org,
    app_id: "100000",
    waba_id: "200000",
    app_secret_cifrado: cifrador.cifrar(secreto, aadCredencialMeta(id, org, "app_secret")),
    access_token_cifrado: cifrador.cifrar(token, aadCredencialMeta(id, org, "access_token")),
    verify_token_hash: verifyToken ? hashVerifyToken(verifyToken) : null,
    phone_number_ids: numeros,
  };
}

describe("cifrado de credenciales", () => {
  it("cifra y descifra con la AAD de la credencial; el sobre no contiene el texto claro", () => {
    const aad = aadCredencialMeta("c1", "o1", "access_token");
    const sobre = cifrador.cifrar("EAAtokenDePrueba", aad);
    expect(sobre).toMatch(/^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]+$/);
    expect(sobre).not.toContain("EAAtokenDePrueba");
    expect(cifrador.descifrar(sobre, aad)).toBe("EAAtokenDePrueba");
  });

  it("un sobre copiado a otra credencial, organizacion o campo no se abre", () => {
    const sobre = cifrador.cifrar("secreto", aadCredencialMeta("c1", "o1", "app_secret"));
    expect(() => cifrador.descifrar(sobre, aadCredencialMeta("c2", "o1", "app_secret"))).toThrow();
    expect(() => cifrador.descifrar(sobre, aadCredencialMeta("c1", "o2", "app_secret"))).toThrow();
    expect(() => cifrador.descifrar(sobre, aadCredencialMeta("c1", "o1", "access_token"))).toThrow();
  });

  it("la llave: ausente -> null; mal formada o de otro tamano -> error explicito", () => {
    expect(parsearLlaveCredencialesMeta(undefined)).toBeNull();
    expect(parsearLlaveCredencialesMeta("  ")).toBeNull();
    expect(parsearLlaveCredencialesMeta(LLAVE.toString("base64"))?.equals(LLAVE)).toBe(true);
    expect(() => parsearLlaveCredencialesMeta(randomBytes(16).toString("base64"))).toThrow(CredencialesMetaLlaveInvalidaError);
    expect(() => parsearLlaveCredencialesMeta("no es base64 !!")).toThrow(CredencialesMetaLlaveInvalidaError);
  });
});

describe("firma X-Hub-Signature-256 contra varias apps", () => {
  const body = cuerpo({ hola: 1 });
  const candidatos = [
    { id: "a", appSecret: "secreto-a" },
    { id: "b", appSecret: "secreto-b" },
  ];

  it("devuelve la credencial cuyo secreto firmo el cuerpo", () => {
    expect(verificarFirmaConCandidatos(body, firmar(body, "secreto-b"), candidatos)).toBe("b");
  });

  it("sin firma, firma de otro secreto, mal formada o sobre otro cuerpo -> null", () => {
    expect(verificarFirmaConCandidatos(body, null, candidatos)).toBeNull();
    expect(verificarFirmaConCandidatos(body, firmar(body, "otro"), candidatos)).toBeNull();
    expect(verificarFirmaConCandidatos(body, "sha256=zz", candidatos)).toBeNull();
    expect(verificarFirmaConCandidatos(cuerpo({ hola: 2 }), firmar(body, "secreto-a"), candidatos)).toBeNull();
    expect(verificarFirmaConCandidatos(body, firmar(body, "secreto-a"), [])).toBeNull();
  });
});

describe("resolutor de credenciales", () => {
  const filas = [fila("c-pm", "org-pm", "secreto-pm", "token-pm", ["5550001", "5550002"], "verify-pm-1234567890"), fila("c-otro", "org-otro", "secreto-otro", "token-otro", ["5550009"])];

  it("resuelve por numero, con token y secreto descifrados", async () => {
    const r = crearResolutorCredencialesMeta({ leer: async () => filas, cifrador });
    const c = await r.credencialDeNumero("5550002");
    expect(c).toMatchObject({ id: "c-pm", organizationId: "org-pm", accessToken: "token-pm", appSecret: "secreto-pm" });
    expect(await r.credencialDeNumero("1234567890")).toBeNull();
  });

  it("cachea la lectura y la vuelve a pedir al invalidar o al vencer", async () => {
    let lecturas = 0;
    let ahora = 0;
    const r = crearResolutorCredencialesMeta({ leer: async () => (lecturas++, filas), cifrador, ttlMs: 1000, ahoraMs: () => ahora });
    await r.credencialDeNumero("5550001");
    await r.credencialDeNumero("5550009");
    expect(lecturas).toBe(1);
    r.invalidar();
    await r.credencialDeNumero("5550001");
    expect(lecturas).toBe(2);
    ahora = 5000;
    await r.credencialDeNumero("5550001");
    expect(lecturas).toBe(3);
  });

  it("una fila que no se puede descifrar (otra llave) se ignora sin tumbar las demas", async () => {
    const ajena = crearCifradorCredencialesMeta(randomBytes(32), 1);
    const mala: FilaCredencialSistema = { ...filas[1]!, access_token_cifrado: ajena.cifrar("x", aadCredencialMeta("c-otro", "org-otro", "access_token")) };
    const r = crearResolutorCredencialesMeta({ leer: async () => [filas[0]!, mala], cifrador, avisar: () => {} });
    expect(await r.credencialDeNumero("5550009")).toBeNull();
    expect((await r.credencialDeNumero("5550001"))?.id).toBe("c-pm");
  });

  it("verify token: solo el de una credencial activa", async () => {
    const r = crearResolutorCredencialesMeta({ leer: async () => filas, cifrador });
    expect(await r.verifyTokenValido("verify-pm-1234567890")).toBe(true);
    expect(await r.verifyTokenValido("verify-pm-1234567891")).toBe(false);
    expect(await r.verifyTokenValido("")).toBe(false);
  });
});

describe("autorizarWebhookMeta", () => {
  const filas = [fila("c-pm", "org-pm", "secreto-pm", "token-pm", ["5550001"]), fila("c-otro", "org-otro", "secreto-otro", "token-otro", ["5550009"])];
  const body = cuerpo({ x: 1 });

  it("firma de plataforma: autoriza y excluye los numeros que tienen app propia", async () => {
    const resolutor = crearResolutorCredencialesMeta({ leer: async () => filas, cifrador });
    const r = await autorizarWebhookMeta({ rawBody: body, firma: firmar(body, "plataforma"), secretoPlataforma: "plataforma", resolutor, numerosDelPayload: () => ["5550001", "777"] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.autorizacion.tipo).toBe("plataforma");
    expect(numeroAutorizado(r.autorizacion, "777")).toBe(true);
    expect(numeroAutorizado(r.autorizacion, "5550001")).toBe(false);
  });

  it("firma de la app de PM: autoriza SOLO los numeros de esa credencial", async () => {
    const resolutor = crearResolutorCredencialesMeta({ leer: async () => filas, cifrador });
    const r = await autorizarWebhookMeta({ rawBody: body, firma: firmar(body, "secreto-pm"), secretoPlataforma: "plataforma", resolutor, numerosDelPayload: () => ["5550001", "5550009"] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.autorizacion).toMatchObject({ tipo: "credencial", credencialId: "c-pm", organizationId: "org-pm" });
    expect(numeroAutorizado(r.autorizacion, "5550001")).toBe(true);
    expect(numeroAutorizado(r.autorizacion, "5550009")).toBe(false);
  });

  it("firma invalida, ausente o de un secreto desconocido -> 401; sin resolutor solo vale la plataforma", async () => {
    const resolutor = crearResolutorCredencialesMeta({ leer: async () => filas, cifrador });
    for (const firma of [null, "sha256=00", firmar(body, "nadie")]) {
      const r = await autorizarWebhookMeta({ rawBody: body, firma, secretoPlataforma: "plataforma", resolutor, numerosDelPayload: () => ["5550001"] });
      expect(r).toEqual({ ok: false, status: 401 });
    }
    const sin = await autorizarWebhookMeta({ rawBody: body, firma: firmar(body, "secreto-pm"), secretoPlataforma: "plataforma", numerosDelPayload: () => ["5550001"] });
    expect(sin).toEqual({ ok: false, status: 401 });
  });

  it("si las credenciales no se pueden leer: la plataforma sigue pasando y lo demas responde 503 (Meta reintenta)", async () => {
    const resolutor = crearResolutorCredencialesMeta({
      leer: async () => {
        throw new Error("base caida");
      },
      cifrador,
    });
    const plat = await autorizarWebhookMeta({ rawBody: body, firma: firmar(body, "plataforma"), secretoPlataforma: "plataforma", resolutor, numerosDelPayload: () => ["5550001"] });
    expect(plat.ok).toBe(true);
    const propia = await autorizarWebhookMeta({ rawBody: body, firma: firmar(body, "secreto-pm"), secretoPlataforma: "plataforma", resolutor, numerosDelPayload: () => ["5550001"] });
    expect(propia).toEqual({ ok: false, status: 503 });
  });

  it("una app propia sin numeros asignados en el payload (prueba de Meta) se verifica contra todas las credenciales", async () => {
    const resolutor = crearResolutorCredencialesMeta({ leer: async () => filas, cifrador });
    const r = await autorizarWebhookMeta({ rawBody: body, firma: firmar(body, "secreto-otro"), secretoPlataforma: "plataforma", resolutor, numerosDelPayload: () => ["123456123"] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(numeroAutorizado(r.autorizacion, "123456123")).toBe(false);
  });
});
