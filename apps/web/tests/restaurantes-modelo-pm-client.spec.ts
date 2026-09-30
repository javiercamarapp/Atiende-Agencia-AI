// Cliente real de admin-modelo-pm.ts (modelo PM, migración 023) + helpers de formulario.
// Mismo patrón que restaurantes-config-client.spec.ts.
import { describe, expect, it, vi } from "vitest";
import {
  deleteWhatsappSucursal,
  describirTurno,
  fetchNoDomicilio,
  fetchPoliticaSucursal,
  fetchWhatsappSucursal,
  fetchZonasReparto,
  parseMontoOpcional,
  setNoDomicilio,
  updatePoliticaSucursal,
  updateWhatsappSucursal,
  updateZonasReparto,
} from "../src/verticals/restaurantes/lib/modelo-pm-client.ts";

const BASE = "http://api.local/v1/restaurantes/prop-1/admin/config";
const POLITICA = {
  horario: [{ dias: [1, 2, 3], abre: "12:00", cierra: "01:00" }],
  pedidoMinimoDomicilio: 200,
  pedidoMinimoRecoger: null,
  propinaPolitica: "solo_tarjeta" as const,
};

describe("politica por sucursal", () => {
  it("GET lee la politica de ESA sucursal", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe(`${BASE}/sucursales/suc-2/politica`);
      return new Response(JSON.stringify(POLITICA), { status: 200 });
    }) as unknown as typeof fetch;
    await expect(fetchPoliticaSucursal(fetchImpl, "http://api.local", "tok", "prop-1", "suc-2")).resolves.toEqual(POLITICA);
  });

  it("PUT manda la politica COMPLETA (reemplazo) tal cual", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe(`${BASE}/sucursales/suc-2/politica`);
      expect(init?.method).toBe("PUT");
      expect(JSON.parse(init!.body as string)).toEqual(POLITICA);
      return new Response(JSON.stringify(POLITICA), { status: 200 });
    }) as unknown as typeof fetch;
    await expect(updatePoliticaSucursal(fetchImpl, "http://api.local", "tok", "prop-1", "suc-2", POLITICA)).resolves.toEqual(POLITICA);
  });

  it("503 de la base sin migrar -> error real con el mensaje del servidor, nunca un exito falso", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "Esta configuración todavía no se puede editar en esta base de datos." }), { status: 503 })) as unknown as typeof fetch;
    await expect(updatePoliticaSucursal(fetchImpl, "http://api.local", "tok", "prop-1", "suc-2", POLITICA)).rejects.toThrow();
  });
});

describe("zonas de reparto / whatsapp por sucursal / no_domicilio", () => {
  it("zonas de reparto: GET y PUT con { zoneIds }", async () => {
    const get = vi.fn(async (url: string) => {
      expect(url).toBe(`${BASE}/sucursales/suc-2/zonas-reparto`);
      return new Response(JSON.stringify({ zoneIds: ["z1"] }), { status: 200 });
    }) as unknown as typeof fetch;
    await expect(fetchZonasReparto(get, "http://api.local", "tok", "prop-1", "suc-2")).resolves.toEqual(["z1"]);

    const put = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.method).toBe("PUT");
      expect(JSON.parse(init!.body as string)).toEqual({ zoneIds: ["z1", "z2"] });
      return new Response(JSON.stringify({ zoneIds: ["z1", "z2"] }), { status: 200 });
    }) as unknown as typeof fetch;
    await expect(updateZonasReparto(put, "http://api.local", "tok", "prop-1", "suc-2", ["z1", "z2"])).resolves.toEqual(["z1", "z2"]);
  });

  it("whatsapp por sucursal: GET, PUT y DELETE", async () => {
    const get = vi.fn(async () => new Response(JSON.stringify({ phoneNumberId: null }), { status: 200 })) as unknown as typeof fetch;
    await expect(fetchWhatsappSucursal(get, "http://api.local", "tok", "prop-1", "suc-2")).resolves.toBeNull();

    const put = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe(`${BASE}/sucursales/suc-2/whatsapp`);
      expect(JSON.parse(init!.body as string)).toEqual({ phoneNumberId: "15550001111" });
      return new Response(JSON.stringify({ phoneNumberId: "15550001111" }), { status: 200 });
    }) as unknown as typeof fetch;
    await expect(updateWhatsappSucursal(put, "http://api.local", "tok", "prop-1", "suc-2", "15550001111")).resolves.toBe("15550001111");

    const del = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe(`${BASE}/sucursales/suc-2/whatsapp`);
      expect(init?.method).toBe("DELETE");
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;
    await expect(deleteWhatsappSucursal(del, "http://api.local", "tok", "prop-1", "suc-2")).resolves.toBeUndefined();
  });

  it("numero ya en uso (409) -> error real", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "Ese número de WhatsApp ya está conectado a otra sucursal u organización." }), { status: 409 })) as unknown as typeof fetch;
    await expect(updateWhatsappSucursal(fetchImpl, "http://api.local", "tok", "prop-1", "suc-2", "15550001111")).rejects.toThrow();
  });

  it("no_domicilio: GET de marcas y PUT por producto/categoria", async () => {
    const get = vi.fn(async (url: string) => {
      expect(url).toBe(`${BASE}/no-domicilio`);
      return new Response(JSON.stringify({ productIds: ["p1"], categoryIds: ["c1"] }), { status: 200 });
    }) as unknown as typeof fetch;
    await expect(fetchNoDomicilio(get, "http://api.local", "tok", "prop-1")).resolves.toEqual({ productIds: ["p1"], categoryIds: ["c1"] });

    const put = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe(`${BASE}/no-domicilio/categorias/c1`);
      expect(JSON.parse(init!.body as string)).toEqual({ noDomicilio: true });
      return new Response(JSON.stringify({ id: "c1", noDomicilio: true }), { status: 200 });
    }) as unknown as typeof fetch;
    await expect(setNoDomicilio(put, "http://api.local", "tok", "prop-1", "categorias", "c1", true)).resolves.toBeUndefined();
  });
});

describe("helpers de formulario", () => {
  it("parseMontoOpcional: vacio = sin minimo, numero >= 0 = monto, basura = undefined", () => {
    expect(parseMontoOpcional("")).toBeNull();
    expect(parseMontoOpcional("  ")).toBeNull();
    expect(parseMontoOpcional("200")).toBe(200);
    expect(parseMontoOpcional("0")).toBe(0);
    expect(parseMontoOpcional("-5")).toBeUndefined();
    expect(parseMontoOpcional("doscientos")).toBeUndefined();
  });

  it("describirTurno: todos los dias, dias sueltos y cierre pasada la medianoche", () => {
    expect(describirTurno({ dias: [0, 1, 2, 3, 4, 5, 6], abre: "12:00", cierra: "01:00" })).toBe("Todos los días 12:00 a 01:00 (cierra al día siguiente)");
    expect(describirTurno({ dias: [1, 5], abre: "12:00", cierra: "16:00" })).toBe("Lun, Vie 12:00 a 16:00");
  });
});
