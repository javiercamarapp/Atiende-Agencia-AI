// Tests del lector de SOLO LECTURA de Graph API. Siempre con `fetchImpl` falso: ningun test toca graph.facebook.com
// ni usa un token real (el de abajo es una cadena fija de prueba).
import { describe, expect, it, vi } from "vitest";
import {
  CAMPOS_NUMERO,
  GRAPH_API_VERSION_PATTERN,
  MetaGraphReadError,
  MetaGraphReaderConfigError,
  MetaGraphWhatsAppReader,
  esVersionGraphValida,
  redactarSecretos,
} from "../src/providers/meta-graph-reader.ts";

const FAKE_TOKEN = "EAAFAKEtoken1234567890abcdefghij-never-real";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

interface Llamada {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

function lector(respuestas: Array<Response | Error | ((url: string) => Response)>, extra: { apiVersion?: string; maxPaginas?: number } = {}) {
  const llamadas: Llamada[] = [];
  let i = 0;
  const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    llamadas.push({ url: String(url), init });
    const siguiente = respuestas[Math.min(i, respuestas.length - 1)];
    i += 1;
    if (siguiente instanceof Error) throw siguiente;
    return typeof siguiente === "function" ? siguiente(String(url)) : siguiente!.clone();
  });
  const reader = new MetaGraphWhatsAppReader({ accessToken: FAKE_TOKEN, fetchImpl: fetchImpl as unknown as typeof fetch, ...extra });
  return { reader, llamadas, fetchImpl };
}

async function fallo(promesa: Promise<unknown>): Promise<MetaGraphReadError> {
  try {
    await promesa;
  } catch (err) {
    expect(err).toBeInstanceOf(MetaGraphReadError);
    return err as MetaGraphReadError;
  }
  throw new Error("se esperaba un error");
}

describe("MetaGraphWhatsAppReader: configuracion", () => {
  it("falla cerrado sin token", () => {
    expect(() => new MetaGraphWhatsAppReader({ accessToken: "" })).toThrow(MetaGraphReaderConfigError);
    expect(() => new MetaGraphWhatsAppReader({ accessToken: "   " })).toThrow(MetaGraphReaderConfigError);
  });

  it("rechaza una version con forma invalida y acepta v23.0", () => {
    expect(() => new MetaGraphWhatsAppReader({ accessToken: FAKE_TOKEN, apiVersion: "23" })).toThrow(MetaGraphReaderConfigError);
    expect(new MetaGraphWhatsAppReader({ accessToken: FAKE_TOKEN, apiVersion: "v23.0" }).version).toBe("v23.0");
    expect(new MetaGraphWhatsAppReader({ accessToken: FAKE_TOKEN }).version).toBe("v21.0");
  });

  it("el patron de version es ^v\\d{2}\\.0$", () => {
    for (const ok of ["v21.0", "v23.0", "v99.0"]) expect(esVersionGraphValida(ok)).toBe(true);
    for (const mal of ["21.0", "v21", "v2.0", "v21.1", "v211.0", "v21.0 ", "", undefined, 21]) expect(esVersionGraphValida(mal)).toBe(false);
    expect(GRAPH_API_VERSION_PATTERN.source).toBe("^v\\d{2}\\.0$");
  });
});

describe("MetaGraphWhatsAppReader: URLs y campos", () => {
  it("numero(): GET /{id}?fields=... con el token solo en la cabecera Authorization", async () => {
    const { reader, llamadas } = lector([jsonResponse({ id: "111", display_phone_number: "+52 999 518 2637", quality_rating: "GREEN", is_on_biz_app: true, platform_type: "CLOUD_API" })]);
    const numero = await reader.numero("111");
    expect(numero.quality_rating).toBe("GREEN");
    expect(llamadas).toHaveLength(1);
    expect(llamadas[0]!.url).toBe(
      "https://graph.facebook.com/v21.0/111?fields=display_phone_number,verified_name,quality_rating,code_verification_status,name_status,status,platform_type,throughput,is_on_biz_app,account_mode",
    );
    expect(CAMPOS_NUMERO).toContain("is_on_biz_app");
    expect((llamadas[0]!.init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${FAKE_TOKEN}`);
    expect(llamadas[0]!.url).not.toContain(FAKE_TOKEN);
  });

  it("numerosDeWaba(): GET /{waba}/phone_numbers con los mismos campos", async () => {
    const { reader, llamadas } = lector([jsonResponse({ data: [{ id: "1" }, { id: "2" }] })]);
    const numeros = await reader.numerosDeWaba("999");
    expect(numeros.map((n) => n.id)).toEqual(["1", "2"]);
    expect(llamadas[0]!.url).toBe(`https://graph.facebook.com/v21.0/999/phone_numbers?fields=${CAMPOS_NUMERO.join(",")}`);
  });

  it("waba(): campos de la WABA; el limite de mensajeria es opcional", async () => {
    const { reader, llamadas } = lector([jsonResponse({ id: "999", name: "PM" })]);
    const waba = await reader.waba("999");
    expect(waba.name).toBe("PM");
    expect(waba.whatsapp_business_manager_messaging_limit).toBeUndefined();
    expect(llamadas[0]!.url).toBe("https://graph.facebook.com/v21.0/999?fields=name,currency,timezone_id,message_template_namespace,whatsapp_business_manager_messaging_limit");
  });

  it("appsSuscritas(): aplana whatsapp_business_api_data y tolera filas sin ese campo", async () => {
    const { reader, llamadas } = lector([jsonResponse({ data: [{ whatsapp_business_api_data: { id: "app1", name: "Atiende" } }, {}] })]);
    expect(await reader.appsSuscritas("999")).toEqual([{ id: "app1", name: "Atiende" }, {}]);
    expect(llamadas[0]!.url).toBe("https://graph.facebook.com/v21.0/999/subscribed_apps");
  });

  it("usa la version configurada y el baseUrl de prueba", async () => {
    const llamadas: string[] = [];
    const fetchImpl = (async (url: string | URL) => {
      llamadas.push(String(url));
      return jsonResponse({ id: "1" });
    }) as unknown as typeof fetch;
    const reader = new MetaGraphWhatsAppReader({ accessToken: FAKE_TOKEN, apiVersion: "v23.0", baseUrl: "http://localhost:9999/", fetchImpl });
    await reader.numero("1");
    expect(llamadas[0]!.startsWith("http://localhost:9999/v23.0/1?fields=")).toBe(true);
  });

  it("codifica el id (no deja colar rutas) y rechaza ids vacios", async () => {
    const { reader, llamadas } = lector([jsonResponse({ id: "x" })]);
    await reader.numero("1/../2?x=y");
    expect(llamadas[0]!.url.startsWith("https://graph.facebook.com/v21.0/1%2F..%2F2%3Fx%3Dy?fields=")).toBe(true);
    await expect(reader.numero("  ")).rejects.toBeInstanceOf(MetaGraphReaderConfigError);
    expect(llamadas).toHaveLength(1);
  });
});

describe("MetaGraphWhatsAppReader: plantillas y paginacion", () => {
  it("plantillas(): limit=100 y sigue paging.next hasta agotarlo", async () => {
    const pagina2 = "https://graph.facebook.com/v21.0/999/message_templates?fields=name&limit=100&after=CURSOR2";
    const { reader, llamadas } = lector([
      jsonResponse({ data: [{ name: "pedido_confirmado", status: "APPROVED" }], paging: { next: pagina2 } }),
      jsonResponse({ data: [{ name: "pedido_en_camino", status: "PENDING" }], paging: { cursors: { after: "x" } } }),
    ]);
    const plantillas = await reader.plantillas("999");
    expect(plantillas.map((p) => p.name)).toEqual(["pedido_confirmado", "pedido_en_camino"]);
    expect(llamadas[0]!.url).toBe("https://graph.facebook.com/v21.0/999/message_templates?fields=name,language,status,category,quality_score&limit=100");
    expect(llamadas[1]!.url).toBe(pagina2);
    expect(llamadas.every((l) => (l.init?.headers as Record<string, string>).Authorization === `Bearer ${FAKE_TOKEN}`)).toBe(true);
  });

  it("quita access_token de paging.next antes de seguirlo", async () => {
    const { reader, llamadas } = lector([
      jsonResponse({ data: [], paging: { next: `https://graph.facebook.com/v21.0/999/message_templates?after=C&access_token=${FAKE_TOKEN}` } }),
      jsonResponse({ data: [{ name: "a" }] }),
    ]);
    await reader.plantillas("999");
    expect(llamadas[1]!.url).toBe("https://graph.facebook.com/v21.0/999/message_templates?after=C");
  });

  it("no sigue un paging.next hacia otro host (el token no sale de Meta)", async () => {
    const { reader, llamadas } = lector([jsonResponse({ data: [], paging: { next: "https://evil.example/v21.0/999/message_templates?after=C" } })]);
    const err = await fallo(reader.plantillas("999"));
    expect(err.message).toContain("otro host");
    expect(llamadas).toHaveLength(1);
  });

  it("corta una paginacion en ciclo y una demasiado larga", async () => {
    const next = "https://graph.facebook.com/v21.0/999/message_templates?after=LOOP";
    const ciclo = lector([jsonResponse({ data: [{ name: "a" }], paging: { next } })]);
    expect((await fallo(ciclo.reader.plantillas("999"))).message).toContain("ciclo");

    let n = 0;
    const larga = lector([() => jsonResponse({ data: [], paging: { next: `https://graph.facebook.com/v21.0/999/message_templates?after=${(n += 1)}` } })], { maxPaginas: 3 });
    expect((await fallo(larga.reader.plantillas("999"))).message).toContain("excedio 3 paginas");
    expect(larga.llamadas).toHaveLength(3);
  });

  it("campos faltantes: sin data o con data que no es lista da una lista vacia; objetos sin campos no revientan", async () => {
    expect(await lector([jsonResponse({})]).reader.plantillas("1")).toEqual([]);
    expect(await lector([jsonResponse({ data: "raro" })]).reader.numerosDeWaba("1")).toEqual([]);
    expect(await lector([jsonResponse({ data: [{ id: "7" }] })]).reader.numerosDeWaba("1")).toEqual([{ id: "7" }]);
    const numero = await lector([jsonResponse({ id: "7" })]).reader.numero("7");
    expect(numero.quality_rating).toBeUndefined();
    expect(numero.is_on_biz_app).toBeUndefined();
  });

  it("un cuerpo 2xx que no es objeto, o no es JSON, es un error claro", async () => {
    expect((await fallo(lector([jsonResponse([1, 2])]).reader.numero("1"))).message).toContain("objeto");
    expect((await fallo(lector([new Response("<html>", { status: 200 })]).reader.waba("1"))).message).toContain("no es JSON");
  });
});

describe("MetaGraphWhatsAppReader: errores de Graph", () => {
  it("190 -> tokenInvalido, con httpStatus, graphCode y mensaje", async () => {
    const { reader } = lector([jsonResponse({ error: { message: "Error validating access token: Session has expired", code: 190, error_subcode: 463 } }, 400)]);
    const err = await fallo(reader.numero("1"));
    expect(err.tokenInvalido).toBe(true);
    expect(err.httpStatus).toBe(400);
    expect(err.graphCode).toBe(190);
    expect(err.graphSubcode).toBe(463);
    expect(err.retryable).toBe(false);
    expect(err.message).toContain("Session has expired");
  });

  it("401 sin cuerpo JSON tambien es tokenInvalido", async () => {
    const err = await fallo(lector([new Response("no", { status: 401 })]).reader.numero("1"));
    expect(err.tokenInvalido).toBe(true);
    expect(err.httpStatus).toBe(401);
    expect(err.message).toContain("(sin detalle)");
  });

  it("403 (permisos) no es tokenInvalido ni reintentable", async () => {
    const err = await fallo(lector([jsonResponse({ error: { message: "(#200) permisos", code: 200 } }, 403)]).reader.waba("1"));
    expect(err.tokenInvalido).toBe(false);
    expect(err.retryable).toBe(false);
    expect(err.graphCode).toBe(200);
    expect(err.httpStatus).toBe(403);
  });

  it("429 y 5xx son reintentables", async () => {
    const e429 = await fallo(lector([jsonResponse({ error: { message: "rate", code: 80007 } }, 429)]).reader.plantillas("1"));
    expect(e429.retryable).toBe(true);
    expect(e429.tokenInvalido).toBe(false);
    for (const status of [500, 502, 503]) {
      const e = await fallo(lector([jsonResponse({ error: { message: "boom", code: 2 } }, status)]).reader.numero("1"));
      expect(e.retryable).toBe(true);
      expect(e.httpStatus).toBe(status);
    }
  });

  it("404 / 400 (numero inexistente) no es reintentable", async () => {
    const err = await fallo(lector([jsonResponse({ error: { message: "Unsupported get request", code: 100 } }, 400)]).reader.numero("404"));
    expect(err.retryable).toBe(false);
    expect(err.graphCode).toBe(100);
  });

  it("fallo de red: reintentable y sin status", async () => {
    const err = await fallo(lector([new Error("getaddrinfo ENOTFOUND graph.facebook.com")]).reader.numero("1"));
    expect(err.retryable).toBe(true);
    expect(err.httpStatus).toBeUndefined();
    expect(err.message).toContain("ENOTFOUND");
  });

  it("una pagina intermedia con error aborta la lista", async () => {
    const { reader } = lector([
      jsonResponse({ data: [{ name: "a" }], paging: { next: "https://graph.facebook.com/v21.0/1/message_templates?after=2" } }),
      jsonResponse({ error: { message: "x", code: 190 } }, 400),
    ]);
    expect((await fallo(reader.plantillas("1"))).tokenInvalido).toBe(true);
  });
});

describe("MetaGraphWhatsAppReader: el token nunca se expone", () => {
  it("redactarSecretos limpia el token exacto, Bearer, access_token= y cadenas EAA...", () => {
    const sucio = `fallo con ${FAKE_TOKEN}; Authorization: Bearer abc.DEF-123; url?access_token=zzz999&x=1; otro EAAB1234567890123456789012345`;
    const limpio = redactarSecretos(sucio, FAKE_TOKEN);
    expect(limpio).not.toContain(FAKE_TOKEN);
    expect(limpio).not.toContain("abc.DEF-123");
    expect(limpio).not.toContain("zzz999");
    expect(limpio).not.toContain("EAAB1234567890123456789012345");
    expect(limpio).toContain("[REDACTADO]");
  });

  it("no toca el nombre de la variable WHATSAPP_ACCESS_TOKEN=<valor> de un texto de ayuda", () => {
    expect(redactarSecretos("Uso: WHATSAPP_ACCESS_TOKEN=<token> node x.ts")).toBe("Uso: WHATSAPP_ACCESS_TOKEN=<token> node x.ts");
  });

  it("si Graph devuelve el token en su mensaje de error, el error y su serializacion no lo traen", async () => {
    const { reader } = lector([jsonResponse({ error: { message: `Invalid OAuth access token ${FAKE_TOKEN} (access_token=${FAKE_TOKEN})`, code: 190 } }, 401)]);
    const err = await fallo(reader.numero("1"));
    for (const texto of [err.message, String(err), JSON.stringify({ ...err, message: err.message }), err.stack ?? ""]) {
      expect(texto).not.toContain(FAKE_TOKEN);
    }
  });

  it("si el error de red menciona el token, tampoco sale", async () => {
    const { reader } = lector([new Error(`connect failed for Bearer ${FAKE_TOKEN}`)]);
    const err = await fallo(reader.numero("1"));
    expect(err.message).not.toContain(FAKE_TOKEN);
  });

  it("no escribe en consola ni con exito ni con error", async () => {
    const espias = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
    try {
      await lector([jsonResponse({ id: "1" })]).reader.numero("1");
      await lector([jsonResponse({ error: { message: FAKE_TOKEN, code: 190 } }, 400)]).reader.numero("1").catch(() => undefined);
      for (const espia of espias) expect(espia).not.toHaveBeenCalled();
    } finally {
      for (const espia of espias) espia.mockRestore();
    }
  });
});

describe("MetaGraphWhatsAppReader: entradas hostiles largas (sin ReDoS)", () => {
  it("baseUrl con 100000 '/' al final se normaliza rapido y sigue funcionando", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string | URL) => {
      urls.push(String(url));
      return jsonResponse({ id: "1" });
    }) as unknown as typeof fetch;
    const t0 = performance.now();
    const reader = new MetaGraphWhatsAppReader({ accessToken: FAKE_TOKEN, baseUrl: `http://localhost:9999${"/".repeat(100_000)}x${"/".repeat(100_000)}`, fetchImpl });
    expect(performance.now() - t0).toBeLessThan(200);
    await reader.numero("1");
    expect(urls[0]!.startsWith("http://localhost:9999")).toBe(true);
    const solo = new MetaGraphWhatsAppReader({ accessToken: FAKE_TOKEN, baseUrl: `http://h${"/".repeat(100_000)}`, fetchImpl });
    await solo.numero("2");
    expect(urls[1]!.startsWith("http://h/v21.0/2?fields=")).toBe(true);
  });

  it("redactarSecretos con cadenas hostiles largas termina rapido", () => {
    const hostiles = [`Bearer ${" ".repeat(100_000)}!`, `Bearer ${"/".repeat(100_000)}`, `access_token=${"a".repeat(100_000)}`, `EA${"A".repeat(100_000)}!`, "/".repeat(100_000), " ".repeat(100_000)];
    const t0 = performance.now();
    for (const h of hostiles) redactarSecretos(h, FAKE_TOKEN);
    expect(performance.now() - t0).toBeLessThan(1000);
  });
});

describe("MetaGraphWhatsAppReader: SOLO GET", () => {
  it("solicitar() rechaza POST, PUT, PATCH, DELETE y minusculas SIN llamar a fetch", async () => {
    const { reader, fetchImpl } = lector([jsonResponse({})]);
    for (const metodo of ["POST", "PUT", "PATCH", "DELETE", "get", "HEAD", "OPTIONS", ""]) {
      await expect(reader.solicitar(metodo, "/1")).rejects.toBeInstanceOf(MetaGraphReaderConfigError);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("todas las llamadas de todos los metodos publicos usan GET y no mandan cuerpo", async () => {
    const { reader, llamadas } = lector([jsonResponse({ id: "1", data: [] })]);
    await reader.numero("1");
    await reader.numerosDeWaba("2");
    await reader.waba("2");
    await reader.plantillas("2");
    await reader.appsSuscritas("2");
    expect(llamadas).toHaveLength(5);
    for (const llamada of llamadas) {
      expect(llamada.init?.method).toBe("GET");
      expect(llamada.init?.body).toBeUndefined();
    }
  });

  it("el lector no expone ningun metodo de escritura", () => {
    const { reader } = lector([jsonResponse({})]);
    const nombres = Object.getOwnPropertyNames(Object.getPrototypeOf(reader));
    expect(nombres.filter((n) => /^(post|put|delete|patch|enviar|send|registrar|register|crear|create|borrar|editar|actualizar|suscribir)/i.test(n))).toEqual([]);
  });
});
