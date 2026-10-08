// @vitest-environment jsdom
//
// <CfoSoftRestaurant />: (a) comandas (modo apagado incluido), (b) importar el reporte con mapeo asistido, columnas de cliente excluidas, vista previa con errores
// por renglón, importación idempotente y lotes cargados, (c) domicilio vs presencial y cuadre con semáforo según los umbrales de la configuración.
// Archivos y datos SINTÉTICOS (CFO-04); la API simulada normaliza con el normalizador real.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { describe, expect, it } from "vitest";
import type { CuadreSrVista } from "@atiende/domain-restaurantes/cfo";
import { CSV_SR_SINTETICO, ETIQUETA_SINTETICO } from "../../../packages/domain-restaurantes/tests/fixtures/cfo-pm-sintetico.ts";
import { operacionApagadaB } from "../e2e/mock-api/fixtures/restaurantes-cfo-b.ts";
import { CfoSoftRestaurant, MENSAJE_SIN_SR, ROTULO_CUADRE, TEXTO_COMANDAS_APAGADO, TITULO_SIN_SR } from "../src/verticals/restaurantes/cfo/CfoSoftRestaurant.tsx";
import { BASE_CFO, IDS, crearApiCfo, respuestaBase } from "./test-utils/cfo-api-simulada.ts";
import { bancoCfoB } from "./test-utils/cfo-b-banco.tsx";
import { changeValue, click, flushMicrotasks } from "./test-utils/render.tsx";

const b = bancoCfoB();
const cargado = () => b.esperar(() => b.q("[data-testid=sr-lotes]") !== null && b.q("[data-testid=sr-bloque-importar]") !== null && !b.texto().includes("Cargando"), "bloques cargados");

async function elegirArchivo(input: HTMLInputElement, file: File): Promise<void> {
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
    for (let i = 0; i < 20; i++) await flushMicrotasks();
    await new Promise((r) => setTimeout(r, 20));
  });
}

async function abrirDialogo(): Promise<HTMLElement> {
  click(b.q("[data-testid=sr-importar-abrir]")!);
  await b.esperar(() => b.dialogo() !== null, "diálogo de importación");
  return b.dialogo()!;
}

const esperarAcciones = async () => {
  await act(async () => {
    for (let i = 0; i < 20; i++) await flushMicrotasks();
    await new Promise((r) => setTimeout(r, 20));
  });
};

const botonDe = (d: HTMLElement, texto: string): HTMLButtonElement => [...d.querySelectorAll("button")].find((x) => x.textContent?.includes(texto)) as HTMLButtonElement;
const selector = (d: HTMLElement, id: string) => d.querySelector<HTMLSelectElement>(`#${id}`)!;

async function importarCsv(csv = CSV_SR_SINTETICO, nombre = "reporte-cuentas.csv"): Promise<HTMLElement> {
  const d = await abrirDialogo();
  changeValue(selector(d, "sr-sucursal"), IDS.T2);
  await elegirArchivo(d.querySelector<HTMLInputElement>("#sr-archivo")!, new File([csv], nombre, { type: "text/csv" }));
  return d;
}

describe("<CfoSoftRestaurant /> · (a) comandas", () => {
  it("muestra encoladas, confirmadas, a mano, fallidas, pendientes, tasa, minutos, vencidas y folios (declarados = confianza baja)", async () => {
    await b.pintar(CfoSoftRestaurant, crearApiCfo());
    await cargado();
    const t = b.q("[data-testid=sr-comandas]")!.textContent!;
    for (const etiqueta of ["Encoladas", "Confirmadas", "Capturadas a mano", "Fallidas", "Pendientes", "Tasa de captura", "Minutos hasta la captura", "Vencidas sobre el umbral"]) expect(t).toContain(etiqueta);
    expect(b.q("[data-testid=comandas-folios]")!.textContent).toContain("texto libre: confianza baja");
    expect(t).toContain("En sombra");
  });

  it("con el envío apagado lo dice y enlaza a Comandas al POS, sin cifras de captura", async () => {
    await b.pintar(CfoSoftRestaurant, crearApiCfo({ "GET /operacion": { status: 200, cuerpo: operacionApagadaB() } }));
    await cargado();
    expect(b.texto()).toContain(TEXTO_COMANDAS_APAGADO);
    expect(b.q("[data-testid=sr-comandas]")).toBeNull();
    expect((b.q("[data-testid=comandas-enlace-pos]") as HTMLAnchorElement).getAttribute("href")).toBe("/restaurantes/demo/comandas-pos");
  });
});

describe("<CfoSoftRestaurant /> · (b) importar y (c) cuadre", () => {
  it("sin reporte: lotes vacíos y el cuadre es un estado vacío grande con el botón a importar", async () => {
    await b.pintar(CfoSoftRestaurant, crearApiCfo());
    await cargado();
    expect(b.q("[data-testid=sr-lotes]")!.textContent).toContain("Todavía no cargas ningún reporte");
    expect(b.texto()).toContain(TITULO_SIN_SR);
    expect(b.texto()).toContain(MENSAJE_SIN_SR);
    expect(b.q("[data-testid=sr-cuadre]")).toBeNull();
    click(b.q("[data-testid=cuadre-subir]")!);
    await b.esperar(() => b.dialogo()?.textContent?.includes("Importar reporte de SoftRestaurant") === true, "el botón abre la importación");
  });

  it("recorrido: sucursal, archivo, mapeo, vista previa, confirmar, lote en la lista y cuadre con semáforo", async () => {
    const api = crearApiCfo();
    await b.pintar(CfoSoftRestaurant, api);
    await cargado();
    const d = await importarCsv();
    expect(d.textContent).toContain("reporte-cuentas.csv");
    // El título SINTÉTICO de arriba no es el encabezado: se detecta el renglón 2 y el layout de cuentas.
    expect(selector(d, "sr-fila-encabezado").value).toBe("1");
    expect(selector(d, "sr-tipo").value).toBe("cuentas");
    expect(selector(d, "sr-mapeo-folio").value).toBe("0");
    expect(selector(d, "sr-mapeo-total").value).toBe("7");
    click(botonDe(d, "Revisar vista previa"));
    await esperarAcciones();
    const previa = d.querySelector("[data-testid=sr-vista-previa]")!;
    expect(previa.textContent).toMatch(/renglones aceptados y 0 rechazados/);
    expect(previa.textContent).toContain("Alias de columnas inferidos");
    expect(api.peticiones("POST", "/softrestaurant/importar").length).toBe(0); // la vista previa no escribe
    click(botonDe(d, "Importar "));
    await esperarAcciones();
    expect(d.querySelector("[data-testid=sr-resultado]")!.textContent).toContain("Reporte importado");
    click(botonDe(d, "Cerrar"));
    await b.esperar(() => b.q("[data-testid=sr-cuadre]") !== null, "cuadre con datos");
    expect(b.q("[data-testid=sr-lotes]")!.textContent).toContain("reporte-cuentas.csv");
    expect(b.qa("[data-testid=sr-cobertura]")[0]!.textContent).toMatch(/7 días/);
    // Cuadre: semáforo con TEXTO (verde, ámbar y rojo de la fixture) y el rótulo del cuadre básico.
    const textos = new Set(b.qa("tr[data-semaforo]").map((f) => f.getAttribute("data-semaforo")));
    expect(textos).toEqual(new Set(["verde", "ambar", "rojo"]));
    expect(b.qa("tr[data-semaforo=verde] [data-testid=semaforo]")[0]!.textContent).toBe("Cuadra");
    expect(b.qa("tr[data-semaforo=ambar] [data-testid=semaforo]")[0]!.textContent).toBe("Revisar");
    expect(b.qa("tr[data-semaforo=rojo] [data-testid=semaforo]")[0]!.textContent).toBe("No cuadra");
    expect(b.texto()).toContain(ROTULO_CUADRE);
    expect(b.q("[data-testid=cuadre-regla-total]")!.textContent).toContain("nunca se suman los dos");
    expect(b.q("[data-testid=cuadre-umbrales]")!.textContent).toMatch(/1 % o menos y de \$50 o menos.*3 %/);
  });

  it("importar el mismo archivo otra vez dice «Este archivo ya estaba cargado»", async () => {
    const api = crearApiCfo();
    await b.pintar(CfoSoftRestaurant, api);
    await cargado();
    for (let vez = 0; vez < 2; vez++) {
      const d = await importarCsv();
      click(botonDe(d, "Revisar vista previa"));
      await esperarAcciones();
      click(botonDe(d, "Importar "));
      await esperarAcciones();
      if (vez === 0) {
        expect(d.querySelector("[data-testid=sr-resultado]")!.textContent).toContain("Reporte importado");
        click(botonDe(d, "Cerrar"));
        await esperarAcciones();
      } else {
        expect(d.querySelector("[data-testid=sr-ya-cargado]")!.textContent).toContain("Este archivo ya estaba cargado");
      }
    }
    expect(api.peticiones("POST", "/softrestaurant/importar").length).toBe(2);
    await b.esperar(() => b.qa("[data-testid=sr-lotes] tbody tr").length === 1, "un solo lote");
  });

  it("el .xlsx SINTÉTICO de ventas por tipo de servicio se lee, se mapea solo como resumen y se importa", async () => {
    const api = crearApiCfo();
    await b.pintar(CfoSoftRestaurant, api);
    await cargado();
    const d = await abrirDialogo();
    changeValue(selector(d, "sr-sucursal"), IDS.T2);
    const bytes = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../e2e/fixtures/sr-resumen-servicio-SINTETICO.xlsx"));
    await elegirArchivo(d.querySelector<HTMLInputElement>("#sr-archivo")!, new File([bytes], "ventas-por-servicio.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
    expect(selector(d, "sr-tipo").value).toBe("resumen_servicio");
    expect(selector(d, "sr-fila-encabezado").value).toBe("1");
    expect(selector(d, "sr-mapeo-servicio").value).toBe("1");
    expect(selector(d, "sr-mapeo-tickets").value).toBe("2");
    click(botonDe(d, "Revisar vista previa"));
    await esperarAcciones();
    expect(d.querySelector("[data-testid=sr-vista-previa]")!.textContent).toMatch(/renglones aceptados y 0 rechazados/);
    click(botonDe(d, "Importar "));
    await esperarAcciones();
    expect(d.querySelector("[data-testid=sr-resultado]")!.textContent).toContain("Reporte importado");
    click(botonDe(d, "Cerrar"));
    await b.esperar(() => b.q("[data-testid=sr-lotes]")!.textContent!.includes("Ventas por tipo de servicio"), "lote de resumen");
  });

  it("una columna «Teléfono» se excluye, se avisa «No subimos datos de tus clientes» y nunca viaja al API", async () => {
    const api = crearApiCfo();
    await b.pintar(CfoSoftRestaurant, api);
    await cargado();
    const csv = ["Folio,Fecha,Tipo de servicio,Teléfono,Total", "T2-1,21/09/2026,A domicilio,9990001111,$120.00", "T2-2,22/09/2026,Comedor,9990002222,$300.00"].join("\n");
    const d = await importarCsv(csv, "con-columna-personal.csv");
    const aviso = d.querySelector("[data-testid=sr-columnas-excluidas]")!;
    expect(aviso.textContent).toContain("No subimos datos de tus clientes");
    expect(aviso.textContent).toContain("Teléfono");
    // La columna personal no se ofrece en ningún selector del mapeo.
    for (const o of d.querySelectorAll("#sr-mapeo-total option")) expect(o.textContent).not.toContain("Teléfono");
    click(botonDe(d, "Revisar vista previa"));
    await esperarAcciones();
    expect(d.querySelector("[data-testid=sr-vista-previa]")!.textContent).toMatch(/2 renglones aceptados/);
    const enviado = JSON.stringify(api.peticiones("POST", "/softrestaurant/importar/vista-previa")[0]!.cuerpo);
    expect(enviado).not.toContain("9990001111");
    expect(enviado).not.toMatch(/Tel[eé]fono/i);
  });

  it("BLOQUEANTE de PII: elegir un renglón de datos como encabezado no libera la columna «Teléfono»: sigue excluida y no viaja", async () => {
    const api = crearApiCfo();
    await b.pintar(CfoSoftRestaurant, api);
    await cargado();
    const csv = ["Folio,Fecha,Total,Teléfono", "T2-1,21/09/2026,$120.00,9991112222", "T2-2,22/09/2026,$300.00,9993334444"].join("\n");
    const d = await importarCsv(csv, "tel-al-final.csv");
    changeValue(selector(d, "sr-fila-encabezado"), "1");
    await esperarAcciones();
    expect(d.querySelector("[data-testid=sr-columnas-excluidas]")!.textContent).toContain("Teléfono");
    expect(d.textContent).not.toContain("9991112222");
    for (const o of d.querySelectorAll("select[id^=sr-mapeo-] option")) expect(o.textContent).not.toContain("Columna 4");
    // Forzar el teléfono (columna 4) como folio ya no es posible desde la interfaz; el mapeo sano lo deja fuera.
    changeValue(selector(d, "sr-mapeo-folio"), "0");
    changeValue(selector(d, "sr-mapeo-fecha"), "1");
    changeValue(selector(d, "sr-mapeo-total"), "2");
    click(botonDe(d, "Revisar vista previa"));
    await esperarAcciones();
    const previas = api.peticiones("POST", "/softrestaurant/importar/vista-previa");
    for (const p of previas) expect(JSON.stringify(p.cuerpo)).not.toMatch(/9991112222|9993334444|Tel[eé]fono/);
  });

  it("un valor con forma de teléfono en la columna mapeada a folio bloquea la revisión con un aviso claro y no llama al API", async () => {
    const api = crearApiCfo();
    await b.pintar(CfoSoftRestaurant, api);
    await cargado();
    const csv = ["Referencia,Fecha,Total", "9991112222,21/09/2026,$120.00", "9993334444,22/09/2026,$300.00"].join("\n");
    const d = await importarCsv(csv, "referencias.csv");
    changeValue(selector(d, "sr-tipo"), "cuentas");
    await esperarAcciones();
    changeValue(selector(d, "sr-mapeo-folio"), "0");
    await esperarAcciones();
    expect(d.querySelector("[data-testid=sr-valor-personal]")!.textContent).toContain("parece un teléfono o un correo");
    expect(botonDe(d, "Revisar vista previa").disabled).toBe(true);
    expect(api.peticiones("POST", "/softrestaurant/importar/vista-previa")).toHaveLength(0);
  });

  it("la vista previa muestra los errores por renglón con la numeración del archivo", async () => {
    const api = crearApiCfo();
    await b.pintar(CfoSoftRestaurant, api);
    await cargado();
    const csv = [ETIQUETA_SINTETICO, "Folio,Fecha,Tipo de servicio,Total", "T2-1,21/09/2026,A domicilio,$120.00", "T2-2,22/09/2026,Comedor,abc", "T2-3,fecha mala,Comedor,$50.00"].join("\n");
    const d = await importarCsv(csv, "con-errores.csv");
    click(botonDe(d, "Revisar vista previa"));
    await esperarAcciones();
    const errores = d.querySelector("[data-testid=sr-errores]")!;
    expect(errores.textContent).toContain("2 errores por renglón");
    expect(errores.textContent).toContain("Renglón 4, total: monto inválido");
    expect(errores.textContent).toContain("Renglón 5, fecha: fecha inválida");
    expect(d.querySelector("[data-testid=sr-vista-previa]")!.textContent).toMatch(/1 renglón aceptado y 2 rechazados/);
  });

  it("un .xls antiguo se rechaza con el mensaje de la casa y no se llama al API", async () => {
    const api = crearApiCfo();
    await b.pintar(CfoSoftRestaurant, api);
    await cargado();
    const d = await abrirDialogo();
    await elegirArchivo(d.querySelector<HTMLInputElement>("#sr-archivo")!, new File(["x"], "reporte.xls", { type: "application/vnd.ms-excel" }));
    expect(d.querySelector("[data-testid=sr-error]")!.textContent).toContain("Formato no admitido");
    expect(api.peticiones("POST", "/softrestaurant/importar/vista-previa").length).toBe(0);
  });

  it("sin elegir sucursal o con una columna obligatoria sin mapear no se puede revisar", async () => {
    const api = crearApiCfo();
    await b.pintar(CfoSoftRestaurant, api);
    await cargado();
    const d = await abrirDialogo();
    await elegirArchivo(d.querySelector<HTMLInputElement>("#sr-archivo")!, new File([CSV_SR_SINTETICO], "r.csv", { type: "text/csv" }));
    expect(botonDe(d, "Revisar vista previa").disabled).toBe(true); // falta la sucursal
    changeValue(selector(d, "sr-sucursal"), IDS.T2);
    expect(botonDe(d, "Revisar vista previa").disabled).toBe(false);
    changeValue(selector(d, "sr-mapeo-total"), "");
    expect(botonDe(d, "Revisar vista previa").disabled).toBe(true);
    expect(d.textContent).toContain("Elige la columna de este dato.");
  });

  it("un error del servidor (422) se muestra tal cual en el diálogo", async () => {
    const api = crearApiCfo({ "POST /softrestaurant/importar/vista-previa": { status: 422, cuerpo: { code: "faltan_columnas", message: "Faltan columnas obligatorias en el archivo." } } });
    await b.pintar(CfoSoftRestaurant, api);
    await cargado();
    const d = await importarCsv();
    click(botonDe(d, "Revisar vista previa"));
    await esperarAcciones();
    expect(d.querySelector("[data-testid=sr-error]")!.textContent).toContain("Faltan columnas obligatorias");
  });

  it("el semáforo y su texto de umbrales salen de la configuración que devuelve el API", async () => {
    const base = await respuestaBase<CuadreSrVista>("/softrestaurant/cuadre");
    const con = { ...base, umbrales: { verdePct: 0.5, ambarPct: 5, verdeCentavos: 2000 }, filas: [{ propertyId: IDS.T2, nombre: "Francisco de Montejo", diaNegocio: "2026-09-21", nuestroDomicilioCentavos: 100_000, nuestroPedidos: 4, srDomicilioCentavos: 100_500, srTickets: 4, diferenciaCentavos: -500, diferenciaPct: 0.5, diferenciaPedidos: 0, semaforo: "verde" as const }], porSucursal: [] };
    await b.pintar(CfoSoftRestaurant, crearApiCfo({ "GET /softrestaurant/cuadre": { status: 200, cuerpo: con } }));
    await cargado();
    expect(b.q("[data-testid=cuadre-umbrales]")!.textContent).toMatch(/0\.5 % o menos y de \$20 o menos.*5 %/);
    expect(b.q("tr[data-semaforo=verde]")).not.toBeNull();
    expect(b.q("tr[data-dia='2026-09-21']")!.textContent).toContain("−$5.00");
  });

  it("«Ajustar umbrales» abre los Ajustes con los tres umbrales del cuadre, en pesos, y guarda solo lo que cambió (en centavos)", async () => {
    const api = crearApiCfo();
    await b.pintar(CfoSoftRestaurant, api);
    await cargado();
    const d0 = await abrirDialogo();
    changeValue(selector(d0, "sr-sucursal"), IDS.T2);
    await elegirArchivo(d0.querySelector<HTMLInputElement>("#sr-archivo")!, new File([CSV_SR_SINTETICO], "r.csv", { type: "text/csv" }));
    click(botonDe(d0, "Revisar vista previa"));
    await esperarAcciones();
    click(botonDe(d0, "Importar "));
    await esperarAcciones();
    click(botonDe(d0, "Cerrar"));
    await b.esperar(() => b.q("[data-testid=cuadre-umbrales-abrir]") !== null, "cuadre");
    click(b.q("[data-testid=cuadre-umbrales-abrir]")!);
    await b.esperar(() => b.dialogo()?.querySelector("[data-testid=ajuste-srCuadreVerdeCentavos]") != null, "ajustes del cuadre");
    const d = b.dialogo()!;
    expect(d.textContent).toContain("Cuadre con SoftRestaurant (domicilio)");
    expect((d.querySelector("[data-testid=ajuste-srCuadreVerdeCentavos]") as HTMLInputElement).value).toBe("50");
    changeValue(d.querySelector("[data-testid=ajuste-srCuadreVerdeCentavos]") as HTMLInputElement, "80.50");
    changeValue(d.querySelector("[data-testid=ajuste-srCuadreVerdePct]") as HTMLInputElement, "2");
    changeValue(d.querySelector("[data-testid=ajuste-srCuadreAmbarPct]") as HTMLInputElement, "4");
    click(botonDe(d, "Guardar 3 cambios"));
    await esperarAcciones();
    expect(api.peticiones("PUT", "/config")[0]!.cuerpo).toEqual({ srCuadreVerdePct: 2, srCuadreAmbarPct: 4, srCuadreVerdeCentavos: 8050 });
  });

  it("estados por bloque: un bloque que falla no tumba a los otros", async () => {
    await b.pintar(CfoSoftRestaurant, crearApiCfo({ "GET /softrestaurant/lotes": { status: 500, cuerpo: { message: "Falló lotes." } } }));
    await b.esperar(() => b.texto().includes("Falló lotes."), "lotes con error");
    expect(b.q("[data-testid=sr-comandas]")).not.toBeNull();
    expect(b.texto()).toContain(TITULO_SIN_SR);
    b.desmontar();
    await b.pintar(CfoSoftRestaurant, crearApiCfo({ "GET /softrestaurant/cuadre": { status: 403 }, "GET /operacion": { status: 503 } }));
    await b.esperar(() => b.texto().includes("Tu rol no tiene acceso al CFO") && b.texto().includes("El CFO aún no está disponible"), "403 y 503");
  });

  it("el cliente apunta a las rutas /softrestaurant/* de CFO-05", async () => {
    const api = crearApiCfo();
    await b.pintar(CfoSoftRestaurant, api);
    await cargado();
    expect(api.peticiones("GET", "/softrestaurant/cuadre").length).toBe(1);
    expect(api.peticiones("GET", "/softrestaurant/lotes").length).toBe(1);
    expect(BASE_CFO).toContain("/admin/cfo");
  });
});
