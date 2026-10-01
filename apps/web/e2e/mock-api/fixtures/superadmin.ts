// Fixtures del back office de plataforma (/superadmin/*). Solo la persona `plataforma-superadmin` ve estas rutas.
import { fallo } from "../respuestas.ts";
import { orgDe } from "../personas.ts";
import type { Ruta, Vertical } from "../tipos.ts";

const VERTICALES: readonly Vertical[] = ["restaurantes", "hoteles", "rentas", "despachos", "licitaciones", "citas"];

function organizaciones() {
  return VERTICALES.map((v, i) => {
    const org = orgDe(v);
    return { id: org.id, vertical: v, name: org.nombre, slug: org.slug, status: i === 5 ? "trial" : "active", createdAt: `2026-0${3 + (i % 5)}-1${i}T15:00:00.000Z`, staffCount: 4 + i };
  });
}

interface Prospecto {
  id: string;
  empresa: string;
  vertical: string;
  ciudad: string | null;
  contactoNombre: string | null;
  telefono: string | null;
  correo: string | null;
  estado: string;
  fuente: string | null;
  notas: string | null;
  createdAt: string;
  updatedAt: string;
}

const PROSPECTOS: Prospecto[] = [
  { id: "prs-1", empresa: "Marisqueria La Playita", vertical: "restaurantes", ciudad: "Progreso", contactoNombre: "Elena Tun", telefono: "+529995550301", correo: "elena.tun@example.test", estado: "contactado", fuente: "referido", notas: null, createdAt: "2026-09-20T16:00:00.000Z", updatedAt: "2026-09-22T16:00:00.000Z" },
];

export const rutasSuperadmin: readonly Ruta[] = [
  { metodo: "GET", patron: "/superadmin/organizations", manejador: () => ({ organizations: organizaciones() }) },
  { metodo: "GET", patron: "/superadmin/prospectos", manejador: (p) => ({ prospectos: p.estado.obtener("sa.prospectos", () => structuredClone(PROSPECTOS)) }) },
  { metodo: "POST", patron: "/superadmin/prospectos", manejador: (p) => {
      const cuerpo = (p.cuerpo ?? {}) as Partial<Prospecto>;
      if (!cuerpo.empresa) return fallo(400, "La empresa es requerida");
      const lista = p.estado.obtener("sa.prospectos", () => structuredClone(PROSPECTOS));
      const nuevo: Prospecto = { id: `prs-${lista.length + 1}`, empresa: cuerpo.empresa, vertical: cuerpo.vertical ?? "restaurantes", ciudad: cuerpo.ciudad ?? null, contactoNombre: cuerpo.contactoNombre ?? null, telefono: cuerpo.telefono ?? null, correo: cuerpo.correo ?? null, estado: "nuevo", fuente: cuerpo.fuente ?? null, notas: cuerpo.notas ?? null, createdAt: "2026-09-30T16:00:00.000Z", updatedAt: "2026-09-30T16:00:00.000Z" };
      lista.push(nuevo);
      return { prospecto: nuevo };
    } },
  { metodo: "GET", patron: "/superadmin/interruptores", manejador: (p) => ({
      disponible: true,
      catalogo: { globales: ["llm", "crons"], agentes: ["restaurantes-whatsapp", "citas-whatsapp"], crons: ["recordatorios-citas", "sync-ical-rentas"] },
      interruptores: p.estado.obtener("sa.interruptores", () => [] as unknown[]),
    }) },
  { metodo: "PUT", patron: "/superadmin/interruptores", manejador: (p) => {
      const c = (p.cuerpo ?? {}) as { scope?: string; target?: string; bloqueado?: boolean; motivo?: string };
      if (!c.scope || !c.target || (c.motivo ?? "").length < 20) return fallo(400, "Datos invalidos");
      const lista = p.estado.obtener("sa.interruptores", () => [] as Array<Record<string, unknown>>);
      const i = lista.findIndex((x) => x.scope === c.scope && x.target === c.target);
      const fila = { scope: c.scope, target: c.target, bloqueado: c.bloqueado === true, motivo: c.motivo, actualizadoPor: "superadmin@example.test", actualizadoEnMs: Date.now() };
      if (i >= 0) lista[i] = fila;
      else lista.push(fila);
      return { ok: true };
    } },
];
