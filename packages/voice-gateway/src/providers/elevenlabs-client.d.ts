// Shim de tipos AMBIENTE para `@elevenlabs/client`.
//
// Este paquete de voice-gateway NO instala `@elevenlabs/client` como
// dependencia directa — es un SDK pesado de NAVEGADOR que solo hace falta
// en el bundle de la app que de verdad llama `startSession()` (exactamente
// como en restaurantes/src/pages/AdminDashboard.tsx, que lo trae vía import
// dinámico). Está declarado como `peerDependency` opcional en package.json:
// la app consumidora (apps/*, o el bundle del navegador de cada vertical)
// lo instala si de verdad usa la superficie de cliente.
//
// Este shim solo declara la forma MÍNIMA real que usa
// `elevenlabs-provider.ts#startSession` (puerto 1:1 de
// `Conversation.startSession` en AdminDashboard.tsx línea ~1510) — lo
// suficiente para tipar en este monorepo sin depender de que el paquete
// esté instalado aquí. Si el SDK real difiere en algún campo no usado por
// este puerto, no afecta: TypeScript solo valida lo que se declara.
declare module '@elevenlabs/client' {
  export interface ElevenLabsConversationStartOptions {
    signedUrl: string;
    dynamicVariables?: Record<string, string>;
    onConnect?: (info: { conversationId: string }) => void;
    onDisconnect?: () => void;
    onMessage?: (event: { message: string; role: 'user' | 'agent' }) => void;
    onError?: (message: string) => void;
  }

  export interface ElevenLabsConversationSession {
    endSession(): Promise<void>;
  }

  export const Conversation: {
    startSession(options: ElevenLabsConversationStartOptions): Promise<ElevenLabsConversationSession>;
  };
}
