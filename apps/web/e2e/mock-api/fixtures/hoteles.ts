// Fixtures de hoteles. Forma de cada respuesta = tipos de apps/web/src/verticals/hoteles/lib.
import { orgDe, propiedadDe } from "../personas.ts";
import type { Ruta } from "../tipos.ts";

const PROP = propiedadDe("hoteles");
const ORG = orgDe("hoteles");

export const rutasHoteles: readonly Ruta[] = [
  { metodo: "GET", patron: "/v1/hoteles/:org/admin/propiedades", manejador: () => ({ propiedades: [{ propertyId: PROP.id, nombre: PROP.nombre }] }) },
];

export const hoteles = { orgSlug: ORG.slug, propertyId: PROP.id };
