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
#include <mmdeviceapi.h>
#include <functiondiscoverykeys_devpkey.h>
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

// ⚠️ ИНДЕКСЫ — ЭТО ПОРЯДОК В КОЛЛЕКЦИИ IMMDevice, А НЕ В waveIn/waveOut. Так прямо сказано в
// документации MFPKEY_WMAAECMA_DEVICE_INDEXES, и это не придирка: подстановка waveIn-индекса даёт
// E_INVALIDARG на AllocateStreamingResources, а «почти совпавший» индекс молча заставляет DSP
// вычитать НЕ ТОТ звук — подавление получается нулевым, и это выглядит как «AEC не работает».
// Печатаем ещё и оба умолчания Windows (обычное и «для связи»): они бывают РАЗНЫЕ, и если DSP
// смотрит на одно, а проигрывание идёт в другое, вычитать нечего.
static void print_endpoints(IMMDeviceEnumerator* en, EDataFlow flow, const char* title, const char* opt) {
    IMMDeviceCollection* col = NULL;
    if (FAILED(en->EnumAudioEndpoints(flow, DEVICE_STATE_ACTIVE, &col))) return;
    UINT n = 0; col->GetCount(&n);

    LPWSTR defConsole = NULL, defComm = NULL;
    IMMDevice* d = NULL;
    if (SUCCEEDED(en->GetDefaultAudioEndpoint(flow, eConsole, &d))) { d->GetId(&defConsole); d->Release(); }
    if (SUCCEEDED(en->GetDefaultAudioEndpoint(flow, eCommunications, &d))) { d->GetId(&defComm); d->Release(); }

    fprintf(stderr, "%s (индекс для %s):\n", title, opt);
    for (UINT i = 0; i < n; i++) {
        IMMDevice* dev = NULL;
        if (FAILED(col->Item(i, &dev))) continue;
        LPWSTR id = NULL; dev->GetId(&id);
        IPropertyStore* props = NULL;
        wchar_t name[256]; name[0] = 0;
        if (SUCCEEDED(dev->OpenPropertyStore(STGM_READ, &props))) {
            PROPVARIANT pv; PropVariantInit(&pv);
            if (SUCCEEDED(props->GetValue(PKEY_Device_FriendlyName, &pv)) && pv.vt == VT_LPWSTR)
                wcsncpy_s(name, pv.pwszVal, _TRUNCATE);
            PropVariantClear(&pv); props->Release();
        }
        char u8[512]; WideCharToMultiByte(CP_UTF8, 0, name, -1, u8, sizeof(u8), NULL, NULL);
        const char* mark = "";
        if (defConsole && id && !wcscmp(defConsole, id)) mark = defComm && !wcscmp(defComm, id) ? "  ← по умолчанию (и для связи)" : "  ← по умолчанию";
        else if (defComm && id && !wcscmp(defComm, id)) mark = "  ← по умолчанию ДЛЯ СВЯЗИ";
        fprintf(stderr, "  %2u  %s%s\n", i, u8, mark);
        if (id) CoTaskMemFree(id);
        dev->Release();
    }
    if (defConsole) CoTaskMemFree(defConsole);
    if (defComm) CoTaskMemFree(defComm);
    col->Release();
}

static void list_devices() {
    IMMDeviceEnumerator* en = NULL;
    if (FAILED(CoCreateInstance(__uuidof(MMDeviceEnumerator), NULL, CLSCTX_ALL,
                                __uuidof(IMMDeviceEnumerator), (void**)&en))) {
        fprintf(stderr, "не удалось создать IMMDeviceEnumerator\n");
        return;
    }
    print_endpoints(en, eCapture, "Микрофоны", "--mic");
    print_endpoints(en, eRender, "Колонки", "--spk");
    fprintf(stderr, "\n-1 = устройство по умолчанию.\n");
    en->Release();
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
    // -2 = «не задано». Само значение -1 ЗАКОННО и означает «устройство по умолчанию» — так
    // задокументировано у MFPKEY_WMAAECMA_DEVICE_INDEXES, поэтому его нельзя путать с «не задано».
    int mic = -2, spk = -2; double seconds = 0.0; bool aec = true, list = false; int echo_ms = 0;
    for (int i = 1; i < argc; i++) {
        std::string a = argv[i];
        if (a == "--list") list = true;
        else if (a == "--no-aec") aec = false;
        else if (a == "--mic" && i + 1 < argc) mic = atoi(argv[++i]);
        else if (a == "--spk" && i + 1 < argc) spk = atoi(argv[++i]);
        else if (a == "--seconds" && i + 1 < argc) seconds = atof(argv[++i]);
        else if (a == "--echo-length" && i + 1 < argc) echo_ms = atoi(argv[++i]);
    }

    HRESULT hr = CoInitializeEx(NULL, COINIT_MULTITHREADED);
    CHECK(hr, "CoInitializeEx");

    if (list) { list_devices(); CoUninitialize(); return 0; }
    if (mic < -1 || spk < -1) {
        fprintf(stderr, "нужны --mic <индекс|-1> и --spk <индекс|-1>; -1 = устройство по умолчанию\n");
        fprintf(stderr, "⚠️ индексы — это порядок в КОЛЛЕКЦИИ IMMDevice (WASAPI), а НЕ в waveIn/waveOut:\n");
        fprintf(stderr, "   так сказано в документации MFPKEY_WMAAECMA_DEVICE_INDEXES. Списки разные,\n");
        fprintf(stderr, "   и подстановка waveIn-индекса даёт E_INVALIDARG на AllocateStreamingResources.\n");
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
    // Длина «хвоста» эха: фильтр моделирует путь колонки→микрофон на столько миллисекунд. Умолчание
    // рассчитано на колонки рядом с микрофоном; звук через ТЕЛЕВИЗОР по HDMI приходит с куда большей
    // задержкой, и если она не помещается в хвост, вычитать нечего — подавление выходит нулевым.
    if (echo_ms > 0) {
        if (FAILED(set_i4(ps, MFPKEY_WMAAECMA_FEATR_ECHO_LENGTH, echo_ms)))
            fprintf(stderr, "[aec] предупреждение: ECHO_LENGTH=%d не принят\n", echo_ms);
        else fprintf(stderr, "[aec] длина хвоста эха: %d мс\n", echo_ms);
    }
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
