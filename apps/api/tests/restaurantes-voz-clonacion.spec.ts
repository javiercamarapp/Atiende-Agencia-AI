// Clonacion de la voz telefonica (POST .../admin/voz/clonar) y su efecto en GET/PUT .../admin/voz/config. Cada caso afirma el EFECTO:
// que se guardo en tts_voice_id, que NO se llamo al proveedor y que la llave nunca aparece en una respuesta.
import { describe, expect, it } from "vitest";
import { InMemoryVozRepository } from "@atiende/domain-restaurantes";
import { buildApp } from "../src/app.ts";
import type { AppDeps } from "../src/deps.ts";
import { ClonacionVozError, ElevenLabsClonadorVoz } from "../src/voz-clonacion.ts";
import type { ClonadorVoz, ClonarVozEntrada } from "../src/voz-clonacion.ts";
import { authedGet, authedJson, buildRestaurantesKpiTestContext } from "./restaurantes-admin-kpis-fixtures.ts";

const VOZ_CLONADA = "AbCdEfGhIjKlMnOpQrSt";
const LLAVE = `sk_${"e".repeat(40)}`;
const CONFIG_OK = { habilitado: true, proveedor: "gemini-3.8-live", voiceId: "Kore", comportamiento: "", mensajeInicial: "Hola, le atiende el asistente virtual." };

class ClonadorFalso implements ClonadorVoz {
  readonly llamadas: ClonarVozEntrada[] = [];
  readonly borradas: string[] = [];
  constructor(private readonly resultado: string | ClonacionVozError = VOZ_CLONADA) {}
  async clonar(entrada: ClonarVozEntrada): Promise<{ readonly voiceId: string }> {
    this.llamadas.push(entrada);
    if (this.resultado instanceof ClonacionVozError) throw this.resultado;
    return { voiceId: this.resultado };
  }
  async borrar(voiceId: string): Promise<void> {
    this.borradas.push(voiceId);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Resp = Omit<Response, "json"> & { json(): Promise<any> };

async function construir(opts: { clonador?: ClonadorFalso | null; sinConfig?: boolean } = {}) {
  const ctx = await buildRestaurantesKpiTestContext(buildApp);
  const voz = new InMemoryVozRepository();
  voz.seedProperty(ctx.propertyIdA, ctx.organizationId);
  voz.seedProperty(ctx.propertyIdB, ctx.organizationId);
  voz.seedProperty(ctx.otherPropertyId, ctx.otherOrganizationId);
  const clonador = opts.clonador === undefined ? new ClonadorFalso() : opts.clonador;
  const deps: AppDeps = { ...ctx.deps, vozRepo: () => voz, ...(clonador ? { clonadorVoz: clonador } : {}) };
  const app = buildApp(deps);
  const request = (input: string, init?: RequestInit) => Promise.resolve(app.request(input, init)) as Promise<Resp>;
  const base = `/v1/restaurantes/${ctx.propertyIdA}/admin/voz`;
  if (!opts.sinConfig) expect((await request(`${base}/config`, authedJson(ctx.staff.owner.token, CONFIG_OK, "PUT"))).status).toBe(200);
  return { ctx, voz, clonador, request, base };
}

function audio(n: number, bytes = 4096, tipo = "audio/webm"): File {
  return new File([new Uint8Array(bytes).fill(n)], `clip-${n}.webm`, { type: tipo });
}

function formulario(opts: { muestras?: File[]; nombre?: string; consentimiento?: string | null } = {}): FormData {
  const f = new FormData();
  for (const m of opts.muestras ?? [audio(1), audio(2), audio(3)]) f.append("muestras", m);
  f.append("nombre", opts.nombre ?? "Voz de Doña Pili");
  if (opts.consentimiento !== null) f.append("consentimiento", opts.consentimiento ?? "true");
  f.append("quitarRuido", "true");
  return f;
}

function multipart(token: string, body: FormData): RequestInit {
  return { method: "POST", headers: { authorization: `Bearer ${token}` }, body };
}

describe("POST .../admin/voz/clonar", () => {
  it("owner: clona con el proveedor, guarda el id en la voz telefonica de ESA sucursal y deja bitacora sin audio", async () => {
    const { ctx, voz, clonador, request, base } = await construir();
    const res = await request(`${base}/clonar`, multipart(ctx.staff.owner.token, formulario()));
    expect(res.status).toBe(201);
    const cuerpo = await res.json();
    expect(cuerpo).toEqual({ vozTelefono: VOZ_CLONADA, vozTelefonoClonada: true, nombre: "Voz de Doña Pili" });
    expect(JSON.stringify(cuerpo)).not.toContain(LLAVE);
    expect(clonador!.llamadas).toHaveLength(1);
    expect(clonador!.llamadas[0]!.muestras.map((m) => m.tipo)).toEqual(["audio/webm", "audio/webm", "audio/webm"]);
    expect(clonador!.llamadas[0]!.etiquetas).toEqual({ atiende_org: ctx.organizationId, atiende_sucursal: ctx.propertyIdA });
    expect((await voz.getVozTelefono(ctx.propertyIdA)).valor).toBe(VOZ_CLONADA);
    expect((await voz.getVozTelefono(ctx.propertyIdB)).valor).toBeNull();

    const entrada = ctx.restaurantesRepo.auditLog.find((r) => r.action === "configuracion.voz_clonada");
    expect(entrada?.actorUserId).toBe(ctx.staff.owner.id);
    expect(JSON.parse(entrada?.despues ?? "{}")).toMatchObject({ vozTelefono: VOZ_CLONADA, muestras: 3, consentimiento: true });

    const get = await (await request(`${base}/config`, authedGet(ctx.staff.owner.token))).json();
    expect(get).toMatchObject({ vozTelefono: VOZ_CLONADA, vozTelefonoClonada: true });
  });

  it("sin ELEVENLABS_API_KEY (sin clonador): 503 honesto y nada se guarda", async () => {
    const { ctx, voz, request, base } = await construir({ clonador: null });
    const res = await request(`${base}/clonar`, multipart(ctx.staff.owner.token, formulario()));
    expect(res.status).toBe(503);
    expect(JSON.stringify(await res.json())).toContain("ELEVENLABS_API_KEY");
    expect((await voz.getVozTelefono(ctx.propertyIdA)).valor).toBeNull();
  });

  it("staff, repartidor y owner de otra organizacion: 403 y el proveedor no se llama; sin sesion 401", async () => {
    const { ctx, clonador, request, base } = await construir();
    for (const token of [ctx.staff.staffSucursalA.token, ctx.staff.repartidor.token, ctx.staff.otroOrgOwner.token]) {
      expect((await request(`${base}/clonar`, multipart(token, formulario()))).status).toBe(403);
    }
    // Cross-tenant: el owner de A no puede clonar en la sucursal de otra organizacion.
    expect((await request(`/v1/restaurantes/${ctx.otherPropertyId}/admin/voz/clonar`, multipart(ctx.staff.owner.token, formulario()))).status).toBe(403);
    expect((await request(`${base}/clonar`, { method: "POST", body: formulario() })).status).toBe(401);
    expect(clonador!.llamadas).toHaveLength(0);
  });

  it("validacion: sin consentimiento, pocas o demasiadas muestras, no-audio, muestra vacia o sin nombre -> 400 sin llamar al proveedor", async () => {
    const { ctx, voz, clonador, request, base } = await construir();
    const casos: FormData[] = [
      formulario({ consentimiento: null }),
      formulario({ consentimiento: "false" }),
      formulario({ muestras: [audio(1)] }),
      formulario({ muestras: [audio(1), audio(2), audio(3), audio(4), audio(5), audio(6)] }),
      formulario({ muestras: [audio(1), audio(2, 4096, "text/html")] }),
      formulario({ muestras: [audio(1), audio(2, 10)] }),
      formulario({ nombre: " " }),
    ];
    for (const f of casos) expect((await request(`${base}/clonar`, multipart(ctx.staff.owner.token, f))).status).toBe(400);
    const sinMultipart = await request(`${base}/clonar`, authedJson(ctx.staff.owner.token, { muestras: [] }, "POST"));
    expect(sinMultipart.status).toBe(400);
    expect(clonador!.llamadas).toHaveLength(0);
    expect((await voz.getVozTelefono(ctx.propertyIdA)).valor).toBeNull();
  });

  it("tope: la sexta clonacion valida en una hora responde 429 sin llamar al proveedor", async () => {
    const { ctx, clonador, request, base } = await construir();
    for (let i = 0; i < 5; i++) expect((await request(`${base}/clonar`, multipart(ctx.staff.owner.token, formulario()))).status).toBe(201);
    expect((await request(`${base}/clonar`, multipart(ctx.staff.owner.token, formulario()))).status).toBe(429);
    expect(clonador!.llamadas).toHaveLength(5);
  });

  it("cuerpo de mas de 4 MB: 413 sin llamar al proveedor", async () => {
    const { ctx, clonador, request, base } = await construir();
    const grande = formulario({ muestras: [audio(1, 2_200_000), audio(2, 2_200_000)] });
    expect((await request(`${base}/clonar`, multipart(ctx.staff.owner.token, grande))).status).toBe(413);
    expect(clonador!.llamadas).toHaveLength(0);
  });

  it("base sin la 103: 503 ANTES de llamar al proveedor; sucursal sin configuracion de voz: 409", async () => {
    const sinMigrar = await construir();
    sinMigrar.voz.migradaVozTelefono = false;
    expect((await sinMigrar.request(`${sinMigrar.base}/clonar`, multipart(sinMigrar.ctx.staff.owner.token, formulario()))).status).toBe(503);
    expect(sinMigrar.clonador!.llamadas).toHaveLength(0);

    const sinConfig = await construir({ sinConfig: true });
    expect((await sinConfig.request(`${sinConfig.base}/clonar`, multipart(sinConfig.ctx.staff.owner.token, formulario()))).status).toBe(409);
    expect(sinConfig.clonador!.llamadas).toHaveLength(0);
  });

  it("el proveedor rechaza las muestras -> 400; el proveedor cae -> 503; nada se guarda", async () => {
    for (const [error, estado] of [
      [new ClonacionVozError("rechazo", 422), 400],
      [new ClonacionVozError("proveedor", 500), 503],
    ] as const) {
      const { ctx, voz, request, base } = await construir({ clonador: new ClonadorFalso(error) });
      expect((await request(`${base}/clonar`, multipart(ctx.staff.owner.token, formulario()))).status).toBe(estado);
      expect((await voz.getVozTelefono(ctx.propertyIdA)).valor).toBeNull();
    }
  });
});

describe("PUT .../admin/voz/config con voz clonada", () => {
  it("conserva la voz clonada guardada al volver a guardar, pero rechaza un id arbitrario que no es del catalogo", async () => {
    const { ctx, voz, request, base } = await construir();
    await request(`${base}/clonar`, multipart(ctx.staff.owner.token, formulario()));

    const mismo = await request(`${base}/config`, authedJson(ctx.staff.owner.token, { ...CONFIG_OK, vozTelefono: VOZ_CLONADA }, "PUT"));
    expect(mismo.status).toBe(200);
    expect(await mismo.json()).toMatchObject({ vozTelefono: VOZ_CLONADA, vozTelefonoClonada: true });

    const otro = await request(`${base}/config`, authedJson(ctx.staff.owner.token, { ...CONFIG_OK, vozTelefono: "ZZZZZZZZZZZZZZZZZZZZ" }, "PUT"));
    expect(otro.status).toBe(400);
    // La clonada de A no sirve en B (no es la guardada de B).
    await request(`/v1/restaurantes/${ctx.propertyIdB}/admin/voz/config`, authedJson(ctx.staff.owner.token, CONFIG_OK, "PUT"));
    const enB = await request(`/v1/restaurantes/${ctx.propertyIdB}/admin/voz/config`, authedJson(ctx.staff.owner.token, { ...CONFIG_OK, vozTelefono: VOZ_CLONADA }, "PUT"));
    expect(enB.status).toBe(400);
    expect((await voz.getVozTelefono(ctx.propertyIdA)).valor).toBe(VOZ_CLONADA);

    // Volver al catalogo deja de marcarla como clonada.
    const catalogo = await (await request(`${base}/config`, authedJson(ctx.staff.owner.token, { ...CONFIG_OK, vozTelefono: "sDh3eviBhiuHKi0MjTNq" }, "PUT"))).json();
    expect(catalogo).toMatchObject({ vozTelefono: "sDh3eviBhiuHKi0MjTNq", vozTelefonoClonada: false });
  });
});

describe("ElevenLabsClonadorVoz (adaptador HTTP)", () => {
  const entrada: ClonarVozEntrada = { nombre: "Voz", muestras: [{ nombre: "a.webm", tipo: "audio/webm", bytes: new Uint8Array([1, 2, 3]) }], quitarRuido: true, etiquetas: { atiende_org: "o" } };

  it("manda la llave solo en el header xi-api-key y devuelve el voice_id valido", async () => {
    const vistas: { url: string; init: RequestInit }[] = [];
    const fetchFalso = (async (url: string, init: RequestInit) => {
      vistas.push({ url, init });
      return new Response(JSON.stringify({ voice_id: VOZ_CLONADA }), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await new ElevenLabsClonadorVoz({ apiKey: LLAVE, fetchImpl: fetchFalso }).clonar(entrada);
    expect(r.voiceId).toBe(VOZ_CLONADA);
    expect(vistas[0]!.url).toBe("https://api.elevenlabs.io/v1/voices/add");
    expect((vistas[0]!.init.headers as Record<string, string>)["xi-api-key"]).toBe(LLAVE);
    const form = vistas[0]!.init.body as FormData;
    expect(form.getAll("files")).toHaveLength(1);
    expect(form.get("remove_background_noise")).toBe("true");
  });

  it("4xx -> rechazo; 401/5xx/red/id con otro formato -> proveedor", async () => {
    const con = (res: Response | Error) =>
      new ElevenLabsClonadorVoz({ apiKey: LLAVE, fetchImpl: (async () => { if (res instanceof Error) throw res; return res; }) as unknown as typeof fetch });
    await expect(con(new Response("{}", { status: 422 })).clonar(entrada)).rejects.toMatchObject({ tipo: "rechazo", estado: 422 });
    await expect(con(new Response("{}", { status: 401 })).clonar(entrada)).rejects.toMatchObject({ tipo: "proveedor" });
    await expect(con(new Response("{}", { status: 500 })).clonar(entrada)).rejects.toMatchObject({ tipo: "proveedor" });
    await expect(con(new Error("red")).clonar(entrada)).rejects.toMatchObject({ tipo: "proveedor" });
    await expect(con(new Response(JSON.stringify({ voice_id: "../../x" }), { status: 200 })).clonar(entrada)).rejects.toMatchObject({ tipo: "proveedor" });
  });
});
