# Body Mirror

App web para cargar un modelo 3D y moverlo con tu cuerpo usando la cámara.
La webcam detecta tu pose con [MediaPipe Pose](https://ai.google.dev/edge/mediapipe/solutions/vision/pose_landmarker)
(33 puntos 3D) y esos movimientos se trasladan, en tiempo real, al esqueleto del modelo
renderizado con [Three.js](https://threejs.org/).

Todo corre en el navegador: la imagen de la cámara no sale de tu computadora.

## Cómo usarla

Requisitos: Node.js 20.19+ (o 22.12+).

```bash
npm install
npm run dev
```

La terminal muestra dos direcciones:

```
➜  Local:   https://localhost:5173/
➜  Network: https://192.168.x.x:5173/
```

- **En esta PC:** abrí la dirección *Local*.
- **Desde el celular, una tablet u otra PC de la misma red Wi-Fi:** abrí la dirección *Network*.

La app se sirve por HTTPS porque los navegadores sólo dejan usar la cámara con HTTPS (o en
`localhost`). El certificado es autofirmado, así que la primera vez el navegador muestra una
advertencia: tocá *Configuración avanzada → Continuar al sitio* (Chrome) o *Mostrar detalles →
visitar este sitio web* (Safari). En Windows, si el firewall pregunta si Node.js puede usar la
red, permitilo en **redes privadas**.

Otros comandos:

| Comando | Para qué |
| --- | --- |
| `npm run dev` | Desarrollo, HTTPS, accesible en la red local (puerto 5173). |
| `npm run start` | Compila la versión optimizada y la sirve por HTTPS en la red local (puerto 4173). Más fluida en el celular. |
| `npm run dev:local` | Sólo en esta PC, por HTTP y sin advertencia de certificado. |

Una vez abierta:

1. **Cargá un modelo** con el botón *Cargar modelo…* o arrastrándolo a la ventana.
   Si no cargás nada se usa un maniquí articulado.
2. Tocá **Iniciar cámara** y aceptá el permiso.
3. Alejate hasta que la cámara vea tu cuerpo (idealmente entero, a 2–3 m y con buena luz).

## Modelos soportados

| Formato | Notas |
| --- | --- |
| `.glb` / `.gltf` | Con o sin esqueleto. Si el `.gltf` usa archivos externos (`.bin`, texturas), elegilos todos juntos. |
| `.vrm` | VRM 0.x y 1.0 (usa el mapa humanoide del archivo; el pelo/ropa con física se mueve solo). |
| `.fbx` | Por ejemplo, personajes de Mixamo. |
| `.obj` | Elegí el `.obj` **junto con** el `.mtl` y las texturas. |

**Modelos con esqueleto:** los huesos se reconocen por nombre (Mixamo, VRM, Unreal, 3ds Max
Biped, Character Creator, Rigify y Human Generator de Blender, y nombres genéricos tipo
`UpperArm_L`, `hand.R`…).
En *Huesos detectados* podés ver qué encontró. Funciona con cualquier pose de reposo
(T-pose, A-pose…), y el modelo se orienta y escala solo.

**Modelos sin esqueleto (OBJ, GLB estático…):** se *riggean automáticamente*:

1. Se renderiza el modelo de frente y se le pasa MediaPipe a esa imagen para ubicar hombros,
   codos, muñecas, caderas, rodillas, tobillos y cabeza (si no se puede, se estiman por
   proporciones del cuerpo). La profundidad de cada articulación se toma del centro de la malla.
2. Se crea un esqueleto humanoide y se calculan los pesos de piel de cada vértice
   (hueso más cercano según el grosor de cada parte, mezcla suave en las articulaciones y
   suavizado sobre la superficie). Ojos, dientes y otras piezas chicas quedan fijas a la cabeza.
3. Con **Descargar modelo riggeado (.glb)** te llevás el resultado para usarlo en otro lado
   (o volver a cargarlo acá sin esperar el auto-rig).

El auto-rig espera una figura humana parada, de frente o de espaldas, en pose T, A o con los
brazos separados del cuerpo.

### Exportar un modelo riggeado desde Blender

1. Seleccioná el cuerpo **y** su esqueleto (armature): si sólo seleccionás el armature, el
   archivo sale sin malla. Incluí también ojos, dientes, pelo y ropa si los querés.
2. *Archivo → Exportar → glTF 2.0 (.glb/.gltf)*.
3. En las opciones: formato **glTF Binary (.glb)** (así las texturas van dentro del archivo),
   *Incluir → Objetos seleccionados*, y en *Datos → Armature* dejá activado **Skinning**.
   Si el modelo tiene modificadores, activá *Aplicar modificadores*.
4. Cargá el `.glb` en la app. En *Huesos detectados* deberías ver todos con ✓.

**Texturas:** glTF sólo exporta las imágenes conectadas directamente al *Principled BSDF*
(Base Color, Normal, Roughness…). Los materiales procedurales o con grupos de nodos, como la
piel de Human Generator, hay que **hornearlos (bake)** a imágenes antes de exportar; si no, el
modelo se ve con un color liso.

Los esqueletos de Human Generator y Rigify usan nombres como `spine.006` (cabeza) o
`upper_arm.L`; la app los reconoce. Si en *Huesos detectados* aparece algún ✗, ese hueso no
se va a mover: revisá cómo se llama en Blender.

## Controles

- **Modo espejo**: el avatar se mueve como tu reflejo (levantás la mano derecha y se levanta
  la mano del avatar que está del mismo lado de la pantalla). Desactivado, el avatar copia tu
  lado anatómico.
- **Precisión**: *lite* es más rápido, *heavy* más preciso (descarga ~30 MB).
- **Calibrar cabeza**: mirá de frente a la cámara y tocalo si el avatar queda mirando
  levemente hacia arriba o abajo.
- **Seguimiento**: activá/desactivá torso, cabeza, brazos, manos, piernas y *Desplazarse*
  (el avatar se mueve de costado cuando vos te movés). Las partes que la cámara no ve vuelven
  solas a una pose relajada; las piernas además mantienen los pies apoyados en el piso.
- **Suavizado**: más suave = menos temblor pero más retraso (filtro *One Euro*).
- **Ver esqueleto**: muestra los huesos encima del modelo.

## Cómo funciona

```
cámara ─► MediaPipe Pose (33 puntos 3D) ─► filtro One Euro ─► retargeting ─► huesos del modelo
```

- `src/tracking.js` — webcam + `PoseLandmarker` (modo video) y detector de imágenes para el auto-rig.
- `src/landmarks.js` — índices de MediaPipe y conversión al espacio del avatar (incluye el modo espejo).
- `src/filters.js` — filtro One Euro para suavizar los puntos.
- `src/retarget.js` — convierte los puntos en rotaciones: torso con la línea de hombros/caderas,
  cabeza con orejas/ojos, brazos y piernas con la dirección de cada segmento más el plano de
  flexión del codo/rodilla para resolver el giro, manos con la palma y pies con la punta.
- `src/humanoid.js` — reconoce los huesos por nombre en rigs de distintos programas.
- `src/autorig.js` — auto-rig para mallas sin esqueleto.
- `src/model.js` — prepara el modelo (orientación, escala, esqueleto).
- `src/loaders.js` — carga GLB/GLTF/VRM/FBX/OBJ desde archivos locales.
- `src/mannequin.js` — maniquí por defecto.
- `src/main.js` — escena, interfaz y bucle principal.

Los binarios WASM de MediaPipe se copian a `public/mediapipe/wasm` al correr `npm run dev` o
`npm run build`; el modelo de pose (`.task`) se descarga de Google la primera vez.

## Publicarla

```bash
npm run build      # genera dist/
npm run preview    # para probar el build
```

`dist/` es un sitio estático: se puede subir a GitHub Pages, Netlify, Vercel, etc. (tiene que
servirse por HTTPS para poder usar la cámara).

## Limitaciones

- Con una sola cámara la profundidad (hacia adelante/atrás) es estimada: los movimientos
  hacia la cámara son menos precisos que los laterales.
- No se siguen los dedos ni las expresiones de la cara; la mano se orienta como un bloque.
- El botón *Ejemplo (Xbot)* descarga un modelo de `threejs.org`, necesita conexión.
