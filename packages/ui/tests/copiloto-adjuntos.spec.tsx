// @vitest-environment jsdom
//
// "Adjuntar archivo" en el ChatDatosShell compartido: el clip solo existe si el transporte lo declara; un archivo valido se envia por el transporte con una etiqueta
// legible (nunca como texto al modelo); un archivo demasiado grande, vacio o de un tipo no soportado se rechaza ANTES de subir y lo dice; mientras hay un turno en
// curso el clip se deshabilita; y "Regenerar" repite el MISMO archivo.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { ChatDatosShell } from "../src/components/copiloto/ChatDatosShell";
import { CopilotoErrorTransporte, type CopilotoAdjuntosConfig } from "../src/components/copiloto/tipos";
import { clic, envioColgado, limpiarDom, microtareas, montar, porEtiqueta, propsBase, RESPUESTA_OK, transporteFalso, type Montado } from "./copiloto-utils";

let montado: Montado | undefined;
afterEach(() => {
  montado?.unmount();
  montado = undefined;
  limpiarDom();
});

const ADJUNTOS: CopilotoAdjuntosConfig = { accept: ".csv,.xlsx,.pdf", maxBytes: 1024 };

function entradaArchivo(raiz: ParentNode): HTMLInputElement {
  return raiz.querySelector<HTMLInputElement>('[data-testid="copiloto-adjunto-input"]')!;
}
async function elegir(raiz: ParentNode, archivo: File) {
  const input = entradaArchivo(raiz);
  Object.defineProperty(input, "files", { configurable: true, value: [archivo] });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await microtareas();
}
const archivo = (nombre: string, contenido = "a,b\n1,2", tipo = "text/csv"): File => new File([contenido], nombre, { type: tipo });

describe("el clip de adjuntos", () => {
  it("sin `adjuntos` en el transporte NO hay clip ni selector de archivos", () => {
    const { t } = transporteFalso();
    montado = montar(<ChatDatosShell {...propsBase(t)} />);
    expect(montado.container.querySelector('[aria-label="Adjuntar archivo"]')).toBeNull();
    expect(entradaArchivo(montado.container)).toBeNull();
  });

  it("con `adjuntos` aparece el clip y el selector acepta solo las extensiones declaradas", () => {
    const { t } = transporteFalso({ adjuntos: ADJUNTOS });
    montado = montar(<ChatDatosShell {...propsBase(t)} />);
    expect(porEtiqueta(montado.container, "Adjuntar archivo").tagName).toBe("BUTTON");
    expect(entradaArchivo(montado.container).accept).toBe(".csv,.xlsx,.pdf");
  });

  it("el clip abre el selector de archivos", () => {
    const { t } = transporteFalso({ adjuntos: ADJUNTOS });
    montado = montar(<ChatDatosShell {...propsBase(t)} />);
    const abrir = vi.spyOn(entradaArchivo(montado.container), "click");
    clic(porEtiqueta(montado.container, "Adjuntar archivo"));
    expect(abrir).toHaveBeenCalledTimes(1);
  });
});

describe("enviar un archivo", () => {
  it("un CSV valido se manda por el transporte con el File y una etiqueta legible, y la respuesta se pinta como cualquier otra", async () => {
    const { t, enviar } = transporteFalso({ adjuntos: ADJUNTOS });
    montado = montar(<ChatDatosShell {...propsBase(t)} />);
    const f = archivo("ventas.csv");
    await elegir(montado.container, f);
    expect(enviar).toHaveBeenCalledTimes(1);
    const arg = enviar.mock.calls[0]![0];
    expect(arg.adjunto).toBe(f);
    expect(arg.pregunta).toBe("Adjunté «ventas.csv»");
    expect(arg.directa).toBeUndefined();
    expect(montado.container.textContent).toContain("Adjunté «ventas.csv»");
    expect(montado.container.textContent).toContain(RESPUESTA_OK.blocks![0]!.title);
  });

  it("un archivo mas grande que el tope, vacio o de otro tipo se rechaza ANTES de subir y se avisa; luego uno valido limpia el aviso", async () => {
    const { t, enviar } = transporteFalso({ adjuntos: ADJUNTOS });
    montado = montar(<ChatDatosShell {...propsBase(t)} />);
    await elegir(montado.container, archivo("enorme.csv", "x".repeat(2048)));
    expect(montado.container.querySelector("[role=alert]")?.textContent).toContain("supera los");
    await elegir(montado.container, archivo("vacio.csv", ""));
    expect(montado.container.querySelector("[role=alert]")?.textContent).toBe("El archivo está vacío.");
    await elegir(montado.container, archivo("virus.exe", "MZ", "application/octet-stream"));
    expect(montado.container.querySelector("[role=alert]")?.textContent).toContain("Solo puedo leer archivos .csv, .xlsx, .pdf");
    expect(enviar).not.toHaveBeenCalled();
    await elegir(montado.container, archivo("ventas.CSV"));
    expect(enviar).toHaveBeenCalledTimes(1);
    expect(montado.container.querySelector("[role=alert]")).toBeNull();
  });

  it("mientras hay un turno en curso el clip esta deshabilitado y no se manda un segundo archivo", async () => {
    const c = envioColgado();
    const { t } = transporteFalso({ adjuntos: ADJUNTOS, enviar: c.enviar });
    montado = montar(<ChatDatosShell {...propsBase(t)} />);
    await elegir(montado.container, archivo("a.csv"));
    expect((porEtiqueta(montado.container, "Adjuntar archivo") as HTMLButtonElement).disabled).toBe(true);
    await elegir(montado.container, archivo("b.csv"));
    expect(c.enviar).toHaveBeenCalledTimes(1);
  });

  it("Regenerar vuelve a analizar el MISMO archivo (no manda la etiqueta como pregunta al modelo)", async () => {
    const { t, enviar } = transporteFalso({ adjuntos: ADJUNTOS });
    montado = montar(<ChatDatosShell {...propsBase(t)} />);
    const f = archivo("ventas.csv");
    await elegir(montado.container, f);
    clic(porEtiqueta(montado.container, "Regenerar respuesta"));
    await microtareas();
    expect(enviar).toHaveBeenCalledTimes(2);
    expect(enviar.mock.calls[1]![0].adjunto).toBe(f);
  });

  it("un rechazo del servidor (p. ej. un PDF escaneado) muestra su motivo tal cual, sin quedarse cargando", async () => {
    const { t } = transporteFalso({ adjuntos: ADJUNTOS, enviar: vi.fn(async () => Promise.reject(new CopilotoErrorTransporte("invalid_input", "Adjuntaste muchos archivos en poco tiempo."))) });
    montado = montar(<ChatDatosShell {...propsBase(t)} />);
    await elegir(montado.container, archivo("a.csv"));
    expect(montado.container.textContent).toContain("Adjuntaste muchos archivos en poco tiempo.");
    expect((porEtiqueta(montado.container, "Adjuntar archivo") as HTMLButtonElement).disabled).toBe(false);
  });
});
