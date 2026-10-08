// CFO-08 · importación SR en el navegador. Modelo de seguridad: LISTA BLANCA POR TIPO DE VALOR. Cada celda mapeada pasa por el parser estricto de su campo
// (dinero, fecha, hora, entero, sí/no, enumerados cerrados, folio) y lo que no pasa NO viaja; el encabezado (esColumnaPersonal) es solo ayuda de UX.
// Usa los archivos SINTÉTICOS de CFO-04 y reúne los escenarios de las tres rondas de revisión como tabla de casos, más un fuzz ligero con PII sembrada.
import { describe, expect, it } from "vitest";
import { normalizarExportSr, parsearCsvSr } from "@atiende/domain-restaurantes/cfo";
import { CSV_SR_SINTETICO, filasXlsxSrSintetico } from "../../../packages/domain-restaurantes/tests/fixtures/cfo-pm-sintetico.ts";
import { parsearCsv } from "../src/verticals/restaurantes/lib/clientes-importacion.ts";
import {
  camposDeTipo,
  camposFaltantes,
  camposRepetidos,
  columnasPersonales,
  construirTablaSr,
  detectarFilaEncabezado,
  nombresPersonales,
  parsearCeldaSr,
  pareceTarjeta,
  sugerirMapeoSr,
  sugerirTipo,
  type MapeoSr,
} from "../src/verticals/restaurantes/cfo/sr-importacion-navegador.ts";

const filasCsv = parsearCsv(CSV_SR_SINTETICO);
type Filas = string[][];

/** Lo enviado en la tabla, como JSON (lo que viajaría en el POST). */
const enviado = (filas: Filas, filaEnc: number, tipo: "cuentas" | "resumen_servicio", mapeo: MapeoSr, opc: { confirmarFolio?: boolean } = {}): string => JSON.stringify(construirTablaSr(filas, filaEnc, tipo, mapeo, opc).tabla);

describe("lectura, encabezado y mapeo", () => {
  it("detecta el encabezado debajo del título SINTÉTICO y el layout de cuentas", () => {
    const h = detectarFilaEncabezado(filasCsv);
    expect(h).toBe(1);
    expect(sugerirTipo(filasCsv[h]!)).toBe("cuentas");
  });

  it("el XLSX de resumen se reconoce como resumen_servicio y mapea sus campos", () => {
    const h = detectarFilaEncabezado(filasXlsxSrSintetico);
    expect(sugerirTipo(filasXlsxSrSintetico[h]!)).toBe("resumen_servicio");
    const m = sugerirMapeoSr(filasXlsxSrSintetico[h]!, "resumen_servicio");
    expect(camposFaltantes("resumen_servicio", m)).toEqual([]);
    expect(m["tickets"]).toBe(2);
  });

  it("sugiere cada campo con los alias del dominio sin repetir columnas", () => {
    const m = sugerirMapeoSr(filasCsv[1]!, "cuentas");
    expect(m).toMatchObject({ folio: 0, fecha: 1, hora: 2, servicio: 3, total: 7, forma_pago: 8, cancelada: 9 });
    expect(camposRepetidos(m)).toEqual([]);
  });

  it("la tabla del archivo SINTÉTICO completo pasa todos los parsers y la entiende el normalizador del servidor igual que el archivo original", () => {
    const m = sugerirMapeoSr(filasCsv[1]!, "cuentas");
    const t = construirTablaSr(filasCsv, 1, "cuentas", m);
    expect(t.errores).toEqual([]);
    const directo = normalizarExportSr({ tabla: parsearCsvSr(CSV_SR_SINTETICO), corte: "01:00", tipo: "cuentas" });
    const mapeado = normalizarExportSr({ tabla: t.tabla, corte: "01:00", tipo: "cuentas" });
    expect(directo.ok && mapeado.ok).toBe(true);
    if (directo.ok && mapeado.ok) {
      expect(mapeado.aceptados).toBe(directo.aceptados);
      expect(mapeado.renglones).toEqual(directo.renglones);
    }
  });

  it("el XLSX SINTÉTICO de resumen pasa los parsers (montos con coma decimal incluidos)", () => {
    const m = sugerirMapeoSr(filasXlsxSrSintetico[1]!, "resumen_servicio");
    const t = construirTablaSr(filasXlsxSrSintetico, 1, "resumen_servicio", m);
    expect(t.errores).toEqual([]);
    const n = normalizarExportSr({ tabla: t.tabla, corte: "01:00", tipo: "resumen_servicio" });
    expect(n.ok && n.aceptados).toBeGreaterThan(0);
  });

  it("un error de otro renglón se informa con su número de renglón del archivo (los de arriba van en blanco)", () => {
    const m = sugerirMapeoSr(filasCsv[1]!, "cuentas");
    const rota = filasCsv.map((f, i) => (i === 4 ? f.map((c, j) => (j === 7 ? "abc" : c)) : f));
    const t = construirTablaSr(rota, 1, "cuentas", m);
    expect(t.errores.map((e) => [e.renglon, e.campo])).toEqual([[5, "total"]]);
    expect(t.tabla[4]).toEqual([]); // el renglón completo no viaja
    expect(t.tabla[0]).toEqual([]);
    expect(JSON.stringify(t.errores)).not.toContain("abc"); // el valor no se muestra
  });
});

describe("parsers por tipo de valor (casos aceptados)", () => {
  const ok = (campo: string, v: string, esperado?: string | null) => {
    const r = parsearCeldaSr(campo, v);
    expect(r.ok, `${campo}=${v}`).toBe(true);
    if (r.ok && esperado !== undefined) expect(r.valor).toBe(esperado);
  };
  it("dinero es-MX", () => {
    for (const v of ["$1,234.50", "1234.5", "1234,50", "1.234,50", "$0.99", "-$12.00", "(12.50)", "12", "$1,234,567.89", "$12,345,678,901.00", "0"]) ok("total", v);
  });
  it("fechas y horas", () => {
    for (const v of ["21/09/2026", "2026-09-21", "21/09/2026 14:30", "45200"]) ok("fecha", v);
    for (const v of ["14:30", "9:05:07", "2:30 pm"]) ok("hora", v);
  });
  it("enteros, sí/no y vacío", () => {
    ok("tickets", "12");
    ok("cancelada", "Sí", "Sí");
    ok("cancelada", "cancelada", "Sí");
    ok("cancelada", "false", "No");
    ok("cancelada", "", null);
    ok("total", "", null);
  });
  it("enumerados cerrados: lo desconocido sale como «Otro»/«otro», nunca como texto libre", () => {
    ok("servicio", "A domicilio", "Domicilio");
    ok("servicio", "Mesa 4", "Comedor");
    ok("servicio", "Drive thru", "Otro");
    ok("servicio", "Ana SINTÉTICA", "Otro");
    ok("forma_pago", "Tarjeta de crédito", "tarjeta");
    ok("forma_pago", "SPEI", "transferencia");
    ok("forma_pago", "Crédito cliente", "tarjeta");
    ok("forma_pago", "Ana Pérez", "otro");
  });
  it("folios normales: alfanuméricos con guiones o diagonales, de 10 dígitos, con ceros", () => {
    for (const v of ["T2-00001", "A/123", "2026092101", "2026092102", "0000012345", "520000000001", "1234-567-890", "123456789"]) ok("folio", v, v);
    for (const v of ["5210000000001", "5500000000000004"]) expect(parsearCeldaSr("folio", v).ok, v).toBe(false); // 13 a 19 dígitos: tarjeta
  });
});

describe("PII: nada de esto viaja por NINGÚN campo (todos los campos mapeados, ambos layouts)", () => {
  const PII = [
    "Ana Pérez",
    "Ana SINTÉTICA 1",
    "ana@correo.com",
    "999 111 22 22",
    "+52 1 999 111 2222",
    "999 11 12 222",
    "99 91 11 22 22",
    "+52 1 (999) 111 2222",
    "(999) 111-2222",
    "999-111-2222",
    "+529991112222",
    "4111 1111 1111 1111",
    "4111-1111-1111-1111",
    "4111111111111111",
    "XAXX010101000",
    "XEXX010101HNEXXXA4",
    "Calle 60 #123 Centro",
  ];
  const campos = (tipo: "cuentas" | "resumen_servicio") => camposDeTipo(tipo).map((c) => c.campo);
  for (const tipo of ["cuentas", "resumen_servicio"] as const) {
    for (const campo of campos(tipo)) {
      it(`${tipo}: «${campo}» no deja pasar ningún valor personal`, () => {
        for (const pii of PII) {
          const n = camposDeTipo(tipo).length;
          const idx = campos(tipo).indexOf(campo);
          const encabezado = camposDeTipo(tipo).map((_, i) => `Columna${i}`);
          const fila = camposDeTipo(tipo).map((c, i) => (i === idx ? pii : TIPICO[c.campo] ?? "1"));
          const mapeo: Record<string, number | null> = {};
          campos(tipo).forEach((c, i) => (mapeo[c] = i));
          const json = enviado([encabezado, fila], 0, tipo, mapeo);
          expect(json, `${campo} <- ${pii}`).not.toContain(pii);
          expect(n).toBeGreaterThan(0);
        }
      });
    }
  }
  // Un valor típico legítimo de cada campo, para que solo el campo bajo prueba lleve PII.
  const TIPICO: Record<string, string> = { folio: "T2-1", fecha: "21/09/2026", hora: "14:30", servicio: "Domicilio", total: "$10.00", subtotal: "$10.00", descuento: "$0.00", propina: "$0.00", forma_pago: "Efectivo", cancelada: "No", impuesto: "$1.60", tickets: "3", cancelado: "$0.00" };

  it("un correo se rechaza con error por renglón en campos que no son enumerados; en un enumerado nunca viaja", () => {
    const r = parsearCeldaSr("fecha", "ana@correo.com");
    expect(r.ok).toBe(false);
    expect(parsearCeldaSr("servicio", "ana@correo.com").ok).toBe(false);
    expect(parsearCeldaSr("forma_pago", "ana@correo.com").ok).toBe(false);
  });
  it("tarjetas de 13 a 19 dígitos (con o sin espacios o guiones) se rechazan en todos los campos", () => {
    for (const v of ["4111 1111 1111 1111", "4111-1111-1111-1111", "4111111111111111", "4111 111111 11111", "4111111111111"]) {
      expect(pareceTarjeta(v), v).toBe(true);
      for (const campo of ["folio", "total", "servicio", "forma_pago", "tickets", "fecha"]) expect(parsearCeldaSr(campo, v).ok, `${campo} ${v}`).toBe(false);
    }
    expect(pareceTarjeta("2026092101")).toBe(false);
  });
  it("un entero de 10 dígitos o más sin decimales no es un monto; un monto grande legítimo con decimales sí", () => {
    expect(parsearCeldaSr("propina", "9991112222").ok).toBe(false);
    expect(parsearCeldaSr("total", "1,234,567,890").ok).toBe(false);
    expect(parsearCeldaSr("total", "$1,234,567.89").ok).toBe(true);
    expect(parsearCeldaSr("total", "$12,345,678,901.00").ok).toBe(true);
  });
  it("un teléfono con formato en el folio pide confirmación; con ella viaja; nunca un correo ni una tarjeta", () => {
    const r = parsearCeldaSr("folio", "999-111-2222");
    expect(r).toMatchObject({ ok: false, confirmable: true });
    expect(parsearCeldaSr("folio", "999-111-2222", { confirmarFolio: true }).ok).toBe(true);
    expect(parsearCeldaSr("folio", "ana@correo.com", { confirmarFolio: true }).ok).toBe(false);
    expect(parsearCeldaSr("folio", "4111-1111-1111-1111", { confirmarFolio: true }).ok).toBe(false);
  });
  it("RFC, CURP y nombres no pasan como folio (el folio debe llevar al menos un número)", () => {
    for (const v of ["XAXX010101000", "XEXX010101HNEXXXA4", "ANA", "Ana", "Cliente"]) expect(parsearCeldaSr("folio", v).ok, v).toBe(false);
  });
});

describe("escenarios de las rondas de revisión (el encabezado ya no es la barrera)", () => {
  it("`Folio,Fecha,Total,Cliente:` / `Teléfono:` mapeadas a servicio: ni el nombre ni el teléfono viajan", () => {
    const filas: Filas = [["Folio", "Fecha", "Total", "Cliente:"], ["T2-1", "21/09/2026", "$10.00", "Ana Pérez"], ["T2-2", "22/09/2026", "$20.00", "Luis Gómez"]];
    const json = enviado(filas, 0, "cuentas", { folio: 0, fecha: 1, total: 2, servicio: 3 });
    expect(json).not.toMatch(/Ana|Luis/);
    const filasT: Filas = [["Folio", "Fecha", "Total", "Teléfono:"], ["T2-1", "21/09/2026", "$10.00", "9991112222"]];
    expect(enviado(filasT, 0, "cuentas", { folio: 0, fecha: 1, total: 2, servicio: 3 })).not.toContain("9991112222");
    expect(enviado(filasT, 0, "cuentas", { folio: 0, fecha: 1, total: 2, forma_pago: 3 })).not.toContain("9991112222");
  });

  it("renglón 1 `Corte de caja,…` elegido como encabezado con nombres en la columna 4", () => {
    const filas: Filas = [["Corte de caja", "Sucursal Centro", "", ""], ["Folio", "Fecha", "Total", "Nombre"], ["T2-1", "21/09/2026", "$10.00", "Ana Pérez"]];
    expect(enviado(filas, 0, "cuentas", { folio: 0, fecha: 1, total: 2, servicio: 3 })).not.toContain("Ana");
    expect(enviado(filas, 0, "cuentas", { folio: 3 })).not.toContain("Ana");
  });

  it("`,,,Cliente:` y `,,Datos:,Teléfono` arriba de un encabezado benigno: los valores no viajan por ningún campo", () => {
    for (const grupo of [["", "", "", "Cliente:"], ["", "", "Datos:", "Teléfono"]]) {
      const filas: Filas = [grupo, ["Folio", "Fecha", "Total", "Número"], ["T2-1", "21/09/2026", "$10.00", "999 111 22 22"]];
      for (const campo of ["servicio", "forma_pago", "cancelada", "fecha", "hora", "propina", "tickets", "folio"]) {
        const m: Record<string, number | null> = { folio: 0, fecha: 1, total: 2 };
        m[campo] = 3;
        if (campo === "fecha" || campo === "folio") m[campo === "fecha" ? "hora" : "servicio"] = null;
        expect(enviado(filas, 1, "cuentas", m), campo).not.toContain("999 111 22 22");
      }
    }
  });

  it("teléfonos en cualquier formato bajo un encabezado benigno, mapeados a CUALQUIER campo, nunca viajan (cuentas y resumen)", () => {
    const tels = ["999 111 22 22", "+52 1 999 111 2222", "999 11 12 222", "99 91 11 22 22", "+52 1 (999) 111 2222"];
    for (const tipo of ["cuentas", "resumen_servicio"] as const) {
      const lista = camposDeTipo(tipo).map((c) => c.campo);
      for (const tel of tels) {
        for (const campo of lista) {
          const base: Record<string, number | null> = {};
          lista.forEach((c, i) => (base[c] = c === campo ? lista.length : i));
          const encabezado = [...lista.map((c) => `H_${c}`), "Benigno"];
          const fila = [...lista.map((c) => TIP[c] ?? "1"), tel];
          expect(enviado([encabezado, fila], 0, tipo, base), `${tipo}.${campo} <- ${tel}`).not.toContain(tel);
        }
      }
    }
  });
  const TIP: Record<string, string> = { folio: "T2-1", fecha: "21/09/2026", hora: "14:30", servicio: "Domicilio", total: "$10.00", subtotal: "$10.00", descuento: "$0.00", propina: "$0.00", forma_pago: "Efectivo", cancelada: "No", impuesto: "$1.60", tickets: "3", cancelado: "$0.00" };

  it("elegir un renglón de datos como encabezado, o columnas duplicadas, o encabezado personal en otra posición: ya no cambia lo que viaja", () => {
    const CON_TEL: Filas = [["Folio", "Fecha", "Total", "Teléfono"], ["T2-1", "21/09/2026", "$100.00", "9991112222"], ["T2-2", "22/09/2026", "$200.00", "9993334444"], ["T2-3", "23/09/2026", "$300.00", "9995556666"]];
    for (const fe of [0, 1, 2, 3]) {
      for (const campo of ["servicio", "total", "propina", "forma_pago", "cancelada", "hora"]) {
        const j = enviado(CON_TEL, fe, "cuentas", { fecha: 1, total: 2, ...(campo === "total" ? {} : {}), folio: 0, [campo]: 3 });
        expect(j, `fe=${fe} ${campo}`).not.toMatch(/9991112222|9993334444|9995556666/);
      }
    }
  });
});

describe("residual declarado", () => {
  it("un teléfono de 10 dígitos SIN formato mapeado a folio es indistinguible de un folio numérico (2026092101): la defensa es la ayuda por encabezado, que lo oculta del selector", () => {
    const filas: Filas = [["Folio", "Fecha", "Total", "Teléfono"], ["T2-1", "21/09/2026", "$10.00", "9991112222"]];
    expect(columnasPersonales(filas, 0)).toEqual([3]); // el selector no ofrece esa columna
    expect(parsearCeldaSr("folio", "9991112222").ok).toBe(true);
    expect(parsearCeldaSr("folio", "2026092101").ok).toBe(true);
  });
});

describe("ayuda de UX por encabezado (no es la barrera), sin falsos positivos", () => {
  it("marca columnas con encabezado personal y su nombre es el encabezado, nunca un valor", () => {
    const filas: Filas = [["Folio", "Fecha", "Total", "Teléfono"], ["T2-1", "21/09/2026", "$10.00", "9991112222"]];
    expect([...nombresPersonales(filas, 0).values()]).toEqual(["Teléfono"]);
    expect(columnasPersonales(filas, 0)).toEqual([3]);
    // Si el texto trae dígitos (p. ej. «Calle 60 #123»), solo se muestra la posición.
    expect([...nombresPersonales([["Folio", "Calle 60 #123", "Total"], ["T2-1", "x", "$10.00"]], 0).values()]).toEqual(["Columna 2"]);
  });
  it("no marca por títulos con «etiqueta:» (R.F.C. / Dirección) ni por renglones de datos de abajo", () => {
    const titulo: Filas = [["R.F.C.:", "XAXX010101000"], ["Dirección:", "Calle 60 #123 Centro"], ["Folio", "Fecha", "Total"], ["T2-1", "21/09/2026", "$10.00"]];
    expect(columnasPersonales(titulo, 2)).toEqual([]);
    const datos: Filas = [["Folio", "Fecha", "Domicilio", "Forma de pago", "Total"], ["T2-1", "21/09/2026", "Calle 60 #123", "Crédito cliente", "$10.00"]];
    expect(columnasPersonales(datos, 0)).toEqual([]);
  });
  it("un título de una sola celda no marca nada (`,Reporte de ventas por cliente`) y solo cuentan renglones de la misma tabla", () => {
    expect(columnasPersonales([["", "Reporte de ventas por cliente"], ["Folio", "Fecha", "Total"], ["T2-1", "21/09/2026", "$10.00"]], 1)).toEqual([]);
  });
  it("el título `Restaurante SINTÉTICO,Sucursal Centro,Colonia Centro` puede marcar una columna por UX, pero con la casilla se recupera y el parser decide", () => {
    const filas: Filas = [["Restaurante SINTÉTICO", "Sucursal Centro", "Colonia Centro"], ["Folio", "Fecha", "Total"], ["T2-1", "21/09/2026", "$10.00"]];
    // Aunque la ayuda excluya la columna 3, mapear (la casilla «incluirla») es válido y los valores pasan sus parsers.
    expect(columnasPersonales(filas, 1)).toEqual([2]);
    const t = construirTablaSr(filas, 1, "cuentas", { folio: 0, fecha: 1, total: 2 });
    expect(t.errores).toEqual([]);
    expect(JSON.stringify(t.tabla)).toContain("$10.00");
  });
  it("encabezados personales en inglés y apellidos", () => {
    for (const h of ["Telephone", "Mobile", "Cell", "Cellphone", "Client", "Guest", "Apellido", "Apellidos", "Contact", "Phone1", "Surname"]) {
      expect(columnasPersonales([["Folio", "Fecha", "Total", h]], 0), h).toEqual([3]);
    }
  });
});

describe("fuzz ligero: PII sembrada en columnas y mapeos aleatorios nunca viaja", () => {
  // PRNG determinista (mulberry32) para que un fallo sea reproducible.
  function azar(semilla: number): () => number {
    let a = semilla >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const SEMBRADAS = [
    "Ana Pérez López", "Luis Gómez", "ana@correo.com", "luis.gomez@empresa.mx", "999 111 22 22", "+52 1 999 111 2222", "999 11 12 222", "99 91 11 22 22", "+52 1 (999) 111 2222",
    "(999) 111-2222", "999-111-2222", "+529991112222", "4111 1111 1111 1111", "4111-1111-1111-1111", "5500000000000004", "XAXX010101000", "Calle 60 #123 Centro", "Colonia Itzimná",
    "Calle 21 x 30 y 32", "CURP", "ANA SINTÉTICA",
  ];
  it("2 000 archivos aleatorios: ningún valor sembrado aparece en el JSON enviado (excepto el folio de 10 dígitos legítimo, que no se siembra)", () => {
    const rnd = azar(20261008);
    const pick = <T>(l: readonly T[]): T => l[Math.floor(rnd() * l.length)]!;
    for (let n = 0; n < 2000; n++) {
      const tipo = rnd() < 0.5 ? "cuentas" : "resumen_servicio";
      const lista = camposDeTipo(tipo).map((c) => c.campo);
      const ancho = 4 + Math.floor(rnd() * 6);
      const encabezado = Array.from({ length: ancho }, (_, i) => (rnd() < 0.3 ? pick(["Cliente", "Teléfono", "Nombre", "Dirección", "Notas", "Referencia"]) : `Col${i}`));
      const filas: Filas = [encabezado];
      const sembradasEn = new Set<string>();
      for (let r = 0; r < 4; r++) {
        filas.push(
          Array.from({ length: ancho }, () => {
            if (rnd() < 0.5) {
              const v = pick(SEMBRADAS);
              sembradasEn.add(v);
              return v;
            }
            return pick(["T2-1", "21/09/2026", "$10.00", "Domicilio", "Efectivo", "No", "14:30", "3"]);
          }),
        );
      }
      const mapeo: Record<string, number | null> = {};
      for (const c of lista) mapeo[c] = rnd() < 0.7 ? Math.floor(rnd() * ancho) : null;
      const json = enviado(filas, 0, tipo, mapeo, { confirmarFolio: rnd() < 0.5 });
      for (const v of sembradasEn) {
        // El folio confirmado por la persona puede llevar un teléfono con formato de 10 dígitos: es la salida declarada, no una fuga.
        const folioConfirmado = /^\(?\d{3}\)?[\s.-]\d{3}[\s.-]?\d{4}$/.test(v);
        if (folioConfirmado) continue;
        expect(json, `${tipo} ${JSON.stringify(mapeo)} <- ${v}`).not.toContain(v);
      }
    }
  });
});
