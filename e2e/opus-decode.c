/* Decode the Windows helper's Opus output (its raw stdout, as captured by
 * e2e/win-capture.js) with libopus: frames [len:2 LE][flags:1][payload],
 * flags 0x08 = several packets [dur:2][len:2][packet], 0x04 = one packet
 * [dur:2][packet], 0x01 = silence. Writes 48 kHz mono s16le to stdout.
 *   cc -O2 -o opus-decode e2e/opus-decode.c -lopus
 *   ./opus-decode capture-opus-x64.bin > decoded.raw */
#include <opus/opus.h>
#include <stdio.h>
#include <stdlib.h>

static OpusDecoder* dec;
static long packets = 0, errors = 0;

static void decode(const unsigned char* p, int len) {
    opus_int16 pcm[5760];
    int n = opus_decode(dec, p, len, pcm, 5760, 0);
    if (n < 0) { errors++; return; }
    fwrite(pcm, sizeof(opus_int16), (size_t)n, stdout);
    packets++;
}

int main(int argc, char** argv) {
    if (argc < 2) { fprintf(stderr, "usage: opus-decode <capture.bin>\n"); return 2; }
    FILE* f = fopen(argv[1], "rb");
    if (!f) { perror(argv[1]); return 2; }
    fseek(f, 0, SEEK_END); long size = ftell(f); fseek(f, 0, SEEK_SET);
    unsigned char* b = malloc((size_t)size);
    if (!b || fread(b, 1, (size_t)size, f) != (size_t)size) { fprintf(stderr, "read failed\n"); return 2; }
    int err;
    dec = opus_decoder_create(48000, 1, &err);
    if (err != OPUS_OK) { fprintf(stderr, "decoder: %s\n", opus_strerror(err)); return 2; }
    long p = 0;
    while (p + 3 <= size) {
        int len = b[p] | (b[p + 1] << 8), flags = b[p + 2];
        if (p + 3 + len > size) break;
        const unsigned char* pl = b + p + 3;
        if (flags == 0x08) {
            int q = 0;
            while (q + 4 <= len) {
                int plen = pl[q + 2] | (pl[q + 3] << 8);
                if (q + 4 + plen > len) { errors++; break; }
                decode(pl + q + 4, plen);
                q += 4 + plen;
            }
        } else if (flags == 0x04 && len > 2) {
            decode(pl + 2, len - 2);
        }
        p += 3 + len;
    }
    fprintf(stderr, "decoded %ld packets, %ld errors\n", packets, errors);
    return (errors || !packets) ? 1 : 0;
}
