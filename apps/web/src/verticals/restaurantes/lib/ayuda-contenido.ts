// F4c (5) -- Centro de ayuda minimo del panel: contenido ESTATICO por vertical (sin backend, sin llamadas, sin datos del negocio).
// Cada tema describe solo lo que el panel hace hoy; lo que depende de otro despliegue lo dice ("cuando se active ...") en vez de prometerlo.
export type VerticalAyuda = "restaurantes";

export interface TemaAyuda {
  readonly id: string;
  readonly titulo: string;
  /** Palabras que no salen en el titulo pero la gente busca ("borrar" para "eliminar un producto"). */
  readonly palabrasClave: readonly string[];
  readonly pasos: readonly string[];
  /** Quien puede hacerlo. */
  readonly roles: string;
}

export const AYUDA_POR_VERTICAL: Readonly<Record<VerticalAyuda, readonly TemaAyuda[]>> = Object.freeze({
  restaurantes: [
    {
      id: "primeros-pasos",
      titulo: "Primeros pasos con tu panel",
      palabrasClave: ["empezar", "inicio", "checklist", "configurar"],
      roles: "Dueño y administrador",
      pasos: [
        "Entra a Primeros pasos: la lista se calcula con los datos reales de tu negocio y te dice qué falta (sucursales, menú, horarios, WhatsApp).",
        "Cada punto pendiente trae un enlace a la pantalla donde se cierra. Nada se marca como hecho a mano.",
        "Cuando todo lo obligatorio esté listo, el panel te lo indica.",
      ],
    },
    {
      id: "menu-borrar",
      titulo: "Borrar un producto del menú",
      palabrasClave: ["eliminar", "quitar", "archivar", "producto", "platillo"],
      roles: "Dueño y administrador con acceso a todas las sucursales",
      pasos: [
        "Primero revisa la vista previa de la baja: te dice si el producto se borrará de forma definitiva o se archivará.",
        "Un producto que nunca se vendió se borra de verdad. Uno que ya aparece en pedidos se archiva: deja de venderse y de listarse, pero tus pedidos y reportes viejos conservan su nombre.",
        "Si solo quieres dejar de venderlo por hoy, márcalo como agotado en la sucursal: no hace falta borrarlo.",
        "Cada baja queda en la bitácora de auditoría con quién la hizo.",
      ],
    },
    {
      id: "menu-disponibilidad",
      titulo: "Marcar un producto como agotado",
      palabrasClave: ["agotado", "disponible", "precio", "sucursal"],
      roles: "Dueño, administrador y encargado (el precio solo dueño y administrador)",
      pasos: [
        "En Productos, usa el interruptor de disponibilidad de la sucursal. El agente deja de ofrecerlo al instante.",
        "Cambiar un precio es de dueño y administrador; el encargado solo marca agotado o disponible.",
      ],
    },
    {
      id: "whatsapp-tono",
      titulo: "Tono y mensaje del agente de WhatsApp",
      palabrasClave: ["tono", "personalidad", "mensaje", "bienvenida", "estilo"],
      roles: "Dueño y administrador con acceso a todas las sucursales",
      pasos: [
        "Elige uno de los cuatro tonos: cálido y cercano, formal y directo, profesional y neutro, o divertido y desenfadado.",
        "Si quieres, agrega un mensaje adicional (hasta 600 caracteres) de bienvenida o de estilo.",
        "Ese mensaje es solo de estilo: el sistema lo rechaza si intenta cambiar la propina, las formas de pago, cuándo pasar con una persona, la seguridad, los precios o los horarios. Esas reglas las pone el sistema y siempre mandan.",
        "Sin tono ni mensaje, el agente se comporta exactamente como hasta ahora.",
      ],
    },
    {
      id: "voz-idiomas",
      titulo: "Idiomas del agente de voz",
      palabrasClave: ["idioma", "inglés", "ingles", "telefono", "llamadas"],
      roles: "Dueño y administrador",
      pasos: [
        "Cada sucursal tiene su propio idioma principal y hasta 4 idiomas adicionales, de una lista de 32.",
        "Con la detección automática, el agente contesta en el idioma en que le habla el cliente (dentro de los que elegiste).",
        "Por omisión cada sucursal habla solo español de México. El idioma cambia cómo habla el agente, nunca sus reglas ni los precios.",
      ],
    },
    {
      id: "conocimiento-archivos",
      titulo: "Subir un PDF o una imagen a la base de conocimiento",
      palabrasClave: ["pdf", "archivo", "imagen", "documento", "conocimiento", "subir"],
      roles: "Dueño y administrador con acceso a todas las sucursales",
      pasos: [
        "Acepta PDF (hasta 3 MB) e imágenes PNG, JPG o WebP (hasta 2 MB), máximo 20 archivos. Se revisa el contenido real del archivo, no solo su extensión; los PDF con scripts o archivos incrustados se rechazan.",
        "El texto del archivo se convierte en borradores de Conocimiento del negocio: revísalos y publica los que quieras. Sirven igual al agente de WhatsApp y al de voz.",
        "Los trozos que traen precios o nombres exactos de tu menú se omiten: el agente toma precios y productos siempre del menú real.",
        "Borrar un archivo borra también los borradores y entradas que salieron de él.",
        "La lectura automática de PDF e imágenes se activa cuando se configure ese servicio; mientras tanto la pantalla lo avisa y puedes escribir el conocimiento a mano.",
      ],
    },
    {
      id: "equipo-roles",
      titulo: "Quién puede hacer qué",
      palabrasClave: ["roles", "permisos", "staff", "encargado", "administrador", "dueño"],
      roles: "Dueño y administrador",
      pasos: [
        "Dueño y administrador (con acceso a todas las sucursales) cambian precios, borran productos, configuran los agentes y ven la auditoría.",
        "El encargado atiende pedidos y marca agotados; no cambia precios ni configuración.",
        "Un administrador con acceso a solo algunas sucursales no puede cambiar lo que afecta a toda la organización (catálogo, agentes).",
      ],
    },
  ],
});

/** Filtra temas por texto libre (sin acentos ni mayusculas) sobre titulo, palabras clave y pasos. Vacio = todos. */
export function buscarAyuda(temas: readonly TemaAyuda[], consulta: string): readonly TemaAyuda[] {
  const plano = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const q = plano(consulta).trim();
  if (q === "") return temas;
  const terminos = q.split(/\s+/);
  return temas.filter((t) => {
    const heno = plano([t.titulo, ...t.palabrasClave, ...t.pasos, t.roles].join(" "));
    return terminos.every((term) => heno.includes(term));
  });
}
