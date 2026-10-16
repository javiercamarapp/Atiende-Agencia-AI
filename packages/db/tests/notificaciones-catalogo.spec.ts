// Catalogo de notificaciones: consistencia de la tabla de datos y, sobre todo, que CADA evento marcado como
// conectado tenga un productor real (archivo existente que contiene el id) y un enlace a una ruta real de
// apps/web; cada evento pendiente declara que le falta; y docs/NOTIFICACIONES.md los lista todos.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AMBITOS_NOTIFICACION, CATALOGO_NOTIFICACIONES, CATEGORIAS_NOTIFICACION } from "../src/notificaciones/catalogo.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function archivosTsx(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) archivosTsx(p, out);
    else if (/\.(tsx|ts)$/.test(e)) out.push(p);
  }
  return out;
}

const rutasWeb = new Set<string>();
for (const f of archivosTsx(path.join(REPO, "apps", "web", "src"))) {
  for (const m of readFileSync(f, "utf8").matchAll(/path="([^"]+)"/g)) {
    rutasWeb.add(m[1]!);
    // Una ruta con comodin (`/restaurantes/:orgSlug/cfo/*`) tambien responde en su base (`/restaurantes/:orgSlug/cfo`).
    if (m[1]!.endsWith("/*")) rutasWeb.add(m[1]!.slice(0, -2));
  }
}

describe("catalogo de notificaciones", () => {
  it("ids unicos, con el formato de la base y prefijo igual al ambito", () => {
    const ids = CATALOGO_NOTIFICACIONES.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const e of CATALOGO_NOTIFICACIONES) {
      expect(e.id, e.id).toMatch(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/);
      expect(e.id.startsWith(`${e.ambito}.`), e.id).toBe(true);
      expect(AMBITOS_NOTIFICACION).toContain(e.ambito);
      expect(CATEGORIAS_NOTIFICACION).toContain(e.categoria);
      expect(["info", "atencion", "critica"]).toContain(e.severidad);
      expect(e.venceDias).toBeGreaterThan(0);
      expect(e.venceDias).toBeLessThanOrEqual(365);
      expect(e.titulo.length).toBeLessThanOrEqual(160);
      expect((e.cuerpo ?? "").length).toBeLessThanOrEqual(500);
    }
  });

  it("cubre las 6 verticales y superadmin", () => {
    for (const a of AMBITOS_NOTIFICACION) expect(CATALOGO_NOTIFICACIONES.some((e) => e.ambito === a), a).toBe(true);
  });

  it("las plantillas solo usan parametros declarados y no admiten PII (sin correos, telefonos ni urls)", () => {
    for (const e of CATALOGO_NOTIFICACIONES) {
      for (const texto of [e.titulo, e.cuerpo ?? ""]) {
        const usados = [...texto.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!);
        for (const u of usados) expect(e.parametros, `${e.id} usa {${u}} sin declararlo`).toContain(u);
        expect(texto, e.id).not.toMatch(/@|https?:|\d{7,}/);
      }
      for (const p of e.parametros) expect(`${e.titulo} ${e.cuerpo ?? ""}`, `${e.id} declara {${p}} sin usarlo`).toContain(`{${p}}`);
    }
  });

  it("cada enlace es una ruta interna que existe en apps/web", () => {
    for (const e of CATALOGO_NOTIFICACIONES) {
      expect(e.enlace, e.id).toMatch(/^\/[A-Za-z0-9_{][A-Za-z0-9_{}/.?&=#%:@+~-]*$/);
      // `{orgSlug}` lo resuelve la base y `{entidadId}` el productor: ambos equivalen a un parametro de ruta (`:param`) de apps/web.
      // La consulta (`?tab=gestion`) no es parte de la ruta: solo selecciona una pestana de la pagina.
      const ruta = e.enlace.replace("{orgSlug}", ":orgSlug").replace("{entidadId}", ":entidadId").split("?")[0]!;
      const normalizar = (r: string) => r.replace(/:\w+/g, ":p");
      expect([...rutasWeb].some((r) => normalizar(r) === normalizar(ruta)), `${e.id}: la ruta ${ruta} no existe en apps/web`).toBe(true);
      expect(e.enlace.includes("{orgSlug}"), e.id).toBe(e.ambito !== "superadmin");
    }
  });

  it("cada evento CONECTADO tiene un productor real que lo referencia; cada PENDIENTE declara el motivo", () => {
    for (const e of CATALOGO_NOTIFICACIONES) {
      if (e.productor.estado === "conectado") {
        const archivo = path.join(REPO, e.productor.archivo);
        expect(existsSync(archivo), `${e.id}: no existe ${e.productor.archivo}`).toBe(true);
        const fuente = readFileSync(archivo, "utf8");
        expect(fuente, `${e.id}: ${e.productor.archivo} no emite este evento`).toContain(`"${e.id}"`);
        expect(fuente, `${e.id}: ${e.productor.archivo} no usa emitirNotificacion`).toContain("emitirNotificacion");
      } else {
        expect(e.productor.motivo.length, e.id).toBeGreaterThan(20);
      }
    }
  });

  it("ningun archivo emite un evento que el catalogo no conoce", () => {
    const ids = new Set(CATALOGO_NOTIFICACIONES.map((e) => e.id));
    const conectados = new Set(CATALOGO_NOTIFICACIONES.flatMap((e) => (e.productor.estado === "conectado" ? [e.productor.archivo] : [])));
    for (const rel of conectados) {
      const fuente = readFileSync(path.join(REPO, rel), "utf8");
      for (const m of fuente.matchAll(/evento:\s*"([a-z_.]+)"/g)) expect(ids.has(m[1]!), `${rel} emite ${m[1]} fuera del catalogo`).toBe(true);
    }
  });

  it("docs/NOTIFICACIONES.md lista todos los eventos del catalogo y su estado", () => {
    const doc = readFileSync(path.join(REPO, "docs", "NOTIFICACIONES.md"), "utf8");
    for (const e of CATALOGO_NOTIFICACIONES) {
      const fila = doc.split("\n").find((l) => l.includes(`\`${e.id}\``));
      expect(fila, `${e.id} no aparece en docs/NOTIFICACIONES.md`).toBeDefined();
      expect(fila!, e.id).toContain(e.productor.estado);
      if (e.productor.estado === "conectado" && e.productor.nota) expect(fila!, `${e.id}: la nota del catalogo falta en el doc`).toContain(e.productor.nota);
      if (e.productor.estado === "pendiente") expect(fila!, `${e.id}: el motivo del catalogo falta en el doc`).toContain(e.productor.motivo);
    }
  });
});

// Los mismos CHECK y validaciones que aplica core.emit_notification en la base (migracion 0039): un evento del catalogo que no los
// cumpla seria rechazado con 22023 en produccion y el aviso se perderia en silencio (best-effort), asi que se verifica aqui, ANTES.
describe("el catalogo cumple las validaciones de core.emit_notification", () => {
  const TIPO = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/;
  const CATEGORIA = /^[a-z][a-z_]{1,39}$/;
  const ENLACE = /^\/[A-Za-z0-9_{][A-Za-z0-9_{}/.?&=#%:@+~-]*$/;

  it("tipo, categoria, enlace, titulo y cuerpo (ya renderizados con el parametro mas largo permitido) caben en las restricciones de la base", () => {
    for (const e of CATALOGO_NOTIFICACIONES) {
      expect(e.id, e.id).toMatch(TIPO);
      expect(e.categoria, e.id).toMatch(CATEGORIA);
      expect(e.enlace, e.id).toMatch(ENLACE);
      expect(e.enlace.length, e.id).toBeLessThanOrEqual(300);
      const peor = (t: string) => t.replace(/\{\w+\}/g, "x".repeat(40));
      expect(peor(e.titulo).length, e.id).toBeLessThanOrEqual(160);
      expect(peor(e.cuerpo ?? "").length, e.id).toBeLessThanOrEqual(500);
      expect(e.venceDias, e.id).toBeLessThanOrEqual(365);
    }
  });

  it("los roles de vertical son codigos validos, sin repetir y sin los implicitos owner/admin; los de superadmin no llevan roles de vertical", () => {
    // owner/admin de la organizacion reciben TODO evento de vertical por defecto (los resuelve la base): listarlos seria ruido o un error.
    for (const e of CATALOGO_NOTIFICACIONES) {
      if (e.ambito === "superadmin") expect(e.roles, e.id).toEqual([]);
      expect(new Set(e.roles).size, `${e.id}: roles repetidos`).toBe(e.roles.length);
      for (const r of e.roles) {
        expect(r, e.id).toMatch(/^[a-z_]+(:[a-z_]+)?$/);
        expect(["owner", "admin"], `${e.id}: ${r} ya es destinatario implicito`).not.toContain(r);
      }
    }
  });

});
