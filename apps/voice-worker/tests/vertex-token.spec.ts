// Token de cuenta de servicio para Vertex AI: JWT RS256 firmado con node:crypto y cambiado por un token en `token_uri` (contra un fetch FALSO; sin Google real).
import { createVerify, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ALCANCE_VERTEX, VertexTokenError, crearProveedorTokenVertex, firmarAserto, leerCredencialesCuentaServicio } from "../src/vertex-token.ts";

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
const JSON_CUENTA = JSON.stringify({ client_email: "voz@mi-proyecto.iam.gserviceaccount.com", private_key: privateKey, token_uri: "https://oauth2.example.invalid/token" });

describe("credenciales de la cuenta de servicio", () => {
  it("lee client_email, private_key y token_uri (con valor por omision)", () => {
    expect(leerCredencialesCuentaServicio(JSON_CUENTA)).toMatchObject({ clientEmail: "voz@mi-proyecto.iam.gserviceaccount.com", tokenUri: "https://oauth2.example.invalid/token" });
    expect(leerCredencialesCuentaServicio(JSON.stringify({ client_email: "a@b", private_key: privateKey })).tokenUri).toBe("https://oauth2.googleapis.com/token");
  });
  it("rechaza JSON roto o sin campos, y un token_uri que no es https vuelve al de Google (nunca manda el aserto a un http://)", () => {
    expect(() => leerCredencialesCuentaServicio("no json")).toThrow(VertexTokenError);
    expect(() => leerCredencialesCuentaServicio("{}")).toThrow(/client_email/);
    expect(() => leerCredencialesCuentaServicio(JSON.stringify({ client_email: "a@b" }))).toThrow(/private_key/);
    expect(leerCredencialesCuentaServicio(JSON.stringify({ client_email: "a@b", private_key: privateKey, token_uri: "http://malo.invalid/t" })).tokenUri).toBe("https://oauth2.googleapis.com/token");
  });
  it("los errores no incluyen la llave privada", () => {
    try {
      leerCredencialesCuentaServicio(JSON.stringify({ client_email: "sin-arroba", private_key: privateKey }));
    } catch (e) {
      expect(String((e as Error).message)).not.toContain("PRIVATE KEY");
    }
  });
});

describe("aserto JWT", () => {
  it("firma RS256 verificable con la llave publica y con iss, scope cloud-platform, aud e iat/exp a 1 hora", () => {
    const aserto = firmarAserto(leerCredencialesCuentaServicio(JSON_CUENTA), 1_800_000_000);
    const [h, c, f] = aserto.split(".") as [string, string, string];
    expect(JSON.parse(Buffer.from(h, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    expect(JSON.parse(Buffer.from(c, "base64url").toString())).toEqual({ iss: "voz@mi-proyecto.iam.gserviceaccount.com", scope: ALCANCE_VERTEX, aud: "https://oauth2.example.invalid/token", iat: 1_800_000_000, exp: 1_800_003_600 });
    expect(createVerify("RSA-SHA256").update(`${h}.${c}`).verify(publicKey, Buffer.from(f, "base64url"))).toBe(true);
  });
});

describe("proveedor de token", () => {
  function montar() {
    let ahora = 1_800_000_000_000;
    const pedidos: { url: string; cuerpo: URLSearchParams }[] = [];
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      pedidos.push({ url: String(url), cuerpo: new URLSearchParams(String(init?.body)) });
      return new Response(JSON.stringify({ access_token: `token-${pedidos.length}`, expires_in: 3600 }));
    }) as typeof fetch;
    const dar = crearProveedorTokenVertex({ credencialesJson: JSON_CUENTA, fetchFn, ahora: () => ahora });
    return { dar, pedidos, avanzar: (ms: number) => void (ahora += ms) };
  }

  it("cambia el aserto por un token (grant jwt-bearer), lo reutiliza hasta 60 s antes de vencer y despues lo renueva", async () => {
    const { dar, pedidos, avanzar } = montar();
    expect(await dar()).toBe("token-1");
    expect(pedidos[0]!.url).toBe("https://oauth2.example.invalid/token");
    expect(pedidos[0]!.cuerpo.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    expect(pedidos[0]!.cuerpo.get("assertion")?.split(".")).toHaveLength(3);
    avanzar(3_000_000);
    expect(await dar()).toBe("token-1");
    expect(pedidos).toHaveLength(1);
    avanzar(541_000);
    expect(await dar()).toBe("token-2");
  });

  it("dos sesiones que abren a la vez comparten UNA sola peticion de token", async () => {
    const { dar, pedidos } = montar();
    expect(await Promise.all([dar(), dar(), dar()])).toEqual(["token-1", "token-1", "token-1"]);
    expect(pedidos).toHaveLength(1);
  });

  it("si Google rechaza o no trae access_token, falla con un motivo corto (la sesion no abre y la escalera cae al respaldo)", async () => {
    const rechazo = crearProveedorTokenVertex({ credencialesJson: JSON_CUENTA, fetchFn: (async () => new Response("{}", { status: 401 })) as typeof fetch });
    await expect(rechazo()).rejects.toThrow(/http 401/);
    const sinToken = crearProveedorTokenVertex({ credencialesJson: JSON_CUENTA, fetchFn: (async () => new Response("{}")) as typeof fetch });
    await expect(sinToken()).rejects.toThrow(/access_token/);
  });
});
