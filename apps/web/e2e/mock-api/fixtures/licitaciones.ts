// Fixtures de licitaciones. Forma de cada respuesta = tipos de apps/web/src/verticals/licitaciones/lib.
import { orgDe, propiedadDe } from "../personas.ts";
import type { Ruta } from "../tipos.ts";

const PROP = propiedadDe("licitaciones");
const ORG = orgDe("licitaciones");

export const rutasLicitaciones: readonly Ruta[] = [
  { metodo: "GET", patron: "/v1/licitaciones/:org/admin/branches", manejador: () => ({ branches: [{ propertyId: PROP.id, name: PROP.nombre }] }) },
];

export const licitaciones = { orgSlug: ORG.slug, propertyId: PROP.id };
