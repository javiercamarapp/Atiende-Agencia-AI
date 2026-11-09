// @vitest-environment jsdom
//
// Clonacion de la voz telefonica: tarjeta de voz con avatar (plataforma, catalogo o clonada; boton solo para owner/admin) y dialogo de
// varias muestras que sube a NUESTRA API (multipart con los clips, nombre y consentimiento) y nunca habla con el proveedor.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClonarVozDialogo } from "../src/verticals/restaurantes/voz/ClonarVozDialogo.tsx";
import { TarjetaVozTelefono, esVozClonada } from "../src/verticals/restaurantes/voz/TarjetaVozTelefono.tsx";
import { changeValue, click, esperarHasta, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

const VOZ_CLONADA = "AbCdEfGhIjKlMnOpQrSt";
let rendered: RenderedComponent | undefined;

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.restoreAllMocks();
});

const PROPS = { apiBaseUrl: "https://api.test", token: "tok", propertyId: "prop-1" };

function botonPorTexto(texto: string): HTMLButtonElement | undefined {
  return Array.from(document.body.querySelectorAll("button")).find((b) => b.textContent?.trim() === texto) as HTMLButtonElement | undefined;
}

/** jsdom no implementa URL.createObjectURL: se define para la prueba (y se retira al terminar). */
function urlsDeClip() {
  Object.assign(URL, { createObjectURL: vi.fn(() => "blob:clip"), revokeObjectURL: vi.fn() });
}

async function subir(input: HTMLInputElement, archivos: File[]) {
  Object.defineProperty(input, "files", { configurable: true, value: archivos });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function clip(n: number, tipo = "audio/webm"): File {
  return new File([new Uint8Array(4096).fill(n)], `clip-${n}.webm`, { type: tipo });
}

describe("TarjetaVozTelefono", () => {
  it("sin voz elegida muestra la de la plataforma; con una clonada, el distintivo; el boton solo para quien puede clonar", () => {
    rendered = renderComponent(<TarjetaVozTelefono {...PROPS} vozTelefono={null} puedeClonar onClonada={() => undefined} />);
    const tarjeta = rendered.container.querySelector('[data-testid="tarjeta-voz-telefono"]')!;
    expect(tarjeta.textContent).toContain("Regina");
    expect(tarjeta.textContent).toContain("Voz de la plataforma");
    expect(botonPorTexto("Clonar una voz")).toBeDefined();
    rendered.unmount();

    rendered = renderComponent(<TarjetaVozTelefono {...PROPS} vozTelefono={VOZ_CLONADA} puedeClonar={false} onClonada={() => undefined} />);
    expect(rendered.container.textContent).toContain("Voz clonada");
    expect(rendered.container.textContent).toContain("Creada con grabaciones de tu negocio");
    expect(botonPorTexto("Clonar otra voz")).toBeUndefined();
    expect(rendered.container.innerHTML).not.toMatch(/#[0-9a-f]{3,6}\b/i);
  });

  it("esVozClonada: solo un id que no es del catalogo telefonico", () => {
    expect(esVozClonada(null)).toBe(false);
    expect(esVozClonada("sDh3eviBhiuHKi0MjTNq")).toBe(false);
    expect(esVozClonada(VOZ_CLONADA)).toBe(true);
  });
});

describe("ClonarVozDialogo", () => {
  it("exige 2 clips, nombre y consentimiento; sube multipart a la API propia y entrega la voz guardada", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ vozTelefono: VOZ_CLONADA, vozTelefonoClonada: true, nombre: "Doña Pili" }), { status: 201 }));
    const onClonada = vi.fn();
    urlsDeClip();
    rendered = renderComponent(<ClonarVozDialogo {...PROPS} open onOpenChange={() => undefined} onClonada={onClonada} fetchImpl={fetchImpl as unknown as typeof fetch} />);
    await flushMicrotasks();

    const enviar = () => botonPorTexto("Clonar voz")!;
    expect(enviar().disabled).toBe(true);

    const input = document.body.querySelector('[data-testid="clonar-voz-archivos"]') as HTMLInputElement;
    await subir(input, [clip(1)]);
    expect(document.body.textContent).toContain("Agrega al menos 2 clips.");
    await subir(input, [clip(2)]);
    expect(document.body.querySelectorAll('[data-testid="clonar-voz-clips"] li')).toHaveLength(2);

    changeValue(document.body.querySelector("#clonar-voz-nombre") as HTMLInputElement, "Doña Pili");
    expect(enviar().disabled).toBe(true); // falta el consentimiento
    click(document.body.querySelector("#clonar-voz-consentimiento")!);
    expect(enviar().disabled).toBe(false);

    await act(async () => {
      click(enviar());
    });
    await esperarHasta(() => onClonada.mock.calls.length > 0, "la voz clonada llega al panel");
    expect(onClonada).toHaveBeenCalledWith(VOZ_CLONADA);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.test/v1/restaurantes/prop-1/admin/voz/clonar");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer tok");
    const form = init.body as FormData;
    expect(form.getAll("muestras")).toHaveLength(2);
    expect(form.get("consentimiento")).toBe("true");
    expect(form.get("nombre")).toBe("Doña Pili");
  });

  it("rechaza archivos que no son audio y muestra el 503 honesto de la API (falta la llave)", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "Clonación de voz no disponible aún: requiere ELEVENLABS_API_KEY en la API." }), { status: 503 }));
    urlsDeClip();
    rendered = renderComponent(<ClonarVozDialogo {...PROPS} open onOpenChange={() => undefined} onClonada={() => undefined} fetchImpl={fetchImpl as unknown as typeof fetch} />);
    await flushMicrotasks();
    const input = document.body.querySelector('[data-testid="clonar-voz-archivos"]') as HTMLInputElement;
    await subir(input, [clip(1, "text/html")]);
    expect(document.body.textContent).toContain("Solo se aceptan archivos de audio.");
    expect(document.body.querySelectorAll('[data-testid="clonar-voz-clips"] li')).toHaveLength(0);

    await subir(input, [clip(1), clip(2)]);
    changeValue(document.body.querySelector("#clonar-voz-nombre") as HTMLInputElement, "Voz");
    click(document.body.querySelector("#clonar-voz-consentimiento")!);
    await act(async () => {
      click(botonPorTexto("Clonar voz")!);
    });
    await esperarHasta(() => (document.body.textContent ?? "").includes("ELEVENLABS_API_KEY"), "aviso honesto del 503");
  });
});
