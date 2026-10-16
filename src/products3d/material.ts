import * as THREE from 'three';

/**
 * One material for every product. Per instance: `aRect` (the product photo's rect in the atlas) and
 * `aColor` (package colour, linear). Per vertex: `aPart` (material slot, see PART) and `uv` (label
 * coordinates, wrapped with fract so labels can repeat around cylinders).
 */
export function productMaterial(atlas: THREE.Texture): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ map: atlas, roughness: 0.55, metalness: 0 });
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute vec4 aRect;
attribute vec3 aColor;
attribute float aPart;
varying vec4 vRect;
varying vec3 vCol;
varying float vPart;
varying vec2 vLab;`,
      )
      .replace(
        '#include <uv_vertex>',
        `#include <uv_vertex>
vRect = aRect; vCol = aColor; vPart = aPart; vLab = uv;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec4 vRect;
varying vec3 vCol;
varying float vPart;
varying vec2 vLab;`,
      )
      .replace(
        '#include <map_fragment>',
        `{
  vec3 body = vCol;
  vec3 c = body;
  float p = vPart;
  if (p > 0.5 && p < 1.5) {
    vec2 f = fract(vLab * 0.9999);
    vec2 luv = mix(vRect.xy, vRect.zw, clamp(f, 0.01, 0.99));
    c = texture2D(map, luv).rgb;
  }
  else if (p < 2.5 && p > 1.5) c = body * 0.45;
  else if (p < 3.5 && p > 2.5) c = vec3(0.85, 0.85, 0.83);
  else if (p < 4.5 && p > 3.5) c = vec3(0.75, 0.76, 0.78);
  else if (p < 5.5 && p > 4.5) c = mix(body, vec3(0.92), 0.6);
  else if (p < 6.5 && p > 5.5) c = body * 0.28 + vec3(0.02, 0.05, 0.03);
  else if (p < 7.5 && p > 6.5) c = vec3(0.10, 0.32, 0.08);
  else if (p > 7.5) c = vec3(0.33, 0.2, 0.1);
  diffuseColor.rgb *= c;
}`,
      )
      .replace(
        '#include <metalnessmap_fragment>',
        `#include <metalnessmap_fragment>
if (vPart > 3.5 && vPart < 4.5) { metalnessFactor = 0.9; roughnessFactor = 0.28; }
else if (vPart > 4.5 && vPart < 6.5) { roughnessFactor = 0.12; }
else if (vPart > 0.5 && vPart < 1.5) { roughnessFactor = 0.42; }
else if (vPart > 6.5) { roughnessFactor = 0.8; }`,
      );
  };
  m.customProgramCacheKey = () => 'oda-product-v1';
  return m;
}
