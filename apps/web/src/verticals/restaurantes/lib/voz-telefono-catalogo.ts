// Voces de la LLAMADA TELEFONICA (TTS de la cascada v2: ElevenLabs eleven_v4_turbo). Copia del catalogo de la API (`CATALOGO_VOCES_TELEFONO` de
// @atiende/voice-core, que valida el PUT): si se agrega una voz alla, se agrega aqui. La primera es la de la plataforma (se usa si la sucursal no elige).
export interface VozTelefono {
  readonly id: string;
  readonly nombre: string;
  readonly estilo: string;
}

export const VOCES_TELEFONO: readonly VozTelefono[] = [
  { id: "9Godp7dNohUvXk6qp0gS", nombre: "Regina", estilo: "Femenina mexicana, de centro de atención (la de la plataforma)" },
  { id: "sDh3eviBhiuHKi0MjTNq", nombre: "Alejandro", estilo: "Masculina mexicana, corporativa" },
  { id: "NUEuVCKSYxEA5YrK3kmx", nombre: "Daniela", estilo: "Femenina mexicana (biblioteca de Los Taquitos de PM)" },
];
