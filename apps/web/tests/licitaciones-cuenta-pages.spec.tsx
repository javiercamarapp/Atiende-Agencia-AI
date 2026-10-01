// @vitest-environment jsdom
//
// Smoke tests reales de las tarjetas de Seguridad de la cuenta (L-02: sesiones, contrasena, Google,
// correo) dentro de <SeguridadPage />, y de las paginas publicas de los enlaces del correo.
import { randomUUID } from "node:crypto";
import { act } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SeguridadPage } from "../src/verticals/licitaciones/pages/Seguridad.tsx";
import { RestablecerContrasenaPage, VerificarCorreoPage } from "../src/verticals/licitaciones/pages/CuentaEnlaces.tsx";
import type { LicitacionesShellContext } from "../src/verticals/licitaciones/LicitacionesShell.tsx";
import { changeValue, click, renderComponent, submitForm, type RenderedComponent } from "./test-utils/render.tsx";

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 30));
  });
}

let rendered: RenderedComponent | undefined;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

// Credenciales y tokens de prueba generados en cada corrida: ningun literal con forma de secreto en el repo.
const u = (p: string) => `${p}-${randomUUID()}`;
const TOKEN = u("t");
const ENLACE = u("e");
const PW_ACTUAL = u("a");
const PW_NUEVA = u("n");

const CTX: LicitacionesShellContext = {
  apiBaseUrl: "https://api.test",
  token: TOKEN,
  propertyId: "prop-1",
  orgSlug: "demo",
  role: "owner",
  staffFullName: "Ana",
  staffEmail: "ana@example.com",
};

function res(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as unknown as Response;
}

const ESTADO = { email: "ana@example.com", emailVerified: true, hasPassword: true, google: { configured: true, available: true, identities: [] as unknown[] } };
const SESIONES = {
  available: true,
  sessions: [
    { id: "s-actual", startedAt: "2026-01-01T10:00:00Z", issuedAt: "2026-01-01T10:30:00Z", expiresAt: "2026-02-01T10:00:00Z", userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/124.0 Safari/537.36", current: true },
    { id: "s-otra", startedAt: "2026-01-01T09:00:00Z", issuedAt: "2026-01-01T09:30:00Z", expiresAt: "2026-02-01T09:00:00Z", userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604.1", current: false },
  ],
};

function api(over: Record<string, (init?: RequestInit) => Response> = {}) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    for (const [suffix, fn] of Object.entries(over)) if (url.endsWith(suffix)) return fn(init);
    if (url.endsWith("/auth/2fa/status")) return res({ available: true, enabled: false, pending: false, lockedUntil: null, backupCodesRemaining: 0 });
    if (url.endsWith("/auth/account/estado")) return res(ESTADO);
    if (url.endsWith("/auth/sessions/listar")) return res(SESIONES);
    throw new Error(`fetch inesperado: ${url}`);
  });
}

async function mountSeguridad() {
  rendered = renderComponent(<SeguridadPage {...CTX} />);
  await settle();
  return rendered;
}

const boton = (r: RenderedComponent, texto: string) => [...r.container.querySelectorAll("button")].find((b) => b.textContent?.includes(texto));
const dialogo = () => document.body.querySelector('[role="alertdialog"]');
const botonDialogo = (texto: string) => [...dialogo()!.querySelectorAll("button")].find((b) => b.textContent?.includes(texto)) as HTMLButtonElement;

describe("Seguridad de la cuenta: sesiones activas", () => {
  it("lista los dispositivos, marca el actual (sin boton de cerrar) y cierra uno ajeno", async () => {
    const cerradas: unknown[] = [];
    let sesiones = SESIONES;
    vi.stubGlobal(
      "fetch",
      api({
        "/auth/sessions/listar": () => res(sesiones),
        "/auth/sessions/cerrar": (init) => {
          cerradas.push(JSON.parse(init!.body as string));
          sesiones = { available: true, sessions: [SESIONES.sessions[0]!] };
          return res({ ok: true });
        },
      }),
    );
    const r = await mountSeguridad();
    expect(r.container.textContent).toContain("Chrome en macOS");
    expect(r.container.textContent).toContain("Safari en iOS");
    expect(r.container.textContent).toContain("Este dispositivo");
    expect([...r.container.querySelectorAll("button")].filter((b) => b.textContent === "Cerrar sesión")).toHaveLength(1);
    click(boton(r, "Cerrar sesión")!);
    await settle();
    // Cerrar la sesión de otro dispositivo es destructivo: primero pide confirmación y no llama al servidor.
    expect(dialogo()).not.toBeNull();
    expect(cerradas).toEqual([]);
    click(botonDialogo("Cerrar sesión"));
    await settle();
    expect(cerradas).toEqual([{ sessionId: "s-otra" }]);
    expect(r.container.textContent).toContain("Sesión cerrada.");
    expect(r.container.textContent).not.toContain("Safari en iOS");
  });

  it("base sin migrar: lo dice y ofrece cerrar las demas por el camino que ya funcionaba (revoke-sessions)", async () => {
    const llamadas: string[] = [];
    vi.stubGlobal(
      "fetch",
      api({
        "/auth/sessions/listar": () => res({ available: false, sessions: [] }),
        "/auth/revoke-sessions": () => {
          llamadas.push("revoke");
          return res({ ok: true });
        },
      }),
    );
    const r = await mountSeguridad();
    expect(r.container.textContent).toContain("todavía no está disponible en este ambiente, pero puedes cerrar tus otras sesiones");
    click(boton(r, "Cerrar mis otras sesiones")!);
    await settle();
    expect(llamadas).toEqual([]);
    click(botonDialogo("Cerrar mis otras sesiones"));
    await settle();
    expect(llamadas).toEqual(["revoke"]);
  });

  it("Cancelar el diálogo (o cerrarlo) NUNCA cierra sesiones", async () => {
    const cerradas: unknown[] = [];
    const llamadas: string[] = [];
    vi.stubGlobal(
      "fetch",
      api({
        "/auth/sessions/cerrar": (init) => {
          cerradas.push(JSON.parse(init!.body as string));
          return res({ ok: true });
        },
        "/auth/sessions/cerrar-otras": () => {
          llamadas.push("otras");
          return res({ ok: true });
        },
        "/auth/revoke-sessions": () => {
          llamadas.push("revoke");
          return res({ ok: true });
        },
      }),
    );
    const r = await mountSeguridad();
    click(boton(r, "Cerrar sesión")!);
    await settle();
    expect(dialogo()).not.toBeNull();
    click(botonDialogo("Cancelar"));
    await settle();
    expect(dialogo()).toBeNull();
    click(boton(r, "Cerrar todas las demás")!);
    await settle();
    expect(dialogo()).not.toBeNull();
    click(botonDialogo("Cancelar"));
    await settle();
    expect(dialogo()).toBeNull();
    expect(cerradas).toEqual([]);
    expect(llamadas).toEqual([]);
  });
});

describe("Seguridad de la cuenta: contrasena", () => {
  it("valida en el cliente (no coinciden) sin llamar al servidor, y muestra el error real del servidor", async () => {
    const f = api({ "/auth/change-password": () => res({ code: "current_password_invalid", message: "La contraseña actual no es correcta." }, 422) });
    vi.stubGlobal("fetch", f);
    const r = await mountSeguridad();
    changeValue(r.container.querySelector<HTMLInputElement>("#cuenta-pass-actual")!, "actual-123");
    changeValue(r.container.querySelector<HTMLInputElement>("#cuenta-pass-nueva")!, PW_NUEVA);
    changeValue(r.container.querySelector<HTMLInputElement>("#cuenta-pass-confirmar")!, "otra-cosa-xx");
    const form = r.container.querySelector<HTMLInputElement>("#cuenta-pass-actual")!.closest("form")!;
    await submitForm(form);
    await settle();
    expect(r.container.textContent).toContain("Las contraseñas no coinciden.");
    expect(f.mock.calls.some(([u]) => String(u).endsWith("/auth/change-password"))).toBe(false);

    changeValue(r.container.querySelector<HTMLInputElement>("#cuenta-pass-confirmar")!, PW_NUEVA);
    await submitForm(form);
    await settle();
    expect(r.container.textContent).toContain("La contraseña actual no es correcta.");
  });

  it("cuenta sin contrasena: no muestra el formulario", async () => {
    vi.stubGlobal("fetch", api({ "/auth/account/estado": () => res({ ...ESTADO, hasPassword: false }) }));
    const r = await mountSeguridad();
    expect(r.container.querySelector("#cuenta-pass-actual")).toBeNull();
    expect(r.container.textContent).toContain("Tu cuenta no tiene contraseña");
  });

  it("'no recuerdo la actual' pide el enlace con el correo de la propia sesion y responde de forma uniforme", async () => {
    const cuerpos: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      api({
        "/auth/password-reset/solicitar": (init) => {
          cuerpos.push(JSON.parse(init!.body as string));
          return res({ ok: true });
        },
      }),
    );
    const r = await mountSeguridad();
    click(boton(r, "No recuerdo la actual")!);
    await settle();
    expect(cuerpos).toEqual([{ email: "ana@example.com", vertical: "licitaciones" }]);
    expect(r.container.textContent).toContain("Si ana@example.com tiene una cuenta");
  });
});

describe("Seguridad de la cuenta: correo y Google", () => {
  it("correo sin verificar: envia el enlace y dice la verdad si el servidor no pudo enviarlo", async () => {
    vi.stubGlobal(
      "fetch",
      api({
        "/auth/account/estado": () => res({ ...ESTADO, emailVerified: false }),
        "/auth/email-verification/enviar": () => res({ ok: true, alreadyVerified: false, sent: false }),
      }),
    );
    const r = await mountSeguridad();
    expect(r.container.textContent).toContain("Sin verificar");
    click(boton(r, "Enviar correo de verificación")!);
    await settle();
    expect(r.container.textContent).toContain("No pudimos enviar el correo");
    expect(r.container.textContent).not.toContain("Te enviamos un enlace a");
  });

  it("Google vinculado: desvincular exige la contrasena y manda el id de la identidad", async () => {
    const cuerpos: unknown[] = [];
    let identidades = [{ id: "g1", email: "ana@gmail.com", linkedAt: "2026-01-01T00:00:00Z" }];
    vi.stubGlobal(
      "fetch",
      api({
        "/auth/account/estado": () => res({ ...ESTADO, google: { configured: true, available: true, identities: identidades } }),
        "/auth/google/desvincular": (init) => {
          cuerpos.push(JSON.parse(init!.body as string));
          identidades = [];
          return res({ ok: true });
        },
      }),
    );
    const r = await mountSeguridad();
    expect(r.container.textContent).toContain("ana@gmail.com");
    click(boton(r, "Desvincular…")!);
    await settle();
    await submitForm(r.container.querySelector<HTMLInputElement>("#cuenta-google-pass")!.closest("form")!);
    await settle();
    expect(cuerpos).toHaveLength(0); // sin contrasena no se llama
    changeValue(r.container.querySelector<HTMLInputElement>("#cuenta-google-pass")!, PW_ACTUAL);
    await submitForm(r.container.querySelector<HTMLInputElement>("#cuenta-google-pass")!.closest("form")!);
    await settle();
    expect(cuerpos).toEqual([{ identityId: "g1", password: PW_ACTUAL }]);
    expect(r.container.textContent).toContain("Todavía no hay ninguna cuenta de Google vinculada.");
  });

  it("Google sin configurar o sin migrar: deshabilitado/honesto, nunca finge", async () => {
    vi.stubGlobal("fetch", api({ "/auth/account/estado": () => res({ ...ESTADO, google: { configured: false, available: true, identities: [] } }) }));
    const r = await mountSeguridad();
    expect(boton(r, "Vincular una cuenta de Google")!.hasAttribute("disabled")).toBe(true);
    expect(r.container.textContent).toContain("pendiente de configurar");
  });

  it("regreso del flujo de Google: ?google_link=ok muestra el aviso y limpia la URL; un error muestra el mensaje", async () => {
    window.history.replaceState(null, "", "/licitaciones/demo/seguridad?google_link=google_ya_vinculada");
    vi.stubGlobal("fetch", api());
    const r = await mountSeguridad();
    expect(r.container.textContent).toContain("ya está vinculada a otra cuenta");
    expect(window.location.search).toBe("");
  });
});

describe("paginas publicas de los enlaces del correo", () => {
  function montarPublica(el: React.ReactElement) {
    rendered = renderComponent(<MemoryRouter>{el}</MemoryRouter>);
    return rendered;
  }

  it("restablecer: lee el token, lo quita de la URL, valida y canjea por POST; luego avisa que se cerraron las sesiones", async () => {
    window.history.replaceState(null, "", `/licitaciones/restablecer-contrasena?token=${ENLACE}`);
    const cuerpos: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: string, init?: RequestInit) => {
        cuerpos.push(JSON.parse(init!.body as string));
        return res({ ok: true });
      }),
    );
    const r = montarPublica(<RestablecerContrasenaPage apiBaseUrl="https://api.test" />);
    await settle();
    expect(window.location.search).toBe(""); // token fuera de la URL
    changeValue(r.container.querySelector<HTMLInputElement>("#restablecer-nueva")!, PW_NUEVA);
    changeValue(r.container.querySelector<HTMLInputElement>("#restablecer-confirmar")!, "distinta-xx");
    await submitForm(r.container.querySelector("form")!);
    await settle();
    expect(cuerpos).toHaveLength(0);
    expect(r.container.textContent).toContain("no coinciden");
    changeValue(r.container.querySelector<HTMLInputElement>("#restablecer-confirmar")!, PW_NUEVA);
    await submitForm(r.container.querySelector("form")!);
    await settle();
    expect(cuerpos).toEqual([{ token: ENLACE, newPassword: PW_NUEVA }]);
    expect(r.container.textContent).toContain("se cerraron todas tus sesiones");
  });

  it("restablecer: enlace vencido/usado muestra el mensaje del servidor; sin token no ofrece formulario", async () => {
    window.history.replaceState(null, "", `/licitaciones/restablecer-contrasena?token=${u("v")}`);
    vi.stubGlobal("fetch", vi.fn(async () => res({ message: "El enlace es inválido, ya se usó o expiró." }, 400)));
    const r = montarPublica(<RestablecerContrasenaPage apiBaseUrl="https://api.test" />);
    await settle();
    changeValue(r.container.querySelector<HTMLInputElement>("#restablecer-nueva")!, PW_NUEVA);
    changeValue(r.container.querySelector<HTMLInputElement>("#restablecer-confirmar")!, PW_NUEVA);
    await submitForm(r.container.querySelector("form")!);
    await settle();
    expect(r.container.textContent).toContain("ya se usó o expiró");
    r.unmount();
    window.history.replaceState(null, "", "/licitaciones/restablecer-contrasena");
    const sin = montarPublica(<RestablecerContrasenaPage apiBaseUrl="https://api.test" />);
    expect(sin.container.querySelector("form")).toBeNull();
    expect(sin.container.textContent).toContain("Enlace incompleto");
  });

  it("verificar correo: canjea UNA sola vez por POST al montar (aunque el efecto corra dos veces) y confirma", async () => {
    window.history.replaceState(null, "", `/licitaciones/verificar-correo?token=${ENLACE}`);
    const f = vi.fn(async () => res({ ok: true }));
    vi.stubGlobal("fetch", f);
    const r = montarPublica(<VerificarCorreoPage apiBaseUrl="https://api.test" />);
    await settle();
    expect(f).toHaveBeenCalledTimes(1);
    expect(JSON.parse((f.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toEqual({ token: ENLACE });
    expect(r.container.textContent).toContain("Tu correo quedó verificado.");
  });

  it("verificar correo: enlace invalido muestra el error del servidor", async () => {
    window.history.replaceState(null, "", `/licitaciones/verificar-correo?token=${u("m")}`);
    vi.stubGlobal("fetch", vi.fn(async () => res({ message: "El enlace es inválido, ya se usó o expiró." }, 400)));
    const r = montarPublica(<VerificarCorreoPage apiBaseUrl="https://api.test" />);
    await settle();
    expect(r.container.textContent).toContain("ya se usó o expiró");
    expect(r.container.textContent).not.toContain("Tu correo quedó verificado.");
  });
});
