// Construccion de produccion de las credenciales de Meta por organizacion (migracion 0090). Sin WHATSAPP_CREDENTIALS_KEY -> `undefined`
// (comportamiento anterior: solo las variables de plataforma). Una llave presente pero mal formada NO tumba el arranque de la API: se
// registra un error (sin el valor) y la funcion queda apagada, igual que sin llave; el envio y la firma de plataforma siguen funcionando.
import type { TenancyEngine } from "@atiende/core-tenancy";
import type { ApiEnv } from "../env.ts";
import { crearCifradorCredencialesMeta, parsearLlaveCredencialesMeta } from "./cifrado.ts";
import { leerCredencialesParaSistema } from "./repositorio.ts";
import { crearResolutorCredencialesMeta } from "./resolutor.ts";
import type { WhatsAppMetaDeps } from "./index.ts";

export function construirWhatsAppMeta(
  env: Pick<ApiEnv, "whatsappCredentialsKey" | "whatsappCredentialsKeyVersion">,
  engine: Pick<TenancyEngine, "withAppSession">,
): WhatsAppMetaDeps | undefined {
  let llave: Buffer | null;
  try {
    llave = parsearLlaveCredencialesMeta(env.whatsappCredentialsKey);
  } catch {
    console.error(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "error",
        evento: "whatsapp_meta_llave_invalida",
        detalle: "WHATSAPP_CREDENTIALS_KEY no son 32 bytes en base64; credenciales por organizacion apagadas",
      }),
    );
    return undefined;
  }
  if (!llave) return undefined;
  const cifrador = crearCifradorCredencialesMeta(llave, env.whatsappCredentialsKeyVersion ?? 1);
  const resolutor = crearResolutorCredencialesMeta({ cifrador, leer: () => engine.withAppSession({ userId: null }, (db) => leerCredencialesParaSistema(db)) });
  return { cifrador, resolutor };
}
