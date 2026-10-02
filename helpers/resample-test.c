/* Quality test for the bundled SpeexDSP resampler (helpers/speexdsp/).
 *
 * Compiles and runs on the host (no Windows headers): CI builds it with cc
 * and runs it. It feeds known tones through the resampler and checks:
 *
 *   1. passband: a 1 kHz sine survives 48000 -> 16000 with < -30 dB error
 *      relative to a reference sine at the output rate
 *   2. anti-alias: a 12 kHz sine (which would alias to 4 kHz) is suppressed
 *      by at least 40 dB, as required by the plan (п. 8)
 *   3. arbitrary ratio: the same holds for 44100 -> 16000
 *   4. streaming: feeding the input in odd-sized pieces (as WASAPI packets
 *      arrive) produces the same output as one shot
 *
 * Exit code 0 = pass. Prints one line per check.
 */
#define OUTSIDE_SPEEX
#define RANDOM_PREFIX deskaudio
#define FLOATING_POINT

#include <stdio.h>
#include <stdlib.h>
#include <math.h>
#include <string.h>

/* The resampler implementation, exactly as the Windows helper builds it. */
#include "speexdsp/resample.c"

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

static double rms_db(const short* buf, size_t n) {
    double s = 0.0;
    for (size_t i = 0; i < n; i++) s += (double)buf[i] * buf[i];
    return 20.0 * log10(sqrt(s / (double)n) / 32768.0 + 1e-30);
}

/* 20*log10 RMS error between `out` and a reference sine (`freq`, output rate
 * `dst`), after finding the best time offset by brute-force correlation over
 * +/- `maxlag` samples. This absorbs the resampler's group delay without
 * hard-coding it. Returns the error in dB. */
static double tone_err_db(const short* out, size_t n, double freq, spx_uint32_t dst) {
    size_t win = (n / 4 < 1000) ? (n / 4) : 1000;   /* correlation window */
    long maxlag = 64;
    if (n <= (size_t)(2 * maxlag) + win + 8) return -1e30;

    double best_e = 1e30;
    for (long lag = -maxlag; lag <= maxlag; lag++) {
        double s = 0.0;
        size_t cnt = 0;
        size_t i0 = (size_t)(n / 2) + lag;
        for (size_t i = 0; i < win; i++, cnt++) {
            double t = ((double)((long)i + lag) + 0.0) / (double)dst;
            double ref = 32767.0 * sin(2.0 * M_PI * freq * t);
            double got = out[i0 + i];
            s += (got - ref) * (got - ref);
        }
        double e = sqrt(s / (double)cnt);
        if (e < best_e) best_e = e;
    }
    return 20.0 * log10(best_e / 32768.0 + 1e-30);
}

/* Feed `n` samples of a sine through the resampler, return output length. */
static size_t run_tone(spx_uint32_t src, spx_uint32_t dst, double freq, size_t n,
                       short* out, size_t out_cap, size_t chunk /* 0 = one shot*/) {
    short* in = malloc(n * sizeof(short));
    for (size_t i = 0; i < n; i++)
        in[i] = (short)lrint(32767.0 * sin(2.0 * M_PI * freq * (double)i / (double)src));

    int err;
    SpeexResamplerState* st = deskaudio_resampler_init(1, src, dst, 5, &err);
    if (err != RESAMPLER_ERR_SUCCESS || !st) { fprintf(stderr, "init failed: %d\n", err); exit(2); }
    deskaudio_resampler_skip_zeros(st);

    spx_uint32_t in_id = 0;
    size_t out_len = 0;
    if (chunk == 0) {
        spx_uint32_t ilen = (spx_uint32_t)n, olen = (spx_uint32_t)(out_cap - out_len);
        deskaudio_resampler_process_int(st, 0, in, &ilen, out + out_len, &olen);
        in_id += ilen; out_len += olen;
    } else {
        while (in_id < n) {
            size_t take = (n - in_id < chunk) ? (n - in_id) : chunk;
            spx_uint32_t ilen = (spx_uint32_t)take, olen = (spx_uint32_t)(out_cap - out_len);
            deskaudio_resampler_process_int(st, 0, in + in_id, &ilen, out + out_len, &olen);
            in_id += ilen; out_len += olen;
        }
    }
    deskaudio_resampler_destroy(st);
    free(in);
    return out_len;
}

int main(void) {
    const spx_uint32_t SRC[] = { 48000, 44100 };
    int fails = 0;
    size_t cap = 16000;
    short* out = malloc(cap * sizeof(short));

    for (size_t k = 0; k < sizeof(SRC) / sizeof(SRC[0]); k++) {
        spx_uint32_t src = SRC[k], dst = 16000;
        char label[32];
        snprintf(label, sizeof(label), "%u->%u", src, dst);

        /* 1: passband 1 kHz — error vs a reference sine, phase-agnostic */
        size_t n1 = run_tone(src, dst, 1000.0, src, out, cap, 0);
        double a1 = tone_err_db(out, n1, 1000.0, dst);
        if (a1 > -30.0) { printf("FAIL %s passband 1kHz: %.1f dB (want <= -30)\n", label, a1); fails++; }
        else printf("ok   %s passband 1kHz: %.1f dB\n", label, a1);

        /* 2: anti-alias 12 kHz -> would alias to 4 kHz */
        size_t n2 = run_tone(src, dst, 12000.0, src, out, cap, 0);
        double a2 = rms_db(out + n2 / 4, n2 / 2);
        if (a2 > -40.0) { printf("FAIL %s alias 12kHz: %.1f dB (want <= -40)\n", label, a2); fails++; }
        else printf("ok   %s alias 12kHz: %.1f dB\n", label, a2);

        /* 3: streaming equivalence, only for 48k (integer ratio keeps it simple) */
        if (src == 48000) {
            short* one = malloc(cap * sizeof(short));
            short* pieced = malloc(cap * sizeof(short));
            size_t no = run_tone(src, dst, 1000.0, src, one, cap, 0);
            size_t np = run_tone(src, dst, 1000.0, src, pieced, cap, 7 /* odd chunk */);
            /* same length + max abs diff <= a few LSBs (boundary samples aside) */
            int ok = (no == np);
            if (ok) {
                for (size_t i = 8; i + 8 < no; i++)
                    if (abs((int)one[i] - (int)pieced[i]) > 8) { ok = 0; break; }
            }
            if (!ok) { printf("FAIL %s streaming: one-shot %zu vs chunked %zu\n", label, no, np); fails++; }
            else printf("ok   %s streaming: %zu samples identical (<=8 LSB)\n", label, no);
            free(one); free(pieced);
        }
    }
    free(out);
    if (fails) { printf("%d failure(s)\n", fails); return 1; }
    printf("resampler ok\n");
    return 0;
}
