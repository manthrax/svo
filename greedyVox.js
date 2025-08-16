import * as THREE from 'three';
import {makePaletteTexture} from './svo5.js';

// --- Greedy mesh builder ---
export function buildGreedyFromDense(voxels, size) {
  const dims = [size, size, size];
  const quads = [];
  const mask = new Int32Array(size * size);
  const x = [0, 0, 0];
  const q = [0, 0, 0];
  const index = (x, y, z) => x + y * size + z * size * size;
  for (let d = 0; d < 3; d++) {
    const u = (d + 1) % 3;
    const v = (d + 2) % 3;
    q[0] = q[1] = q[2] = 0;
    q[d] = 1;
    for (x[d] = -1; x[d] < dims[d];) {
      let n = 0;
      for (x[v] = 0; x[v] < dims[v]; ++x[v]) {
        for (x[u] = 0; x[u] < dims[u]; ++x[u], ++n) {
          const a = (x[d] >= 0) ? voxels[index(x[0], x[1], x[2])] : 0;
          const b = (x[d] < dims[d] - 1) ? voxels[index(x[0] + q[0], x[1] + q[1], x[2] + q[2])] : 0;
          if (a && b && a === b) {
            mask[n] = 0;
          } else if (a) {
            mask[n] = a;
          } else if (b) {
            mask[n] = -b;
          } else {
            mask[n] = 0;
          }
        }
      }
      ++x[d];
      n = 0;
      for (let j = 0; j < dims[v]; ++j) {
        for (let i = 0; i < dims[u];) {
          const c = mask[n];
          if (c) {
            let w;
            for (w = 1; i + w < dims[u] && mask[n + w] === c; ++w) {}
            let h;
            outer: for (h = 1; j + h < dims[v]; ++h) {
              for (let k = 0; k < w; ++k) {
                if (mask[n + k + h * dims[u]] !== c) {
                  break outer;
                }
              }
            }
            x[u] = i;
            x[v] = j;
            const o = [x[0], x[1], x[2]];
            const sizeVec = [0, 0, 0];
            sizeVec[u] = w;
            sizeVec[v] = h;
            sizeVec[d] = c > 0 ? 1 : -1;
            if (c < 0) {
              o[0] += q[0];
              o[1] += q[1];
              o[2] += q[2];
            }
            quads.push({ origin: o, size: sizeVec });
            for (let jj = 0; jj < h; ++jj) {
              for (let ii = 0; ii < w; ++ii) {
                mask[n + ii + jj * dims[u]] = 0;
              }
            }
            i += w;
            n += w;
          } else {
            ++i;
            ++n;
          }
        }
      }
    }
  }
  const count = quads.length;
  const origins = new Float32Array(count * 3);
  const sizes = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    origins.set(quads[i].origin, i * 3);
    sizes.set(quads[i].size, i * 3);
  }
  return { origins, sizes, count };
}

// --- Material setup ---
const uniforms = {
  uVoxTex: { value: null },
  uVoxSize: { value: 1 },
  uPalette: { value: null }
};

export const mat = new THREE.MeshStandardMaterial({ side: THREE.DoubleSide });
mat.onBeforeCompile = injectShader;

function injectShader(s) {
  s.uniforms.uVoxTex = uniforms.uVoxTex;
  s.uniforms.uVoxSize = uniforms.uVoxSize;
  s.uniforms.uPalette = uniforms.uPalette;
  const vs = 'vertexShader';
  const fs = 'fragmentShader';
  const rep = (sd, chunk, fn) => {
    s[sd] = s[sd].replace(`#include <${chunk}>`, fn(`#include <${chunk}>`));
  };
  rep(vs, 'common', (t) => t + `
  attribute vec3 aOrigin;
  attribute vec3 aSize;
  uniform float uVoxSize;
  varying vec3 vVoxCoord;
  //varying vec3 vNormal;
  `);
  rep(vs, 'beginnormal_vertex', () => 'vec3 objectNormal = vNormal;');
  rep(vs, 'begin_vertex', () => `
    vec3 origin = aOrigin;
    vec3 size = abs(aSize);
    vec3 dir = sign(aSize);
    vec3 pos;
    vec3 n;
    if(dir.x != 0.0){
      pos = origin + vec3(0.0, position.x * size.y, position.y * size.z);
      pos.x += (dir.x > 0.0) ? size.x : 0.0;
      n = vec3(dir.x,0.0,0.0);
    }else if(dir.y != 0.0){
      pos = origin + vec3(position.x * size.x, 0.0, position.y * size.z);
      pos.y += (dir.y > 0.0) ? size.y : 0.0;
      n = vec3(0.0,dir.y,0.0);
    }else{
      pos = origin + vec3(position.x * size.x, position.y * size.y, 0.0);
      pos.z += (dir.z > 0.0) ? size.z : 0.0;
      n = vec3(0.0,0.0,dir.z);
    }
    vVoxCoord = pos;
    vNormal = n;
    vec3 transformed = pos / uVoxSize - 0.5;
  `);
  rep(fs, 'common', (t) => t + `\nuniform sampler3D uVoxTex;\nuniform sampler2D uPalette;\nuniform float uVoxSize;\nvarying vec3 vVoxCoord;`);
  rep(fs, 'map_fragment', () => `
    ivec3 coord = ivec3(vVoxCoord);
    float id = texelFetch(uVoxTex, coord, 0).r;
    vec4 pal = texelFetch(uPalette, ivec2(int(id * 255.0), 0), 0) / 255.0;
    diffuseColor = pal;
  `);
}

// --- Upload helpers ---
let uVoxTex = null;
let uPaletteTex = null;
export function uploadVoxels(bytes, size) {
  if (!uVoxTex || uVoxTex.image.width !== size) {
    uVoxTex = new THREE.Data3DTexture(bytes, size, size, size);
    uVoxTex.format = THREE.RedFormat;
    uVoxTex.type = THREE.UnsignedByteType;
    uVoxTex.minFilter = uVoxTex.magFilter = THREE.NearestFilter;
    uVoxTex.wrapR = uVoxTex.wrapS = uVoxTex.wrapT = THREE.ClampToEdgeWrapping;
    uVoxTex.needsUpdate = true;
    uniforms.uVoxTex.value = uVoxTex;
  } else {
    uVoxTex.image.data.set(bytes);
    uVoxTex.needsUpdate = true;
  }
  uniforms.uVoxSize.value = size;
}

export function ensurePalette(tex) {
  if (!uPaletteTex) {
    uPaletteTex = tex || makePaletteTexture();
    uniforms.uPalette.value = uPaletteTex;
  } else if (tex) {
    uPaletteTex.image.data.set(tex.image.data);
    uPaletteTex.needsUpdate = true;
  }
}

// --- Mesh creation ---
export function makeMesh(voxels, size) {
  const { origins, sizes, count } = buildGreedyFromDense(voxels, size);
  const base = new THREE.PlaneGeometry(1, 1);
  const geo = new THREE.InstancedBufferGeometry().copy(base);
  geo.instanceCount = count;
  geo.setAttribute('aOrigin', new THREE.InstancedBufferAttribute(origins, 3));
  geo.setAttribute('aSize', new THREE.InstancedBufferAttribute(sizes, 3));
  return new THREE.Mesh(geo, mat);
}
