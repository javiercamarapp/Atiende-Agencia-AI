# Ajustes del agente de restaurantes (equivalentes de lo que el original hacía con ElevenLabs)

Pantalla **Agente > Ajustes del agente** (owner/admin). Cada control llama a un endpoint real, se guarda con bitácora y declara **dónde aplica hoy**.
Contrato de API: `apps/api/src/routes/verticals/restaurantes/ajustes-agente.ts`. Dominio: `packages/domain-restaurantes/src/ajustes-agente/`.

| Función | Qué es | Dónde aplica hoy |
|---|---|---|
| Modelo del agente de WhatsApp | Lista cerrada (`MODELOS_AGENTE`) con costo estimado por 1,000 mensajes | Desde el siguiente mensaje (el turno manda `preferredModel` al gateway) |
| Temperatura del agente de WhatsApp | 0 a 1, **solo** si el modelo la admite | Desde el siguiente mensaje |
| Temperatura de la voz | Parámetro real de Gemini Live (`generationConfig.temperature`) | Vista previa ahora; llamadas reales con el servicio de llamadas |
| Ritmo y estilo de habla | Gemini no tiene velocidad numérica: se piden por instrucción, anexada **al final** (no cambia reglas ni el trato de usted) | Vista previa ahora; llamadas reales con el servicio de llamadas |
| Modelo de la cascada de voz | Mismo catálogo con costo por minuto | Solo existe en llamadas reales (el escalón 2 de la escalera) |
| Sonido de fondo de restaurante | Ambiente sintetizado con tres presets (`cocina-taqueria`, `sala-tranquila`, `calle-ocupada`), apagado por omisión, volumen 0 a 20 % (pico), baja bajo la voz | Llamadas reales: el worker lo mezcla en la salida (`MezcladorSalida`; sin probar contra LiveKit real). **No suena en la vista previa del panel** (la pantalla dice «No disponible aún») |
| Tecleo al anotar | Clics de teclado/POS sintetizados mientras una herramienta está en vuelo (cotizar, confirmar, crear pedido, buscar cliente); se corta si el cliente habla; apagado por omisión, volumen 0 a 25 % | Igual que el fondo (migración 087) |
| Naturalidad en español de México | Anexa al final de la instrucción el bloque de acento/léxico mexicano y de naturalidad (`BLOQUE_NATURALIDAD`) | Llamadas reales (llegan con el contexto de la llamada) y vista previa (migración 087) |
| Preset «restaurante humano» | Rellena ritmo, estilo, temperatura, ambiente, tecleo y naturalidad (no guarda solo ni cambia la voz); ver `docs/VOZ-RESTAURANTE-HUMANO.md` | Ahora |
| Voz y saludo por sucursal | Catálogo de 30 voces con muestra y frase de saludo (config de voz existente) | Ya |
| Conocimiento automático | Documentos generados **al momento** de los datos (ver abajo) | Vista previa de voz ya; llamadas reales con el servicio de llamadas |
| Clonación de voz | **No se construye**: Gemini no clona | Estado honesto "No disponible con el proveedor actual" |

## Modelo elegido sin romper el gateway

`LlmGateway.complete({ preferredModel })` pone el modelo elegido al frente de la escalera **del mismo rol** (`restaurantes:whatsapp_agent`); el resto queda de
respaldo. Los modelos elegibles se registran con `registerAlternatives` (no entran a la escalera por defecto: un fallo no cae a ellos), pasan por la misma política
de proveedores de EE.UU. (`routingForModel`) y comparten circuit breaker con el escalón del mismo id. Un modelo no registrado se ignora. Como el rol no cambia, el
interruptor de plataforma, el tope diario/mensual y el registro de uso siguen siendo los del rol. El reintento tras un fallo real de `crear_pedido` (rol escalado)
no usa el modelo elegido.

**Temperatura**: `aceptaTemperatura` sale de `supported_parameters` de los endpoints permitidos de OpenRouter (leído el 2026-10-04): DeepSeek V4.1 Flash,
Gemini 2.5 Flash-Lite, Gemini 3.8 Flash y Muse Spark 1.3 la aceptan; GPT-6 Luna y Claude Sonnet 5.5 no (con `require_parameters` mandarla deja la ruta sin
endpoints). Para esos dos la pantalla dice que no la admiten y el servidor la rechaza (400) en vez de ignorarla.

**Costo estimado**: precio de lista de `MODEL_PRICES` (agent-core) × un uso típico (6,000 tokens de entrada y 400 de salida por mensaje; 12,000 y 500 por minuto de
cascada). No es una factura: el costo real lo reporta OpenRouter por llamada.

## Base de conocimiento automática (equivalente a los `[Auto]` del original)

`generarConocimientoAuto` arma cuatro documentos desde los datos de la cuenta: **sucursales y horarios**, **menú y precios por sucursal**, **colonia → sucursal más
cercana** (con alerta cuando las dos más cercanas quedan a menos de 1 km de diferencia) y **preguntas frecuentes** (solo las que tienen dato). No hay texto escrito a mano y
**no se guardan copias**: cada lectura sale de los datos vigentes, así que se "re-sincroniza" sola (la huella cambia cuando cambia un dato). El precio que se cobra sigue saliendo
de `cotizar_pedido`.

- **Ventas** y **personal** no se generan: el agente que atiende al cliente no necesita cifras de ventas (el Copiloto las responde con datos en vivo) y el personal es información
  de personas. La pantalla lo dice con su razón.
- Tope de 6,000 caracteres en la instrucción de voz, en orden de prioridad; un documento que no cabe **entero** se omite (nunca a medias) y el agente lo consulta en vivo con sus herramientas.
- WhatsApp **no** recibe los documentos: ya consulta el menú y las sucursales en vivo con herramientas y el prompt de cada mensaje pagaría esos tokens en todos los turnos.

## Despliegue

1. Mergear el código (compatible con la base sin migrar: GET devuelve los valores de siempre con `disponible: false`; PUT responde 503; el agente se comporta igual).
2. Aplicar `packages/domain-restaurantes/migrations/055_ajustes_agente_modelo_voz_fondo.sql` (espejo `supabase/migrations/20240101000330_...`). Después de aplicarla se pueden guardar ajustes.
2b. Aplicar `packages/domain-restaurantes/migrations/087_ajustes_agente_ambiente_tecleo_humano.sql` (espejo `supabase/migrations/20240101000398_...`): cuatro columnas en la misma tabla (preset de ambiente, tecleo, volumen del tecleo, naturalidad). Sin ella, GET devuelve `ambienteDisponible: false`, los ajustes de siempre siguen funcionando y guardar lo nuevo responde 503 («No disponible aún: requiere la migración 087»). Verificación: `scripts/verify-restaurantes-voz-ambiente-tecleo/` (Postgres real, puerto 55787). **Esta migración no se ha aplicado a ninguna base.**
3. Sin variables nuevas ni crons nuevos. Cambiar el modelo de WhatsApp requiere `OPENROUTER_API_KEY` (sin ella, el gateway real no existe y la elección no tiene efecto).

## Lo que el worker de llamadas aplica hoy (`apps/voice-worker`)

`POST /internal/restaurantes/voz/llamada/contexto` ahora devuelve, además de la instrucción: `sonido` (fondo con preset y volumen, tecleo con volumen) y `temperatura`. La instrucción
ya incluye ritmo, estilo y, si está activa, la naturalidad (`instruccionConAjustes`). El worker:

- abre un `MezcladorSalida` solo si la telefonía sabe bombear una salida mezclada y hay fondo o tecleo activos (si no, la llamada suena como siempre); en LiveKit un bombeo continuo de
  tramas de 20 ms alimenta la pista del agente (`bombearSalida`);
- avisa inicio y fin de CADA herramienta al tecleo desde el ejecutor del controlador (el mismo punto para Gemini Live y para la cascada);
- baja el ambiente y corta el tecleo cuando el puente de audio oye hablar al cliente, y vacía la cola de voz del agente en un barge-in;
- pone la temperatura en la apertura de la sesión (la leen Gemini Live y la cascada).

Sigue SIN aplicarse en llamadas reales: `modeloCascada` (el modelo de la cascada de los ajustes) y la verbalización por umbral en milisegundos (la espera se enmascara con la frase pedida en la
instrucción y con el tecleo, no con un temporizador). Nada de esto se ha probado contra LiveKit, Twilio ni Gemini reales.
