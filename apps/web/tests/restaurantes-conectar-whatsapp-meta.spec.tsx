// @vitest-environment jsdom
//
// «Conectar mi número con Meta» (Embedded Signup): no disponible -> aviso honesto con lo que falta; disponible -> corre el flujo de
// Meta (doble), manda code + ids al servidor y muestra el PIN una vez. Y el lector del mensaje WA_EMBEDDED_SIGNUP solo acepta facebook.com.
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConectarWhatsappMeta } from "../src/verticals/restaurantes/components/ConectarWhatsappMeta.tsx";
import { leerMensajeEmbeddedSignup } from "../src/verticals/restaurantes/lib/whatsapp-embedded-signup.ts";
import { click, esperarHasta, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
});

function respuesta(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("ConectarWhatsappMeta", () => {
  it("no disponible: aviso con los nombres de lo que falta y sin boton", async () => {
    const fetchImpl = vi.fn(async () => respuesta(200, { disponible: false, faltantes: ["WHATSAPP_EMBEDDED_SIGNUP", "META_APP_ID"], appId: null, configId: null, graphApiVersion: "v21.0" })) as unknown as typeof fetch;
    rendered = renderComponent(<ConectarWhatsappMeta apiBaseUrl="https://api.test" token="t" propertyId="p1" branchId="b1" fetchImpl={fetchImpl} onConectado={() => {}} />);
    await esperarHasta(() => rendered!.container.textContent!.includes("no está disponible aún"), "aviso");
    expect(rendered.container.textContent).toContain("WHATSAPP_EMBEDDED_SIGNUP, META_APP_ID");
    expect(rendered.container.querySelector("button")).toBeNull();
  });

  it("disponible: corre el flujo de Meta, manda code + ids y muestra el PIN", async () => {
    const posts: unknown[] = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") {
        posts.push(JSON.parse(String(init.body)));
        return respuesta(201, { phoneNumberId: "555000111", numero: "+52 999 123 4567", nombreVerificado: "Los Taquitos", pin: "042137" });
      }
      return respuesta(200, { disponible: true, faltantes: [], appId: "123", configId: "456", graphApiVersion: "v23.0" });
    }) as unknown as typeof fetch;
    const correrFlujo = vi.fn(async () => ({ code: "codigo-meta", wabaId: "1234567", phoneNumberId: "555000111" }));
    const onConectado = vi.fn();
    rendered = renderComponent(<ConectarWhatsappMeta apiBaseUrl="https://api.test" token="t" propertyId="p1" branchId="b1" fetchImpl={fetchImpl} correrFlujo={correrFlujo} onConectado={onConectado} />);
    await esperarHasta(() => rendered!.container.querySelector("button") !== null, "boton");
    click(rendered.container.querySelector("button")!);
    await esperarHasta(() => rendered!.container.textContent!.includes("042137"), "PIN");
    expect(correrFlujo).toHaveBeenCalledWith({ appId: "123", configId: "456", graphApiVersion: "v23.0" });
    expect(posts).toEqual([{ code: "codigo-meta", wabaId: "1234567", phoneNumberId: "555000111" }]);
    expect(onConectado).toHaveBeenCalledWith("555000111");
  });
});

describe("leerMensajeEmbeddedSignup", () => {
  const ok = { type: "WA_EMBEDDED_SIGNUP", event: "FINISH", data: { waba_id: "1", phone_number_id: "2" } };
  it("solo acepta mensajes de facebook.com", () => {
    expect(leerMensajeEmbeddedSignup({ origin: "https://www.facebook.com", data: JSON.stringify(ok) })).toEqual({ wabaId: "1", phoneNumberId: "2" });
    expect(leerMensajeEmbeddedSignup({ origin: "https://evil.example", data: ok })).toBeNull();
    expect(leerMensajeEmbeddedSignup({ origin: "https://facebook.com.evil.example", data: ok })).toBeNull();
    expect(leerMensajeEmbeddedSignup({ origin: "https://www.facebook.com", data: { ...ok, event: "CANCEL" } })).toBe("cancelado");
    expect(leerMensajeEmbeddedSignup({ origin: "https://www.facebook.com", data: "no json" })).toBeNull();
  });
});
