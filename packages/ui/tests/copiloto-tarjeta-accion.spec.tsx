// @vitest-environment jsdom
//
// CopilotoTarjetaAccion (CHAT-17): vista previa, motivo obligatorio, Confirmar (pide la verificacion ANTES de enviar), Cancelar sin NINGUNA peticion,
// estados terminales y que una propuesta nunca se dibuje como tabla. El cliente es un doble controlable; el servidor real lo prueban apps/api/tests.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { CopilotoTarjetaAccion, propuestaDeBloque } from "../src/components/copiloto/CopilotoTarjetaAccion";
import { ChatDatosShell } from "../src/components/copiloto/ChatDatosShell";
import { CopilotoAccionError } from "../src/components/copiloto/tipos";
import type { CopilotoAccionPropuesta, CopilotoAccionVista, CopilotoAccionesCliente, CopilotoBloque, CopilotoRespuesta } from "../src/components/copiloto/tipos";
import { clic, escribir, limpiarDom, microtareas, montar, porTexto, propsBase, tecla, transporteFalso, type Montado } from "./copiloto-utils";

let montado: Montado | undefined;
afterEach(() => {
  montado?.unmount();
  montado = undefined;
  limpiarDom();
});

const SWITCH: CopilotoAccionPropuesta = { propuesta: "bcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrst", clase: "interruptor", tipo: "apagar_agente", agente: "restaurantes:whatsapp_agent", resumen: "Apagar el agente restaurantes:whatsapp_agent: deja de llamar al modelo." };
const INTENT: CopilotoAccionPropuesta = { propuesta: "33333333-3333-4333-8333-333333333333", clase: "intent", tipo: "ejecutar_mantenimiento_ahora", resumen: "Correr el mantenimiento ahora." };
const MOTIVO = "Costos fuera de control en este agente";

function cliente(over: Partial<CopilotoAccionesCliente> = {}, vista: CopilotoAccionVista | Error = { estado: "pendiente", resumen: SWITCH.resumen, tipo: SWITCH.tipo }) {
  const consultar = vi.fn(async () => {
    if (vista instanceof Error) throw vista;
    return vista;
  });
  const confirmar = vi.fn<CopilotoAccionesCliente["confirmar"]>(async () => ({ estado: "ejecutada" }));
  const c: CopilotoAccionesCliente = { consultar, confirmar, enlacePendientes: "/superadmin/acciones", ...over };
  return { c, consultar, confirmar };
}

async function montarTarjeta(p: CopilotoAccionPropuesta, c: CopilotoAccionesCliente) {
  montado = montar(<CopilotoTarjetaAccion propuesta={p} cliente={c} />);
  await microtareas();
  return montado.container;
}

const boton = (raiz: ParentNode, texto: string) => porTexto<HTMLButtonElement>(raiz, "button", texto);

describe("propuestaDeBloque", () => {
  const bloque = (rows: CopilotoBloque["rows"], tool = "proponer_accion"): CopilotoBloque => ({ tool, title: "Proponer", columns: [], rows, truncated: false });
  it("lee la fila y rechaza lo que no es una propuesta valida", () => {
    expect(propuestaDeBloque(bloque([{ propuesta: "x", clase: "intent", tipo: "cerrar_prospecto", resumen: "r" }]))).toEqual({ propuesta: "x", clase: "intent", tipo: "cerrar_prospecto", resumen: "r" });
    expect(propuestaDeBloque(bloque([{ propuesta: "x", clase: "interruptor", tipo: "apagar_agente", resumen: "r" }]))).toBeNull(); // interruptor sin agente
    expect(propuestaDeBloque(bloque([{ propuesta: "x", clase: "otra", tipo: "t", resumen: "r" }]))).toBeNull();
    expect(propuestaDeBloque(bloque([]))).toBeNull();
    expect(propuestaDeBloque(bloque([{ propuesta: "x", clase: "intent", tipo: "t", resumen: "r" }], "ventas_por_dia"))).toBeNull();
  });
});

describe("tarjeta de accion", () => {
  it("muestra la vista previa del servidor, el agente, el motivo obligatorio y el enlace a Acciones", async () => {
    const { c, consultar } = cliente();
    const raiz = await montarTarjeta(SWITCH, c);
    expect(consultar).toHaveBeenCalledTimes(1);
    expect(raiz.textContent).toContain("Acción propuesta");
    expect(raiz.textContent).toContain(SWITCH.resumen);
    expect(raiz.textContent).toContain("restaurantes:whatsapp_agent");
    expect(raiz.textContent).toContain("Motivo (obligatorio)");
    const enlace = raiz.querySelector("a") as HTMLAnchorElement;
    expect(enlace.getAttribute("href")).toBe("/superadmin/acciones");
  });

  it("Confirmar queda deshabilitado hasta que el motivo tenga 20 caracteres; no se envia nada antes", async () => {
    const { c, confirmar } = cliente();
    const raiz = await montarTarjeta(SWITCH, c);
    expect(boton(raiz, "Confirmar").disabled).toBe(true);
    escribir(raiz.querySelector("textarea") as HTMLTextAreaElement, "corto");
    expect(boton(raiz, "Confirmar").disabled).toBe(true);
    clic(boton(raiz, "Confirmar"));
    await microtareas();
    expect(confirmar).not.toHaveBeenCalled();
    escribir(raiz.querySelector("textarea") as HTMLTextAreaElement, MOTIVO);
    expect(boton(raiz, "Confirmar").disabled).toBe(false);
  });

  it("Confirmar manda UNA sola vez el motivo y deja la tarjeta 'Ejecutada' (un doble clic no duplica)", async () => {
    const { c, confirmar } = cliente();
    const raiz = await montarTarjeta(SWITCH, c);
    escribir(raiz.querySelector("textarea") as HTMLTextAreaElement, MOTIVO);
    clic(boton(raiz, "Confirmar"));
    clic(boton(raiz, "Confirmar"));
    await microtareas();
    expect(confirmar).toHaveBeenCalledTimes(1);
    expect(confirmar).toHaveBeenCalledWith(SWITCH, MOTIVO);
    expect(raiz.querySelector("[data-fase]")?.getAttribute("data-fase")).toBe("ejecutada");
    expect(raiz.textContent).toContain("Ejecutada");
    expect(raiz.querySelector("textarea")).toBeNull();
  });

  it("Cancelar NO hace ninguna peticion de confirmacion y la tarjeta queda 'Cancelada'", async () => {
    const { c, confirmar } = cliente();
    const raiz = await montarTarjeta(SWITCH, c);
    escribir(raiz.querySelector("textarea") as HTMLTextAreaElement, MOTIVO);
    clic(boton(raiz, "Cancelar"));
    await microtareas();
    expect(confirmar).not.toHaveBeenCalled();
    expect(raiz.textContent).toContain("Cancelada");
    expect(raiz.textContent).toContain("No se ejecutó nada");
    expect(raiz.querySelector("button")).toBeNull();
  });

  it("Escape no confirma nada (ni en el campo de motivo ni en la tarjeta)", async () => {
    const { c, confirmar } = cliente();
    const raiz = await montarTarjeta(SWITCH, c);
    const campo = raiz.querySelector("textarea") as HTMLTextAreaElement;
    escribir(campo, MOTIVO);
    tecla(campo, "Escape");
    tecla(raiz.querySelector("section") as HTMLElement, "Escape");
    await microtareas();
    expect(confirmar).not.toHaveBeenCalled();
  });

  it("si la persona cancela la verificacion MFA no se ejecuta, lo dice y puede volver a intentar", async () => {
    const { c, confirmar } = cliente();
    confirmar.mockRejectedValueOnce(new CopilotoAccionError("stepup_cancelado"));
    const raiz = await montarTarjeta(SWITCH, c);
    escribir(raiz.querySelector("textarea") as HTMLTextAreaElement, MOTIVO);
    clic(boton(raiz, "Confirmar"));
    await microtareas();
    expect(raiz.textContent).toContain("Falta verificar tu identidad");
    expect(raiz.querySelector("[data-fase]")?.getAttribute("data-fase")).toBe("pendiente");
    clic(boton(raiz, "Confirmar"));
    await microtareas();
    expect(confirmar).toHaveBeenCalledTimes(2);
    expect(raiz.querySelector("[data-fase]")?.getAttribute("data-fase")).toBe("ejecutada");
  });

  it("un conflicto (venció, ya se usó, el estado cambió) es terminal: 'Archivada', sin reintento", async () => {
    const { c, confirmar } = cliente();
    confirmar.mockRejectedValueOnce(new CopilotoAccionError("conflicto"));
    const raiz = await montarTarjeta(SWITCH, c);
    escribir(raiz.querySelector("textarea") as HTMLTextAreaElement, MOTIVO);
    clic(boton(raiz, "Confirmar"));
    await microtareas();
    expect(raiz.textContent).toContain("Archivada");
    expect(raiz.textContent).toContain("ya no es válida");
    expect(raiz.querySelector("button")).toBeNull();
  });

  it("un intent del catalogo no pide motivo (no hay donde guardarlo) y confirma directo", async () => {
    const { c, confirmar } = cliente({}, { estado: "pendiente", resumen: INTENT.resumen, tipo: INTENT.tipo });
    const raiz = await montarTarjeta(INTENT, c);
    expect(raiz.querySelector("textarea")).toBeNull();
    expect(boton(raiz, "Confirmar").disabled).toBe(false);
    clic(boton(raiz, "Confirmar"));
    await microtareas();
    expect(confirmar).toHaveBeenCalledWith(INTENT, "");
  });

  it.each([
    ["ejecutada", "Ejecutada"],
    ["vencida", "Vencida"],
    ["archivada", "Archivada"],
    ["cancelada", "Cancelada"],
    ["fallida", "Falló"],
  ] as const)("al reabrir, una propuesta '%s' ya no ofrece confirmar", async (estado, etiqueta) => {
    const { c, confirmar } = cliente({}, { estado, resumen: SWITCH.resumen, tipo: SWITCH.tipo });
    const raiz = await montarTarjeta(SWITCH, c);
    expect(raiz.textContent).toContain(etiqueta);
    expect(raiz.querySelector("button")).toBeNull();
    expect(raiz.querySelector("textarea")).toBeNull();
    expect(confirmar).not.toHaveBeenCalled();
  });

  it("si no se puede consultar la vigencia lo dice, no inventa un estado y deja confirmar (el servidor la vuelve a comprobar)", async () => {
    const { c } = cliente({}, new Error("red"));
    const raiz = await montarTarjeta(SWITCH, c);
    expect(raiz.textContent).toContain("No pude verificar si la propuesta sigue vigente");
    expect(raiz.querySelector("textarea")).not.toBeNull();
  });
});

describe("la propuesta dentro del Copiloto", () => {
  const respuesta = (bloque: CopilotoBloque): CopilotoRespuesta => ({ text: "Preparé la propuesta; confírmala en la tarjeta.", status: "ok", seq: 2, blocks: [bloque] });
  const bloque: CopilotoBloque = {
    tool: "proponer_accion",
    title: "Proponer una acción",
    columns: [{ key: "propuesta", label: "Propuesta", kind: "text" }],
    rows: [{ propuesta: SWITCH.propuesta, clase: "interruptor", tipo: SWITCH.tipo, agente: SWITCH.agente ?? null, resumen: SWITCH.resumen }],
    truncated: false,
  };

  async function preguntar(raiz: ParentNode) {
    escribir(raiz.querySelector("textarea") as HTMLTextAreaElement, "apaga el agente");
    clic(raiz.querySelector('[aria-label="Enviar"]') as HTMLElement);
    await microtareas();
    await act(async () => {
      await Promise.resolve();
    });
  }

  it("con `acciones`, el bloque se dibuja como tarjeta (nunca como tabla) y el token no aparece como texto de tabla", async () => {
    const { t } = transporteFalso({ enviar: vi.fn(async () => respuesta(bloque)) });
    const { c } = cliente();
    montado = montar(<ChatDatosShell {...propsBase(t, { acciones: c })} />);
    await preguntar(montado.container);
    expect(montado.container.querySelector('[data-testid="copiloto-tarjeta-accion"]')).not.toBeNull();
    expect(montado.container.querySelector("table")).toBeNull();
  });

  it("sin `acciones` (verticales) un bloque proponer_accion no se pinta: ni tarjeta ni tabla", async () => {
    const { t } = transporteFalso({ enviar: vi.fn(async () => respuesta(bloque)) });
    montado = montar(<ChatDatosShell {...propsBase(t)} />);
    await preguntar(montado.container);
    expect(montado.container.querySelector('[data-testid="copiloto-tarjeta-accion"]')).toBeNull();
    expect(montado.container.textContent).not.toContain(SWITCH.propuesta);
  });

  it("la variante panel es compacta (sin min-h de pagina) y conserva el compositor", async () => {
    const { t } = transporteFalso();
    montado = montar(<ChatDatosShell {...propsBase(t, { variante: "panel" })} />);
    const raiz = montado.container.querySelector('[data-testid="copiloto-shell"]') as HTMLElement;
    expect(raiz.getAttribute("data-variante")).toBe("panel");
    expect(raiz.className).not.toContain("min-h-[calc(100dvh-8rem)]");
    expect(raiz.querySelector("textarea")).not.toBeNull();
  });
});
