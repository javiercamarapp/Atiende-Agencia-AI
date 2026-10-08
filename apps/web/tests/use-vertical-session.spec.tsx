// @vitest-environment jsdom
//
// PR-4 del plan de diseno-ux: `useVerticalSession` unifica la sesion que cada
// *Shell.tsx repetia (lectura persistida, SESSION_EXPIRED_EVENT por vertical,
// sucursales, sucursal activa persistida, organizacion/rol, logout limpio).
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useVerticalSession, type VerticalSession, type VerticalSessionAdapter, type VerticalBranch } from "../src/lib/useVerticalSession.ts";
import { SESSION_EXPIRED_EVENT, SESSION_REFRESHED_EVENT } from "../src/lib/authed-fetch.ts";
import type { LoginSession } from "../src/lib/auth-client.ts";
import { flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";
import { installMemoryLocalStorage } from "./test-utils/memory-storage.ts";

const SESSION: LoginSession = {
  token: "tok",
  refreshToken: "ref",
  email: "staff@example.com",
  fullName: "Staff",
  organizations: [
    { id: "org-1", slug: "demo", nombre: "Demo", vertical: "citas", rol: "admin" },
    { id: "org-2", slug: "otra", nombre: "Otra", vertical: "citas", rol: "owner" },
  ],
};
const SESSION_KEY = "test.session";
const BRANCHES: VerticalBranch[] = [
  { propertyId: "p1", name: "Centro" },
  { propertyId: "p2", name: "Norte" },
];

let storage: Storage;
let fetchBranches: ReturnType<typeof vi.fn>;
let logout: ReturnType<typeof vi.fn>;
let adapter: VerticalSessionAdapter;
let onRequireLogin: ReturnType<typeof vi.fn>;
let ultimo: VerticalSession | undefined;
let rendered: RenderedComponent | undefined;

function Sonda({ orgSlug = "demo" }: { orgSlug?: string }) {
  ultimo = useVerticalSession({ adapter, apiBaseUrl: "https://api.test", orgSlug, onRequireLogin });
  return null;
}

async function montar(orgSlug?: string) {
  rendered = renderComponent(<Sonda orgSlug={orgSlug} />);
  await act(async () => {
    await flushMicrotasks();
  });
}

beforeEach(() => {
  storage = installMemoryLocalStorage();
  fetchBranches = vi.fn().mockResolvedValue(BRANCHES);
  logout = vi.fn().mockResolvedValue(undefined);
  onRequireLogin = vi.fn();
  adapter = {
    vertical: "citas",
    readSession: (s) => {
      const raw = s.getItem(SESSION_KEY);
      return raw ? (JSON.parse(raw) as LoginSession) : null;
    },
    clearSession: (s) => s.removeItem(SESSION_KEY),
    logout: (...a) => logout(...a),
    fetchBranches: (...a) => fetchBranches(...a),
    readPropertyId: (s, org) => s.getItem(`prop:${org}`),
    persistPropertyId: (s, org, id) => s.setItem(`prop:${org}`, id),
    resolveActivePropertyId: (bs, sel) => (bs.length === 0 ? null : bs.some((b) => b.propertyId === sel) ? sel : bs[0]!.propertyId),
  };
  ultimo = undefined;
});
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
});

describe("useVerticalSession", () => {
  it("sin sesion persistida: fase sin-sesion y dispara onRequireLogin sin pedir sucursales", async () => {
    await montar();
    expect(ultimo!.fase).toBe("sin-sesion");
    expect(onRequireLogin).toHaveBeenCalled();
    expect(fetchBranches).not.toHaveBeenCalled();
  });

  it("con sesion: carga sucursales y deriva organizacion, rol y sucursal activa de la organizacion pedida", async () => {
    storage.setItem(SESSION_KEY, JSON.stringify(SESSION));
    await montar("demo");
    const s = ultimo!;
    expect(s.fase).toBe("listo");
    if (s.fase !== "listo") return;
    expect(fetchBranches).toHaveBeenCalledWith(fetch, "https://api.test", "tok", "demo");
    expect(s.orgId).toBe("org-1");
    expect(s.role).toBe("admin");
    expect(s.propertyId).toBe("p1");
    expect(s.activeBranch.name).toBe("Centro");
    expect(s.hasRole(["owner", "admin"])).toBe(true);
    expect(s.hasRole(["owner"])).toBe(false);
  });

  it("una organizacion que no esta en la sesion cae a rol 'staff' y orgId vacio", async () => {
    storage.setItem(SESSION_KEY, JSON.stringify(SESSION));
    await montar("desconocida");
    const s = ultimo!;
    if (s.fase !== "listo") throw new Error("fase " + s.fase);
    expect(s.role).toBe("staff");
    expect(s.orgId).toBe("");
  });

  it("fase cargando mientras las sucursales no llegan, y vacio si no hay ninguna", async () => {
    storage.setItem(SESSION_KEY, JSON.stringify(SESSION));
    fetchBranches.mockReturnValue(new Promise(() => {}));
    await montar();
    expect(ultimo!.fase).toBe("cargando");
    rendered!.unmount();
    fetchBranches.mockResolvedValue([]);
    await montar();
    expect(ultimo!.fase).toBe("vacio");
  });

  it("error al cargar sucursales: fase error con el mensaje, y reintentar vuelve a pedirlas", async () => {
    storage.setItem(SESSION_KEY, JSON.stringify(SESSION));
    fetchBranches.mockRejectedValueOnce(new Error("sin conexion"));
    await montar();
    expect(ultimo!.fase).toBe("error");
    expect(ultimo!.error).toBe("sin conexion");
    await act(async () => {
      ultimo!.reintentar();
      await flushMicrotasks();
    });
    expect(fetchBranches).toHaveBeenCalledTimes(2);
    expect(ultimo!.fase).toBe("listo");
  });

  it("selectBranch cambia la sucursal activa y la persiste por organizacion; una persistida previa se respeta", async () => {
    storage.setItem(SESSION_KEY, JSON.stringify(SESSION));
    storage.setItem("prop:demo", "p2");
    await montar();
    let s = ultimo!;
    if (s.fase !== "listo") throw new Error("fase " + s.fase);
    expect(s.propertyId).toBe("p2");
    const seleccionar = s.selectBranch;
    act(() => seleccionar("p1"));
    s = ultimo!;
    if (s.fase !== "listo") throw new Error("fase " + s.fase);
    expect(s.propertyId).toBe("p1");
    expect(storage.getItem("prop:demo")).toBe("p1");
    expect(storage.getItem("prop:otra")).toBeNull();
  });

  it("SESSION_EXPIRED_EVENT de ESTA vertical limpia la sesion y pide login; el de otra vertical se ignora", async () => {
    storage.setItem(SESSION_KEY, JSON.stringify(SESSION));
    await montar();
    onRequireLogin.mockClear();
    act(() => {
      window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT, { detail: { vertical: "hoteles" } }));
    });
    expect(onRequireLogin).not.toHaveBeenCalled();
    expect(storage.getItem(SESSION_KEY)).not.toBeNull();
    act(() => {
      window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT, { detail: { vertical: "citas" } }));
    });
    expect(onRequireLogin).toHaveBeenCalledTimes(1);
    expect(storage.getItem(SESSION_KEY)).toBeNull();
    expect(ultimo!.fase).toBe("sin-sesion");
  });

  it("QA-citas-R1-caos-09: tras un refresh la sesion del hook usa el access token NUEVO (las pantallas no siguen mandando el vencido); el evento de otra vertical se ignora", async () => {
    storage.setItem(SESSION_KEY, JSON.stringify(SESSION));
    await montar();
    expect(ultimo!.session!.token).toBe("tok");
    storage.setItem(SESSION_KEY, JSON.stringify({ ...SESSION, token: "tok-2", refreshToken: "ref-2" }));
    act(() => {
      window.dispatchEvent(new CustomEvent(SESSION_REFRESHED_EVENT, { detail: { vertical: "hoteles" } }));
    });
    expect(ultimo!.session!.token).toBe("tok");
    act(() => {
      window.dispatchEvent(new CustomEvent(SESSION_REFRESHED_EVENT, { detail: { vertical: "citas" } }));
    });
    expect(ultimo!.session!.token).toBe("tok-2");
    expect(ultimo!.fase).toBe("listo");
  });

  it("QA-citas-R1-caos-10: 'Cerrar sesion' tras un refresh revoca el refresh token VIGENTE, no el viejo ya rotado", async () => {
    storage.setItem(SESSION_KEY, JSON.stringify(SESSION));
    await montar();
    // Un refresh persistio la sesion nueva pero el evento todavia no llego al estado (o el estado quedo viejo): el logout lee lo persistido.
    storage.setItem(SESSION_KEY, JSON.stringify({ ...SESSION, token: "tok-2", refreshToken: "ref-2" }));
    await act(async () => {
      await ultimo!.logout();
    });
    expect(logout).toHaveBeenCalledWith(fetch, "https://api.test", "ref-2");
  });

  it("logout llama al endpoint con el refreshToken, limpia la sesion y redirige", async () => {
    storage.setItem(SESSION_KEY, JSON.stringify(SESSION));
    await montar();
    onRequireLogin.mockClear();
    await act(async () => {
      await ultimo!.logout();
    });
    expect(logout).toHaveBeenCalledWith(fetch, "https://api.test", "ref");
    expect(storage.getItem(SESSION_KEY)).toBeNull();
    expect(onRequireLogin).toHaveBeenCalledTimes(1);
    expect(ultimo!.fase).toBe("sin-sesion");
  });

  it("logout limpio aunque el endpoint falle: la sesion local se limpia igual y no hay promesa rechazada", async () => {
    storage.setItem(SESSION_KEY, JSON.stringify(SESSION));
    logout.mockRejectedValue(new Error("red caida"));
    await montar();
    onRequireLogin.mockClear();
    await act(async () => {
      await expect(ultimo!.logout()).resolves.toBeUndefined();
    });
    expect(logout).toHaveBeenCalledTimes(1);
    expect(storage.getItem(SESSION_KEY)).toBeNull();
    expect(onRequireLogin).toHaveBeenCalledTimes(1);
  });

  it("un doble clic en cerrar sesion no llama dos veces al endpoint", async () => {
    storage.setItem(SESSION_KEY, JSON.stringify(SESSION));
    let liberar!: () => void;
    logout.mockReturnValue(new Promise<void>((r) => (liberar = r)));
    await montar();
    const l = ultimo!.logout;
    await act(async () => {
      void l();
      void l();
      await flushMicrotasks();
    });
    expect(logout).toHaveBeenCalledTimes(1);
    expect(ultimo!.loggingOut).toBe(true);
    await act(async () => {
      liberar();
      await flushMicrotasks();
    });
  });

  it("si el componente se desmonta con las sucursales en vuelo no actualiza estado", async () => {
    storage.setItem(SESSION_KEY, JSON.stringify(SESSION));
    let resolver!: (b: VerticalBranch[]) => void;
    fetchBranches.mockReturnValue(new Promise<VerticalBranch[]>((r) => (resolver = r)));
    const consola = vi.spyOn(console, "error").mockImplementation(() => {});
    await montar();
    rendered!.unmount();
    rendered = undefined;
    await act(async () => {
      resolver(BRANCHES);
      await flushMicrotasks();
    });
    expect(consola).not.toHaveBeenCalled();
    consola.mockRestore();
  });
});
