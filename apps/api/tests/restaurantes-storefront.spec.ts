// Storefront publico de restaurantes (R-09): menu, cotizar -> confirmar -> crear y rastreo por token,
// por HTTP real sobre el repositorio en memoria. Cubre reglas duras, token invalido/de otro tenant/vencido,
// origen no permitido, limite de tasa, doble envio y rastreo sin datos personales.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { FakeSoftRestaurantAdapter, InMemoryComandaOutboxStore, MapaProductoCodigo, crearResolverSucursalPos, type SoftRestaurantPort } from "@atiende/domain-restaurantes/softrestaurant";
import { InMemoryPrivacidadRepository } from "@atiende/domain-restaurantes";
import { buildApp } from "../src/app.ts";
import type { AppDeps } from "../src/deps.ts";
import { issueStorefrontTrackingToken, signStorefrontTrackingToken, storefrontTrackingKey } from "../src/storefront-tracking-token.ts";
import { InMemoryVozRepository } from "@atiende/domain-restaurantes";
import { buildTestDeps, jsonRequestInit, TEST_ENV } from "./fixtures.ts";

const ORG = "los-taquitos-de-pm";
const BASE = `/v1/restaurantes/${ORG}/storefront`;
const ORIGIN = { origin: "http://localhost:5173" };
const SESSION = "sesion-web-0001-abcdef";

async function setup() {
  const t = await buildTestDeps();
  const app = buildApp(t.deps);
  const coca = { product_id: t.products.cocaCola, requested_quantity: 2 };
  const post = (path: string, body: Record<string, unknown>, headers: Record<string, string> = ORIGIN) => app.request(`${BASE}${path}`, jsonRequestInit(body, headers));
  // Cuerpos de respuesta heterogeneos de un endpoint HTTP: los asserts verifican la forma.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json = async (res: Response) => (await res.json()) as Record<string, any>;
  const flow = async (extra: Record<string, unknown> = {}) => {
    const body = { session_id: SESSION, items: [coca], canal: "recoger", payment_method: "efectivo", ...extra };
    const q = await post("/fco-montejo/quote", body);
    const quote = await json(q);
    const c = await post("/fco-montejo/confirm", { session_id: SESSION, quote_hash: quote.quote_hash });
    const o = await post("/fco-montejo/orders", { ...body, quote_hash: quote.quote_hash, acepta_aviso_privacidad: true, customer_name: "Ana Pérez", customer_phone: "999 123 4567", customer_address: "Calle Secreta 123", ...extra });
    return { q, c, o };
  };
  return { ...t, app, coca, post, json, flow };
}

describe("lectura publica: sucursales y menu", () => {
  it("lista el restaurante y sus sucursales activas sin necesitar login", async () => {
    const s = await setup();
    const res = await s.app.request(BASE);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await s.json(res);
    expect(body.restaurante).toEqual({ slug: ORG, nombre: "Los Taquitos de PM" });
    expect(body.sucursales.map((b: { slug: string }) => b.slug)).toEqual(["fco-montejo"]);
  });

  it("menu por categorias con precio de la sucursal y 'hoy no hay'", async () => {
    const s = await setup();
    await s.restaurantesRepo.upsertBranchProductState(s.propertyId, s.products.cocaCola!, 47, false);
    const body = await s.json(await s.app.request(`${BASE}/fco-montejo/menu`));
    const items = body.categorias.flatMap((c: { items: unknown[] }) => c.items) as Array<{ name: string; price: number; available: boolean }>;
    expect(items.find((i) => i.name === "Coca-Cola")).toMatchObject({ price: 47, available: false });
    expect(items.find((i) => i.name.startsWith("Tacos"))).toMatchObject({ price: 164, available: true });
  });

  it("404 con restaurante o sucursal inexistente", async () => {
    const s = await setup();
    expect((await s.app.request(`/v1/restaurantes/no-existe/storefront`)).status).toBe(404);
    expect((await s.app.request(`${BASE}/no-existe/menu`)).status).toBe(404);
  });

  it("una sucursal inactiva no es visible", async () => {
    const s = await setup();
    s.restaurantesRepo.seedBranch({ propertyId: randomUUID(), organizationId: s.organizationId, name: "Cerrada", slug: "cerrada", status: "inactive", phone: null, address: null, lat: null, lng: null });
    expect((await s.app.request(`${BASE}/cerrada/menu`)).status).toBe(404);
  });
});

describe("sucursal sugerida y zonas (portada)", () => {
  async function conZona() {
    const s = await setup();
    s.restaurantesRepo.seedKnownZone({ id: randomUUID(), organizationId: s.organizationId, name: "Vista Alegre", lat: 21.02, lng: -89.67, createdAt: "2026-01-01T00:00:00Z" });
    return s;
  }

  it("zonas: solo nombres, sin coordenadas ni ids", async () => {
    const s = await conZona();
    const res = await s.app.request(`${BASE}/zonas`);
    expect(res.status).toBe(200);
    const body = await s.json(res);
    expect(body).toEqual({ zonas: ["Vista Alegre"] });
  });

  it("por colonia: sugiere la sucursal que reparte ahi", async () => {
    const s = await conZona();
    const res = await s.post("/sucursal-sugerida", { colonia: "vista alegre" });
    expect(res.status).toBe(200);
    expect((await s.json(res)).sugerencia).toMatchObject({ tipo: "reparte", sucursal: { slug: "fco-montejo" }, zona: "Vista Alegre" });
  });

  it("colonia desconocida: sin_resultado honesto (200), no se inventa sucursal", async () => {
    const s = await conZona();
    const res = await s.post("/sucursal-sugerida", { colonia: "Atlantida" });
    expect((await s.json(res)).sugerencia).toMatchObject({ tipo: "sin_resultado" });
  });

  it("por ubicacion: sugiere la mas cercana y NO devuelve ni guarda las coordenadas", async () => {
    const s = await conZona();
    const res = await s.post("/sucursal-sugerida", { lat: 21.0187, lng: -89.6709 });
    const texto = JSON.stringify(await s.json(res));
    expect(texto).toContain("fco-montejo");
    expect(texto).not.toContain("21.0187");
    expect(texto).not.toContain("89.6709");
  });

  it("validaciones: sin datos, ubicacion invalida, origen no permitido y restaurante inexistente", async () => {
    const s = await conZona();
    expect((await s.post("/sucursal-sugerida", {})).status).toBe(400);
    expect((await s.post("/sucursal-sugerida", { lat: 999, lng: 0 })).status).toBe(400);
    expect((await s.post("/sucursal-sugerida", { lat: "21", lng: "-89" })).status).toBe(400);
    expect((await s.post("/sucursal-sugerida", { colonia: "x".repeat(121) })).status).toBe(400);
    expect((await s.post("/sucursal-sugerida", { colonia: "vista alegre" }, { origin: "https://sitio-no-permitido.mx" })).status).toBe(403);
    const res = await s.app.request(`/v1/restaurantes/no-existe/storefront/sucursal-sugerida`, jsonRequestInit({ colonia: "x" }, ORIGIN));
    expect(res.status).toBe(404);
  });
});

describe("aviso de privacidad: encargados y transferencias (borrador)", () => {
  /** Restaurante sin canal de WhatsApp ni voz: la fixture base ya trae un numero conectado. */
  async function orgSinCanal() {
    const s = await setup();
    const organizationId = randomUUID();
    const propertyId = randomUUID();
    s.restaurantesRepo.seedOrganization({ id: organizationId, slug: "sin-canal", name: "Sin Canal" });
    s.restaurantesRepo.seedBranch({ propertyId, organizationId, name: "Unica", slug: "unica", status: "active", phone: null, address: null, lat: null, lng: null });
    return { s, organizationId, propertyId, url: "/v1/restaurantes/sin-canal/storefront/privacidad" };
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ids = (body: Record<string, any>) => body.encargados.encargados.map((e: { id: string }) => e.id);

  it("sin WhatsApp ni voz configurados: lista vacia, igual marcada como borrador", async () => {
    const { s, url } = await orgSinCanal();
    const res = await s.app.request(url);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect((await s.json(res)).encargados).toMatchObject({ borrador: true, revisionLegalPendiente: true, encargados: [] });
  });

  it("con un numero de WhatsApp conectado aparecen el modelo de lenguaje y Meta con su pais", async () => {
    const { s, organizationId, url } = await orgSinCanal();
    await s.restaurantesRepo.upsertWhatsappChannelConfig(organizationId, "pnid-123");
    const body = await s.json(await s.app.request(url));
    expect(ids(body)).toEqual(["openrouter", "meta_whatsapp"]);
    expect(body.encargados.encargados[0].pais).toBeTruthy();
  });

  it("con la voz habilitada en una sucursal activa aparecen Gemini, Twilio y LiveKit", async () => {
    const { s, organizationId, propertyId, url } = await orgSinCanal();
    const voz = new InMemoryVozRepository();
    voz.seedProperty(propertyId, organizationId);
    await voz.upsertConfig(organizationId, propertyId, { habilitado: true, proveedor: "gemini-3.8-live", voiceId: "Kore", comportamiento: "Hable de usted.", mensajeInicial: "Hola." } as never);
    const app = buildApp({ ...s.deps, vozRepo: () => voz });
    expect(ids((await (await app.request(url)).json()) as Record<string, unknown>)).toEqual(["openrouter", "gemini", "twilio", "livekit"]);
  });

  it("una voz deshabilitada, o con la base sin migrar, NO se lista", async () => {
    const { s, organizationId, propertyId, url } = await orgSinCanal();
    const voz = new InMemoryVozRepository();
    voz.seedProperty(propertyId, organizationId);
    await voz.upsertConfig(organizationId, propertyId, { habilitado: false, proveedor: "gemini-3.8-live", voiceId: "Kore", comportamiento: "Hable de usted.", mensajeInicial: "Hola." } as never);
    const deshabilitada = buildApp({ ...s.deps, vozRepo: () => voz });
    expect(ids((await (await deshabilitada.request(url)).json()) as Record<string, unknown>)).toEqual([]);
    voz.migrada = false;
    const res = await deshabilitada.request(url);
    expect(res.status).toBe(200);
    expect(ids((await res.json()) as Record<string, unknown>)).toEqual([]);
  });

  it("restaurante inexistente: 404", async () => {
    const s = await setup();
    expect((await s.app.request(`/v1/restaurantes/no-existe/storefront/privacidad`)).status).toBe(404);
  });
});

describe("flujo cotizar -> confirmar -> crear y rastreo", () => {
  it("pedido a recoger completo: crea, devuelve token y el rastreo no expone datos personales", async () => {
    const s = await setup();
    const { q, c, o } = await s.flow();
    expect(q.status).toBe(200);
    expect(c.status).toBe(200);
    expect(o.status).toBe(200);
    const created = await s.json(o);
    expect(created).toMatchObject({ estado: "pending", total: 90, canal: "recoger", comanda: null });
    const tracking = await s.app.request(`${BASE}/track/${created.rastreo_token}`);
    expect(tracking.status).toBe(200);
    const text = JSON.stringify(await tracking.json());
    expect(text).toContain('"status":"pending"');
    expect(text).not.toMatch(/Ana|9991234567|Secreta|customer/);
    // La URL del rastreo tampoco lleva datos personales: solo el token opaco.
    expect(created.rastreo_token).not.toMatch(/Ana|9991234567|Secreta/);
  });

  describe("consentimiento del aviso de privacidad (R-18)", () => {
    async function conPrivacidad(privacidad: InMemoryPrivacidadRepository) {
      const t = await buildTestDeps();
      const deps: AppDeps = { ...t.deps, privacidadRepo: () => privacidad };
      const app = buildApp(deps);
      const coca = { product_id: t.products.cocaCola, requested_quantity: 2 };
      const post = (path: string, body: Record<string, unknown>) => app.request(`${BASE}${path}`, jsonRequestInit(body, ORIGIN));
      const base = { session_id: SESSION, items: [coca], canal: "recoger", payment_method: "efectivo" };
      const quote = (await (await post("/fco-montejo/quote", base)).json()) as { quote_hash: string };
      await post("/fco-montejo/confirm", { session_id: SESSION, quote_hash: quote.quote_hash });
      const crear = (extra: Record<string, unknown>) => post("/fco-montejo/orders", { ...base, quote_hash: quote.quote_hash, customer_name: "Ana Pérez", customer_phone: "9991234567", ...extra });
      return { t, crear };
    }

    it.each([[{}], [{ acepta_aviso_privacidad: false }], [{ acepta_aviso_privacidad: "true" }], [{ acepta_aviso_privacidad: 1 }]])("sin aceptar el aviso (%j): 400 claro y NO se crea pedido ni cliente", async (extra) => {
      const privacidad = new InMemoryPrivacidadRepository();
      const { t, crear } = await conPrivacidad(privacidad);
      const res = await crear(extra);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: "validation_error", motivo: "aviso_privacidad_requerido", message: expect.stringContaining("aviso de privacidad") });
      expect(await t.restaurantesRepo.findCustomerByPhone(t.organizationId, "9991234567")).toBeNull();
      expect(privacidad.pedidoConsents.size).toBe(0);
      // Y el rechazo no consume la cotizacion confirmada: con la casilla marcada, el MISMO flujo crea el pedido.
      const ok = await crear({ acepta_aviso_privacidad: true });
      expect(ok.status).toBe(200);
    });

    it("aceptando el aviso guarda la evidencia: version vigente del aviso, canal web, UNA fila por pedido y sin telefono ni nombre", async () => {
      const privacidad = new InMemoryPrivacidadRepository();
      const { t, crear } = await conPrivacidad(privacidad);
      privacidad.configs.set(t.organizationId, { responsibleName: "PM", noticeUrl: "https://pm.example/aviso", noticeVersion: "v7", conversationRetentionDays: 180, voiceRetentionDays: 30, recordingConsentRequired: true, configurada: true });
      const res = await crear({ acepta_aviso_privacidad: true });
      expect(res.status).toBe(200);
      const order = (await t.restaurantesRepo.listOrders(t.organizationId, { propertyIds: null, limit: 10 } as never)).orders[0]!;
      expect(privacidad.pedidoConsents.size).toBe(1);
      expect(privacidad.pedidoConsents.get(order.id)).toMatchObject({ organizationId: t.organizationId, noticeVersion: "v7", channel: "web" });
      expect(JSON.stringify([...privacidad.pedidoConsents.values()])).not.toMatch(/Ana|9991234567/);
      // Doble envio del mismo pedido: no duplica la evidencia.
      expect((await crear({ acepta_aviso_privacidad: true })).status).toBe(200);
      expect(privacidad.pedidoConsents.size).toBe(1);
    });

    it("base SIN la migracion 063: el pedido se crea igual (200), el consentimiento queda 'no disponible' y nada se guarda", async () => {
      const privacidad = new InMemoryPrivacidadRepository();
      privacidad.consentimientoPedidosMigrado = false;
      const { crear } = await conPrivacidad(privacidad);
      expect((await crear({ acepta_aviso_privacidad: true })).status).toBe(200);
      expect(privacidad.pedidoConsents.size).toBe(0);
    });

    it("si guardar la evidencia falla de verdad, el pedido YA creado no se pierde (200) y el error se registra", async () => {
      const privacidad = new InMemoryPrivacidadRepository();
      privacidad.recordOrderPrivacyConsent = async () => {
        throw new Error("falla simulada");
      };
      const { t, crear } = await conPrivacidad(privacidad);
      const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const res = await crear({ acepta_aviso_privacidad: true });
      expect(res.status).toBe(200);
      expect(error).toHaveBeenCalledWith(expect.stringContaining("consentimiento"), "falla simulada");
      error.mockRestore();
      expect((await t.restaurantesRepo.listOrders(t.organizationId, { propertyIds: null, limit: 10 } as never)).orders).toHaveLength(1);
    });
  });

  it("crear sin cotizar: 400 con el motivo y no se crea pedido", async () => {
    const s = await setup();
    const res = await s.post("/fco-montejo/orders", { session_id: SESSION, items: [s.coca], canal: "recoger", payment_method: "efectivo", acepta_aviso_privacidad: true, customer_name: "Ana", customer_phone: "9991234567" });
    expect(res.status).toBe(400);
    expect(await s.json(res)).toMatchObject({ code: "validation_error", motivo: "sin_cotizacion" });
    expect(await s.restaurantesRepo.findCustomerByPhone(s.organizationId, "9991234567")).toBeNull();
  });

  it("doble envio: el segundo POST devuelve el MISMO rastreo (ya_registrado), no un error ni un pedido nuevo", async () => {
    const s = await setup();
    const first = await s.json((await s.flow()).o);
    const body = { session_id: SESSION, items: [s.coca], canal: "recoger", payment_method: "efectivo", acepta_aviso_privacidad: true, customer_name: "Ana Pérez", customer_phone: "9991234567" };
    const again = await s.json(await s.post("/fco-montejo/orders", body));
    expect(again.ya_registrado).toBe(true);
    const verify = (t: string) => JSON.parse(Buffer.from(t.split(".")[1]!, "base64url").toString()).ord;
    expect(verify(again.rastreo_token)).toBe(verify(first.rastreo_token));
  });

  it("a domicilio sin direccion: 400; con direccion y bajo el minimo de $200: 400 con el faltante", async () => {
    const s = await setup();
    s.restaurantesRepo.seedBranchPolicy(s.propertyId, { pedidoMinimoDomicilio: 200 });
    const bajo = await s.post("/fco-montejo/quote", { session_id: SESSION, items: [s.coca], canal: "domicilio" });
    expect(bajo.status).toBe(400);
    expect((await s.json(bajo)).message).toMatch(/mínimo a domicilio.*\$200.*faltan \$110/);
    const ok = { session_id: SESSION, items: [{ product_id: s.products.tacosPastor, requested_quantity: 6, tortilla: "maiz" }], canal: "domicilio", payment_method: "efectivo" };
    const q = await s.json(await s.post("/fco-montejo/quote", ok));
    await s.post("/fco-montejo/confirm", { session_id: SESSION, quote_hash: q.quote_hash });
    const sinDireccion = await s.post("/fco-montejo/orders", { ...ok, acepta_aviso_privacidad: true, customer_name: "Ana", customer_phone: "9991234567" });
    expect(sinDireccion.status).toBe(400);
    expect((await s.json(sinDireccion)).message).toMatch(/dirección completa/);
  });

  it("promo con domicilio: la vista previa explica que solo aplica al recoger; al recoger descuenta", async () => {
    const s = await setup();
    await s.restaurantesRepo.createPromotion(s.organizationId, { code: "COCA2X1", name: "2x1", type: "bogo", value: 1, channels: ["recoger"] });
    const dom = await s.json(await s.post("/fco-montejo/quote", { session_id: SESSION, items: [s.coca], canal: "domicilio", promo_code: "coca2x1" }));
    expect(dom.promo).toMatchObject({ valida: false, descuento: 0 });
    const rec = await s.json(await s.post("/fco-montejo/quote", { session_id: SESSION, items: [s.coca], canal: "recoger", promo_code: "coca2x1" }));
    expect(rec.promo).toMatchObject({ valida: true, descuento: 45, totalConDescuento: 45 });
  });

  it("sucursal cerrada: 400 con la proxima apertura", async () => {
    const s = await setup();
    s.restaurantesRepo.seedBranchPolicy(s.propertyId, { horario: [{ dias: [0, 1, 2, 3, 4, 5, 6], abre: "00:00", cierra: "00:01" }] });
    const res = await s.post("/fco-montejo/quote", { session_id: SESSION, items: [s.coca], canal: "recoger" });
    expect(res.status).toBe(400);
    expect((await s.json(res)).message).toMatch(/cerrada/);
  });
});

describe("rastreo: token invalido, de otro tenant, vencido y base sin migrar", () => {
  it("token manipulado, mal formado o inventado: 404 uniforme", async () => {
    const s = await setup();
    const { o } = await s.flow();
    const token = (await s.json(o)).rastreo_token as string;
    const [h, p, sig] = token.split(".");
    const manipulado = `${h}.${Buffer.from(JSON.stringify({ org: s.organizationId, ord: randomUUID(), iat: 1, exp: 9999999999 })).toString("base64url")}.${sig}`;
    for (const bad of [manipulado, `${h}.${p}.AAAA`, "basura", "t1..", encodeURIComponent("a.b.c"), "t1." + "x".repeat(700)]) {
      const res = await s.app.request(`${BASE}/track/${bad}`);
      expect(res.status, bad).toBe(404);
    }
  });

  it("token valido de OTRA organizacion no rastrea nada aqui (cross-tenant)", async () => {
    const s = await setup();
    const { o } = await s.flow();
    const orderId = JSON.parse(Buffer.from(((await s.json(o)).rastreo_token as string).split(".")[1]!, "base64url").toString()).ord as string;
    const otraOrg = randomUUID();
    s.restaurantesRepo.seedOrganization({ id: otraOrg, slug: "otro-restaurante", name: "Otro" });
    const key = storefrontTrackingKey(TEST_ENV.internalSecret);
    // (a) token emitido para la otra organizacion pero con el id del pedido de esta: el pedido no es suyo.
    const ajeno = issueStorefrontTrackingToken(key, otraOrg, orderId);
    expect((await s.app.request(`/v1/restaurantes/otro-restaurante/storefront/track/${ajeno}`)).status).toBe(404);
    // (b) token de esta organizacion presentado en la URL de la otra.
    const propio = issueStorefrontTrackingToken(key, s.organizationId, orderId);
    expect((await s.app.request(`/v1/restaurantes/otro-restaurante/storefront/track/${propio}`)).status).toBe(404);
    expect((await s.app.request(`${BASE}/track/${propio}`)).status).toBe(200);
  });

  it("token vencido: 404; pedido inexistente con token bien firmado: 404", async () => {
    const s = await setup();
    const key = storefrontTrackingKey(TEST_ENV.internalSecret);
    const vencido = signStorefrontTrackingToken(key, { org: s.organizationId, ord: randomUUID(), iat: 1, exp: 2 });
    expect((await s.app.request(`${BASE}/track/${vencido}`)).status).toBe(404);
    expect((await s.app.request(`${BASE}/track/${issueStorefrontTrackingToken(key, s.organizationId, randomUUID())}`)).status).toBe(404);
  });

  it("un token firmado con otra llave (p. ej. el de voz) no sirve", async () => {
    const s = await setup();
    const falso = issueStorefrontTrackingToken(storefrontTrackingKey("otro-secreto"), s.organizationId, randomUUID());
    expect((await s.app.request(`${BASE}/track/${falso}`)).status).toBe(404);
  });

  it("base sin la migracion 032: 200 con disponible:false y mensaje honesto, no 500", async () => {
    const s = await setup();
    const { o } = await s.flow();
    const token = (await s.json(o)).rastreo_token as string;
    s.restaurantesRepo.simulateStorefrontTrackingUnavailable();
    const res = await s.app.request(`${BASE}/track/${token}`);
    expect(res.status).toBe(200);
    expect(await s.json(res)).toMatchObject({ disponible: false, mensaje: expect.stringContaining("no está disponible") });
  });
});

describe("anti-abuso", () => {
  it("403 con Origin no permitido en cotizar, confirmar y crear", async () => {
    const s = await setup();
    const malo = { origin: "https://sitio-no-permitido.mx" };
    for (const path of ["/fco-montejo/quote", "/fco-montejo/confirm", "/fco-montejo/orders"]) {
      expect((await s.post(path, { session_id: SESSION, items: [s.coca] }, malo)).status, path).toBe(403);
    }
  });

  it("session_id e items invalidos: 400 antes de tocar la base", async () => {
    const s = await setup();
    expect((await s.post("/fco-montejo/quote", { session_id: "corto", items: [s.coca] })).status).toBe(400);
    expect((await s.post("/fco-montejo/quote", { session_id: SESSION, items: [] })).status).toBe(400);
    expect((await s.post("/fco-montejo/quote", { session_id: SESSION, items: Array.from({ length: 51 }, () => s.coca) })).status).toBe(400);
    expect((await s.post("/fco-montejo/quote", { session_id: SESSION, items: [null] })).status).toBe(400);
  });

  it("el precio nunca viene del navegador: un price/total mandado se ignora", async () => {
    const s = await setup();
    const q = await s.json(await s.post("/fco-montejo/quote", { session_id: SESSION, items: [{ ...s.coca, price: 1 }], total: 1, canal: "recoger" }));
    expect(q.quote.total).toBe(90);
  });

  it("limite de tasa: el pedido 11 de la misma IP y sesion en un minuto recibe 429", async () => {
    const s = await setup();
    const headers = { ...ORIGIN, "x-forwarded-for": "203.0.113.9" };
    let last = 0;
    for (let i = 0; i < 11; i += 1) {
      last = (await s.post("/fco-montejo/orders", { session_id: SESSION, items: [s.coca], canal: "recoger", payment_method: "efectivo", acepta_aviso_privacidad: true, customer_name: "A", customer_phone: "9991234567" }, headers)).status;
    }
    expect(last).toBe(429);
  });

  it("limite de tasa: rotar session_id en cada peticion NO da un bucket nuevo (tope por IP)", async () => {
    const s = await setup();
    const headers = { ...ORIGIN, "x-forwarded-for": "203.0.113.10" };
    const statuses: number[] = [];
    for (let i = 0; i < 12; i += 1) {
      const sid = `rotada-${String(i).padStart(2, "0")}-abcdefghij`;
      statuses.push((await s.post("/fco-montejo/orders", { session_id: sid, items: [s.coca], canal: "recoger", payment_method: "efectivo", acepta_aviso_privacidad: true, customer_name: "A", customer_phone: "9991234567" }, headers)).status);
    }
    expect(statuses.slice(0, 10)).not.toContain(429);
    expect(statuses.slice(10)).toEqual([429, 429]);
  });

  it("limite de tasa: otra IP conserva su propio cupo aunque la primera ya se agoto", async () => {
    const s = await setup();
    const a = { ...ORIGIN, "x-forwarded-for": "203.0.113.11" };
    for (let i = 0; i < 11; i += 1) await s.post("/fco-montejo/quote", { session_id: `ip-a-${String(i).padStart(2, "0")}-abcdefghijk`, items: [s.coca], canal: "recoger" }, a);
    const otra = { ...ORIGIN, "x-forwarded-for": "203.0.113.12" };
    expect((await s.post("/fco-montejo/quote", { session_id: SESSION, items: [s.coca], canal: "recoger" }, otra)).status).not.toBe(429);
  });
});

describe("comanda a SoftRestaurant desde el storefront", () => {
  it("con la bandera ACTIVA el pedido del storefront encola la comanda y la respuesta la reporta", async () => {
    const base = await buildTestDeps();
    const store = new InMemoryComandaOutboxStore();
    store.ponerModo(base.organizationId, "activo");
    const fake = new FakeSoftRestaurantAdapter();
    const port = new Proxy(fake, { get: (t, p, r) => (p === "esReal" ? true : Reflect.get(t, p, r)) }) as unknown as SoftRestaurantPort;
    const deps: AppDeps = {
      ...base.deps,
      softRestaurantStore: () => store,
      softRestaurantPort: port,
      softRestaurantMapeo: { resolverCodigos: new MapaProductoCodigo([{ productId: base.products.cocaCola!, codigo: "FAKE-003" }]), resolverSucursal: crearResolverSucursalPos({ [base.propertyId]: "T2" }) },
    };
    const app = buildApp(deps);
    const body = { session_id: SESSION, items: [{ product_id: base.products.cocaCola, requested_quantity: 2 }], canal: "recoger", payment_method: "efectivo" };
    const post = (path: string, b: Record<string, unknown>) => app.request(`${BASE}${path}`, jsonRequestInit(b, ORIGIN));
    const q = (await (await post("/fco-montejo/quote", body)).json()) as { quote_hash: string };
    await post("/fco-montejo/confirm", { session_id: SESSION, quote_hash: q.quote_hash });
    const res = await post("/fco-montejo/orders", { ...body, quote_hash: q.quote_hash, acepta_aviso_privacidad: true, customer_name: "Ana", customer_phone: "9991234567" });
    expect(res.status).toBe(200);
    const created = (await res.json()) as { comanda: { estado: string } | null };
    expect(created.comanda).not.toBeNull();
    expect(store.todas()).toHaveLength(1);
    expect(store.todas()[0]).toMatchObject({ organizationId: base.organizationId });
  });
});
