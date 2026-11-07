// ds3 «Guía»: puente web con GET/PUT /v1/onboarding/progreso. Nunca lanza: sin red, sin migracion o con 4xx la guia sigue con el navegador.
import { describe, expect, it, vi } from "vitest";
import { baseDeConsola, pistaGuia, servidorProgresoGuia } from "../src/lib/guia-progreso.ts";

describe("pistaGuia y baseDeConsola", () => {
  it("normaliza el rol de la sesion a la pista que acepta el servidor", () => {
    expect(pistaGuia("restaurantes", "owner")).toBe("restaurantes.owner");
    expect(pistaGuia("restaurantes", "Repartidor")).toBe("restaurantes.repartidor");
    expect(pistaGuia("citas", "recepción")).toBe("citas.recepcion");
    expect(pistaGuia("hoteles", "front-desk")).toBe("hoteles.front_desk");
    expect(pistaGuia("rentas", undefined)).toBe("rentas");
  });
  it("saca la raiz de la consola y el slug de cualquier ruta de la vertical", () => {
    expect(baseDeConsola("/restaurantes/taqueria-el-faro/notificaciones")).toEqual({ base: "/restaurantes/taqueria-el-faro", orgSlug: "taqueria-el-faro" });
    expect(baseDeConsola("/superadmin")).toBeNull();
  });
});

describe("servidorProgresoGuia", () => {
  const json = (cuerpo: unknown, status = 200) => new Response(JSON.stringify(cuerpo), { status, headers: { "content-type": "application/json" } });

  it("lee con el token, la pista y la organizacion, y normaliza", async () => {
    const f = vi.fn(async () => json({ disponible: true, progreso: { modo: "corto", paso: "pedidos.que", visto: true, activo: true, terminado: false, omitido: false, descartado: false, actualizado: "2026-11-06T10:00:00.000Z" } }));
    const s = servidorProgresoGuia(f as unknown as typeof fetch, "https://api", "tok", "restaurantes.owner", "taqueria");
    expect(await s.leer()).toMatchObject({ paso: "pedidos.que", modo: "corto", actualizado: Date.parse("2026-11-06T10:00:00.000Z") });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api/v1/onboarding/progreso?pista=restaurantes.owner&org=taqueria");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer tok");
  });

  it("base sin migrar, 4xx o sin red: null (nunca lanza)", async () => {
    const sin = servidorProgresoGuia((async () => json({ disponible: false, progreso: null })) as unknown as typeof fetch, "a", "t", "citas.owner", "c");
    expect(await sin.leer()).toBeNull();
    const prohibido = servidorProgresoGuia((async () => json({ error: "forbidden" }, 403)) as unknown as typeof fetch, "a", "t", "citas.owner", "c");
    expect(await prohibido.leer()).toBeNull();
    const caido = servidorProgresoGuia((async () => { throw new TypeError("offline"); }) as unknown as typeof fetch, "a", "t", "citas.owner", "c");
    expect(await caido.leer()).toBeNull();
    await expect(caido.guardar({ visto: true, omitido: false, descartado: false, paso: null, activo: false, modo: null, terminado: false, actualizado: 1 })).resolves.toBeUndefined();
  });

  it("guarda solo lo no derivable, con PUT y el slug", async () => {
    const f = vi.fn(async () => json({ disponible: true, actualizado: "x" }));
    const s = servidorProgresoGuia(f as unknown as typeof fetch, "https://api", "tok", "restaurantes.owner", "taqueria");
    await s.guardar({ visto: true, omitido: false, descartado: false, paso: "pedidos.que", activo: true, modo: "corto", terminado: false, actualizado: 1 });
    const [, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe("PUT");
    expect(JSON.parse(String(init.body))).toEqual({ pista: "restaurantes.owner", org: "taqueria", modo: "corto", paso: "pedidos.que", visto: true, omitido: false, descartado: false, activo: true, terminado: false });
  });
});
