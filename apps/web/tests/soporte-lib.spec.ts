// Lógica sin React de la sesión de soporte (apps/web/src/lib/soporte.ts). Relojes fijos; sin process.env.TZ.
import { describe, expect, it, vi } from "vitest";
import {
  PERSISTIR_POR_VERTICAL,
  elevarSoporte,
  entrarComoSoporte,
  formatearRestante,
  leerNombreOrganizacion,
  leerSoporteDelToken,
  limpiarSesionSoporteLocal,
  motivoSoporteValido,
  salirDeSoporte,
} from "../src/lib/soporte.ts";
import type { SessionStorageLike } from "../src/lib/auth-client.ts";
import { respuestaEntrar, tokenSinSoporte, tokenSoporteFalso } from "./test-utils/token-soporte.ts";

const T0 = Date.parse("2030-03-04T10:00:00.000Z");
const MIN = 60_000;

function storage(): SessionStorageLike & { dump(): Record<string, string> } {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k), dump: () => Object.fromEntries(m) };
}
const json = (body: unknown, ok = true, status = 200) => ({ ok, status, json: async () => body }) as unknown as Response;

describe("motivoSoporteValido -- con los argumentos reales del front", () => {
  it("rechaza vacío, null, undefined, solo espacios, saltos de línea, números y corto", () => {
    for (const raw of ["", null, undefined, "   ", "\n\t \n", 123456789012, {}, "123456789", "   123456789   "]) {
      expect(motivoSoporteValido(raw), JSON.stringify(raw)).toBeNull();
    }
  });
  it("acepta 10 caracteres tras recortar y devuelve el texto recortado", () => {
    expect(motivoSoporteValido("  1234567890  ")).toBe("1234567890");
    expect(motivoSoporteValido("Revisar el checkout del cliente")).toBe("Revisar el checkout del cliente");
  });
  it("rechaza más de 500 caracteres", () => {
    expect(motivoSoporteValido("x".repeat(501))).toBeNull();
    expect(motivoSoporteValido("x".repeat(500))).toBe("x".repeat(500));
  });
});

describe("leerSoporteDelToken / formatearRestante", () => {
  it("lee el claim del token de soporte y su vencimiento", () => {
    const t = tokenSoporteFalso({ sid: "abc", orgId: "o9", vertical: "hoteles", expMs: T0 + 60 * MIN, ro: true });
    expect(leerSoporteDelToken(t)).toEqual({ sid: "abc", soloLectura: true, expiresAtMs: T0 + 60 * MIN, organizationId: "o9", vertical: "hoteles" });
    expect(leerSoporteDelToken(tokenSoporteFalso({ expMs: T0, ro: false }))?.soloLectura).toBe(false);
  });
  it("un token normal, vacío o corrupto no es de soporte", () => {
    for (const t of [tokenSinSoporte(), "", null, undefined, "a.b", "a.%%%.c", "a.e30.c"]) expect(leerSoporteDelToken(t)).toBeNull();
  });
  it("caduca en hh:mm con reloj fijo, redondeando hacia arriba y sin negativos", () => {
    expect(formatearRestante(T0 + 60 * MIN, T0)).toBe("01:00");
    expect(formatearRestante(T0 + 42 * MIN, T0)).toBe("00:42");
    expect(formatearRestante(T0 + 42 * MIN + 1, T0)).toBe("00:43");
    expect(formatearRestante(T0 - MIN, T0)).toBe("00:00");
  });
});

describe("entrarComoSoporte", () => {
  const abierta = respuestaEntrar({ slug: "los-taquitos-de-pm", nombre: "Los Taquitos de PM", expMs: T0 + 60 * MIN });
  const me = { email: "javier@atiende.ai", fullName: "Javier", organizations: [{ id: "o1", slug: "los-taquitos-de-pm", nombre: "Los Taquitos de PM", vertical: "restaurantes", rol: "owner" }] };

  it("con motivo inválido NO llama a nada", async () => {
    const entrarFn = vi.fn();
    const fetchImpl = vi.fn();
    for (const motivo of ["", null, "   ", "corto"]) {
      await expect(entrarComoSoporte({ fetchImpl: fetchImpl as never, apiBaseUrl: "https://api.test", storage: storage(), entrarFn }, "o1", motivo)).rejects.toThrow(/obligatorio/);
    }
    expect(entrarFn).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("camino feliz: pide /auth/me con el token de soporte, persiste la sesión de la vertical y guarda el nombre", async () => {
    const st = storage();
    const entrarFn = vi.fn(async () => abierta);
    const fetchImpl = vi.fn(async () => json(me));
    const r = await entrarComoSoporte({ fetchImpl: fetchImpl as never, apiBaseUrl: "https://api.test/", storage: st, entrarFn }, "o1", "  Revisar el panel del cliente ");
    expect(entrarFn).toHaveBeenCalledWith("o1", "Revisar el panel del cliente");
    expect(fetchImpl).toHaveBeenCalledWith("https://api.test/auth/me", { headers: { authorization: `Bearer ${abierta.token}` } });
    expect(r.vertical).toBe("restaurantes");
    expect(r.slug).toBe("los-taquitos-de-pm");
    const guardada = JSON.parse(st.getItem("atiende.restaurantes.session")!);
    expect(guardada.token).toBe(abierta.token);
    expect(guardada.refreshToken).toBe("");
    expect(leerNombreOrganizacion(st, "s1")).toBe("Los Taquitos de PM");
    expect(r.soporte.soloLectura).toBe(true);
  });

  it("si /auth/me falla cierra la sesión recién abierta y NO persiste nada", async () => {
    const st = storage();
    const fetchImpl = vi.fn(async (url: string) => (url.endsWith("/auth/me") ? json({}, false, 500) : json({ ok: true })));
    await expect(entrarComoSoporte({ fetchImpl: fetchImpl as never, apiBaseUrl: "https://api.test", storage: st, entrarFn: async () => abierta }, "o1", "Revisar el panel del cliente")).rejects.toThrow();
    expect(st.dump()).toEqual({});
    expect(fetchImpl).toHaveBeenCalledWith("https://api.test/soporte/salir", expect.objectContaining({ method: "POST" }));
  });

  it("si la API no abre la sesión (bitácora caída) no se toca el almacenamiento", async () => {
    const st = storage();
    await expect(
      entrarComoSoporte({ fetchImpl: vi.fn() as never, apiBaseUrl: "https://api.test", storage: st, entrarFn: async () => Promise.reject(new Error("La bitácora no respondió")) }, "o1", "Revisar el panel del cliente"),
    ).rejects.toThrow("La bitácora no respondió");
    expect(st.dump()).toEqual({});
  });
});

describe("elevar, salir y limpiar", () => {
  it("elevar exige segundo motivo y devuelve el token nuevo; un error de la API llega como mensaje", async () => {
    const fetchImpl = vi.fn(async () => json({ token: "nuevo" }));
    await expect(elevarSoporte(fetchImpl as never, "https://api.test", "t", "   ")).rejects.toThrow(/obligatorio/);
    await expect(elevarSoporte(fetchImpl as never, "https://api.test", "t", null)).rejects.toThrow(/obligatorio/);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await elevarSoporte(fetchImpl as never, "https://api.test", "t", "Corregir un precio capturado mal")).toBe("nuevo");
    expect(JSON.parse(String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body))).toEqual({ reason: "Corregir un precio capturado mal" });
    await expect(elevarSoporte((async () => json({ message: "La sesión ya está elevada" }, false, 409)) as never, "https://api.test", "t", "Segundo intento valido")).rejects.toThrow("La sesión ya está elevada");
  });

  it("salir es best-effort: sin red no lanza", async () => {
    await expect(salirDeSoporte((async () => Promise.reject(new Error("sin red"))) as never, "https://api.test", "t")).resolves.toBeUndefined();
  });

  it("limpiar borra la sesión de la vertical y el nombre, y no toca otras llaves", () => {
    const st = storage();
    PERSISTIR_POR_VERTICAL.hoteles!(st, { token: "t", refreshToken: "", email: "a@b.c", organizations: [] });
    st.setItem("atiende.superadmin.session", "intacta");
    st.setItem("atiende.soporte.sesion", JSON.stringify({ sid: "s1", nombre: "X" }));
    limpiarSesionSoporteLocal(st, "hoteles");
    expect(st.getItem("atiende.hoteles.session")).toBeNull();
    expect(leerNombreOrganizacion(st, "s1")).toBeNull();
    expect(st.getItem("atiende.superadmin.session")).toBe("intacta");
  });
});
