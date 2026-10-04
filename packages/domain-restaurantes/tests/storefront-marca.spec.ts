// R-38 / R-43 -- marca publica del storefront, wa.me, promociones visibles y validacion de la solicitud de evento.
// Sobre el repositorio en memoria; la base sin migrar (SQLSTATE 42P01/42703 dentro de la transaccion compartida) se cubre abajo con
// AbortAwareFakeSession.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MARCA_VACIA, StorefrontValidationError, buildStorefrontPromociones, enlaceWhatsapp, validarMarca, validarSolicitudEvento } from "../src/storefront-marca.ts";
import { buildStorefrontBranches } from "../src/storefront.ts";
import { PostgresRestaurantesRepository } from "../src/postgres-repository.ts";
import { RestaurantesConfigUnavailableError } from "../src/repository.ts";
import { buildRestaurantFixture } from "./fixtures.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

const ORG = "00000000-0000-4000-8000-0000000000b1";

function pgError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

describe("validarMarca", () => {
  it("normaliza texto, vacia lo que viene en blanco y acepta enlaces https de la red correcta", () => {
    const m = validarMarca({
      titular: "  Los   Taquitos  ",
      eslogan: "",
      about: "Tacos\ncon historia",
      portadaUrl: "https://cdn.example.com/portada.jpg",
      logoUrl: " https://cdn.example.com/logo.png ",
      instagramUrl: "https://www.instagram.com/lostaquitos",
      facebookUrl: "https://facebook.com/lostaquitos",
      tiktokUrl: "https://tiktok.com/@lostaquitos",
    });
    expect(m).toEqual({
      titular: "Los Taquitos",
      eslogan: null,
      about: "Tacos\ncon historia",
      portadaUrl: "https://cdn.example.com/portada.jpg",
      logoUrl: "https://cdn.example.com/logo.png",
      instagramUrl: "https://www.instagram.com/lostaquitos",
      facebookUrl: "https://facebook.com/lostaquitos",
      tiktokUrl: "https://tiktok.com/@lostaquitos",
    });
  });

  it("un cuerpo vacio borra todo (todos los campos null)", () => {
    const { updatedAt: _omitido, ...vacia } = MARCA_VACIA;
    expect(validarMarca({})).toEqual(vacia);
  });

  it.each([
    ["portadaUrl", "http://cdn.example.com/a.jpg"],
    ["portadaUrl", "javascript:alert(1)"],
    ["logoUrl", "data:image/png;base64,AAAA"],
    ["logoUrl", "https://localhost/logo.png"],
    ["instagramUrl", "https://evil.example.com/instagram.com/x"],
    ["facebookUrl", "https://instagram.com/lostaquitos"],
    ["tiktokUrl", "https://tiktok.com.evil.example/x"],
    ["instagramUrl", "https://instagram.com/con espacio"],
  ])("rechaza %s = %s", (campo, valor) => {
    expect(() => validarMarca({ [campo]: valor })).toThrow(StorefrontValidationError);
  });

  it("rechaza textos fuera de limite y tipos que no son texto", () => {
    expect(() => validarMarca({ titular: "x".repeat(121) })).toThrow(/titular/);
    expect(() => validarMarca({ about: "x".repeat(1201) })).toThrow(/descripción/);
    expect(() => validarMarca({ eslogan: 42 })).toThrow(StorefrontValidationError);
  });
});

describe("enlaceWhatsapp", () => {
  it("arma el wa.me con el numero de la sucursal en formato internacional y el texto prellenado codificado", () => {
    expect(enlaceWhatsapp("999 123 4567", "Hola, quiero pedir")).toBe("https://wa.me/529991234567?text=Hola%2C%20quiero%20pedir");
    expect(enlaceWhatsapp("+52 1 999 123 4567", "x")).toContain("https://wa.me/5219991234567");
  });
  it("sin telefono o con uno invalido no hay enlace (el boton no se muestra)", () => {
    expect(enlaceWhatsapp(null, "x")).toBeNull();
    expect(enlaceWhatsapp("12345", "x")).toBeNull();
  });
});

describe("buildStorefrontBranches expone whatsappUrl", () => {
  it("solo con telefono valido", async () => {
    const f = buildRestaurantFixture();
    const vistas = await buildStorefrontBranches(f.repo, f.organizationId);
    expect(vistas.length).toBeGreaterThan(0);
    for (const v of vistas) expect(v.whatsappUrl === null || v.whatsappUrl.startsWith("https://wa.me/")).toBe(true);
  });
});

describe("buildStorefrontPromociones", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-28T20:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("lista solo las que el motor aplica solas en recoger y estan vigentes: nada de codigos, domicilio, vencidas ni agotadas", async () => {
    const f = buildRestaurantFixture();
    const sucursales = (await f.repo.listBranchesForOrganizationAdmin(f.organizationId)).map((b) => ({ slug: b.slug, propertyId: b.propertyId }));
    const base = { type: "bogo" as const, value: 1, channels: ["recoger" as const] };
    await f.repo.createPromotion(f.organizationId, { ...base, code: "LUNES2X1", name: "Lunes 2x1", autoApply: true, daysOfWeek: [1], description: "Tacos al pastor" });
    await f.repo.createPromotion(f.organizationId, { ...base, code: "SOLOCODIGO", name: "Solo con codigo", autoApply: false });
    await f.repo.createPromotion(f.organizationId, { code: "DOMI", name: "A domicilio", type: "percentage", value: 10, autoApply: true, channels: ["domicilio"] });
    await f.repo.createPromotion(f.organizationId, { ...base, code: "VENCIDA", name: "Vencida", autoApply: true, endsAt: "2026-09-01T00:00:00Z" });
    await f.repo.createPromotion(f.organizationId, { ...base, code: "FUTURA", name: "Futura", autoApply: true, startsAt: "2026-12-01T00:00:00Z" });
    await f.repo.createPromotion(f.organizationId, { ...base, code: "AGOTADA", name: "Agotada", autoApply: true, maxUses: 1 });
    await f.repo.incrementPromotionUses(f.organizationId, (await f.repo.findPromotionByCode(f.organizationId, "AGOTADA"))!.id);
    await f.repo.createPromotion(f.organizationId, { ...base, code: "APAGADA", name: "Apagada", autoApply: true, isActive: false });
    const vistas = await buildStorefrontPromociones(f.repo, f.organizationId, sucursales);
    expect(vistas.map((v) => v.nombre)).toEqual(["Lunes 2x1"]);
    expect(vistas[0]).toMatchObject({ beneficio: "2x1", canal: "recoger", dias: [1], sucursales: null, descripcion: "Tacos al pastor" });
    expect(JSON.stringify(vistas)).not.toContain("LUNES2X1"); // el codigo interno no se publica
  });

  it("una promocion con alcance por sucursal muestra los slugs de las sucursales activas y se oculta si ya no hay ninguna", async () => {
    const f = buildRestaurantFixture();
    const sucursales = (await f.repo.listBranchesForOrganizationAdmin(f.organizationId)).map((b) => ({ slug: b.slug, propertyId: b.propertyId }));
    const [una] = sucursales;
    await f.repo.createPromotion(f.organizationId, { code: "UNASUC", name: "Una sucursal", type: "percentage", value: 15, autoApply: true, channels: ["recoger"], propertyIds: [una!.propertyId] });
    await f.repo.createPromotion(f.organizationId, { code: "AJENA", name: "Sucursal cerrada", type: "fixed", value: 30, autoApply: true, channels: ["recoger"], propertyIds: ["00000000-0000-4000-8000-00000000dead"] });
    const vistas = await buildStorefrontPromociones(f.repo, f.organizationId, sucursales);
    expect(vistas.map((v) => v.nombre)).toEqual(["Una sucursal"]);
    expect(vistas[0]).toMatchObject({ beneficio: "15% de descuento", sucursales: [una!.slug] });
  });

  it("no mezcla promociones de otra organizacion", async () => {
    const f = buildRestaurantFixture();
    await f.repo.createPromotion("00000000-0000-4000-8000-0000000000ff", { code: "OTRA", name: "De otra org", type: "bogo", value: 1, autoApply: true, channels: ["recoger"] });
    expect(await buildStorefrontPromociones(f.repo, f.organizationId, [])).toEqual([]);
  });
});

describe("validarSolicitudEvento", () => {
  const HOY = "2026-10-03";
  const ok = { nombre: "Ana Pérez", telefono: "999 123 4567", fechaEvento: "2026-11-15", personas: 40, sucursal: "fco-montejo", comentario: "Boda, mesa de tacos", aceptaAviso: true };

  it("devuelve la solicitud normalizada y el mensaje que se guarda (sin telefono ni nombre dentro del mensaje)", () => {
    const s = validarSolicitudEvento(ok, HOY);
    expect(s).toMatchObject({ nombre: "Ana Pérez", telefono: "9991234567", fechaEvento: "2026-11-15", personas: 40, sucursalSlug: "fco-montejo" });
    expect(s.mensaje).toBe("Fecha del evento: 2026-11-15\nPersonas: 40\nComentario: Boda, mesa de tacos\nAviso de privacidad aceptado.");
  });

  it("la fecha de hoy es valida; ayer, una fecha imposible o muy lejana no", () => {
    expect(validarSolicitudEvento({ ...ok, fechaEvento: HOY }, HOY).fechaEvento).toBe(HOY);
    expect(() => validarSolicitudEvento({ ...ok, fechaEvento: "2026-10-02" }, HOY)).toThrow(/ya pasó/);
    expect(() => validarSolicitudEvento({ ...ok, fechaEvento: "2026-02-30" }, HOY)).toThrow(/fecha/);
    expect(() => validarSolicitudEvento({ ...ok, fechaEvento: "2029-01-01" }, HOY)).toThrow(/lejos/);
    expect(() => validarSolicitudEvento({ ...ok, fechaEvento: "15/11/2026" }, HOY)).toThrow(/fecha/);
  });

  it.each([
    [{ nombre: "A" }, /nombre/],
    [{ nombre: 7 }, /texto/],
    [{ telefono: "123" }, /teléfono/],
    [{ personas: 0 }, /personas/],
    [{ personas: 2001 }, /personas/],
    [{ personas: 10.5 }, /personas/],
    [{ personas: "40" }, /personas/],
    [{ sucursal: "../etc" }, /sucursal/],
    [{ sucursal: undefined }, /sucursal/],
    [{ comentario: "x".repeat(1001) }, /comentario/],
    [{ aceptaAviso: false }, /aviso de privacidad/],
    [{ aceptaAviso: "true" }, /aviso de privacidad/],
  ])("rechaza %j", (cambio, mensaje) => {
    expect(() => validarSolicitudEvento({ ...ok, ...cambio }, HOY)).toThrow(mensaje);
  });

  it("el comentario es opcional y se limpian caracteres de control", () => {
    const s = validarSolicitudEvento({ ...ok, comentario: "  \u0000hola\u0007  " }, HOY);
    expect(s.comentario).toBe("hola");
    expect(validarSolicitudEvento({ ...ok, comentario: undefined }, HOY).mensaje).not.toContain("Comentario");
  });
});

describe("marca contra la base SIN migrar (SQLSTATE 42P01 en una transaccion compartida)", () => {
  it("la lectura devuelve null y la MISMA sesion sigue viva (SAVEPOINT, sin 25P02)", async () => {
    const session = new AbortAwareFakeSession([
      { match: /from restaurantes\.storefront_marca/, respond: () => pgError("42P01", 'relation "restaurantes.storefront_marca" does not exist') },
      { match: /select 1 as siguiente/, respond: () => [{ ok: true }] },
    ]);
    const repo = new PostgresRestaurantesRepository(session);
    await expect(repo.findStorefrontMarca(ORG)).resolves.toBeNull();
    await expect(session.query("select 1 as siguiente;")).resolves.toEqual({ rows: [{ ok: true }] });
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
  });

  it("la escritura responde 'no disponible' (error tipado, no 500) y la sesion sigue viva", async () => {
    const session = new AbortAwareFakeSession([
      { match: /insert into restaurantes\.storefront_marca/, respond: () => pgError("42703", 'column "portada_url" does not exist') },
      { match: /select 1 as siguiente/, respond: () => [{ ok: true }] },
    ]);
    const repo = new PostgresRestaurantesRepository(session);
    await expect(repo.upsertStorefrontMarca(ORG, { ...MARCA_VACIA, titular: "X" })).rejects.toBeInstanceOf(RestaurantesConfigUnavailableError);
    await expect(session.query("select 1 as siguiente;")).resolves.toEqual({ rows: [{ ok: true }] });
  });

  it("con la migracion aplicada lee y escribe la fila y mapea las columnas", async () => {
    const fila = { titular: "T", eslogan: null, about: null, portada_url: "https://a.example/p.jpg", logo_url: null, instagram_url: null, facebook_url: null, tiktok_url: null, updated_at: "2026-10-03T12:00:00.000Z" };
    const session = new AbortAwareFakeSession([
      { match: /insert into restaurantes\.storefront_marca/, respond: () => [fila] },
      { match: /from restaurantes\.storefront_marca/, respond: () => [fila] },
    ]);
    const repo = new PostgresRestaurantesRepository(session);
    const guardada = await repo.upsertStorefrontMarca(ORG, { ...MARCA_VACIA, titular: "T", portadaUrl: "https://a.example/p.jpg" });
    expect(guardada).toMatchObject({ titular: "T", portadaUrl: "https://a.example/p.jpg", updatedAt: "2026-10-03T12:00:00.000Z" });
    expect(await repo.findStorefrontMarca(ORG)).toEqual(guardada);
  });
});
