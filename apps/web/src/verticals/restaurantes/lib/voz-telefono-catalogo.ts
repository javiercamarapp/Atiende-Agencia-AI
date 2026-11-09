// Voces de la LLAMADA TELEFONICA (TTS de la cascada v2: ElevenLabs eleven_v4_turbo). Copia del catalogo de la API (`CATALOGO_VOCES_TELEFONO` de
// @atiende/voice-core, que valida el PUT): si se agrega una voz alla, se agrega aqui. La primera es la de la plataforma (se usa si la sucursal no elige).
import { traductorActivo } from "@atiende/ui";
import type { Clave } from "@atiende/ui";
import { restaurantesAgenteVoz } from "@atiende/ui/i18n/restaurantes/agenteVoz";

export interface VozTelefono {
  readonly id: string;
  readonly nombre: string;
  readonly estilo: string;
}

const tr = traductorActivo(restaurantesAgenteVoz);

/** El estilo se traduce en cada lectura al idioma de la consola. */
function voz(id: string, nombre: string, clave: Clave): VozTelefono {
  return {
    id,
    nombre,
    get estilo() {
      return tr(clave);
    },
  };
}

export const VOCES_TELEFONO: readonly VozTelefono[] = [
  voz("9Godp7dNohUvXk6qp0gS", "Regina", "restaurantes.agenteVoz.telefono.Regina"),
  voz("sDh3eviBhiuHKi0MjTNq", "Alejandro", "restaurantes.agenteVoz.telefono.Alejandro"),
  voz("NUEuVCKSYxEA5YrK3kmx", "Daniela", "restaurantes.agenteVoz.telefono.Daniela"),
];
