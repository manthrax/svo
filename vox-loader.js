
function nextPow2(n) {
    return 1 << Math.ceil(Math.log2(n));
}

// ----- MagicaVoxel .vox parser (minimal: MAIN/SIZE/XYZI/RGBA) -----
export async function parseVOX(buf) {
    const dv = new DataView(buf);
    let off = 0;
    function str4() {
        const s = String.fromCharCode(dv.getUint8(off), dv.getUint8(off + 1), dv.getUint8(off + 2), dv.getUint8(off + 3));
        off += 4;
        return s;
    }
    function u32() {
        const v = dv.getUint32(off, true);
        off += 4;
        return v;
    }
    if (str4() !== 'VOX ')
        throw new Error('Not a VOX file');
    const ver = u32();
    if (str4() !== 'MAIN')
        throw new Error('Missing MAIN');
    const mainSz = u32();
    const mainChildren = u32();
    off += mainSz;
    // skip MAIN content
    let sizeX = 0
      , sizeY = 0
      , sizeZ = 0;
    let voxels = null;
    let palette = null;
    const chunksEnd = off + mainChildren;
    while (off < chunksEnd) {
        const id = str4();
        const csz = u32();
        const cchild = u32();
        if (id === 'SIZE') {
            sizeX = u32();
            sizeY = u32();
            sizeZ = u32();
            off += csz - 12;
        } else if (id === 'XYZI') {
            const n = u32();
            voxels = new Uint8Array(n * 4);
            for (let i = 0; i < n; i++) {
                voxels[i * 4 + 0] = dv.getUint8(off++);
                // x
                voxels[i * 4 + 1] = dv.getUint8(off++);
                // y
                voxels[i * 4 + 2] = dv.getUint8(off++);
                // z
                voxels[i * 4 + 3] = dv.getUint8(off++);
                // colorIndex (1..255)
            }
        } else if (id === 'RGBA') {
            const arr = new Uint8Array(256 * 4);
            for (let i = 0; i < 256; i++) {
                const r = dv.getUint8(off++)
                  , g = dv.getUint8(off++)
                  , b = dv.getUint8(off++)
                  , a = dv.getUint8(off++);
                arr[i * 4 + 0] = r;
                arr[i * 4 + 1] = g;
                arr[i * 4 + 2] = b;
                arr[i * 4 + 3] = a;
            }
            palette = arr;
        } else {
            off += csz;
            // skip unknown content
        }
        off += cchild;
        // skip children
    }
    if (!palette)
        palette = DEFAULT_VOX_PALETTE;
    if (!voxels)
        throw new Error('No XYZI chunk');
    const maxDim = Math.max(sizeX, sizeY, sizeZ);
    const S = nextPow2(maxDim);
    const dense = new Uint8Array(S * S * S);
    // 0 by default
    const ox = ((S - sizeX) >> 1)
      , oy = ((S - sizeY) >> 1)
      , oz = ((S - sizeZ) >> 1);
    for (let i = 0; i < voxels.length; i += 4) {
        const x = voxels[i + 0]
          , y = voxels[i + 1]
          , z = voxels[i + 2]
          , ci = voxels[i + 3];
        const X = x + ox
          , Y = y + oy
          , Z = z + oz;
        const idx = X + Y * S + Z * S * S;
        dense[idx] = ci;
        // 1..255 palette index; 0 empty
    }
    return {
        dense,
        size: S,
        palette
    };
}