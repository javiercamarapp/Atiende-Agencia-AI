# Avisos de privacidad simplificados (WhatsApp, voz y web)

> **BORRADOR técnico. No es asesoría legal.** Requiere revisión de abogado especialista. Los marcadores `[[POR COMPLETAR: ...]]` no se inventan; este archivo no se publica con ellos.
> Fundamento: LFPDPPP (DOF 20-mar-2025), Art. 16 fr. II: el aviso simplificado debe contener **al menos las fracciones I a IV del Art. 15** (identidad y domicilio; datos y cuáles son sensibles;
> finalidades distinguiendo las que requieren consentimiento; opciones para limitar uso o divulgación) e indicar **dónde consultar el integral**. Además, por el Art. 15 fr. V, conviene
> decir cómo ejercer ARCO. El integral completo es `aviso-privacidad-integral.md`.

## Estado actual en el código y brecha

Hoy el primer mensaje lo genera `privacyNoticeWhatsApp` (`packages/domain-restaurantes/src/privacidad/aviso.ts`) y la llamada `voiceOpeningScript`. Ambos ya dicen que es un asistente virtual,
el uso de datos para el pedido, la retención y "mis datos personales" para ARCO. **Les falta**, frente al Art. 16 fr. II: el **domicilio** del responsable, la distinción de finalidades que requieren
consentimiento (historial, grabación) y la opción de limitar el uso. Los textos de abajo cierran esa brecha. No se cambió el código: es una decisión de producto, porque modifica el primer mensaje de
todos los restaurantes y hace obligatorio capturar el domicilio en `privacy_config` (hoy no existe ese campo).

## 1. Primer mensaje de WhatsApp (versión propuesta)

WhatsApp admite mensajes largos, pero el primero debe leerse rápido: se propone **un mensaje de aviso** y el saludo normal después.

```
Soy el asistente virtual (una inteligencia artificial) de [[POR COMPLETAR: nombre comercial]]. Responsable de sus datos: [[POR COMPLETAR: razón social]], [[POR COMPLETAR: domicilio]].
Uso su nombre, teléfono, dirección, ubicación (si la comparte), mensajes y pedido para tomar y entregar su pedido y atenderle; no pedimos datos de tarjeta. No pedimos datos sensibles; si tiene una alergia, se la pasamos a una persona de la sucursal. [[POR COMPLETAR: texto final de consentimiento expreso y por escrito para datos sensibles (Art. 8), definido con abogado]]
Además, con su permiso guardamos su historial para recordar "su pedido de siempre". Si no quiere, escriba "sin historial" y le atendemos igual.
Compartimos datos con proveedores tecnológicos (WhatsApp/Meta, modelos de IA, voz) que pueden estar fuera de México, solo para dar el servicio.
Para acceder, rectificar, cancelar u oponerse (ARCO), o revocar su permiso, escriba "mis datos personales". Aviso integral: [[POR COMPLETAR: URL del aviso integral]]
```

Longitud orientativa: unos 900 caracteres.

**Versión corta (cuando el integral no esté publicado todavía) — NO usar como sustituto del integral:**
el Art. 16 exige indicar dónde consultar el integral; sin URL el mensaje debe decir cómo pedirlo ("pídalo a la sucursal"), que es lo que hace hoy el código. Pero el aviso integral
**debe existir y estar a disposición** (Art. 14-16), así que esta versión es transitoria.

## 2. Guion de apertura de la llamada (voz)

Se dice en voz natural, sin leer cifras largas. La pregunta de grabación es **obligatoria** cuando la retención de voz es mayor que 0; con 0 la llamada no se graba y no se pregunta.
Es **el mismo texto** que dice el código (`voiceOpeningScript` en `packages/domain-restaurantes/src/privacidad/aviso.ts`). Va **corto a propósito**: la E2E del 6-nov-2026 midió que el
guion anterior (~90 palabras) ocupaba los primeros 25 s y el cliente contestaba con su pedido encima; el tope es de 45 palabras con un nombre comercial de 4 palabras.

```
Soy el asistente virtual de [[POR COMPLETAR: nombre comercial]], inteligencia artificial.
Uso sus datos solo para su pedido.
Su voz la procesa un proveedor externo para entenderle.
Aviso y derechos: WhatsApp o sucursal.            (con URL publicada: «Aviso en la página; derechos: WhatsApp.»)
¿Autoriza grabar y transcribir la llamada [[POR COMPLETAR: días]] días para mejorar el servicio?
```

Qué cubre cada frase: identidad y que es una IA; finalidad de los datos; encargado de voz (ElevenLabs) aunque no se autorice grabar; dónde está el aviso integral (Art. 16) y el
canal para ejercer los derechos ARCO (escribir "mis datos personales" por WhatsApp o pedirlo en la sucursal); consentimiento expreso de grabar **y transcribir**, con plazo y finalidad.
La pregunta es **cerrada** (sí/no): no ofrece una alternativa en la misma frase, para que un «sí» no sea ambiguo.

La frase «Su voz la procesa un proveedor externo para entenderle» es `VOICE_PROCESSOR_NOTICE`: el audio pasa por ElevenLabs aunque no se autorice grabar, y ElevenLabs puede conservarlo según su política (sección 6.1 del integral).
El nombre del responsable, su domicilio y el detalle de los derechos van en el aviso integral (el guion de voz ya no los lee por la duración; pendiente de visto bueno legal).

Respuestas ya implementadas: si autoriza, "Gracias, queda registrado"; si dice que no, "Sin problema: esta llamada no se graba" y se le atiende igual (la llamada no se condiciona al
consentimiento); si es ambiguo, **no se graba** (`interpretRecordingConsent`).

## 3. Texto corto para el sitio y para formularios web

```
Tratamos sus datos de contacto y de pedido para atenderle. Responsable: [[POR COMPLETAR: razón social]], [[POR COMPLETAR: domicilio]]. No pedimos datos sensibles ni de tarjeta.
Puede limitar el uso de su historial o negarse a mensajes comerciales y ejercer sus derechos ARCO en [[POR COMPLETAR: correo ARCO]]. Aviso integral: [[POR COMPLETAR: URL]]
```

## 4. Mensajes de apoyo (cuando el cliente escribe "mis datos personales")

El detector ARCO (#533/#545) ya responde un menú y registra la solicitud. Frase de apoyo al final del menú, propuesta:

```
Responderemos en máximo 20 días hábiles y es gratis. Guarde su número de referencia. Si no queda conforme, puede acudir a la Secretaría Anticorrupción y Buen Gobierno.
```

**Revocación / "sin historial"**: texto de confirmación propuesto:

```
Listo: ya no usaremos su historial para recordar su pedido. Puede cambiarlo cuando quiera escribiendo "mis datos personales".
```

(La opción "sin historial" no existe hoy como función en el agente; es un requerimiento de producto pendiente derivado de la distinción primaria/secundaria. Hasta que exista, el aviso de WhatsApp
no debe prometerla: usar la versión actual del código o quitar esa frase.)
