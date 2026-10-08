/* IMA ADPCM encoder — byte-exact port of the agent-side JS
 * (adpcmEncode in modules_meshcore/deskaudio.js), shared by the native
 * Windows helper and the CI host test so both sides provably agree.
 * The output block layout (4-byte header + 4-bit nibbles) is decoded by the
 * browser's _adpcmDecode.
 */
#ifndef DA_ADPCM_ENC_H
#define DA_ADPCM_ENC_H

#ifdef __cplusplus
extern "C" {
#endif

// ---- IMA ADPCM encoder: exact port of the agent-side JS (adpcmEncode in
// modules_meshcore/deskaudio.js), so both sides produce interchangeable
// blocks and the browser decoder is shared. Header: predictor s16 LE, step
// index, pad flag — the browser's _adpcmDecode reads the same layout.
static const int IMA_STEP[89] = {
    7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45,
    50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230,
    253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963,
    1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327,
    3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442,
    11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767};
static const int IMA_INDEX[16] = { -1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8 };

// `out` must hold 4 + nSamp/2 + 1 bytes. Returns the number of bytes written.
static int da_adpcmEncode(const short* in, int nSamp, unsigned char* out) {
    if (nSamp <= 0) return 0;
    int predictor = in[0], index = 0;
    // Seed the step size from the block's dynamics (stored in the header), so
    // the first samples are not slew-limited (mirrors the JS encoder).
    if (nSamp > 1) {
        int accd = 0, prev = predictor;
        for (int k = 1; k < nSamp; k++) { int d = in[k] - prev; if (d < 0) d = -d; accd += d; prev = in[k]; }
        double avgd = (double)accd / (nSamp - 1);
        while (index < 88 && IMA_STEP[index] < avgd) index++;
    }
    out[0] = (unsigned char)(predictor & 0xFF);
    out[1] = (unsigned char)((predictor >> 8) & 0xFF);
    out[2] = (unsigned char)index;
    out[3] = 0;
    int pos = 4, cur = 0, hi = 0;
    for (int i = 1; i < nSamp; i++) {
        int sample = in[i], step = IMA_STEP[index], diff = sample - predictor, code = 0;
        if (diff < 0) { code = 8; diff = -diff; }
        int vpdiff = step >> 3;
        if (diff >= step) { code |= 4; diff -= step; vpdiff += step; }
        step >>= 1;
        if (diff >= step) { code |= 2; diff -= step; vpdiff += step; }
        step >>= 1;
        if (diff >= step) { code |= 1; vpdiff += step; }
        if (code & 8) predictor -= vpdiff; else predictor += vpdiff;
        if (predictor > 32767) predictor = 32767; else if (predictor < -32768) predictor = -32768;
        index += IMA_INDEX[code];
        if (index < 0) index = 0; else if (index > 88) index = 88;
        if (!hi) { cur = code & 0x0F; hi = 1; } else { out[pos++] = (unsigned char)(cur | ((code & 0x0F) << 4)); hi = 0; }
    }
    out[3] = hi ? 1 : 0;   // 1 => the last byte carries a padding (unused) high nibble
    if (hi) out[pos++] = (unsigned char)cur;
    return pos;
}


#ifdef __cplusplus
}
#endif

#endif /* DA_ADPCM_ENC_H */
