// Native WASAPI loopback capture of the default render device — no .NET required.
//
// Output on stdout is a stream of frames:  [len:2 LE][flags:1][payload].
//   flags bit0 (0x01) = silence: the payload is empty; the receiver keeps
//                       the stream continuous but sends nothing over the air
//   flags bit1 (0x02) = payload is ADPCM (each frame a self-contained block)
//   flags bit2 (0x04) = payload is one Opus packet: [dur:2 LE][opus bytes]
//                       (helpers up to 1.0.3)
//   flags bit3 (0x08) = payload is several Opus packets, each
//                       [dur:2 LE][len:2 LE][opus bytes] - one frame per 40 ms
//   flags 0x00        = payload is raw s16le PCM.
// dur is in 48 kHz samples. A frame is emitted every FLUSH_MS of audio. Frame
// boundaries are independent of WASAPI packet boundaries: partial frames are
// kept back.
// Arguments:  deskaudio.exe <rate> [adpcm|pcm|opus] [kbps=N] [silence]
//
// Depends only on system DLLs present on every Windows since Vista/7 (ole32).
// Cross-compiled from Linux with MinGW-w64, statically linked so the produced
// .exe needs no MinGW runtime DLLs. Build with helpers/build-native.sh (CI checks
// that the committed binaries match this source).

#define WIN32_LEAN_AND_MEAN
#define COBJMACROS
#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <stdio.h>
#include <stdlib.h>
#include <io.h>
#include <fcntl.h>

// SpeexDSP resampler (bundled, BSD license) instead of the old 3-sample box
// average: a proper anti-aliasing filter before decimation. Built with
// OUTSIDE_SPEEX + RANDOM_PREFIX=deskaudio so the symbols stay private.
#define OUTSIDE_SPEEX
#define RANDOM_PREFIX deskaudio
#define FLOATING_POINT
#include "speexdsp/resample.c"

static const int FLUSH_MS = 40;

#include "adpcm-enc.h"
#include "opus-enc.h"

// True when every sample is exactly zero (WASAPI marks real silence, but the
// resampler output is what we check — matches the agent's old isSilent()).
static int allZero(const short* in, int nSamp) {
    for (int i = 0; i < nSamp; i++) if (in[i] != 0) return 0;
    return 1;
}

static int fail(const char* msg, HRESULT hr) {
    if (hr) fprintf(stderr, "%s (0x%08lX)\n", msg, (unsigned long)hr);
    else fprintf(stderr, "%s\n", msg);
    return 1;
}

// WASAPI gives no data when nothing plays; an all-silent mix buffer is legal,
// so "no packets" just means "quiet", not an error. On AUDCLNT_E_DEVICE_INVALIDATED
// (user switched the default output, device unplugged) we release everything and
// reopen the *new* default device. This many consecutive reopen failures ends the
// capture; the counter resets once a device opens successfully.
static const int REOPEN_MAX_ATTEMPTS = 10;

// Follows the default render device. Switching the default output (plugging in
// headphones, choosing another device in Windows) does not invalidate a
// loopback stream on the old device - it just goes quiet - so the helper
// listens for OnDefaultDeviceChanged and reopens the new default.
// A single static instance lives for the whole process, so reference counting
// never frees it (and no operator new/delete is linked in).
class DefaultDeviceWatcher : public IMMNotificationClient {
    volatile LONG changed_;
public:
    DefaultDeviceWatcher() : changed_(0) {}
    bool takeChanged() { return InterlockedExchange(&changed_, 0) != 0; }
    ULONG STDMETHODCALLTYPE AddRef() { return 2; }
    ULONG STDMETHODCALLTYPE Release() { return 1; }
    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void** ppv) {
        if (riid == __uuidof(IUnknown) || riid == __uuidof(IMMNotificationClient)) { *ppv = this; AddRef(); return S_OK; }
        *ppv = NULL; return E_NOINTERFACE;
    }
    HRESULT STDMETHODCALLTYPE OnDefaultDeviceChanged(EDataFlow flow, ERole role, LPCWSTR) {
        if (flow == eRender && role == eConsole) InterlockedExchange(&changed_, 1);
        return S_OK;
    }
    HRESULT STDMETHODCALLTYPE OnDeviceAdded(LPCWSTR) { return S_OK; }
    HRESULT STDMETHODCALLTYPE OnDeviceRemoved(LPCWSTR) { return S_OK; }
    HRESULT STDMETHODCALLTYPE OnDeviceStateChanged(LPCWSTR, DWORD) { return S_OK; }
    HRESULT STDMETHODCALLTYPE OnPropertyValueChanged(LPCWSTR, const PROPERTYKEY) { return S_OK; }
};
static DefaultDeviceWatcher g_watcher;

#ifdef DA_BUILD_OPUS
static DaOpusEnc* op = NULL;

// The packets of one 40 ms block are collected here and written as a single
// multi-packet frame (flag 0x08): one message per 40 ms instead of one per
// 20 ms halves the per-message overhead on the agent/server/browser path.
static unsigned char opusBatch[2 * (4 + sizeof(((DaOpusEnc*)0)->pkt))];
static int opusBatchLen = 0;

static void collect_opus_packet(int len, const unsigned char* pkt, int dur) {
    if (opusBatchLen + 4 + len > (int)sizeof(opusBatch)) return;   // cannot happen at <=48 kbps
    unsigned char* p = opusBatch + opusBatchLen;
    p[0] = (unsigned char)(dur & 0xFF); p[1] = (unsigned char)((dur >> 8) & 0xFF);
    p[2] = (unsigned char)(len & 0xFF); p[3] = (unsigned char)((len >> 8) & 0xFF);
    memcpy(p + 4, pkt, len);
    opusBatchLen += 4 + len;
}

static void flush_opus_batch() {
    if (opusBatchLen == 0) return;
    unsigned char hdr[3];
    hdr[0] = (unsigned char)(opusBatchLen & 0xFF);
    hdr[1] = (unsigned char)((opusBatchLen >> 8) & 0xFF);
    hdr[2] = 0x08;      // several Opus packets
    fwrite(hdr, 1, 3, stdout);
    fwrite(opusBatch, 1, opusBatchLen, stdout);
    opusBatchLen = 0;
}
#endif

int main(int argc, char** argv) {
    int dstRate = (argc > 1) ? atoi(argv[1]) : 16000;
    if (dstRate != 8000 && dstRate != 16000 && dstRate != 24000) dstRate = 16000;
    // codec: "adpcm" (default), "pcm", or "opus" (needs a libopus build);
    // "silence" to suppress silent frames; "kbps=N" sets the Opus bitrate.
    bool useAdpcm = true, suppressSilence = false, useOpus = false;
    int opusBitrate = 32000;
    for (int i = 2; i < argc; i++) {
        if (strcmp(argv[i], "pcm") == 0) { useAdpcm = false; useOpus = false; }
        else if (strcmp(argv[i], "adpcm") == 0) { useAdpcm = true; useOpus = false; }
        else if (strcmp(argv[i], "silence") == 0) suppressSilence = true;
        else if (strncmp(argv[i], "kbps=", 5) == 0) opusBitrate = atoi(argv[i] + 5) * 1000;
#ifdef DA_BUILD_OPUS
        else if (strcmp(argv[i], "opus") == 0) { useOpus = true; useAdpcm = false; }
#endif
    }
#ifndef DA_BUILD_OPUS
    (void)useOpus; (void)opusBitrate;   // no libopus linked in: adpcm/pcm only
#endif

#ifdef DA_BUILD_OPUS
    if (useOpus) {
        // Opus is 48 kHz native: opus_encode() frame sizes are in ENCODER-rate
        // samples, so feeding 16 kHz samples with frame_size=320 (6.67 ms at
        // 48 kHz) is invalid and libopus errors out. Resample the capture to
        // 48 kHz right here (the same SpeexDSP filter the ADPCM path uses)
        // and give the encoder honest 960-sample 20 ms frames.
        dstRate = 48000;
        op = da_opus_init(48000, opusBitrate);
        if (!op) return fail("opus init failed", 0);
    }
#endif

    // stdout must be binary, otherwise 0x0A bytes get mangled to 0x0D 0x0A.
    _setmode(_fileno(stdout), _O_BINARY);

    HRESULT hr = CoInitializeEx(NULL, COINIT_MULTITHREADED);
    if (FAILED(hr)) return fail("CoInitializeEx failed", hr);

    IMMDeviceEnumerator* pEnum = NULL;
    hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), NULL, CLSCTX_ALL,
                          __uuidof(IMMDeviceEnumerator), (void**)&pEnum);
    if (FAILED(hr)) return fail("CoCreateInstance(MMDeviceEnumerator) failed", hr);

    DefaultDeviceWatcher* watcher = &g_watcher;
    bool watching = SUCCEEDED(pEnum->RegisterEndpointNotificationCallback(watcher));

    // Keep running across device changes: release and reopen whatever is now
    // the default render device. `misses` counts consecutive attempts that did
    // not lead to a working capture - an open step failing, or a capture that
    // died within MIN_GOOD_MS - so a device that opens but never works (e.g.
    // held in exclusive mode by another app) ends the helper with an error
    // instead of retrying forever.
    const DWORD MIN_GOOD_MS = 2000;
    int misses = 0;
    const char* lastStep = "capture";      // what failed last, for the error message
    HRESULT lastHr = 0;
    for (;;) {
        if (misses >= REOPEN_MAX_ATTEMPTS) {
            if (watching) pEnum->UnregisterEndpointNotificationCallback(watcher);
            pEnum->Release(); CoUninitialize();
            char msg[160];
            snprintf(msg, sizeof msg, "audio device unavailable: %s failed", lastStep);
            return fail(msg, lastHr);
        }
        watcher->takeChanged();             // opening the current default now
        IMMDevice* pDevice = NULL;
        hr = pEnum->GetDefaultAudioEndpoint(eRender, eConsole, &pDevice);
        if (FAILED(hr)) { lastStep = "GetDefaultAudioEndpoint"; lastHr = hr; misses++; Sleep(300); continue; }

        IAudioClient* pClient = NULL;
        hr = pDevice->Activate(__uuidof(IAudioClient), CLSCTX_ALL, NULL, (void**)&pClient);
        if (FAILED(hr)) { lastStep = "Activate"; lastHr = hr; pDevice->Release(); misses++; Sleep(300); continue; }

        WAVEFORMATEX* pwfx = NULL;
        hr = pClient->GetMixFormat(&pwfx);
        if (FAILED(hr)) { lastStep = "GetMixFormat"; lastHr = hr; pClient->Release(); pDevice->Release(); misses++; Sleep(300); continue; }

        int ch = pwfx->nChannels;
        int srcRate = (int)pwfx->nSamplesPerSec;
        int bits = pwfx->wBitsPerSample;
        bool isFloat = (pwfx->wFormatTag == WAVE_FORMAT_IEEE_FLOAT);
        if (pwfx->wFormatTag == WAVE_FORMAT_EXTENSIBLE) {
            WAVEFORMATEXTENSIBLE* ext = (WAVEFORMATEXTENSIBLE*)pwfx;
            isFloat = (ext->SubFormat.Data1 == 3); // 3 = IEEE float, 1 = PCM
        }
        if (!((isFloat && bits == 32) || (!isFloat && bits == 16))) {
            // A nonstandard mix format is unlikely to change on reopen; give up.
            CoTaskMemFree(pwfx); pClient->Release(); pDevice->Release();
            if (watching) pEnum->UnregisterEndpointNotificationCallback(watcher);
            pEnum->Release(); CoUninitialize();
            return fail("Unsupported mix format", 0);
        }

        hr = pClient->Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK,
                                 10000000 /*1 s*/, 0, pwfx, NULL);
        if (FAILED(hr)) { lastStep = "Initialize"; lastHr = hr; CoTaskMemFree(pwfx); pClient->Release(); pDevice->Release(); misses++; Sleep(300); continue; }

        IAudioCaptureClient* pCapture = NULL;
        hr = pClient->GetService(__uuidof(IAudioCaptureClient), (void**)&pCapture);
        if (FAILED(hr)) { lastStep = "GetService"; lastHr = hr; CoTaskMemFree(pwfx); pClient->Release(); pDevice->Release(); misses++; Sleep(300); continue; }

        hr = pClient->Start();
        if (FAILED(hr)) { lastStep = "Start"; lastHr = hr; pCapture->Release(); CoTaskMemFree(pwfx); pClient->Release(); pDevice->Release(); misses++; Sleep(300); continue; }

        // SpeexDSP resampler: proper anti-aliasing before decimation to dstRate.
        // The old code averaged every `step`-th group of samples, which passes
        // everything above dstRate/2 through as folded noise (aliasing).
        int resErr = 0;
        SpeexResamplerState* res = deskaudio_resampler_init(1, (spx_uint32_t)srcRate, (spx_uint32_t)dstRate, 5, &resErr);
        if (!res) { lastStep = "resampler init"; lastHr = (HRESULT)resErr; pCapture->Release(); CoTaskMemFree(pwfx); pClient->Release(); pDevice->Release(); misses++; Sleep(300); continue; }
        deskaudio_resampler_skip_zeros(res);
        // One line per (re)open: shown in the plugin's log in the browser.
        fprintf(stderr, "capture: %d Hz, %d ch, %s -> %d Hz %s%s\n", srcRate, ch, isFloat ? "float32" : "int16",
                dstRate, useOpus ? "opus" : (useAdpcm ? "adpcm" : "pcm"), suppressSilence ? ", silence suppressed" : "");
        fflush(stderr);

        // Down-mix to mono in place, then resample. A packet is up to a few
        // hundred frames; 64k frames covers ~0.7 s at 96 kHz stereo worst case.
        int monoCap = 65536, outCap = 65536;
        short* mono = (short*)malloc(monoCap * sizeof(short));
        short* rOut = (short*)malloc(outCap * sizeof(short));
        // Frame assembly: resampler output accumulates here until FLUSH_MS of
        // audio is ready (or more), then is emitted as [len:2][flags:1][payload].
        int frameSamples = dstRate * FLUSH_MS / 1000;
        int pendCap = frameSamples + outCap;
        short* pend = (short*)malloc(pendCap * sizeof(short));
        int pendLen = 0;
        // ADPCM payload worst case: 4 + n/2 + 1 per frame.
        int encCap = 4 + (frameSamples + outCap) / 2 + 16;
        unsigned char* enc = (unsigned char*)malloc(encCap);
        if (!mono || !rOut || !pend || !enc) {
            free(mono); free(rOut); free(pend); free(enc);
            deskaudio_resampler_destroy(res); pCapture->Release(); CoTaskMemFree(pwfx); pClient->Release(); pDevice->Release();
            if (watching) pEnum->UnregisterEndpointNotificationCallback(watcher);
            pEnum->Release(); CoUninitialize();
            return fail("out of memory", 0);
        }

        bool fatal = false, switched = false, wasSilent = false;
        DWORD openedAt = GetTickCount();
        for (;;) {
            if (watcher->takeChanged()) { switched = true; break; }   // new default output: reopen
            UINT32 pkt = 0;
            hr = pCapture->GetNextPacketSize(&pkt);
            if (FAILED(hr)) break;   // device invalidated: reopen below
            if (pkt == 0) {
                if (ferror(stdout)) { fatal = true; break; }   // the agent closed our stdout: stop
                Sleep(5);
                continue;
            }
            while (pkt > 0) {
                BYTE* data = NULL; UINT32 frames = 0; DWORD flags = 0;
                hr = pCapture->GetBuffer(&data, &frames, &flags, NULL, NULL);
                if (FAILED(hr)) break;   // reopen below
                bool silent = (flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0;
                // ReleaseBuffer must get the full packet size, so only the
                // down-mix is clamped (a packet is ~10 ms; never in practice).
                UINT32 useFrames = (frames > (UINT32)monoCap) ? (UINT32)monoCap : frames;
                const float* f = (const float*)data;
                const short* s = (const short*)data;
                for (UINT32 i = 0; i < useFrames; i++) {
                    double sum = 0.0;
                    if (!silent) {
                        for (int c = 0; c < ch; c++)
                            sum += isFloat ? f[i * ch + c] : s[i * ch + c] / 32768.0;
                    }
                    double v = sum / ch * 32767.0;
                    if (v > 32767.0) v = 32767.0; else if (v < -32768.0) v = -32768.0;
                    mono[i] = (short)lrint(v);
                }
                pCapture->ReleaseBuffer(frames);
                spx_uint32_t inLen = useFrames, outLen = outCap;
                deskaudio_resampler_process_int(res, 0, mono, &inLen, rOut, &outLen);
                // Accumulate into the pending frame buffer; emit every
                // frameSamples (40 ms) as one frame, independent of how WASAPI
                // split the audio into packets.
                if (outLen > 0 && pendLen + (int)outLen <= pendCap) {
                    memcpy(pend + pendLen, rOut, outLen * sizeof(short));
                    pendLen += (int)outLen;
                }
                while (pendLen >= frameSamples) {
                    int silent = allZero(pend, frameSamples);
                    if (suppressSilence && silent) {
                        // keep the frame count honest but send no payload:
                        // a 3-byte frame with the silence flag
                        unsigned char hdr[3];
                        hdr[0] = 0; hdr[1] = 0; hdr[2] = 0x01;
                        fwrite(hdr, 1, 3, stdout);
                        wasSilent = true;
                    } else if (useOpus) {
#ifdef DA_BUILD_OPUS
                        // After a suppressed pause the encoder's history is
                        // stale: start the new sound from a clean state.
                        if (wasSilent) da_opus_reset(op);
                        // 40 ms in -> two 20 ms packets out, sent as one frame.
                        da_opus_feed(op, pend, frameSamples, collect_opus_packet);
                        flush_opus_batch();
#endif
                    } else if (useAdpcm) {
                        int n = da_adpcmEncode(pend, frameSamples, enc);
                        unsigned char hdr[3];
                        hdr[0] = (unsigned char)(n & 0xFF);
                        hdr[1] = (unsigned char)((n >> 8) & 0xFF);
                        hdr[2] = 0x02;      // ADPCM payload
                        fwrite(hdr, 1, 3, stdout);
                        if (n > 0) fwrite(enc, 1, n, stdout);
                    } else {
                        int n = frameSamples * 2;
                        unsigned char hdr[3];
                        hdr[0] = (unsigned char)(n & 0xFF);
                        hdr[1] = (unsigned char)((n >> 8) & 0xFF);
                        hdr[2] = 0x00;      // raw s16le
                        fwrite(hdr, 1, 3, stdout);
                        fwrite(pend, 1, n, stdout);
                    }
                    if (!silent) wasSilent = false;
                    fflush(stdout);
                    memmove(pend, pend + frameSamples, (pendLen - frameSamples) * sizeof(short));
                    pendLen -= frameSamples;
                }
                if (ferror(stdout)) { fatal = true; break; }
                hr = pCapture->GetNextPacketSize(&pkt);
                if (FAILED(hr)) break;
            }
            if (fatal) break;
            if (FAILED(hr)) break;   // reopen path below
        }

        free(mono); free(rOut); free(pend); free(enc);
        deskaudio_resampler_destroy(res);
        pClient->Stop();
        pCapture->Release();
        CoTaskMemFree(pwfx);
        pClient->Release();
        pDevice->Release();

        if (fatal) break;             // clean exit: agent closed stdout
        if (ferror(stdout)) break;
        if (switched) { fprintf(stderr, "default output device changed: reopening\n"); fflush(stderr); continue; }
        lastStep = "capture"; lastHr = hr;
        fprintf(stderr, "capture interrupted (0x%08lX): reopening the default device\n", (unsigned long)hr); fflush(stderr);
        // The open device went bad. Only a capture that ran for a while
        // counts as "working"; one that dies right away is another miss.
        if (GetTickCount() - openedAt >= MIN_GOOD_MS) misses = 1; else misses++;
        Sleep(300);
    }

#ifdef DA_BUILD_OPUS
    if (op) { da_opus_free(op); op = NULL; }
#endif
    if (watching) pEnum->UnregisterEndpointNotificationCallback(watcher);
    pEnum->Release();
    CoUninitialize();
    return 0;
}
