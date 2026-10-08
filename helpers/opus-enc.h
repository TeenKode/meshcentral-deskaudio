/* Opus encoder wrapper for the native helper.
 *
 * The helper encodes desktop audio into 20 ms Opus packets and emits them as
 * codec-opus frames on stdout (see the frame protocol in
 * win-loopback-native.cpp). This header is the only Opus API surface the
 * helper touches; DA_BUILD_OPUS gates the whole thing so the helper still
 * compiles (and works, ADPCM-only) when libopus is not linked in.
 *
 * The encoder runs at 48 kHz and opus_encode() sizes frames in ENCODER-rate
 * samples, so the helper resamples the capture to 48 kHz first and feeds
 * 960-sample (20 ms) frames. (Feeding capture-rate samples with a
 * capture-rate frame size is an invalid Opus frame duration: that was the
 * "wrong speed" bug of 1.0.2.) Each packet is reported with its duration in
 * 48 kHz samples, which the browser uses for the decoder timestamps.
 */
#ifndef DA_OPUS_ENC_H
#define DA_OPUS_ENC_H

#ifdef DA_BUILD_OPUS

#include <opus/opus.h>
#include <string.h>
#include <stdlib.h>

#define DA_OPUS_RATE      48000
#define DA_OPUS_FRAME_MS  20
#define DA_OPUS_SAMPLES   (DA_OPUS_RATE * DA_OPUS_FRAME_MS / 1000)   /* 960 */

typedef struct {
    OpusEncoder*   enc;
    int            frameSamples;   /* 20 ms at the capture rate */
    short*         pcm;            /* frameSamples samples */
    int            pendLen;
    unsigned char  pkt[4000];      /* well above a 20 ms packet at 512 kbps */
} DaOpusEnc;

/* bitrate: bits per second (24000/32000/48000 typical). Returns NULL on
 * failure. `inRate` is the rate of the samples fed in; the helper always
 * passes 48000 (see above). */
static DaOpusEnc* da_opus_init(int inRate, int bitrate) {
    if (inRate != 8000 && inRate != 12000 && inRate != 16000
        && inRate != 24000 && inRate != 48000) return NULL;
    DaOpusEnc* e = (DaOpusEnc*)calloc(1, sizeof(DaOpusEnc));
    if (!e) return NULL;
    int err = 0;
    e->enc = opus_encoder_create(DA_OPUS_RATE, 1, OPUS_APPLICATION_AUDIO, &err);
    if (err != OPUS_OK || !e->enc) { free(e); return NULL; }
    opus_encoder_ctl(e->enc, OPUS_SET_BITRATE(bitrate));
    e->frameSamples = inRate * DA_OPUS_FRAME_MS / 1000;
    e->pcm = (short*)malloc(e->frameSamples * sizeof(short));
    if (!e->pcm) { opus_encoder_destroy(e->enc); free(e); return NULL; }
    return e;
}

/* Drop the encoder history and any partial frame (after a silent pause). */
static void da_opus_reset(DaOpusEnc* e) {
    if (!e) return;
    opus_encoder_ctl(e->enc, OPUS_RESET_STATE);
    e->pendLen = 0;
}

static void da_opus_free(DaOpusEnc* e) {
    if (!e) return;
    if (e->enc) opus_encoder_destroy(e->enc);
    free(e->pcm);
    free(e);
}

/* Feed capture-rate PCM. When a full 20 ms frame has accumulated, encode one
 * Opus packet and call emit(len, payload, dur48k). `emit` writes the frame to
 * stdout (header included by the caller). Returns 0, or a negative Opus
 * error. */
static int da_opus_feed(DaOpusEnc* e, const short* in, int n,
                        void (*emit)(int len, const unsigned char* pkt, int dur)) {
    while (n > 0) {
        int take = e->frameSamples - e->pendLen;
        if (take > n) take = n;
        memcpy(e->pcm + e->pendLen, in, take * sizeof(short));
        e->pendLen += take;
        in += take; n -= take;
        if (e->pendLen >= e->frameSamples) {
            int len = opus_encode(e->enc, e->pcm, e->frameSamples, e->pkt, (opus_int32)sizeof(e->pkt));
            e->pendLen = 0;
            if (len < 0) return (int)len;
            emit(len, e->pkt, DA_OPUS_SAMPLES);
        }
    }
    return 0;
}

#endif /* DA_BUILD_OPUS */
#endif /* DA_OPUS_ENC_H */
