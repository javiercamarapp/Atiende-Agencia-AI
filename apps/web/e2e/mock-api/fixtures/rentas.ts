// Fixtures de rentas vacacionales (Rentas Sol y Mar). Forma = apps/web/src/verticals/rentas/lib/calendario-client.ts.
import { fallo } from "../respuestas.ts";
import { orgDe, propiedadDe } from "../personas.ts";
import type { Ruta } from "../tipos.ts";

const PROP = propiedadDe("rentas");
const ORG = orgDe("rentas");
const R = "/rentas/:id";

const UNIDADES = [
  { id: "uni-1", nombre: "Casa Playa Norte", duracionMinimaNoches: 2 },
  { id: "uni-2", nombre: "Depto Malecon 4B", duracionMinimaNoches: 1 },
];

function dia(desdeHoy: number): string {
  return new Date(Date.now() + desdeHoy * 86_400_000).toISOString().slice(0, 10);
}

interface Ocupacion {
  id: string;
  unidadId: string;
  capa: "reserva" | "bloqueo";
  rango: { inicio: string; fin: string };
  razon: string;
  estado: string;
  canalCodigo: string | null;
  huespedNombre: string | null;
  huespedContacto: string | null;
  createdAt: string;
}

function ocupacionesSemilla(): Ocupacion[] {
  return [
    { id: "ocu-1", unidadId: "uni-1", capa: "reserva", rango: { inicio: dia(4), fin: dia(7) }, razon: "RESERVA_CANAL", estado: "confirmado", canalCodigo: null, huespedNombre: "Familia Zapata", huespedContacto: "+529995550401", createdAt: "2026-09-28T15:00:00.000Z" },
    { id: "ocu-2", unidadId: "uni-1", capa: "bloqueo", rango: { inicio: dia(12), fin: dia(14) }, razon: "MANTENIMIENTO", estado: "confirmado", canalCodigo: null, huespedNombre: null, huespedContacto: null, createdAt: "2026-09-29T15:00:00.000Z" },
  ];
}

export const rutasRentas: readonly Ruta[] = [
  { metodo: "GET", patron: "/v1/rentas/:org/admin/propiedades", manejador: () => ({ propiedades: [{ propertyId: PROP.id, nombre: PROP.nombre }] }) },
  { metodo: "GET", patron: `${R}/unidades`, manejador: () => ({ unidades: UNIDADES }) },
  { metodo: "GET", patron: `${R}/unidades/:uid/ocupaciones`, manejador: (p) => ({ ocupaciones: p.estado.obtener("rentas.ocupaciones", ocupacionesSemilla).filter((o) => o.unidadId === p.params.uid) }) },
  { metodo: "GET", patron: `${R}/calendario`, manejador: (p) => ({
      zona_horaria: "America/Merida",
      hoy: dia(0),
      total: 2,
      truncado: false,
      ocupaciones: p.estado.obtener("rentas.ocupaciones", ocupacionesSemilla).map(({ huespedContacto: _c, createdAt: _t, ...visual }) => visual),
    }) },
  { metodo: "POST", patron: `${R}/unidades/:uid/reservas/:oid/cancelar`, manejador: (p) => cancelar(p.estado.obtener("rentas.ocupaciones", ocupacionesSemilla), p.params.oid) },
  { metodo: "POST", patron: `${R}/unidades/:uid/bloqueos/:oid/cancelar`, manejador: (p) => cancelar(p.estado.obtener("rentas.ocupaciones", ocupacionesSemilla), p.params.oid) },
];

function cancelar(lista: Ocupacion[], id: string | undefined) {
  const o = lista.find((x) => x.id === id);
  if (!o) return fallo(404, "Esa ocupacion no existe");
  o.estado = "cancelado";
  return o;
}

export const rentas = { orgSlug: ORG.slug, propertyId: PROP.id };
