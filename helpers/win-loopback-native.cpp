// Native WASAPI loopback capture of the default render device — no .NET required.
// Writes raw s16le mono PCM at the requested rate to stdout.
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

int main(int argc, char** argv) {
    int dstRate = (argc > 1) ? atoi(argv[1]) : 16000;
    if (dstRate != 8000 && dstRate != 16000 && dstRate != 24000) dstRate = 16000;

    // stdout must be binary, otherwise 0x0A bytes get mangled to 0x0D 0x0A.
    _setmode(_fileno(stdout), _O_BINARY);

    HRESULT hr = CoInitializeEx(NULL, COINIT_MULTITHREADED);
    if (FAILED(hr)) return fail("CoInitializeEx failed", hr);

    IMMDeviceEnumerator* pEnum = NULL;
    hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), NULL, CLSCTX_ALL,
                          __uuidof(IMMDeviceEnumerator), (void**)&pEnum);
    if (FAILED(hr)) return fail("CoCreateInstance(MMDeviceEnumerator) failed", hr);

    // The old helper exited (code 0) on AUDCLNT_E_DEVICE_INVALIDATED, which the
    // UI reported as a plain "stopped". Instead, keep running across device
    // changes: release and reopen whatever is now the default render device.
    int misses = 0;
    for (;;) {
        if (misses >= REOPEN_MAX_ATTEMPTS) { pEnum->Release(); CoUninitialize(); return fail("audio device unavailable", 0); }
        IMMDevice* pDevice = NULL;
        hr = pEnum->GetDefaultAudioEndpoint(eRender, eConsole, &pDevice);
        if (FAILED(hr)) { misses++; Sleep(300); continue; }
        misses = 0;

        IAudioClient* pClient = NULL;
        hr = pDevice->Activate(__uuidof(IAudioClient), CLSCTX_ALL, NULL, (void**)&pClient);
        if (FAILED(hr)) { pDevice->Release(); misses++; Sleep(300); continue; }

        WAVEFORMATEX* pwfx = NULL;
        hr = pClient->GetMixFormat(&pwfx);
        if (FAILED(hr)) { pClient->Release(); pDevice->Release(); misses++; Sleep(300); continue; }

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
            CoTaskMemFree(pwfx); pClient->Release(); pDevice->Release(); pEnum->Release(); CoUninitialize();
            return fail("Unsupported mix format", 0);
        }

        hr = pClient->Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK,
                                 10000000 /*1 s*/, 0, pwfx, NULL);
        if (FAILED(hr)) { CoTaskMemFree(pwfx); pClient->Release(); pDevice->Release(); misses++; Sleep(300); continue; }

        IAudioCaptureClient* pCapture = NULL;
        hr = pClient->GetService(__uuidof(IAudioCaptureClient), (void**)&pCapture);
        if (FAILED(hr)) { CoTaskMemFree(pwfx); pClient->Release(); pDevice->Release(); misses++; Sleep(300); continue; }

        hr = pClient->Start();
        if (FAILED(hr)) { pCapture->Release(); CoTaskMemFree(pwfx); pClient->Release(); pDevice->Release(); misses++; Sleep(300); continue; }

        // SpeexDSP resampler: proper anti-aliasing before decimation to dstRate.
        // The old code averaged every `step`-th group of samples, which passes
        // everything above dstRate/2 through as folded noise (aliasing).
        int resErr = 0;
        SpeexResamplerState* res = deskaudio_resampler_init(1, (spx_uint32_t)srcRate, (spx_uint32_t)dstRate, 5, &resErr);
        if (!res) { pCapture->Release(); CoTaskMemFree(pwfx); pClient->Release(); pDevice->Release(); pEnum->Release(); CoUninitialize(); return fail("resampler init failed", resErr); }
        deskaudio_resampler_skip_zeros(res);

        // Down-mix to mono in place, then resample. A packet is up to a few
        // hundred frames; 64k frames covers ~0.7 s at 96 kHz stereo worst case.
        int monoCap = 65536, outCap = 65536;
        short* mono = (short*)malloc(monoCap * sizeof(short));
        short* rOut = (short*)malloc(outCap * sizeof(short));
        if (!mono || !rOut) { free(mono); free(rOut); deskaudio_resampler_destroy(res); pCapture->Release(); CoTaskMemFree(pwfx); pClient->Release(); pDevice->Release(); pEnum->Release(); CoUninitialize(); return fail("out of memory", 0); }

        bool fatal = false;
        for (;;) {
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
                if (frames > (UINT32)monoCap) frames = monoCap;   // never in practice
                const float* f = (const float*)data;
                const short* s = (const short*)data;
                for (UINT32 i = 0; i < frames; i++) {
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
                spx_uint32_t inLen = frames, outLen = outCap;
                deskaudio_resampler_process_int(res, 0, mono, &inLen, rOut, &outLen);
                if (outLen > 0) { fwrite(rOut, sizeof(short), outLen, stdout); fflush(stdout); }
                if (ferror(stdout)) { fatal = true; break; }
                hr = pCapture->GetNextPacketSize(&pkt);
                if (FAILED(hr)) break;
            }
            if (fatal) break;
            if (FAILED(hr)) break;   // reopen path below
        }

        free(mono); free(rOut);
        deskaudio_resampler_destroy(res);
        pClient->Stop();
        pCapture->Release();
        CoTaskMemFree(pwfx);
        pClient->Release();
        pDevice->Release();

        if (fatal) break;             // clean exit: agent closed stdout
        if (ferror(stdout)) break;
        misses++;                     // the open device went bad: reopen
        Sleep(300);
    }

    pEnum->Release();
    CoUninitialize();
    return 0;
}
