// tools/voice/aec-capture/aec_capture.cpp — ЗАХВАТ МИКРОФОНА С ПОДАВЛЕНИЕМ СОБСТВЕННОГО ЭХА.
//
// Зачем. Владелец не может перебить ассистента голосом: пока из колонок идёт ответ, активатор
// перестаёт узнавать имя (`bugs/25`, замер — `researches/23`: в комнате SNR 0…+3 дБ, а детектору
// нужно +18 дБ). Лечение выбрано владельцем — AEC, вариант «встроенный в Windows»
// (`interviews/interview_009` Q1 = A).
//
// Почему отдельный exe на C++, а не питон. Настоящий AEC уже есть в самой Windows — Voice Capture
// DSP (`CLSID_CWMAudioAEC`), но это COM-объект DMO без автоматизации: из питона к нему пришлось бы
// тащить comtypes и вручную описывать интерфейсы. А в РЕЖИМЕ SOURCE этот DSP сам открывает и
// микрофон, и поток, идущий на колонки, и отдаёт уже очищенный звук — то есть весь наш конвейер
// остаётся нетронутым: слушатель как читал 16 кГц моно s16le из трубы дочернего процесса
// (`frames_from_ffmpeg`), так и продолжит, только процесс будет другой. Одна маленькая программа
// вместо переделки воспроизведения и записи в один процесс — это и есть путь наименьших сущностей.
//
// ⚠️ ШУМОДАВ И АРУ ВЫКЛЮЧЕНЫ НАМЕРЕННО. Разведка (`researches/23` §1): детектор слова-активатора не
// терпит НЕЛИНЕЙНЫХ искажений, поэтому в трактах barge-in оставляют только линейный адаптивный
// фильтр, а остаточный подавитель, центральный клиппер и АРУ гасят. Наш микрофон и так идёт через
// шумодав NVIDIA Broadcast, и замером показано, что шум активаторам безразличен.
//
// Ключи свойств и значения enum взяты ИЗ ЗАГОЛОВКА SDK `wmcodecdsp.h` (SINGLE_CHANNEL_AEC = 0),
// а не по памяти.
//
// Сборка:  powershell -File tools\voice\aec-capture\build.ps1
// Запуск:
//   aec-capture.exe --list                      ← перечислить устройства с индексами (звук не трогает)
//   aec-capture.exe --mic 1 --spk 0             ← поток 16 кГц моно s16le в stdout
//   aec-capture.exe --mic 1 --spk 0 --seconds 5 ← ограниченный по времени прогон (для замеров)
//   aec-capture.exe --mic 1 --spk 0 --no-aec    ← КОНТРОЛЬ: тот же путь, но без подавления эха
//
// `--no-aec` существует не для удобства, а ради честного замера: сравнивать «с AEC» надо с тем же
// самым трактом без AEC, иначе меряешь разницу двух программ, а не работу подавителя.
//
// [NOT-TESTED]

#include <windows.h>
#include <objbase.h>
#include <dmo.h>
#include <mediaobj.h>
#include <propsys.h>
#include <propvarutil.h>
// Типы медиа (MEDIATYPE_Audio, MEDIASUBTYPE_PCM, FORMAT_WaveFormatEx) ОБЪЯВЛЕНЫ в uuids.h, а их
// значения лежат в strmiids.lib; CLSID самого DSP — в wmcodecdspuuid.lib. Оба .lib есть в Windows
// SDK на этой машине (проверено), поэтому GUID'ы берутся из системы, а не вписываются руками:
// выдуманный GUID собирается и линкуется молча, а падает уже в бою.
#include <uuids.h>
#include <wmcodecdsp.h>
#include <mmsystem.h>
#include <mmreg.h>
#include <stdio.h>
#include <io.h>
#include <fcntl.h>
#include <string>

#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "propsys.lib")
#pragma comment(lib, "winmm.lib")
#pragma comment(lib, "msdmo.lib")
#pragma comment(lib, "user32.lib")
#pragma comment(lib, "strmiids.lib")
#pragma comment(lib, "wmcodecdspuuid.lib")
#pragma comment(lib, "dmoguids.lib")      // IID_IMediaObject / IID_IMediaBuffer

static const int SR = 16000;     // родная частота нашего тракта: уши, активаторы и рот все на 16 кГц
static const int CH = 1;
static const int BITS = 16;

#define CHECK(hr, what) if (FAILED(hr)) { fprintf(stderr, "[aec] %s -> 0x%08lx\n", what, (unsigned long)(hr)); return 2; }

// Минимальный IMediaBuffer: DMO отдаёт данные только в буфер, который мы обязаны предоставить сами.
class SimpleBuffer : public IMediaBuffer {
public:
    SimpleBuffer(DWORD max) : m_ref(1), m_len(0), m_max(max) { m_data = new BYTE[max]; }
    ~SimpleBuffer() { delete[] m_data; }
    STDMETHODIMP QueryInterface(REFIID iid, void** ppv) {
        if (iid == IID_IUnknown || iid == IID_IMediaBuffer) { *ppv = static_cast<IMediaBuffer*>(this); AddRef(); return S_OK; }
        *ppv = NULL; return E_NOINTERFACE;
    }
    STDMETHODIMP_(ULONG) AddRef() { return InterlockedIncrement(&m_ref); }
    STDMETHODIMP_(ULONG) Release() { LONG r = InterlockedDecrement(&m_ref); if (!r) delete this; return r; }
    STDMETHODIMP SetLength(DWORD len) { if (len > m_max) return E_INVALIDARG; m_len = len; return S_OK; }
    STDMETHODIMP GetMaxLength(DWORD* max) { *max = m_max; return S_OK; }
    STDMETHODIMP GetBufferAndLength(BYTE** buf, DWORD* len) { if (buf) *buf = m_data; if (len) *len = m_len; return S_OK; }
private:
    LONG m_ref; BYTE* m_data; DWORD m_len, m_max;
};

// Перечисление устройств теми же индексами, которых ждёт DSP: он адресует waveIn/waveOut, а не
// endpoint-ID. Имена печатаются в UTF-8 — кириллица в названиях устройств здесь обычное дело.
static void list_devices() {
    UINT nin = waveInGetNumDevs(), nout = waveOutGetNumDevs();
    fprintf(stderr, "Микрофоны (waveIn), индекс для --mic:\n");
    for (UINT i = 0; i < nin; i++) {
        WAVEINCAPSW c; if (waveInGetDevCapsW(i, &c, sizeof(c)) != MMSYSERR_NOERROR) continue;
        char u8[512]; WideCharToMultiByte(CP_UTF8, 0, c.szPname, -1, u8, sizeof(u8), NULL, NULL);
        fprintf(stderr, "  %2u  %s\n", i, u8);
    }
    fprintf(stderr, "Колонки (waveOut), индекс для --spk:\n");
    for (UINT i = 0; i < nout; i++) {
        WAVEOUTCAPSW c; if (waveOutGetDevCapsW(i, &c, sizeof(c)) != MMSYSERR_NOERROR) continue;
        char u8[512]; WideCharToMultiByte(CP_UTF8, 0, c.szPname, -1, u8, sizeof(u8), NULL, NULL);
        fprintf(stderr, "  %2u  %s\n", i, u8);
    }
}

static HRESULT set_bool(IPropertyStore* ps, const PROPERTYKEY& key, bool v) {
    PROPVARIANT pv; PropVariantInit(&pv); pv.vt = VT_BOOL; pv.boolVal = v ? VARIANT_TRUE : VARIANT_FALSE;
    HRESULT hr = ps->SetValue(key, pv); PropVariantClear(&pv); return hr;
}
static HRESULT set_i4(IPropertyStore* ps, const PROPERTYKEY& key, LONG v) {
    PROPVARIANT pv; PropVariantInit(&pv); pv.vt = VT_I4; pv.lVal = v;
    HRESULT hr = ps->SetValue(key, pv); PropVariantClear(&pv); return hr;
}

int main(int argc, char** argv) {
    int mic = -1, spk = -1; double seconds = 0.0; bool aec = true, list = false;
    for (int i = 1; i < argc; i++) {
        std::string a = argv[i];
        if (a == "--list") list = true;
        else if (a == "--no-aec") aec = false;
        else if (a == "--mic" && i + 1 < argc) mic = atoi(argv[++i]);
        else if (a == "--spk" && i + 1 < argc) spk = atoi(argv[++i]);
        else if (a == "--seconds" && i + 1 < argc) seconds = atof(argv[++i]);
    }

    HRESULT hr = CoInitializeEx(NULL, COINIT_MULTITHREADED);
    CHECK(hr, "CoInitializeEx");

    if (list) { list_devices(); CoUninitialize(); return 0; }
    if (mic < 0 || spk < 0) {
        fprintf(stderr, "нужны --mic <индекс> и --spk <индекс>; список: aec-capture.exe --list\n");
        CoUninitialize(); return 1;
    }

    IMediaObject* dmo = NULL;
    hr = CoCreateInstance(CLSID_CWMAudioAEC, NULL, CLSCTX_INPROC_SERVER, IID_IMediaObject, (void**)&dmo);
    CHECK(hr, "CoCreateInstance(CLSID_CWMAudioAEC)");

    IPropertyStore* ps = NULL;
    hr = dmo->QueryInterface(IID_IPropertyStore, (void**)&ps);
    CHECK(hr, "QueryInterface(IPropertyStore)");

    // Режим системы: одноканальный AEC (значение 0 из enum AEC_SYSTEM_MODE в wmcodecdsp.h).
    // Именно из-за «одноканальный» выход на колонки обязан быть МОНО — это согласовано с владельцем
    // (`interview_009` Q2 = A: моно включается на время голосовой сессии).
    hr = set_i4(ps, MFPKEY_WMAAECMA_SYSTEM_MODE, aec ? SINGLE_CHANNEL_AEC : SINGLE_CHANNEL_NSAGC);
    CHECK(hr, "SYSTEM_MODE");
    // Режим SOURCE: DSP сам открывает микрофон и поток на колонки. Без него пришлось бы самим
    // подавать опорный сигнал и синхронизировать задержку — то есть переписывать воспроизведение.
    hr = set_bool(ps, MFPKEY_WMAAECMA_DMO_SOURCE_MODE, true);
    CHECK(hr, "DMO_SOURCE_MODE");
    // Пара устройств пакуется в одно 32-битное значение: старшее слово — колонки, младшее — микрофон.
    hr = set_i4(ps, MFPKEY_WMAAECMA_DEVICE_INDEXES, (LONG)((spk << 16) | (mic & 0xffff)));
    CHECK(hr, "DEVICE_INDEXES");
    // Тонкая настройка разрешена — и дальше мы гасим ВСЮ нелинейщину (см. шапку файла).
    hr = set_bool(ps, MFPKEY_WMAAECMA_FEATURE_MODE, true);
    CHECK(hr, "FEATURE_MODE");
    if (FAILED(set_i4(ps, MFPKEY_WMAAECMA_FEATR_NS, 0)))            fprintf(stderr, "[aec] предупреждение: NS не выключился\n");
    if (FAILED(set_bool(ps, MFPKEY_WMAAECMA_FEATR_AGC, false)))     fprintf(stderr, "[aec] предупреждение: AGC не выключился\n");
    if (FAILED(set_bool(ps, MFPKEY_WMAAECMA_FEATR_CENTER_CLIP, false))) fprintf(stderr, "[aec] предупреждение: центральный клиппер не выключился\n");

    // Формат выхода — ровно тот, что ест наш тракт: 16 кГц, моно, 16 бит.
    DMO_MEDIA_TYPE mt; ZeroMemory(&mt, sizeof(mt));
    hr = MoInitMediaType(&mt, sizeof(WAVEFORMATEX));
    CHECK(hr, "MoInitMediaType");
    mt.majortype = MEDIATYPE_Audio; mt.subtype = MEDIASUBTYPE_PCM; mt.formattype = FORMAT_WaveFormatEx;
    mt.bFixedSizeSamples = TRUE; mt.bTemporalCompression = FALSE; mt.lSampleSize = CH * BITS / 8;
    WAVEFORMATEX* wf = (WAVEFORMATEX*)mt.pbFormat;
    wf->wFormatTag = WAVE_FORMAT_PCM; wf->nChannels = CH; wf->nSamplesPerSec = SR;
    wf->wBitsPerSample = BITS; wf->nBlockAlign = CH * BITS / 8;
    wf->nAvgBytesPerSec = SR * wf->nBlockAlign; wf->cbSize = 0;
    hr = dmo->SetOutputType(0, &mt, 0);
    MoFreeMediaType(&mt);
    CHECK(hr, "SetOutputType(16k mono s16)");

    hr = dmo->AllocateStreamingResources();
    CHECK(hr, "AllocateStreamingResources");

    _setmode(_fileno(stdout), _O_BINARY);
    fprintf(stderr, "[aec] пошёл: mic=%d spk=%d aec=%s %d Гц моно\n", mic, spk, aec ? "on" : "OFF", SR);

    SimpleBuffer* buf = new SimpleBuffer(SR * 2);      // с запасом на секунду звука
    DMO_OUTPUT_DATA_BUFFER out; ZeroMemory(&out, sizeof(out));
    out.pBuffer = buf;

    const double limit = seconds > 0 ? seconds : 1e12;
    double got = 0.0;
    while (got < limit) {
        DWORD status = 0;
        buf->SetLength(0);
        out.dwStatus = 0;
        hr = dmo->ProcessOutput(0, 1, &out, &status);
        if (FAILED(hr)) { fprintf(stderr, "[aec] ProcessOutput -> 0x%08lx\n", (unsigned long)hr); break; }
        BYTE* p = NULL; DWORD len = 0;
        buf->GetBufferAndLength(&p, &len);
        if (len) {
            if (fwrite(p, 1, len, stdout) != len) break;   // родитель закрыл трубу — уходим
            fflush(stdout);
            got += (double)len / (SR * 2);
        } else {
            Sleep(10);                                     // DSP ещё не накопил кадр
        }
    }

    buf->Release();
    dmo->FreeStreamingResources();
    ps->Release();
    dmo->Release();
    CoUninitialize();
    return 0;
}
