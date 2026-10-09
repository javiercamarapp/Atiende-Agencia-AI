// Sanidad del guard global del DS v2: demuestra que CADA regla falla de verdad ante una violacion
// (un guard que nunca falla es peor que no tenerlo). Dos niveles: (1) por regla, un fixture que la
// viola debe ser detectado y su version corregida no; (2) de punta a punta, un arbol temporal con
// violaciones se escanea con el mismo cargador que usa el guard real.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { REGLAS, REGLAS_DELEGACION, cargarFuentes, infractores, sinComentarios, violacionesDelegacion, type Fuente } from "./test-utils/ds-v2-guard-reglas";

/** Por regla (clave = prefijo del nombre): codigo que la viola y codigo limpio equivalente. */
const CASOS: ReadonlyArray<{ regla: string; viola: string; limpio: string; ruta?: string }> = [
  { regla: "window.confirm", viola: 'if (window.confirm("Borrar?")) borrar();', limpio: "const confirmar = useConfirm();" },
  { regla: "window.confirm", viola: 'if (confirm("Borrar?")) borrar();', limpio: "await confirmar({ titulo: 'x' });" },
  { regla: "tamano de texto arbitrario", viola: '<p className="text-[13px]">x</p>', limpio: '<p className="text-sm">x</p>' },
  { regla: "paleta cruda", viola: '<p className="text-green-600">x</p>', limpio: '<p className="text-success">x</p>' },
  { regla: "paleta cruda", viola: '<div className="bg-white/80" />', limpio: '<div className="bg-card" />' },
  { regla: "color hexadecimal", viola: 'const c = "#ff00aa";', limpio: 'const c = "hsl(var(--primary))";' },
  { regla: "estilo inline", viola: "<div style={{ width: 3 }} />", limpio: '<div className="w-3" />' },
  { regla: "<select>", viola: "<select><option>a</option></select>", limpio: "<NativeSelect />" },
  { regla: "<textarea>", viola: "<textarea />", limpio: "<Textarea />" },
  { regla: "checkbox crudo", viola: '<input type="checkbox" />', limpio: "<Checkbox />" },
  { regla: "formatMoney local", viola: "function formatMoney(n: number) { return String(n); }", limpio: 'import { formatMoney } from "@atiende/ui";', ruta: "verticals/x/pages/Y.tsx" },
  { regla: "fmtMoney local", viola: "function fmtMoney(n: number) { return String(n); }", limpio: 'import { formatMoney } from "@atiende/ui";', ruta: "verticals/hoteles/pages/Y.tsx" },
  { regla: "fmtMoney local", viola: 'n.toLocaleString("es-MX", { minimumFractionDigits: 2 })', limpio: "formatMoney(n)", ruta: "verticals/hoteles/pages/Y.tsx" },
  { regla: "ModalFormularioLateral", viola: "<ModalFormularioLateral />", limpio: "<FormDialog />" },
  { regla: "<table>", viola: "<table><tr /></table>", limpio: "<DataTable />" },
  { regla: "<Badge>", viola: '<Badge className="x">a</Badge>', limpio: "<StatusBadge tone=\"success\">a</StatusBadge>" },
  { regla: "relleno interno p-6", viola: '<div className="flex p-6">x</div>', limpio: '<PageContainer className="flex">x</PageContainer>' },
  { regla: "tokens heredados", viola: '<div className="bg-gold" />', limpio: '<div className="bg-primary" />' },
  { regla: "tokens heredados", viola: '<div className="text-terracotta/80" />', limpio: '<div className="text-muted-foreground" />' },
  { regla: "tokens heredados", viola: '<div className="shadow-glow" />', limpio: '<div className="shadow-card" />' },
  { regla: "variantes de Button", viola: '<Button variant="hero">a</Button>', limpio: '<Button variant="default">a</Button>' },
  { regla: "variantes de Button", viola: "<Button variant={'gold'}>a</Button>", limpio: '<Button variant="outline">a</Button>' },
  { regla: "Table a mano en restaurantes", viola: "<Table><TableBody /></Table>", limpio: "<DataTable />", ruta: "verticals/restaurantes/pages/Y.tsx" },
  { regla: "Table a mano en listados de despachos", viola: "<Table><TableBody /></Table>", limpio: "<DataTable />", ruta: "verticals/despachos/pages/Cobranza.tsx" },
  { regla: "AlertDialog local en restaurantes", viola: "<AlertDialog open>x</AlertDialog>", limpio: "const { confirmar, dialogo } = useConfirm();", ruta: "verticals/restaurantes/pages/Y.tsx" },
  { regla: "Guardando a mano en restaurantes", viola: '<Button>{saving ? "Guardando…" : "Guardar"}</Button>', limpio: "<Button loading={saving}>Guardar</Button>", ruta: "verticals/restaurantes/pages/Y.tsx" },
  { regla: "primitivo Radix de overlay", viola: 'import * as D from "@radix-ui/react-dialog";', limpio: 'import { Dialog } from "@atiende/ui";' },
  { regla: "primitivo Radix de overlay", viola: "import { Root } from '@radix-ui/react-select';", limpio: 'import { Select } from "@atiende/ui";' },
  { regla: "sonner importado directo", viola: 'import { toast } from "sonner";', limpio: 'import { notify } from "@atiende/ui";' },
  { regla: "toast directo", viola: 'toast.success("Listo");', limpio: 'notify.success("Listo");', ruta: "verticals/restaurantes/pages/Y.tsx" },
  { regla: "toast directo", viola: 'import { toast } from "@atiende/ui";', limpio: 'import { notify } from "@atiende/ui";', ruta: "verticals/restaurantes/pages/Y.tsx" },
  { regla: "alert() nativo", viola: "alert(mensaje);", limpio: "notify.error(mensaje);" },
  { regla: "overlay a mano en restaurantes", viola: "<div role='dialog' />", limpio: "<FormDialog open />", ruta: "verticals/restaurantes/pages/Y.tsx" },
  { regla: "overlay a mano en restaurantes", viola: '<div role={"listbox"} />', limpio: "<Selector />", ruta: "verticals/restaurantes/pages/Y.tsx" },
  { regla: "alert() nativo", viola: 'window.alert("Listo");', limpio: 'notify.success("Listo");' },
  { regla: "alert() nativo", viola: '<div aria-modal="true" role="dialog" />', limpio: "<Dialog open />" },
  { regla: "overlay a mano en restaurantes", viola: '<div role="dialog" className="x" />', limpio: "<FormDialog open />", ruta: "verticals/restaurantes/pages/Y.tsx" },
  { regla: "overlay a mano en restaurantes", viola: '<div className="fixed inset-0 z-50" />', limpio: '<div className="relative" />', ruta: "verticals/restaurantes/components/Z.tsx" },
  { regla: "overlay a mano en restaurantes", viola: '<input list="x" /><datalist id="x" />', limpio: "<Selector />", ruta: "verticals/restaurantes/pages/Y.tsx" },
];

const porRegla = (prefijo: string) => {
  const r = REGLAS.find((x) => x.nombre.startsWith(prefijo));
  if (!r) throw new Error(`no existe la regla ${prefijo}`);
  return r;
};
const fuente = (codigo: string, ruta = "verticals/x/Archivo.tsx"): Fuente => ({ ruta, codigo: sinComentarios(codigo) });

describe("guard DS v2 — sanidad por regla (cada regla falla ante su violacion)", () => {
  it("todas las reglas tienen al menos un caso de sanidad", () => {
    const cubiertas = new Set(CASOS.map((c) => REGLAS.find((r) => r.nombre.startsWith(c.regla))?.nombre));
    expect(REGLAS.filter((r) => !cubiertas.has(r.nombre)).map((r) => r.nombre)).toEqual([]);
  });

  for (const c of CASOS) {
    it(`${c.regla}: detecta ${JSON.stringify(c.viola).slice(0, 50)} y deja pasar el codigo limpio`, () => {
      const regla = porRegla(c.regla);
      expect(infractores([fuente(c.viola, c.ruta)], regla)).toHaveLength(1);
      expect(infractores([fuente(c.limpio, c.ruta)], regla)).toEqual([]);
    });
  }

  it("las reglas de trinquete de restaurantes no aplican a otras zonas", () => {
    for (const prefijo of ["Table a mano en restaurantes", "AlertDialog local en restaurantes", "Guardando a mano en restaurantes", "overlay a mano en restaurantes", "toast directo en restaurantes"]) {
      expect(infractores([fuente("<Table /> <AlertDialog /> {'Guardando…'} <div role='dialog' /> <datalist />", "verticals/hoteles/pages/Y.tsx")], porRegla(prefijo))).toEqual([]);
    }
  });

  it("la regla de listados de despachos deja pasar las paginas de calculo, Dashboard y el portal, y atrapa cualquier otra", () => {
    const regla = porRegla("Table a mano en listados de despachos");
    for (const ruta of ["Bookkeeping", "DevolucionIva", "Declaraciones", "Nomina", "Reportes", "ContabilidadElectronica", "Conciliacion", "Dashboard"]) {
      expect(infractores([fuente("<Table />", `verticals/despachos/pages/${ruta}.tsx`)], regla)).toEqual([]);
    }
    expect(infractores([fuente("<Table />", "verticals/despachos/portal/PortalClientePage.tsx")], regla)).toEqual([]);
    for (const ruta of ["pages/Staff.tsx", "pages/NuevaPaginaListado.tsx", "components/Lista.tsx", "portal/OtraCosa.tsx"]) {
      expect(infractores([fuente("<Table />", `verticals/despachos/${ruta}`)], regla)).toHaveLength(1);
    }
    expect(infractores([fuente("<Table />", "verticals/hoteles/pages/Y.tsx")], regla)).toEqual([]);
  });

  it("WidgetWhatsApp (panel no modal): exento solo de aria-modal y del overlay a mano; en cualquier otro archivo las reglas aplican", () => {
    const panel = '<div role="dialog" aria-modal="false" />';
    const ruta = "verticals/restaurantes/preview/WidgetWhatsApp.tsx";
    expect(infractores([fuente(panel, ruta)], porRegla("alert() nativo"))).toEqual([]);
    expect(infractores([fuente(panel, ruta)], porRegla("overlay a mano en restaurantes"))).toEqual([]);
    expect(infractores([fuente(panel, "verticals/restaurantes/preview/Otro.tsx")], porRegla("alert() nativo"))).toHaveLength(1);
    expect(infractores([fuente(panel, "verticals/restaurantes/preview/Otro.tsx")], porRegla("overlay a mano en restaurantes"))).toHaveLength(1);
    // el resto de reglas siguen aplicando al widget
    expect(infractores([fuente('<p className="text-[13px]" />', ruta)], porRegla("tamano de texto arbitrario"))).toHaveLength(1);
  });

  it("alert(: x.alert(, useAlert( y role=alert son codigo limpio; toast directo no aplica fuera de restaurantes", () => {
    const alerta = porRegla("alert() nativo");
    for (const limpio of ["avisos.alert(1);", "const a = useAlert();", '<p role="alert">x</p>', "const alertas = 1;"]) {
      expect(infractores([fuente(limpio)], alerta), limpio).toEqual([]);
    }
    expect(infractores([fuente('toast.success("x");', "verticals/hoteles/pages/Y.tsx")], porRegla("toast directo en restaurantes"))).toEqual([]);
  });

  it("las reglas soloPaginas ignoran archivos fuera de pages/", () => {
    const regla = porRegla("formatMoney local");
    expect(infractores([fuente("function formatMoney() {}", "lib/format.ts")], regla)).toEqual([]);
  });

  it("la regla fmtMoney solo aplica a paginas de hoteles (otras paginas formatean porcentajes o moneda con sufijo)", () => {
    const regla = porRegla("fmtMoney local");
    const codigo = 'n.toLocaleString("es-MX", { minimumFractionDigits: 1 })';
    expect(infractores([fuente(codigo, "verticals/despachos/pages/Dashboard.tsx")], regla)).toEqual([]);
    expect(infractores([fuente(codigo, "verticals/hoteles/lib/x.ts")], regla)).toEqual([]);
  });

  it("una violacion dentro de un comentario no cuenta (el guard escanea codigo, no prosa)", () => {
    const codigo = '// no usar window.confirm("x") ni bg-green-500\n/* <select> y #ff0000 */\nconst a = 1;';
    for (const regla of REGLAS) expect(infractores([fuente(codigo)], regla)).toEqual([]);
  });
});

describe("guard DS v2 — sanidad de delegacion de formato", () => {
  it("falla si el modulo no delega o reimplementa el formato, y pasa si delega", () => {
    for (const regla of REGLAS_DELEGACION) {
      const limpio = [{ ruta: regla.ruta, codigo: 'import { formatMoney } from "@atiende/ui";\nexport const f = formatMoney;' }];
      expect(violacionesDelegacion(limpio, regla)).toEqual([]);
      const sinImport = [{ ruta: regla.ruta, codigo: "export const f = 1;" }];
      expect(violacionesDelegacion(sinImport, regla)).toContain("no importa de @atiende/ui");
      const reimplementa = [{ ruta: regla.ruta, codigo: 'import { x } from "@atiende/ui";\nnew Intl.NumberFormat("es-MX"); n.toLocaleString("es-MX", { minimumFractionDigits: 2 });' }];
      expect(violacionesDelegacion(reimplementa, regla).length).toBeGreaterThan(0);
      expect(violacionesDelegacion([], regla)).toHaveLength(1);
    }
  });
});

describe("guard DS v2 — sanidad de punta a punta sobre un arbol temporal", () => {
  const raiz = mkdtempSync(join(tmpdir(), "ds-v2-guard-"));
  afterAll(() => rmSync(raiz, { recursive: true, force: true }));

  const escribir = (rel: string, contenido: string) => {
    const ruta = join(raiz, rel);
    mkdirSync(dirname(ruta), { recursive: true });
    writeFileSync(ruta, contenido);
  };

  it("el cargador encuentra los .ts/.tsx anidados y cada regla senala solo el archivo infractor", () => {
    escribir("verticals/v/pages/Limpia.tsx", 'export const A = () => <p className="text-sm">ok</p>;');
    escribir("verticals/v/pages/Sucia.tsx", 'export const B = () => <p className="text-[11px] bg-red-500" style={{ top: 0 }}>x</p>;');
    escribir("components/Hex.tsx", 'export const C = "#abc123";');
    escribir("notas.md", "window.confirm('x') en un .md no se escanea");
    const fuentes = cargarFuentes(raiz);
    expect(fuentes.map((f) => f.ruta).sort()).toEqual(["components/Hex.tsx", "verticals/v/pages/Limpia.tsx", "verticals/v/pages/Sucia.tsx"]);
    expect(infractores(fuentes, porRegla("tamano de texto arbitrario"))).toEqual(["verticals/v/pages/Sucia.tsx"]);
    expect(infractores(fuentes, porRegla("paleta cruda"))).toEqual(["verticals/v/pages/Sucia.tsx"]);
    expect(infractores(fuentes, porRegla("estilo inline"))).toEqual(["verticals/v/pages/Sucia.tsx"]);
    expect(infractores(fuentes, porRegla("color hexadecimal"))).toEqual(["components/Hex.tsx"]);
    expect(infractores(fuentes, porRegla("window.confirm"))).toEqual([]);
  });
});
