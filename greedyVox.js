// greedy-mesh-instanced.js
import * as THREE from 'three';
import { makePaletteTexture } from './svo5.js';

// --- Greedy mesh builder (dense -> instanced quads)
// set ignoreMaterials to true to merge faces across different voxel IDs
export function buildGreedyFromDense(voxels, size, ignoreMaterials = false) {
  const dims = [size, size, size];
  const quads = [];
  const mask = new Int32Array(size * size);
  const x = [0, 0, 0];
  const q = [0, 0, 0];
  const index = (x, y, z) => x + y * size + z * size * size;

  for (let d = 0; d < 3; d++) {
    const u = (d + 1) % 3;
    const v = (d + 2) % 3;
    q[0] = q[1] = q[2] = 0; q[d] = 1;

    for (x[d] = -1; x[d] < dims[d];) {
      let n = 0;
      for (x[v] = 0; x[v] < dims[v]; ++x[v]) {
        for (x[u] = 0; x[u] < dims[u]; ++x[u], ++n) {
          const a = (x[d] >= 0) ? voxels[index(x[0], x[1], x[2])] : 0;
          const b = (x[d] < dims[d] - 1) ? voxels[index(x[0] + q[0], x[1] + q[1], x[2] + q[2])] : 0;
          const av = ignoreMaterials ? (a ? 1 : 0) : a;
          const bv = ignoreMaterials ? (b ? 1 : 0) : b;
          mask[n] = (av && bv && av === bv) ? 0 : (av ? av : (bv ? -bv : 0));
        }
      }

      ++x[d];
      n = 0;

      for (let j = 0; j < dims[v]; ++j) {
        for (let i = 0; i < dims[u];) {
          const c = mask[n];
          if (c) {
            let w = 1;
            while (i + w < dims[u] && mask[n + w] === c) ++w;
            let h = 1;
            outer: for (; j + h < dims[v]; ++h) {
              for (let k = 0; k < w; ++k) {
                if (mask[n + k + h * dims[u]] !== c) break outer;
              }
            }

            x[u] = i; x[v] = j;
            const o = [x[0], x[1], x[2]];
            const sizeVec = [0, 0, 0];
            sizeVec[u] = w;
            sizeVec[v] = h;
            // thickness encoded with sentinel ±0.5 so it never collides with w/h=1
            sizeVec[d] = c > 0 ? 0.5 : -0.5;
            if (c < 0) { o[0] += q[0]; o[1] += q[1]; o[2] += q[2]; }

            quads.push({ origin: o, size: sizeVec });

            for (let jj = 0; jj < h; ++jj)
              for (let ii = 0; ii < w; ++ii)
                mask[n + ii + jj * dims[u]] = 0;

            i += w; n += w;
          } else { ++i; ++n; }
        }
      }
    }
  }

  const count = quads.length;
  const origins = new Float32Array(count * 3);
  const sizes   = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    origins.set(quads[i].origin, i * 3);
    sizes.set(quads[i].size, i * 3);
  }
  return { origins, sizes, count };
}

// --- Material setup ---
const uniforms = {
  uVoxTex:  { value: null },
  uVoxSize: { value: 1 },
  uPalette: { value: null }
};

export const mat = new THREE.MeshStandardMaterial({
  //side: THREE.DoubleSide, 
  metalness: 0.0, 
  roughness: 1.,
  wireframe:false,
  //opacity:.5,
  //transparent:true,
});
mat.onBeforeCompile = injectShader;

function injectShader(s) {
  s.uniforms.uVoxTex = uniforms.uVoxTex;
  s.uniforms.uVoxSize = uniforms.uVoxSize;
  s.uniforms.uPalette = uniforms.uPalette;

  const rep = (sd, chunk, fn) => { s[sd] = s[sd].replace(`#include <${chunk}>`, fn(`#include <${chunk}>`)); };

  // --- VERTEX ---
  rep('vertexShader', 'common', (t) => t + `
    attribute vec3 aOrigin;
    attribute vec3 aSize;
    uniform float uVoxSize;
    varying vec3 vVoxCoord;   // voxel-space position on the face
    varying vec3 vFacetNrm;   // object-space constant face normal

    vec3 faceNormal(vec3 asz){
      // thickness component has magnitude ~0.5, w/h are >=1.0
      if (abs(asz.x) < 0.75) return vec3(sign(asz.x),0.,0.);
      if (abs(asz.y) < 0.75) return vec3(0.,sign(asz.y),0.);
      return vec3(0.,0.,sign(asz.z));
    }
  `);

  // Let StandardMaterial build the correct transformed normal
  rep('vertexShader', 'beginnormal_vertex', () => `
    vec3 objectNormal = faceNormal(aSize);
  `);

  rep('vertexShader', 'begin_vertex', () => `
    vec3 origin = aOrigin;
    vec3 size   = abs(aSize);
    vec3 n      = faceNormal(aSize);
    vec2 p      = uv; // 0..1 across quad

    vec3 pos;
    if (abs(aSize.x) < 0.75) {       // thickness along X → plane is YZ
      if (aSize.x > 0.) {
        pos = origin + vec3(0., p.x*size.y, p.y*size.z);
      } else {
        pos = origin + vec3(-1., (1.0-p.x)*size.y, p.y*size.z);
      }
    } else if (abs(aSize.y) < 0.75) { // thickness along Y → plane is XZ
      if (aSize.y > 0.) {
        pos = origin + vec3(p.x*size.x, 0., p.y*size.z);
      } else {
        pos = origin + vec3(p.x*size.x, -1., (1.0-p.y)*size.z);
      }
    } else {                          // thickness along Z → plane is XY
      if (aSize.z > 0.) {
        pos = origin + vec3(p.x*size.x, p.y*size.y, 0.);
      } else {
        pos = origin + vec3((1.0-p.x)*size.x, p.y*size.y, -1.);
      }
    }
    vVoxCoord = pos;
    vFacetNrm = n;

    vec3 transformed = (pos*vec3(-1.,-1.,1.)) / uVoxSize - 0.5;
  `);

  // --- FRAGMENT ---
  rep('fragmentShader', 'common', (t) => t + `
    uniform sampler3D uVoxTex;
    uniform sampler2D uPalette;
    uniform float uVoxSize;
    varying vec3 vVoxCoord;
    varying vec3 vFacetNrm;
  `);

  // Replace albedo fetch with palette lookup; sample half a voxel inside
  rep('fragmentShader', 'map_fragment', () => `
    vec3 sampleP = vVoxCoord - 0.5 * normalize(vFacetNrm);
    ivec3 coord  = clamp(ivec3(sampleP), ivec3(0), ivec3(int(uVoxSize)-1));
    float id     = texelFetch(uVoxTex, coord, 0).r;               // 0..1 already
    vec4 pal     = texelFetch(uPalette, ivec2(int(id*255.0), 0), 0); // DO NOT /255.0
    // Optional: linearize if your palette is authored in sRGB
    // pal.rgb = pow(pal.rgb, vec3(2.2));

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
  if (!uPaletteTex) uPaletteTex = tex || makePaletteTexture();
  else if (tex) { uPaletteTex.image.data.set(tex.image.data); }

  uPaletteTex.minFilter = uPaletteTex.magFilter = THREE.NearestFilter;
  uPaletteTex.generateMipmaps = false;
  if ('colorSpace' in uPaletteTex) uPaletteTex.colorSpace = THREE.LinearSRGBColorSpace;
  else uPaletteTex.encoding = THREE.LinearEncoding;
  uPaletteTex.needsUpdate = true;
  uniforms.uPalette.value = uPaletteTex;
}

// --- Mesh creation ---
export function makeMesh(voxels, size, ignoreMaterials = false) {
  const { origins, sizes, count } = buildGreedyFromDense(voxels, size, ignoreMaterials);
  const base = new THREE.PlaneGeometry(1, 1); // has uv 0..1
  const geo = new THREE.InstancedBufferGeometry().copy(base);
  geo.instanceCount = count;
  geo.setAttribute('aOrigin', new THREE.InstancedBufferAttribute(origins, 3).setUsage(THREE.StaticDrawUsage));
  geo.setAttribute('aSize',   new THREE.InstancedBufferAttribute(sizes,   3).setUsage(THREE.StaticDrawUsage));
  
  let bb = geo.boundingBox = new THREE.Box3();
  bb.setFromBufferAttribute(geo.getAttribute('aOrigin'));
  let bs = geo.boundingSphere = new THREE.Sphere();
  bs.radius = bb.getSize(bs.center).length();
  bb.getCenter(bs.center);
  return new THREE.Mesh(geo, mat);
}
