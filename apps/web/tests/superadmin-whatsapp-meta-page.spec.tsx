// @vitest-environment jsdom
// Credenciales de Meta por organizacion (migracion 0090): la pantalla muestra solo metadatos, manda los secretos una sola vez (solo
// escritura), los limpia al cerrar, asigna numeros por sucursal y es honesta sin llave o con la base sin migrar.
import { act } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SuperAdminWhatsappMetaPage } from "../src/superadmin/pages/WhatsappMeta.tsx";
import { changeValue, click, flushMicrotasks, renderComponent, submitForm, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
const ORG = "00000000-0000-4000-8000-0000000000b1";
const CRED = "00000000-0000-4000-8000-0000000000c1";
const SUC = "00000000-0000-4000-8000-0000000000d1";

async function esperar(): Promise<void> {
  await act(async () => {
    await flushMicrotasks();
    await flushMicrotasks();
  });
}
const json = (body: unknown, ok = true) => ({ ok, json: async () => body }) as unknown as Response;

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

const DATOS = {
  disponible: true,
  credenciales: [{ id: CRED, etiqueta: "App de PM", appId: "1234567890", wabaId: "9876543210", tieneVerifyToken: true, activa: true, tokenRotadoEnMs: 1_762_500_000_000, numeros: 1 }],
  numeros: [
    { propertyId: SUC, propertyNombre: "Sucursal T7", phoneNumberId: "5550001", credencialId: CRED, origen: "sucursal" },
    { propertyId: "00000000-0000-4000-8000-0000000000d2", propertyNombre: "Sucursal Galerías", phoneNumberId: null, credencialId: null, origen: "sucursal" },
  ],
};

function montar() {
  rendered = renderComponent(
    <MemoryRouter initialEntries={[`/superadmin/organizaciones/${ORG}/whatsapp`]}>
      <Routes>
        <Route path="/superadmin/organizaciones/:id/whatsapp" element={<SuperAdminWhatsappMetaPage apiBaseUrl="https://api.test" token="tok" />} />
      </Routes>
    </MemoryRouter>,
  );
  return rendered;
}

const boton = (texto: string, raiz: ParentNode = document.body) => [...raiz.querySelectorAll("button")].find((b) => b.textContent?.trim() === texto || b.textContent?.includes(texto))!;

describe("SuperAdminWhatsappMetaPage", () => {
  it("lista apps y numeros por sucursal (solo metadatos)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(DATOS)));
    const r = montar();
    await esperar();
    const t = r.container.textContent ?? "";
    expect(t).toContain("App de PM");
    expect(t).toContain("1234567890");
    expect(t).toContain("Propio");
    expect(t).toContain("Sucursal T7");
    expect(t).toContain("5550001");
    expect(t).toContain("Sin número");
    expect(t).toContain("Plataforma");
    expect(t).toContain("Registrar app de Meta");
  });

  it("sin llave: aviso 'no disponible aún' y sin controles", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ disponible: false, motivo: "sin_llave", credenciales: [], numeros: [] })));
    const r = montar();
    await esperar();
    expect(r.container.textContent).toContain("WHATSAPP_CREDENTIALS_KEY");
    expect(r.container.textContent).not.toContain("Registrar app de Meta");
  });

  it("base sin migrar: aviso honesto", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ disponible: false, motivo: "no_migrada", credenciales: [], numeros: [] })));
    const r = montar();
    await esperar();
    expect(r.container.textContent).toContain("0090_whatsapp_credenciales_meta");
  });

  it("registrar: valida obligatorios, manda los secretos UNA vez y limpia los campos al cerrar", async () => {
    let enviado: Record<string, unknown> | null = null;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST" && url.endsWith("/credenciales")) {
        enviado = JSON.parse(String(init.body)) as Record<string, unknown>;
        return json({ credencial: { id: CRED } });
      }
      return json(DATOS);
    });
    vi.stubGlobal("fetch", fetchMock);
    const r = montar();
    await esperar();
    click(boton("Registrar app de Meta", r.container));
    await submitForm(document.body.querySelector("#form-whatsapp-meta") as HTMLFormElement);
    expect(document.body.textContent).toContain("Completa los campos obligatorios");
    expect(enviado).toBeNull();

    const secreto = document.body.querySelector("#wa-meta-app-secret") as HTMLInputElement;
    expect(secreto.type).toBe("password");
    changeValue(document.body.querySelector("#wa-meta-etiqueta") as HTMLInputElement, "App de PM");
    changeValue(document.body.querySelector("#wa-meta-app-id") as HTMLInputElement, "1234567890");
    changeValue(document.body.querySelector("#wa-meta-waba-id") as HTMLInputElement, "9876543210");
    changeValue(secreto, "abcdef0123456789abcdef0123456789");
    changeValue(document.body.querySelector("#wa-meta-access-token") as HTMLInputElement, "EAAGtokenDePrueba0123456789");
    await submitForm(document.body.querySelector("#form-whatsapp-meta") as HTMLFormElement);
    await esperar();
    expect(enviado).toEqual({ etiqueta: "App de PM", appId: "1234567890", wabaId: "9876543210", appSecret: "abcdef0123456789abcdef0123456789", accessToken: "EAAGtokenDePrueba0123456789" });
    expect(r.container.textContent).toContain("App registrada");

    click(boton("Registrar app de Meta", r.container));
    expect((document.body.querySelector("#wa-meta-app-secret") as HTMLInputElement).value).toBe("");
  });

  it("rotar manda solo lo que se escribio", async () => {
    let enviado: unknown = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "PUT" && url.includes(`/credenciales/${CRED}`)) {
          enviado = JSON.parse(String(init.body));
          return json({ rotada: true });
        }
        return json(DATOS);
      }),
    );
    const r = montar();
    await esperar();
    click(boton("Rotar", r.container));
    changeValue(document.body.querySelector("#wa-meta-access-token") as HTMLInputElement, "EAAGotroTokenDePrueba0123456789");
    await submitForm(document.body.querySelector("#form-whatsapp-meta") as HTMLFormElement);
    await esperar();
    expect(enviado).toEqual({ accessToken: "EAAGotroTokenDePrueba0123456789" });
  });

  it("asignar: sucursal sin numero -> numero + app elegida", async () => {
    let enviado: unknown = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "PUT" && url.endsWith("/numeros")) {
          enviado = JSON.parse(String(init.body));
          return json({ asignado: true });
        }
        return json(DATOS);
      }),
    );
    const r = montar();
    await esperar();
    const botones = [...r.container.querySelectorAll("button")].filter((b) => b.textContent?.includes("Asignar"));
    click(botones[1]!);
    changeValue(document.body.querySelector("#wa-meta-phone-number-id") as HTMLInputElement, "5550002");
    changeValue(document.body.querySelector("#wa-meta-credencial") as HTMLSelectElement, CRED);
    await submitForm(document.body.querySelector("#form-whatsapp-meta") as HTMLFormElement);
    await esperar();
    expect(enviado).toEqual({ phoneNumberId: "5550002", credencialId: CRED, propertyId: "00000000-0000-4000-8000-0000000000d2" });
    expect(r.container.textContent).toContain("Número asignado");
  });
});
