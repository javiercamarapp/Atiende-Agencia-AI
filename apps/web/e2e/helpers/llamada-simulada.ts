// Llamada de prueba SIMULADA para las pruebas de navegador: reemplaza el WebSocket de Gemini Live (el que abre la vista previa de voz)
// por un guion local. El microfono lo pone Chromium con sus banderas de dispositivo falso (ver `ARGUMENTOS_MICROFONO_FALSO`).
// Nada sale a internet ni usa credenciales.
import type { Page } from "@playwright/test";

export const ARGUMENTOS_MICROFONO_FALSO = ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] as const;

export interface GuionLlamada {
  /** Fragmentos de transcripcion que el "agente" y la persona dicen despues de conectar. */
  readonly lineas: readonly { readonly rol: "agente" | "usuario"; readonly texto: string }[];
}

export const GUION_POR_OMISION: GuionLlamada = {
  lineas: [
    { rol: "agente", texto: "Hola, le atiende el asistente virtual de Taquería El Faro. ¿Qué le gustaría ordenar?" },
    { rol: "usuario", texto: "Quiero tres tacos al pastor para recoger." },
  ],
};

/** Intercepta el WebSocket de la llamada de prueba (wss://gemini.e2e.test, el que devuelve el mock en `/voz/preview/sesion`). */
export async function simularLlamada(page: Page, guion: GuionLlamada = GUION_POR_OMISION): Promise<void> {
  await page.routeWebSocket(/gemini\.e2e\.test/, (ws) => {
    ws.onMessage((mensaje) => {
      if (typeof mensaje !== "string" || !mensaje.includes('"setup"')) return;
      ws.send(JSON.stringify({ setupComplete: {} }));
      let retraso = 400;
      for (const l of guion.lineas) {
        const clave = l.rol === "agente" ? "outputTranscription" : "inputTranscription";
        setTimeout(() => {
          try {
            ws.send(JSON.stringify({ serverContent: { [clave]: { text: l.texto }, turnComplete: l.rol === "agente" } }));
          } catch {
            // la llamada ya se colgo
          }
        }, retraso);
        retraso += 500;
      }
    });
  });
}
