import*as THREE from 'three';

// ----- Utils -----
const NUM_RESERVED = 256;
// 0..255 leaf (0 empty), >=256 = child pointer
function isPow2(n) {
    return (n & (n - 1)) === 0;
}
// default palette (fallback)
export const DEFAULT_VOX_PALETTE = ( () => {
    const arr = new Uint8Array(256 * 4);
    for (let i = 0; i < 256; i++) {
        arr[i * 4 + 0] = i;
        arr[i * 4 + 1] = i;
        arr[i * 4 + 2] = i;
        arr[i * 4 + 3] = 255;
    }
    arr[1 * 4 + 0] = 255;
    arr[1 * 4 + 1] = 255;
    arr[1 * 4 + 2] = 255;
    // 1 = white
    arr[2 * 4 + 0] = 255;
    arr[2 * 4 + 1] = 64;
    arr[2 * 4 + 2] = 64;
    // 2 = reddish
    return arr;
}
)();

export function makePaletteTexture(bytes) {
    const data = bytes || DEFAULT_VOX_PALETTE;
    const tex = new THREE.DataTexture(data,256,1,THREE.RGBAFormat,THREE.UnsignedByteType);
    tex.magFilter = tex.minFilter = THREE.NearestFilter;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;
    return tex;
}

// ----- SVO builder (CPU) -----
// voxels: Uint8Array length size^3, 0 empty, 1..255 palette index
export function buildSVOFromDense(voxels, size, maxTexWidth = 4096) {
    if (!isPow2(size))
        throw new Error('size must be power of two');
    const nodes = [];
    // array of Uint32Array(8)
    function rec(x, y, z, s) {
        // Homogeneity check
        let first = voxels[(x) + (y) * size + (z) * size * size];
        let homogeneous = true;
        outer: for (let zz = 0; zz < s; zz++) {
            const zOff = (z + zz) * size * size;
            for (let yy = 0; yy < s; yy++) {
                const row = (y + yy) * size + zOff;
                for (let xx = 0; xx < s; xx++) {
                    const v = voxels[x + xx + row];
                    if (v !== first) {
                        homogeneous = false;
                        break outer;
                    }
                }
            }
        }
        if (homogeneous) {
            return first >>> 0;
        }
        const halfSize = s >> 1;
        const c = new Uint32Array(8);
        let idx = 0;
        for (let zz = 0; zz < 2; zz++)
            for (let yy = 0; yy < 2; yy++)
                for (let xx = 0; xx < 2; xx++,
                idx++) {
                    c[idx] = rec(x + xx * halfSize, y + yy * halfSize, z + zz * halfSize, halfSize);
                }
        // collapse identical leaves
        const a = c[0];
        if (a < NUM_RESERVED) {
            if (c[1] === a && c[2] === a && c[3] === a && c[4] === a && c[5] === a && c[6] === a && c[7] === a)
                return a;
        }
        const nodeId = nodes.length >>> 0;
        nodes.push(c);
        return (NUM_RESERVED + nodeId) >>> 0;
    }
    let rootPtr = rec(0, 0, 0, size);
    let rootId;
    if (rootPtr >= NUM_RESERVED)
        rootId = (rootPtr - NUM_RESERVED) >>> 0;
    else {
        const id = nodes.length >>> 0;
        const c = new Uint32Array(8);
        c.fill(rootPtr);
        nodes.push(c);
        rootId = id;
    }
    // pack nodes (two texels per node) into 2D texture
    const nodeCount = nodes.length;
    const texels = nodeCount * 2;
    const width = Math.min(texels, maxTexWidth);
    const height = Math.ceil(texels / width);
    const data = new Float32Array(width * height * 4);
    for (let i = 0; i < nodeCount; i++) {
        const c = nodes[i];
        const base = i * 8;
        data.set([c[0], c[1], c[2], c[3]], base);
        data.set([c[4], c[5], c[6], c[7]], base + 4);
    }
    return {
        data,
        width,
        height,
        rootId,
        svoSize: size
    };
}

// ----- Self-tests (console) -----
(function runSelfTests() {
    // Test 1: all empty -> one node, all children 0
    const S = 8;
    const dense0 = new Uint8Array(S * S * S);
    const p0 = buildSVOFromDense(dense0, S);
    console.assert(p0.width === 2, 'Empty volume should pack to 1 node (width=2 texels)');
    let allZero = true;
    for (let i = 0; i < 8; i++) {
        allZero = allZero && (p0.data[i] === 0);
    }
    console.assert(allZero, 'Root node children should be zero');
    // Test 2: single voxel -> should create >1 node
    const dense1 = new Uint8Array(S * S * S);
    dense1[S / 2 + (S / 2) * S + (S / 2) * S * S] = 5;
    const p1 = buildSVOFromDense(dense1, S);
    console.assert(p1.width >= 4, 'Single voxel should create multiple nodes (width>=4)');
    // Test 3: solid volume with value 9 -> one node filled with 9
    const dense2 = new Uint8Array(S * S * S);
    dense2.fill(9);
    const p2 = buildSVOFromDense(dense2, S);
    console.assert(p2.width === 2, 'Solid volume should also pack to 1 node (width=2)');
    let allNine = true;
    for (let i = 0; i < 8; i++) {
        allNine = allNine && (p2.data[i] === 9);
    }
    console.assert(allNine, 'Root node children should all be 9');
}
)();

// ----- Demo dense to bootstrap material -----
export function makeDense(size=64) {
    const vox = new Uint8Array(size * size * size);
    const c = size / 2
      , r = size * 0.35;
    for (let z = 0; z < size; z++) {
        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                const dx = x - c
                  , dy = y - c
                  , dz = z - c;
                const d = Math.hypot(dx, dy, dz);
                const i = x + y * size + z * size * size;
                vox[i] = (d < r ? 2 : 0);
                // red index 2
            }
        }
    }
    return vox;
}

// Build initial data BEFORE creating material (avoid TDZ on `mat`)
const initPack = buildSVOFromDense(makeDense(64), 64);
let uSvoTex = new THREE.DataTexture(initPack.data,initPack.width,initPack.height,THREE.RGBAFormat,THREE.FloatType);
uSvoTex.magFilter = uSvoTex.minFilter = THREE.NearestFilter;
uSvoTex.wrapS = uSvoTex.wrapT = THREE.ClampToEdgeWrapping;
uSvoTex.needsUpdate = true;
let uRootNode = initPack.rootId | 0;
let uSvoSize = initPack.svoSize | 0;
let uPaletteTex = makePaletteTexture();

// ----- Material -----
export const mat = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    transparent: true,
    depthWrite: true,
    side: THREE.BackSide,
    uniforms: {
        iTime: {
            value: 0
        },
        iResolution: {
            value: new THREE.Vector2()
        },
        uSvoTex: {
            value: uSvoTex
        },
        uRootNode: {
            value: uRootNode
        },
        uSvoSize: {
            value: uSvoSize
        },
        uPalette: {
            value: uPaletteTex
        },
        uLodPx: {
            value: 0.0
        },
    },
    vertexShader: /* glsl */
    `
    out vec3 vWorldPos;
    void main(){
      vec4 wp = modelMatrix * vec4(position,1.0);
      vWorldPos = wp.xyz;
      gl_Position = projectionMatrix * viewMatrix * wp;
    }
  `,
    fragmentShader: /* glsl */
    `
    precision highp float; 
    precision highp int; 
    precision highp sampler2D;

    // NOTE: 
    uniform mat4 modelMatrix;
    //uniform mat4 viewMatrix;
    uniform mat4 projectionMatrix;
    //uniform vec3 cameraPosition;
    `+`
    
    uniform float iTime; 
    uniform vec2 iResolution;
    
    uniform sampler2D uSvoTex; 
    uniform uint uRootNode;
    uniform uint uSvoSize; 
    uniform sampler2D uPalette;
    uniform float uLodPx;

    in vec3 vWorldPos; out vec4 fragColor;
    const uint NUM_RESERVED_NODES = 256u;

    vec3 palette(uint idx){ return texelFetch(uPalette, ivec2(int(idx),0), 0).rgb; }

uvec4 fetchU32(uint idx){
  uint W = uint( textureSize(uSvoTex,0).x);//uint(textureSize(uSvoTex).x + 0.5);
  ivec2 p = ivec2(int(idx % W), int(idx / W));
  vec4 rf = texelFetch(uSvoTex, p, 0);
  return uvec4(rf + 0.5); // round
}

    uint childOf(uint nodeId, uint childIdx){
      uint texel = nodeId*2u + (childIdx>>2u);
      uvec4 row = fetchU32(uint(texel));//texelFetch(uSvoTex, ivec2(int(texel),0), 0);
      uint lane = childIdx & 3u; return (lane==0u)?row.x:(lane==1u)?row.y:(lane==2u)?row.z:row.w;
    }

    bool rayCubeIntersect(vec3 ro, vec3 rd_inv, vec3 rd_flipped_sign, uvec3 corner, uint size, out float outTmin, out float tmax, out vec3 inNormal){
      vec3 cubeMin = vec3(corner);
      vec3 cubeMax = vec3(corner + size);
      vec3 t0s = (cubeMin - ro) * rd_inv; 
      vec3 t1s = (cubeMax - ro) * rd_inv;
      vec3 tsmaller = min(t0s,t1s); 
      vec3 tbigger = max(t0s,t1s);
      float tmin = max(tsmaller.x, max(tsmaller.y, tsmaller.z)); 
      tmax = min(tbigger.x, min(tbigger.y, tbigger.z));
      bool hit = tmax > max(tmin, 0.0);
      outTmin = max(tmin,0.0); 
      inNormal = vec3(equal(vec3(tmin), tsmaller)) * rd_flipped_sign; 
      return hit;
    }

    vec3 shade(vec3 base, vec3 hitPos, vec3 normal){ 
        vec3 L = normalize(vec3(5.0,16.0,7.5)); 
        float diff = max(dot(normal,L),0.0); 
        return base*diff + vec3(0.1); 
    }

    vec4 trace(inout vec3 ro, inout vec3 rd){
      float tmin, tmax; 
      vec3 normal; 
      vec3 rd_inv = 1.0/rd; 
      vec3 rd_flipped = -sign(rd);
      uint size = uSvoSize; 
      uvec4 stack[32]; 
      uint stack_len=1u; 
      stack[0]=uvec4(uvec3(0), uRootNode);
      for(int i=0;i<128;i++){
        if(stack_len==0u) break;
        uvec4 node = stack[stack_len-1u];
        bool inter = rayCubeIntersect(ro, rd_inv, rd_flipped, node.xyz, size, tmin, tmax, normal);
        if(!inter){ stack_len-=1u; size*=2u; continue; }
        ro += rd * tmin;
        // LOD: optional proxy if projected size < uLodPx
        if(uLodPx > 0.0){
          float s = float(uSvoSize);
          vec3 centerO = (vec3(node.xyz)+float(size)*0.5 - vec3(s*0.5))/s;
          vec3 centerW = (modelMatrix*vec4(centerO,1.0)).xyz;
          float viewZ = -(viewMatrix*vec4(centerW,1.0)).z;
          float focalY = projectionMatrix[1][1]; float px = ( (float(size)/s) * focalY / max(viewZ,1e-4) ) * (iResolution.y*0.5);
          if(px < uLodPx){ vec3 n = normalize(-sign(rd)); return vec4(shade(vec3(0.8), ro, n), 1.0); }
        }
        // descend/select child
        vec3 local = ro - vec3(node.xyz); 
        uint halfSize = size/2u; 
        uvec3 gt = uvec3(greaterThanEqual(local, vec3(halfSize)));
        uvec3 offset = gt * halfSize; 
        uint childIdx = gt.x + 2u*gt.y + 4u*gt.z; 
        uint child = childOf(node.a, childIdx);
        if(child >= NUM_RESERVED_NODES){ 
            stack[stack_len]=uvec4(node.xyz+offset, child-NUM_RESERVED_NODES); 
            stack_len+=1u; 
            size/=2u; 
        }
        else if(child != 0u){ 
            if(tmin==0.0){ 
                inter = rayCubeIntersect(ro, rd_inv, rd_flipped, node.xyz+offset, size/2u, tmin, tmax, normal); 
            }
            return vec4(shade(palette(child), ro, normal), 1.0);
        } else {
            inter = rayCubeIntersect(ro, rd_inv, rd_flipped, node.xyz+offset, size/2u, tmin, tmax, normal); 
            ro += rd*(tmax+0.0001); }
      }
      discard;
      return vec4(0.0);
    }

    void main(){
      vec3 rdW = normalize(vWorldPos - cameraPosition);
      mat4 invModel = inverse(modelMatrix); vec3 roO = (invModel*vec4(cameraPosition,1.0)).xyz; vec3 rdO = normalize((invModel*vec4(rdW,0.0)).xyz);
      float s = float(uSvoSize); 
      vec3 ro = roO*s + vec3(s*0.5);
      vec3 rd = rdO*s;
      vec4 col = trace(ro, rd);
      // depth
      vec3 hitO = (ro - vec3(s*0.5))/s; 
      vec4 hitW = modelMatrix*vec4(hitO,1.0); 
      vec4 clip = projectionMatrix*viewMatrix*hitW; 
      float depth01 = (clip.z/clip.w)*0.5+0.5; 
      gl_FragDepth = depth01;
      fragColor = col;
    }
  `
});

// ----- Upload helpers (AFTER material exists) -----
export function uploadSVO({data, width, height, rootId, svoSize}) {

    if (!uSvoTex || uSvoTex.image.width !== width || uSvoTex.image.height !== height) {
        uSvoTex = new THREE.DataTexture(data,width,height,THREE.RGBAFormat,THREE.FloatType);

        uSvoTex.magFilter = uSvoTex.minFilter = THREE.NearestFilter;
        uSvoTex.wrapS = uSvoTex.wrapT = THREE.ClampToEdgeWrapping;
        uSvoTex.needsUpdate = true;
        mat.uniforms.uSvoTex.value = uSvoTex;
    } else {
        if (uSvoTex.image.data.length !== width * height * 4) {
            uSvoTex.image.data = new Float32Array(width * height * 4);
        }
        uSvoTex.image.data.set(data);
        uSvoTex.needsUpdate = true;
    }
    uRootNode = rootId | 0;
    uSvoSize = svoSize | 0;
    mat.uniforms.uRootNode.value = uRootNode;
    mat.uniforms.uSvoSize.value = uSvoSize;
}
export function ensurePalette(tex) {
    if (!uPaletteTex) {
        uPaletteTex = tex || makePaletteTexture();
        mat.uniforms.uPalette.value = uPaletteTex;
    } else if (tex) {
        uPaletteTex.image.data.set(tex.image.data);
        uPaletteTex.needsUpdate = true;
    }
}

export {uSvoTex};

let hooks={
    metalness:null
}

export function injectShader(s){
    const fs='fragmentShader'
    const vs='vertexShader'
    let replace=(sd,chnk,fn)=>s[sd]=s[sd].replace(`#include <${chnk}>`,fn(`#include <${chnk}>`))
    
    replace(vs,'common',(tk)=>tk+`\n varying vec4 vWorldPos;`);
    replace(fs,'common',(tk)=>tk+`\n`);
    replace(fs,'map_fragment',(tk)=>tk+`\ndiffuseColor = vec4(1.,0.,0.,0.);`);
    replace(fs,'roughnessmap_fragment',(tk)=>tk+`\nroughnessFactor = 0.3;`);
    replace(fs,'metalnessmap_fragment',(tk)=>tk+`\nmetalnessFactor = .9;`);
    replace(fs,'normal_fragment_begin',(tk)=>tk+`\nnormal *= 1.;`);
    replace(fs,'clipping_planes_fragment',(tk)=>`\n\n`+tk);
}