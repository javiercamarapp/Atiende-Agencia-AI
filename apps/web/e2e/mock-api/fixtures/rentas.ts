// Fixtures de rentas. Forma de cada respuesta = tipos de apps/web/src/verticals/rentas/lib.
import { orgDe, propiedadDe } from "../personas.ts";
import type { Ruta } from "../tipos.ts";

const PROP = propiedadDe("rentas");
const ORG = orgDe("rentas");

export const rutasRentas: readonly Ruta[] = [
  { metodo: "GET", patron: "/v1/rentas/:org/admin/propiedades", manejador: () => ({ propiedades: [{ propertyId: PROP.id, nombre: PROP.nombre }] }) },
];

export const rentas = { orgSlug: ORG.slug, propertyId: PROP.id };
