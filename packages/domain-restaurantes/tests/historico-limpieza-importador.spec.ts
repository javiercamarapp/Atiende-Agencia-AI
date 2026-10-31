// Historial importado: lector CSV/JSON, colonias, limpieza, plan idempotente y reporte sin PII. TODO con datos sinteticos.
import { describe, expect, it } from "vitest";
import { ArchivoHistoricoInvalidoError, parsearArchivoHistorico, parsearCsvHistorico } from "../src/historico/csv.ts";
import { crearCatalogoColonias, inferirColoniaDeDireccion, normalizarColonia } from "../src/historico/colonias.ts";
import { categoriaQueja, fechaDia, limpiarArchivoHistorico, limpiarFilaHistorica, numero } from "../src/historico/limpieza.ts";
import { PuertoHistoricoMemoria, agregarPedidosACliente, construirReporte, importarHistorial, planificarImportacion, reporteMarkdown } from "../src/historico/importador.ts";

const ORG = "00000000-0000-0000-0000-00000000aa01";
const CSV = [
  "celular,nombre,direccion,colonia,entrega_habitual,pago,preferencias,favoritos,pedidos,gasto_piso_mxn,ticket_mxn,primer_pedido,ultimo_pedido,estado,quejas,duplicado_con,calidad_dato",
  '+5219990000001,Cliente Ejemplo A,"Calle 10 x 11, Col. Montebello",,domicilio,efectivo,tortilla:maiz;salsa:verde;omision:cebolla,"bistec;pastor",8,1600,200,2026-01-05,2026-10-20,activo,demora;salsas,,',
  "+529990000002,,,,recoger,tarjeta,,pastor,1,150,150,2026-09-01,2026-09-01,n/a,,,",
  "99900000033,Telefono Largo,,,,,,,,,,,,,,,",
  "+52 999 000 0004,Cliente Ejemplo D,Calle 20 numero 5,,domicilio,,,,3,900,300,15/02/2026,01/05/2026,queja_abierta,cobro,+529990000001,posible_duplicado",
  "9990000001,Repetido,,,,,,,,,,,,,,,",
].join("\n");

describe("csv", () => {
  it("parsea comillas, BOM, punto y coma y normaliza encabezados", () => {
    const f = parsearCsvHistorico("﻿Celular;Nombre\r\n9990000001;\"Ana; \"\"la\"\" Prueba\"\r\n");
    expect(f).toEqual([{ celular: "9990000001", nombre: 'Ana; "la" Prueba' }]);
  });
  it("rechaza comillas sin cerrar y encabezados repetidos", () => {
    expect(() => parsearCsvHistorico('a,b\n"x,1')).toThrow(ArchivoHistoricoInvalidoError);
    expect(() => parsearCsvHistorico("a,a\n1,2")).toThrow(ArchivoHistoricoInvalidoError);
  });
  it("detecta JSON (arreglo u objeto con filas) y normaliza llaves", () => {
    expect(parsearArchivoHistorico('[{"Celular":"9990000001"}]')).toEqual([{ celular: "9990000001" }]);
    expect(parsearArchivoHistorico('{"clientes":[{"Gasto Piso MXN":5}]}')).toEqual([{ gasto_piso_mxn: 5 }]);
    expect(() => parsearArchivoHistorico("[1,")).toThrow(ArchivoHistoricoInvalidoError);
    expect(() => parsearArchivoHistorico('{"x":1}')).toThrow(ArchivoHistoricoInvalidoError);
  });
});

describe("colonias", () => {
  it("marcador explicito, segmento propio, coincidencia y ambiguedad", () => {
    expect(inferirColoniaDeDireccion("Calle 10 x 11, Col. Montebello")).toMatchObject({ colonia: "Montebello", metodo: "marcador_catalogo", confianza: "alta" });
    expect(inferirColoniaDeDireccion("Calle 60 x 21, Centro, Merida")).toMatchObject({ colonia: "Centro", metodo: "segmento_catalogo", confianza: "alta" });
    expect(inferirColoniaDeDireccion("calle 30 numero 4 garcia gineres")).toMatchObject({ colonia: "García Ginerés", confianza: "media" });
    expect(inferirColoniaDeDireccion("Calle 5 Altabrisa y Cholul")).toMatchObject({ colonia: null, metodo: "ambigua" });
  });
  it("una calle con nombre de colonia o un nombre debil suelto NO cuenta", () => {
    expect(inferirColoniaDeDireccion("Calle Montebello 123").colonia).toBeNull();
    expect(inferirColoniaDeDireccion("Calle 50 mexico 12").colonia).toBeNull();
    expect(inferirColoniaDeDireccion("").colonia).toBeNull();
  });
  it("el catalogo es configurable y normalizarColonia corrige a 1 letra o conserva texto libre", () => {
    const cat = crearCatalogoColonias([{ nombre: "Colonia Sintetica Norte", alias: ["csn"] }]);
    expect(inferirColoniaDeDireccion("Calle 1, csn", cat).colonia).toBe("Colonia Sintetica Norte");
    expect(normalizarColonia("Montebelo").colonia).toBe("Montebello");
    expect(normalizarColonia("Lugar Desconocido")).toMatchObject({ colonia: "Lugar Desconocido", metodo: "marcador_libre" });
  });
});

describe("limpieza", () => {
  it("telefonos: +521, +52 y 10 digitos pasan; 11 digitos, vacios y objetos invalidos se rechazan sin recortar", () => {
    const ok = (t: string) => limpiarFilaHistorica({ celular: t }, 1);
    for (const t of ["+5219990000001", "+529990000001", "9990000001", "(999) 000-0001"]) expect(ok(t)).toMatchObject({ ok: true, cliente: { telefono: "9990000001" } });
    expect(ok("99900000011")).toMatchObject({ ok: false, rechazo: { motivo: "telefono_invalido", telefonoMascara: "*******0011" } });
    expect(limpiarFilaHistorica({}, 2)).toMatchObject({ ok: false, rechazo: { motivo: "telefono_faltante" } });
    expect(limpiarFilaHistorica("x", 3)).toMatchObject({ ok: false, rechazo: { motivo: "fila_invalida" } });
  });
  it("banderas, preferencias, colonia inferida y queja abierta", () => {
    const [a, b, , d] = parsearArchivoHistorico(CSV).map((r, i) => limpiarFilaHistorica(r, i + 1));
    expect(a).toMatchObject({ ok: true, cliente: { nombre: "Cliente Ejemplo A", colonia: "Montebello", tortilla: "maiz", salsas: ["verde"], omisiones: ["cebolla"], favoritos: ["bistec", "pastor"], quejas: ["demora", "salsas"] } });
    expect(a!.ok && a!.cliente.banderas).toContain("colonia_inferida_alta");
    expect(b!.ok && b!.cliente.banderas).toEqual(["sin_nombre"]);
    expect(d!.ok && d!.cliente).toMatchObject({ estado: "queja_abierta", primerPedido: "2026-02-15", ultimoPedido: "2026-05-01", duplicadoCon: ["9990000001"] });
    expect(d!.ok && d!.cliente.banderas).toEqual(expect.arrayContaining(["revision_humana", "posible_duplicado", "colonia_pendiente_pedir_ubicacion"]));
  });
  it("domicilio sin direccion, fechas invalidas/invertidas y numeros sucios se marcan, no se inventan", () => {
    const r = limpiarFilaHistorica({ celular: "9990000009", entrega_habitual: "domicilio", pedidos: "2.5", gasto_piso_mxn: "-3", primer_pedido: "2026-03-01", ultimo_pedido: "2026-02-01" }, 1);
    expect(r.ok && r.cliente.banderas).toEqual(expect.arrayContaining(["domicilio_sin_direccion", "pedidos_invalido", "gasto_invalido", "fechas_invertidas"]));
    expect(r.ok && r.cliente).toMatchObject({ pedidos: 2, gastoMxn: 0, primerPedido: "2026-02-01", ultimoPedido: "2026-03-01" });
    expect(fechaDia("2026-02-30")).toBeNull();
    expect(numero("$1,234.50")).toBe(1234.5);
  });
  it("la queja guarda solo la categoria (nunca el texto libre)", () => {
    expect(categoriaQueja("tardaron mucho en llegar")).toBe("demora");
    const r = limpiarFilaHistorica({ celular: "9990000001", quejas: "el repartidor Juan Perez fue grosero" }, 1);
    expect(r.ok && r.cliente.quejas).toEqual(["otra"]);
    expect(JSON.stringify(r)).not.toContain("Juan");
  });
  it("la huella es estable ante el orden y cambia con el contenido; telefono repetido en el archivo se rechaza", () => {
    const a = limpiarFilaHistorica({ celular: "9990000001", favoritos: "b;a" }, 1);
    const b = limpiarFilaHistorica({ celular: "9990000001", favoritos: "a;b" }, 99);
    const c = limpiarFilaHistorica({ celular: "9990000001", favoritos: "a;b;c" }, 1);
    expect(a.ok && b.ok && a.cliente.huella === b.cliente.huella).toBe(true);
    expect(a.ok && c.ok && a.cliente.huella !== c.cliente.huella).toBe(true);
    const lote = limpiarArchivoHistorico(parsearArchivoHistorico(CSV));
    expect(lote.clientes).toHaveLength(3);
    expect(lote.rechazos.map((x) => x.motivo)).toEqual(["telefono_invalido", "telefono_repetido_en_archivo"]);
  });
});

describe("importador", () => {
  it("vista previa por omision: 0 escrituras; aplicar crea; reaplicar da 0 creadas y todo sin cambio", async () => {
    const puerto = new PuertoHistoricoMemoria();
    const previa = await importarHistorial(ORG, CSV, puerto);
    expect(previa.reporte).toMatchObject({ modo: "vista_previa", filasLeidas: 5, validas: 3, rechazadas: 2, creadas: 3, conConsentimientoMarketing: 0, pedidosCreados: 0 });
    expect(puerto.escrituras).toBe(0);
    const aplicado = await importarHistorial(ORG, CSV, puerto, { aplicar: true });
    expect(aplicado.reporte).toMatchObject({ modo: "aplicado", creadas: 3, actualizadas: 0 });
    expect(puerto.escrituras).toBe(3);
    const otra = await importarHistorial(ORG, CSV, puerto, { aplicar: true });
    expect(otra.reporte).toMatchObject({ creadas: 0, actualizadas: 0, sinCambios: 3 });
    expect(puerto.escrituras).toBe(3);
  });
  it("un cambio en una fila la marca actualizar; un telefono suprimido (ARCO) no se reimporta", async () => {
    const puerto = new PuertoHistoricoMemoria();
    await importarHistorial(ORG, CSV, puerto, { aplicar: true });
    puerto.suprimidos.add("9990000002");
    const cambiado = CSV.replace(",8,1600,200,", ",9,1800,200,");
    const r = await importarHistorial(ORG, cambiado, puerto, { aplicar: true });
    expect(r.reporte).toMatchObject({ creadas: 0, actualizadas: 1, sinCambios: 1, suprimidas: 1 });
  });
  it("el reporte no contiene telefonos completos, nombres ni direcciones", async () => {
    const { reporte } = await importarHistorial(ORG, CSV, new PuertoHistoricoMemoria());
    const salida = JSON.stringify(reporte) + reporteMarkdown(reporte);
    expect(salida).not.toMatch(/\d{10}/);
    for (const prohibido of ["Cliente Ejemplo", "Montebello", "Calle 10", "Telefono Largo"]) expect(salida).not.toContain(prohibido);
    expect(reporte.paresDuplicados).toHaveLength(1);
    expect(reporte.paresDuplicados[0]).toMatch(/^\*+\d{4} ~ \*+\d{4}$/);
    expect(reporte.noImportado.length).toBeGreaterThan(0);
  });
  it("las colonias con menos de 5 clientes se agrupan en «otras»", () => {
    const { clientes, rechazos } = limpiarArchivoHistorico(parsearArchivoHistorico(CSV));
    const plan = planificarImportacion(clientes, rechazos, new Map(), "a".repeat(64));
    expect(construirReporte(plan, 5, "vista_previa").porColonia).toEqual({ otras: 3 });
  });
  it("acepta un arreglo ya parseado y pedidos sueltos se pliegan a agregados sin crear pedidos", () => {
    const { filas, descartados } = agregarPedidosACliente([
      { celular: "+529990000001", fecha: "2026-01-02", total: 100, producto: "pastor;bistec" },
      { celular: "9990000001", fecha: "2026-03-02", total: "300", producto: "pastor" },
      { celular: "123", fecha: "2026-03-02", total: 10 },
      { celular: "9990000002", fecha: "no", total: 10 },
    ]);
    expect(descartados).toBe(2);
    expect(filas).toEqual([{ celular: "9990000001", pedidos: 2, gasto_piso_mxn: 400, ticket_mxn: 200, primer_pedido: "2026-01-02", ultimo_pedido: "2026-03-02", favoritos: "pastor;bistec" }]);
  });
});
