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
Uso su nombre, teléfono, dirección, ubicación (si la comparte), mensajes y pedido para tomar y entregar su pedido y atenderle; no pedimos datos de tarjeta. Si nos cuenta una alergia, la usamos solo para su pedido.
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

```
Hola, soy el asistente virtual de [[POR COMPLETAR: nombre comercial]]; soy una inteligencia artificial, no una persona.
Sus datos los trata [[POR COMPLETAR: razón social]], domicilio [[POR COMPLETAR: domicilio, dicho en una frase corta]], para tomar y entregar su pedido.
El aviso de privacidad completo está en [[POR COMPLETAR: página o "la sucursal"]]. Para ejercer sus derechos sobre sus datos, escriba "mis datos personales" por WhatsApp o dígalo en la sucursal.
¿Autoriza que esta llamada se grabe y se transcriba para mejorar el servicio? Se guarda [[POR COMPLETAR: días]] días. Si dice que no, lo atiendo igual, sin grabar.
```

Respuestas ya implementadas (no cambian): si autoriza, "Gracias, queda registrado"; si dice que no, "Sin problema: esta llamada no se graba"; si es ambiguo, **no se graba** (`interpretRecordingConsent`).

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
