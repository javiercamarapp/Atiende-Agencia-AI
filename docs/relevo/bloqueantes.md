# Bloqueantes (9-nov-2026)

Lo que no se resuelve escribiendo código. Cada punto dice quién lo destraba y qué se queda parado mientras tanto. Sin secretos: solo nombres.

## 1. GitHub Actions bloqueado por facturación
- Desde el 8-nov 15:43 UTC ningún job arranca (pago fallido o límite de gasto de la cuenta). **Quién**: dueño de la cuenta de GitHub (Billing & plans).
- Bloquea: todas las fusiones (regla de CI verde), la verificación de `main` tras cada merge y la medición en la nube (`medicion-agente.yml`).
- Al destrabar: correr primero #815 (typecheck con tope de memoria) para dejar `main` en verde.

## 2. Migraciones en `main` sin aplicar a la base real
| Migración | Prefijo en `supabase/migrations` | Viene de | Efecto mientras falte |
|---|---|---|---|
| 0075 | 000611 | guía ds3 (#746): progreso del recorrido por persona | el recorrido no se retoma en otro equipo |
| `mcp_cfdi` 002 | 000631 | RLS de folios CFDI (#761) | `folio_stamp_reservation` sigue **sin RLS** (igual que antes del PR) |
| 0077 | 000640 | registro autoservicio de restaurantes (#774) | el registro autoservicio no funciona contra la base |
| 0085 | 000720 | cockpit CFO (#786): supuestos de costo, capturas del dueño y uso por cliente | el cockpit no tiene dónde guardar sus datos |
| 0090 | 000730 | credenciales de Meta por organización (#811) | se sigue usando la credencial única de plataforma |

La confirmación de `apply_migration` expiró varias veces. **Quién**: Javier/dueño, en el editor SQL de Supabase con el archivo preparado por el loop, o dando OK explícito
para aplicarlas por herramienta.

## 3. Voz sin infraestructura
- Fly: la app del worker no existe. LiveKit: proyecto sin inbound trunk ni regla de despacho. Twilio: sin número puente, sin SIP trunk y **sin Regulatory Bundle de México**
  (Constancia de Situación Fiscal + comprobante de domicilio en la localidad del prefijo; la aprobación tarda días hábiles). Desvío condicional de PM sin contratar con su compañía.
- **Quién**: Javier (cuentas y pagos de Twilio, LiveKit y Fly) y PM (titular de la línea, desvío).
- Bloquea: cualquier llamada real (hoy 0). Runbook: `docs/VOZ-ACTIVACION.md`.

## 4. Decisiones del dueño
| Decisión | Contexto | Qué queda parado |
|---|---|---|
| Umbral del **pedido grande** | el servidor manda a aprobación «> $2,500 en efectivo de un número sin historial»; el banco C4 supone > $4,000 (D31). 5 de 53 fallos de #718 en C4 | cerrar #718 y su medición |
| **Precios de rentas, licitaciones y despachos** | los planes aprobados el 7-nov (Básico/Plus/Pro/Enterprise, piso de margen 55 %) son de restaurantes | cobro de las otras verticales |
| **Tope de mensajes**: ¿corta o avisa? | al llegar al tope del plan, cortar el servicio o solo avisar (los avisos al 80/100/150 % ya están en #793) | comportamiento final del cobro medido |
| **Aviso de privacidad revisado por abogado** | el texto actual no tiene revisión legal; también contrato de encargo y lista de subencargados | salida a producción con datos de clientes |
| **Twilio: número, Bundle MX y desvío** | ver punto 3 | voz real |
| **Proteger `main`** | protección de rama con CI requerido, revisión y sin force-push (estado actual de la regla no verificado en este documento) | defensa en profundidad del despliegue automático |
| **Rotación de llaves** | rotar las llaves que han pasado por máquinas de agentes; procedimiento en `docs/runbooks/ROTACION-DE-LLAVES.md` | cierre de seguridad antes de producción |
| **Retención cero en STT/TTS** | ZDR solo aplica al LLM de voz; ElevenLabs y Deepgram no reciben parámetros de retención | política de privacidad de voz |
| **Gasto de mediciones** | sin mediciones de pago desde el 8-nov | C4 de `fa304de9f`, E2E de #813 |

## 5. Operación de la Mac del loop
- ~57 GB en clones; crudos de evals y grabaciones de voz solo en esta Mac (los resúmenes ya están en `docs/evals/`). Poca RAM: un proceso pesado a la vez.
- La llave de OpenRouter es compartida por todos los agentes: el gasto por medición es cota superior.
