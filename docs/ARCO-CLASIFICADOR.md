# Detector ARCO hibrido (regex + clasificador LLM + herramienta del agente)

Un falso negativo de una solicitud ARCO es incumplimiento legal (LFPDPPP; la respuesta corre 20 dias habiles desde la recepcion) y un falso positivo arruina un pedido. Dos revisiones
independientes con corpus nuevos mostraron que un detector de regex puro no generaliza (recall de 76 % y 69 % sobre frases que no habia visto). Por eso el atajo ARCO del agente de WhatsApp de
restaurantes tiene TRES capas; las dos primeras corren en el webhook ANTES del agente, la tercera es del propio agente.

| Capa | Que hace | Cuando corre | Si falla |
|---|---|---|---|
| 1. Regex determinista (`privacidad/arco-deteccion.ts`) | Raices etiquetadas (derecho + fuerza) de ALTA precision. Una senal FUERTE registra la solicitud y toma el turno. | Siempre, por mensaje, sin costo. | No falla. |
| 2. Clasificador LLM (`privacidad/clasificador-arco.ts`, rol `restaurantes:clasificador_arco`) | Salida JSON estricta `{intencion, confianza, derecho_mas_probable}`. Sube a peticion lo que la regex no vio (confianza >= 0.7), a senal debil (0.4-0.7), y puede DESCARTAR una senal regex debil o de precision media (`arbitrable`) con «ninguna» >= 0.8. | Por mensaje donde la regex no vio nada FUERTE y el mensaje pasa el prefiltro de vocabulario (lo claramente solo-pedido no llega al modelo). Una rafaga partida se clasifica con sus ultimos 3 mensajes juntos (solo para clasificar; el registro guarda el texto del cliente). | Fail-open: timeout (2 s), proveedor, JSON invalido, tope diario o interruptor apagado -> se queda la capa regex, el pedido NUNCA se bloquea, la falla se registra (sin texto del cliente). |
| 3. Herramienta `registrar_solicitud_arco` del agente | El modelo principal registra la solicitud cuando reconoce la intencion aunque ni 1 ni 2 la vieran («para que quieren mi numero», «paren de mandarme mensajes»). | Dentro del turno del agente (solo WhatsApp). | Sin puerto o base sin migrar: responde que escale con `privacidad_arco`. |

Las tres capas registran igual (`registrarSolicitudArco`): solicitud pendiente de CONFIRMO (24 h), plazos de la 030, telefono canonico `+52` + 10 digitos (la solicitud registrada por voz la
encuentra el CONFIRMO de WhatsApp), `detail` redactado. Una senal debil nunca registra ni descarta el mensaje: el agente sigue con el pedido y se agrega la oferta de derechos.

## Privacidad del clasificador

- Al proveedor viaja SOLO el texto del propio mensaje del cliente: tarjetas redactadas y numeros de 7+ digitos reemplazados por `[numero]`, acotado a 1200 caracteres. Ningun telefono, nombre
  de organizacion ni historial. Va por el gateway LLM unico: proveedores de EE.UU. con ZDR (`VERIFIED_MODEL_HOSTS`), interruptor de plataforma y registro de gasto por rol.
- El registro de eventos (`arco_clasificador`) lleva intencion, confianza, modelo, tokens, costo, latencia y el motivo de la falla; nunca el texto.

## Modelo y costo

- Ruta del rol = tareas cortas del gateway: `openai/gpt-6-luna` (razonamiento bajo, sin `temperature`) y respaldo `deepseek/deepseek-v4.1-flash`. `anthropic/claude-haiku-5.5` existe en
  OpenRouter ($0.10 / $0.50 por millon de tokens, igual que Luna) pero NO esta en `VERIFIED_MODEL_HOSTS` (sin proveedor EE.UU./ZDR verificado) y la politica de proveedores no se relaja.
- Costo por llamada (ESTIMADO con precios de lista, sin medir): prompt ~790 tokens + mensaje + esquema ~ 950 entrada x $0.10/M = $0.000095, y ~250 de salida/razonamiento x $0.50/M =
  $0.000125, o sea **~US$0.0002 por mensaje clasificado** como techo. Con el prefiltro solo pasan los mensajes que tocan datos, contacto o listas; en el corpus de prueba (hecho de frases
  cercanas a ARCO a proposito) pasa el 92 %, en trafico real de pedidos sera una fraccion pequena. 10 000 mensajes clasificados al mes = ~US$2. La medicion real (tokens y costo por
  llamada) la imprime `scripts/medir-clasificador-arco`.
- Topes: 2 s por llamada; 1000 llamadas por organizacion y dia en proceso; 3000 por organizacion y dia en el rol del gateway (persistente, `llm-role-limits.ts`); presupuesto mensual por
  organizacion del gateway; interruptor de plataforma `restaurantes:clasificador_arco`.

## Medicion con el modelo real

`scripts/medir-clasificador-arco/medir.ts` corre el sistema hibrido (el mismo `intencionesPorMensaje` de produccion) contra: corpus del revisor #533 (209), corpus del revisor #545 partido en
DESARROLLO (113, se uso para afinar la regex) y CIEGO (112, nunca se leyo ni se afino contra el), corpus propio (134) y las 11 rafagas. Imprime recall y falsos positivos por corpus, mezcla
regex/modelo, tokens, costo por llamada, latencia p50/p95 y cuantas pasarian de 2 s. Tope duro de gasto (`--tope-usd`, 3 por omision); la llave de OpenRouter va en el ENTORNO, nunca se
imprime ni se guarda:

```
set -a; . <archivo con OPENROUTER_API_KEY>; set +a
npx vite-node scripts/medir-clasificador-arco/medir.ts -- --modelo openai/gpt-6-luna --salida docs/ARCO-CLASIFICADOR-MEDICION.json
```

### Resultado de la capa regex sola (medido, sin modelo; `--solo-regex`)

| Corpus | recall | falsos positivos |
|---|---|---|
| #545 desarrollo (56 ARCO / 51 no ARCO) | 98,2 % | 0 |
| #545 CIEGO (56 / 53) | 91,1 % | 1 |
| #533 (115 / 84) | 100 % | 0 |
| propio (69 / 65) | 100 % | 0 |
| rafagas (cada mensaje por separado) | 8 de 11 | |

El 100 % de #533 y propio y el 98 % del desarrollo estan sesgados (se afino la regex mirandolos); el 91 % del corpus CIEGO es la estimacion honesta de la capa regex sola. El objetivo
del sistema completo (recall >= 98 %) depende de la capa 2.

### Resultado con el modelo real

PENDIENTE: ver el cuerpo del PR. Este repositorio no incluye ninguna llave de OpenRouter para Atiende y la medicion no se corrio con una llave ajena.
