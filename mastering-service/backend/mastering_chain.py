"""
mastering_chain.py

Полная DSP-цепочка мастеринга под сервис "YouTube -> WAV с фирменной обработкой".

Порядок обработки:
  0. Subsonic/DC-очистка          - highpass ~20Hz, убирает мусор, "съедающий" headroom
  0.5 Анализ исходного сигнала (LUFS / LRA / плотность / насыщенность) -> классификация
  1. Pre-normalization (хедрум-таргет зависит от классификации: -2dB обычный / -3dB "плотный")
  2. True Iron (Kazrog)      - трансформаторная сатурация, voicing 111C, Unity mode
  3. bx_enhancer (Brainworx) - EQ/Sculpt + компрессор (Fast attack, POST position, MED character)
  4. Multiband Compressor    - адаптивный Amount + доп. масштаб интенсивности (-15% для "плотных")
  5. Fairchild-style Limiter (Kazrog, AMP mode) - компенсация под компрессию,
     тоже со масштабом интенсивности
  5.5 LUFS-нормализация       - точный интегральный лауднесс-таргет (по умолчанию -14 LUFS,
     под нормализацию YouTube), ставится ДО финального true-peak лимитера
  5.75 Ресэмплинг под выходной формат (44100 Гц), если исходник был на другой частоте
  6. True-Peak Limiter (финальная стадия) - точный контроль true peak (-0.3 или -0.5 dBTP)
     уже на выходной частоте дискретизации
  7. TPDF-дизер + квантование в 16 бит

Формат выдачи ФИКСИРОВАН и не настраивается пользователем сервиса:
WAV, 16 бит, 44100 Гц - и никаких других опций. Идея сервиса - быстро отдать
человеку готовый, круто звучащий файл, а не панель настроек.

Зависимости:
    pip install numpy scipy soundfile pedalboard pyloudnorm --break-system-packages

ВАЖНО (честно о точности):
Это максимально близкая программная реконструкция звучания твоей VST-цепочки
по считанным с интерфейсов параметрам. Пороги классификации (loud/dense/full)
подобраны как разумная отправная точка, но их обязательно нужно откалибровать
на реальных треках-референсах твоей студии - см. verbose=True в process_audio
для отладки, какое решение принял классификатор. Оценка LRA (loudness range)
ниже - упрощённая, "по мотивам" EBU R128, а не побитово точная реализация
эталонного алгоритма - но для целей классификации плотности этого достаточно.
"""

from typing import Callable, Optional

import numpy as np
from fractions import Fraction
from scipy.signal import resample_poly
from pedalboard import Pedalboard, Compressor, HighpassFilter, LowpassFilter
import soundfile as sf
import pyloudnorm as pyln


def _notify(on_stage: Optional[Callable[[str], None]], stage_name: str) -> None:
    """Сообщает вызывающему коду (например, веб-бэкенду) о начале стадии
    цепочки, чтобы можно было честно отразить прогресс в UI. Не бросает
    исключения наружу, если колбэк сам упал - обработка аудио важнее."""
    if on_stage is not None:
        try:
            on_stage(stage_name)
        except Exception:
            pass


# ============================================================
# STAGE 0: Subsonic/DC-очистка
# ============================================================

def clean_stage(x: np.ndarray, sr: int, highpass_hz: float = 20.0) -> np.ndarray:
    """
    Убирает DC-offset и инфразвук (часто остаются после перекодирования
    YouTube-исходников). Если их не убрать, они "съедают" headroom и
    заставляют компрессоры/лимитеры ниже по цепочке работать сильнее,
    чем нужно на самом деле. На слух совершенно незаметно - работает
    полностью скрыто от пользователя сервиса, как и всё остальное здесь.
    """
    board = Pedalboard([HighpassFilter(cutoff_frequency_hz=highpass_hz)])
    return board(x, sr)


# ============================================================
# STAGE 0.5: Анализ исходного сигнала и классификация
# ============================================================

def estimate_loudness_range(x: np.ndarray, sr: int, meter: "pyln.Meter",
                             block_sec: float = 3.0, hop_sec: float = 1.0,
                             abs_gate_lufs: float = -70.0,
                             rel_gate_offset_lu: float = -20.0) -> float:
    """
    Упрощённая оценка LRA (loudness range, в LU) "по мотивам" EBU R128:
    считает интегральную громкость по скользящим блокам (block_sec с шагом
    hop_sec), отбрасывает блоки тише абсолютного гейта (abs_gate_lufs),
    затем отбрасывает блоки тише относительного гейта (среднее минус
    rel_gate_offset_lu) и берёт разницу между 95-м и 10-м перцентилем
    оставшихся значений.

    Это НЕ побитово точный эталонный алгоритм EBU R128 (там гейтинг чуть
    тоньше, блоки короче и точнее перекрываются), но даёт достаточно
    надёжный практический показатель того, насколько сигнал уже сжат/
    выровнен по громкости во времени - для классификации исходника хватает.
    Чем меньше LRA, тем плотнее/"зажатее" уже сам исходник.
    """
    n = len(x)
    block_len = int(block_sec * sr)
    hop_len = int(hop_sec * sr)

    if n < block_len or block_len <= 0:
        return 0.0

    block_loudness = []
    for start in range(0, n - block_len + 1, hop_len):
        block = x[start:start + block_len]
        val = meter.integrated_loudness(block)
        if np.isfinite(val) and val > abs_gate_lufs:
            block_loudness.append(val)

    if len(block_loudness) < 2:
        return 0.0

    block_loudness = np.array(block_loudness)
    relative_gate = np.mean(block_loudness) + rel_gate_offset_lu
    gated = block_loudness[block_loudness > relative_gate]

    if len(gated) < 2:
        gated = block_loudness

    return float(np.percentile(gated, 95) - np.percentile(gated, 10))


def analyze_source_signal(x: np.ndarray, sr: int) -> dict:
    """
    Считает базовые метрики исходного сигнала:
      - rms_db             : средняя громкость (RMS, по сэмплам) - оставлена для справки
      - peak_db             : пиковый уровень (по сэмплам)
      - crest_factor_db     : peak - rms - оставлен для справки/verbose
      - band_energy_ratio   : доля энергии в диапазоне 60Hz-8kHz от общей энергии спектра,
                              показатель "насыщенности/жирности" тона
      - lufs                : интегральная громкость по стандарту BS.1770 (LUFS) -
                              именно под неё нормализует YouTube (-14 LUFS), так что
                              это куда более честный показатель "громкости", чем RMS
      - lra                  : упрощённая оценка loudness range (LU, см. estimate_loudness_range) -
                              насколько сигнал уже выровнен/сжат по громкости во времени
    """
    mono = x if x.ndim == 1 else np.mean(x, axis=1)

    rms = np.sqrt(np.mean(mono ** 2) + 1e-12)
    peak = np.max(np.abs(mono)) + 1e-12
    rms_db = 20 * np.log10(rms)
    peak_db = 20 * np.log10(peak)
    crest_factor_db = peak_db - rms_db

    spectrum = np.abs(np.fft.rfft(mono))
    freqs = np.fft.rfftfreq(len(mono), 1.0 / sr)
    total_energy = np.sum(spectrum ** 2) + 1e-12
    # "жирный/широкий" тон = заметная энергия одновременно в суб-басе И в верхах,
    # а не только в середине спектра (узкий тон даст низкое значение)
    wide_mask = (freqs < 100) | (freqs > 6000)
    wide_spectrum_ratio = np.sum(spectrum[wide_mask] ** 2) / total_energy

    meter = pyln.Meter(sr)
    lufs = meter.integrated_loudness(x)
    if not np.isfinite(lufs):
        lufs = -70.0  # практическая "тишина" по конвенции BS.1770
    lra = estimate_loudness_range(x, sr, meter)

    return {
        "rms_db": rms_db,
        "peak_db": peak_db,
        "crest_factor_db": crest_factor_db,
        "wide_spectrum_ratio": wide_spectrum_ratio,
        "lufs": lufs,
        "lra": lra,
    }


def classify_source(metrics: dict,
                     loud_lufs_threshold_db: float = -14.0,
                     dense_lra_threshold_lu: float = 6.0,
                     wide_spectrum_threshold: float = 0.15) -> str:
    """
    Классифицирует исходник как "dense_dynamic" (громкий, плотный, насыщенный,
    с "жирной широкой кривой") или "normal".

    ВАЖНО: эти пороги - разумная отправная точка, а не выверенные значения.
    Обязательно откалибруй их на своих реальных референс-треках (verbose=True
    в process_audio покажет метрики и решение классификатора для каждого файла).

    is_loud теперь считается по интегральному LUFS (BS.1770), а не по RMS -
    это соответствует тому, как реально нормализуют платформы (YouTube: -14 LUFS).
    is_dense теперь считается по LRA (loudness range), а не по крест-фактору
    отдельных сэмплов - LRA надёжнее отличает уже сжатый плотный трек от
    динамичного, потому что смотрит на разброс громкости во времени, а не на
    один случайный пик.
    """
    is_loud = metrics["lufs"] > loud_lufs_threshold_db
    is_dense = metrics["lra"] < dense_lra_threshold_lu
    is_wide = metrics["wide_spectrum_ratio"] > wide_spectrum_threshold

    score = sum([is_loud, is_dense, is_wide])
    return "dense_dynamic" if score >= 2 else "normal"


# ============================================================
# STAGE 1: Pre-normalization (выравнивание хедрума)
# ============================================================

def normalize_headroom(x: np.ndarray,
                        target_peak_db_when_loud: float = -2.0,
                        target_peak_db_when_quiet: float = -2.0,
                        ceiling_trigger_db: float = -0.5,
                        floor_trigger_db: float = -3.0) -> np.ndarray:
    """
    - Пик громче ceiling_trigger_db  -> опускаем до target_peak_db_when_loud
      (это значение зависит от классификации: -2dB обычный сигнал, -3dB "dense_dynamic")
    - Пик тише floor_trigger_db      -> поднимаем до target_peak_db_when_quiet (-2dB)
    - Пик внутри "здоровой зоны"     -> не трогаем
    """
    peak = np.max(np.abs(x))
    if peak < 1e-9:
        return x

    peak_db = 20 * np.log10(peak)

    if peak_db > ceiling_trigger_db:
        target_linear = 10 ** (target_peak_db_when_loud / 20)
        return x * (target_linear / peak)

    if peak_db < floor_trigger_db:
        target_linear = 10 ** (target_peak_db_when_quiet / 20)
        return x * (target_linear / peak)

    return x


# ============================================================
# STAGE 2: True Iron (Kazrog) - transformer saturation
# ============================================================

def true_iron_stage(x: np.ndarray,
                     strength: float = 5.14,
                     mix: float = 0.915,
                     voicing: str = "111C",
                     unity_mode: bool = True,
                     dna: bool = True) -> np.ndarray:
    """
    Эмуляция трансформаторной сатурации True Iron.

    unity_mode=True - режим Unity (у пользователя выбран этот, не Boost):
    автоматически компенсирует громкость от CRUSH, а не добавляет её сверху.
    """
    drive = 1.0 + strength * 0.35

    voicing_curves = {
        "V178":  lambda s: np.tanh(s * drive),
        "111C":  lambda s: np.tanh(s * drive * 0.9) - 0.05 * np.sign(s) * (np.abs(s) ** 2) * drive * 0.15,
        "1166A": lambda s: s - (s ** 3) * (drive * 0.12),
        "4001B": lambda s: np.tanh(s * drive * 1.1),
        "108X":  lambda s: s - (s ** 3) * (drive * 0.18) + (s ** 5) * (drive * 0.02),
    }
    curve = voicing_curves.get(voicing, voicing_curves["111C"])
    saturated = curve(x)

    if dna:
        saturated = saturated + 0.03 * (x ** 2) * np.sign(x) * (drive / 3.0)

    if unity_mode:
        rms_in = np.sqrt(np.mean(x ** 2) + 1e-12)
        rms_out = np.sqrt(np.mean(saturated ** 2) + 1e-12)
        if rms_out > 1e-9:
            saturated = saturated * (rms_in / rms_out)

    return x * (1 - mix) + saturated * mix


# ============================================================
# STAGE 3: bx_enhancer (Brainworx)
# ============================================================

def bx_enhancer_stage(x: np.ndarray,
                       sr: int,
                       basis: float = 0.03,
                       boost: float = 0.09,
                       comp_threshold_db: float = -10.8,
                       comp_release_ms: float = 132.0,
                       comp_mix: float = 1.0,
                       attack_mode: str = "fast",
                       position: str = "post",
                       character: str = "MED",
                       bass_pct: float = 0.06,
                       excite_pct: float = 0.02,
                       stereo_width_pct: float = 1.12,
                       final_mix: float = 0.53) -> np.ndarray:
    """Sculpt (тонкая сатурация) + Compressor (Fast/POST/MED) + Colour."""
    attack_ms = 3.0 if attack_mode == "fast" else 15.0
    character_ratio = {"SOFT": 1.5, "MED": 2.2, "HARD": 3.5}.get(character, 2.2)

    def sculpt(signal):
        base = np.tanh(signal * (1 + basis))
        return base * (1 - boost) + np.tanh(signal * (1 + boost * 3)) * boost

    def compress(signal):
        board = Pedalboard([
            Compressor(threshold_db=comp_threshold_db, ratio=character_ratio,
                       attack_ms=attack_ms, release_ms=comp_release_ms)
        ])
        return board(signal, sr)

    if position == "post":
        stage = sculpt(x)
        stage = compress(stage)
    else:
        stage = compress(x)
        stage = sculpt(stage)

    if comp_mix < 1.0:
        stage = stage * (1 - comp_mix) + compress(stage) * comp_mix

    excited = np.tanh(stage * (1 + excite_pct * 4))
    stage = stage * (1 - excite_pct) + excited * excite_pct
    stage = stage * (1 + bass_pct * 0.5)

    if stage.ndim == 2 and stage.shape[1] == 2:
        mid = (stage[:, 0] + stage[:, 1]) / 2
        side = (stage[:, 0] - stage[:, 1]) / 2 * stereo_width_pct
        stage = np.stack([mid + side, mid - side], axis=1)

    return x * (1 - final_mix) + stage * final_mix


# ============================================================
# STAGE 4: Adaptive Multiband Compressor
# ============================================================

def _envelope_follower(signal: np.ndarray, sr: int,
                        attack_ms: float = 10.0, release_ms: float = 100.0) -> np.ndarray:
    mono = signal if signal.ndim == 1 else np.mean(signal, axis=1)
    attack_coeff = np.exp(-1.0 / (sr * attack_ms / 1000.0))
    release_coeff = np.exp(-1.0 / (sr * release_ms / 1000.0))

    env = np.zeros_like(mono)
    level = 0.0
    abs_signal = np.abs(mono)
    for i in range(len(abs_signal)):
        s = abs_signal[i]
        coeff = attack_coeff if s > level else release_coeff
        level = coeff * level + (1 - coeff) * s
        env[i] = level
    return env


def _adaptive_amount(level_db: np.ndarray,
                      low_thresh_db: float, high_thresh_db: float,
                      amount_quiet: float, amount_loud: float) -> np.ndarray:
    blend = np.clip((level_db - low_thresh_db) / (high_thresh_db - low_thresh_db), 0.0, 1.0)
    return amount_quiet * (1 - blend) + amount_loud * blend


def multiband_stage(x: np.ndarray, sr: int,
                     low_split_hz: float = 98.3,
                     high_split_hz: float = 1660.0,
                     amount_quiet: float = 0.15,
                     amount_loud: float = 0.40,
                     adaptive_low_db: float = -24.0,
                     adaptive_high_db: float = -6.0,
                     intensity_scale: float = 1.0) -> np.ndarray:
    """
    Мультибэнд-компрессия с адаптивным Amount (плывёт от уровня сигнала во времени)
    + общий intensity_scale (для "dense_dynamic" исходников = 0.85, то есть -15%).
    """
    amount_quiet_scaled = amount_quiet * intensity_scale
    amount_loud_scaled = amount_loud * intensity_scale

    mono_ref = x if x.ndim == 1 else np.mean(x, axis=1)

    board_low = Pedalboard([LowpassFilter(cutoff_frequency_hz=low_split_hz)])
    board_high = Pedalboard([HighpassFilter(cutoff_frequency_hz=high_split_hz)])

    low_band = board_low(x, sr)
    high_band = board_high(x, sr)
    mid_band = x - low_band - high_band

    level_env = _envelope_follower(mono_ref, sr, attack_ms=10, release_ms=100)
    level_db = 20 * np.log10(np.maximum(level_env, 1e-8))
    amount_curve = _adaptive_amount(level_db, adaptive_low_db, adaptive_high_db,
                                     amount_quiet_scaled, amount_loud_scaled)

    def apply_amount(band):
        amt = amount_curve
        if amt.shape[0] != band.shape[0]:
            amt = np.resize(amt, band.shape[0])
        return amt[:, None] if band.ndim == 2 else amt

    band_configs = [
        (low_band,  -21.8, 1.75, 156.0, 364.0),
        (mid_band,  -23.2, 1.75, 102.0, 282.0),
        (high_band, -22.0, 1.75, 79.5,  219.0),
    ]

    result = np.zeros_like(x)
    for band, thresh_above, ratio_above, attack, release in band_configs:
        comp = Pedalboard([Compressor(threshold_db=thresh_above, ratio=ratio_above,
                                       attack_ms=attack, release_ms=release)])
        processed = comp(band, sr)
        amt = apply_amount(band)
        result = result + (band * (1 - amt) + processed * amt)

    return result


# ============================================================
# STAGE 5: Fairchild-style Limiter (Kazrog, AMP mode)
#          + компенсация под компрессию
# ============================================================

def fairchild_limiter_stage(x: np.ndarray, sr: int,
                             threshold_pct: float = 55.0,
                             wet_dry: float = 0.465,
                             warmth: float = 0.474,
                             attack_mode: str = "fast",
                             mode: str = "AMP",
                             interim_target_peak_db: float = -1.0,
                             intensity_scale: float = 1.0) -> np.ndarray:
    """
    Fairchild-style лимитер в AMP mode + компенсация под степень компрессии.
    interim_target_peak_db - грубая нормализация по сэмпл-пику (не true peak,
    точный true-peak контроль - отдельная финальная стадия ниже).
    intensity_scale - для "dense_dynamic" исходников снижает силу компрессии/wet на 15%.
    """
    thresh_linear = 10 ** ((-30 + (threshold_pct / 100) * 30) / 20)
    attack_ms = 5.0 if attack_mode == "fast" else 20.0
    release_ms = 300.0 if mode == "AMP" else 100.0

    base_ratio = 8.0
    ratio_scaled = 1.0 + (base_ratio - 1.0) * intensity_scale
    wet_dry_scaled = wet_dry * intensity_scale

    limiter = Pedalboard([
        Compressor(threshold_db=20 * np.log10(thresh_linear), ratio=ratio_scaled,
                   attack_ms=attack_ms, release_ms=release_ms)
    ])
    limited = limiter(x, sr)

    warm = np.tanh(limited * (1 + warmth))
    blended = x * (1 - wet_dry_scaled) + warm * wet_dry_scaled

    rms_in = np.sqrt(np.mean(x ** 2) + 1e-12)
    rms_out = np.sqrt(np.mean(blended ** 2) + 1e-12)
    compensated = blended * (rms_in / max(rms_out, 1e-9))

    peak = np.max(np.abs(compensated))
    if peak > 1e-9:
        target_linear = 10 ** (interim_target_peak_db / 20)
        compensated = compensated * (target_linear / peak)

    return compensated


# ============================================================
# STAGE 5.5: LUFS-нормализация (целевая интегральная громкость)
# ============================================================

def loudness_normalize_stage(x: np.ndarray, sr: int, target_lufs: float = -14.0) -> np.ndarray:
    """
    Точная нормализация под целевой интегральный лауднесс (по умолчанию
    -14 LUFS - именно под этот уровень YouTube проигрывает файл после
    собственной нормализации, так что итоговый WAV попадает "в его калибровку"
    заранее, а не отдаётся платформе на откуп).

    Стоит ПЕРЕД финальным true-peak лимитером специально: если эта стадия
    поднимает громкость, могут появиться новые пики - их подхватит и
    поправит следующая, финальная стадия.
    """
    meter = pyln.Meter(sr)
    current_lufs = meter.integrated_loudness(x)
    if not np.isfinite(current_lufs):
        return x

    gain_db = target_lufs - current_lufs
    gain = 10 ** (gain_db / 20)
    return x * gain


# ============================================================
# STAGE 5.75: Ресэмплинг под фиксированный выходной формат
# ============================================================

def resample_to_target_rate(x: np.ndarray, sr: int, target_sr: int = 44100) -> np.ndarray:
    """
    Приводит частоту дискретизации к выходному формату сервиса (44100 Гц).
    Если исходник уже на этой частоте - возвращает как есть без потерь.
    Стоит ДО финальной true-peak лимитации, чтобы та стадия ловила и любые
    новые пики, которые мог внести ресэмплинг.
    """
    if sr == target_sr:
        return x
    ratio = Fraction(target_sr, sr).limit_denominator(1000)
    up, down = ratio.numerator, ratio.denominator
    return resample_poly(x, up, down, axis=0)


# ============================================================
# STAGE 6: True-Peak Limiter (финальная точная стадия)
# ============================================================

def estimate_true_peak_db(x: np.ndarray, oversample_factor: int = 4) -> float:
    """
    True peak - это пик, который может возникнуть МЕЖДУ сэмплами при
    цифро-аналоговом преобразовании и не виден при обычном замере по сэмплам.
    Стандартный метод оценки - апсемплинг (обычно x4) и замер пика уже на
    повышенной частоте дискретизации.
    """
    if len(x) < 2:
        peak = np.max(np.abs(x)) + 1e-12
        return 20 * np.log10(peak)
    oversampled = resample_poly(x, oversample_factor, 1, axis=0)
    peak = np.max(np.abs(oversampled)) + 1e-12
    return 20 * np.log10(peak)


def true_peak_limit(x: np.ndarray,
                     target_true_peak_db: float = -0.3,
                     oversample_factor: int = 4,
                     tolerance_db: float = 0.05,
                     ceiling_only: bool = False) -> np.ndarray:
    """
    Приводит истинный пик (true peak) к целевому значению
    (по умолчанию -0.3 dBTP; для более консервативного варианта передай -0.5).

    ceiling_only=False (дефолт, поведение как раньше): двунаправленная
    нормализация - если сигнал тише таргета, поднимает, если громче - опускает.
    Полезно как самостоятельный инструмент, когда true peak - единственный
    таргет громкости.

    ceiling_only=True: работает ТОЛЬКО как потолок - опускает пик, если он
    выше таргета, но никогда не поднимает сигнал вверх. Используется в
    основном пайплайне ПОСЛЕ LUFS-нормализации (Stage 5.5): реальную громкость
    уже выставила LUFS-стадия, и подъём здесь до точного true-peak таргета
    задрал бы итоговый LUFS выше нужного значения (актуально для плотных,
    уже сильно сжатых сигналов, где true peak и LUFS почти совпадают).
    """
    tp_db = estimate_true_peak_db(x, oversample_factor)
    gain_db = target_true_peak_db - tp_db

    if ceiling_only and gain_db > 0:
        return x

    if abs(gain_db) < tolerance_db:
        return x

    gain = 10 ** (gain_db / 20)
    result = x * gain

    # Подстраховка: после линейного гейна true peak должен точно совпасть с
    # таргетом, но на случай пограничных эффектов передискретизации -
    # мягкий хард-клип точно по таргету.
    safety_ceiling = 10 ** (target_true_peak_db / 20)
    result = np.clip(result, -safety_ceiling, safety_ceiling)
    return result


# ============================================================
# STAGE 7: TPDF-дизер + квантование в 16 бит
# ============================================================

def tpdf_dither(x: np.ndarray, bit_depth: int = 16) -> np.ndarray:
    """
    TPDF-дизер (Triangular PDF) перед квантованием в целевую битность.
    Стандартная финальная деталь профессионального мастеринга: убирает
    жёсткие квантование-артефакты на тихих хвостах и фейдах, которые иначе
    были бы слышны при переходе с float на 16 бит. Полностью скрыто от
    пользователя сервиса - просто часть "фирменной обработки".
    """
    q = 2.0 ** (-(bit_depth - 1))
    noise = (np.random.uniform(-1, 1, x.shape) + np.random.uniform(-1, 1, x.shape)) * (q / 2)
    return np.clip(x + noise, -1.0, 1.0)


def float_to_pcm16(x: np.ndarray) -> np.ndarray:
    """
    Квантование float -> int16 после дизера. Делается вручную (не отдаётся
    на откуп soundfile), чтобы гарантированно записался именно продизеренный
    сигнал, без дополнительного неконтролируемого округления при записи.
    """
    return np.round(np.clip(x, -1.0, 1.0) * 32767.0).astype(np.int16)


# ============================================================
# ГЛАВНАЯ ФУНКЦИЯ ПАЙПЛАЙНА
# ============================================================

# Выходной формат сервиса зафиксирован и не настраивается пользователем.
OUTPUT_SAMPLE_RATE = 44100
OUTPUT_BIT_DEPTH = 16


def process_audio(input_path: str, output_path: str,
                   final_true_peak_db: float = -0.3,
                   target_lufs: float = -14.0,
                   verbose: bool = False,
                   on_stage: Optional[Callable[[str], None]] = None) -> None:
    """
    Полный пайплайн: читает аудио -> очистка -> анализ и классификация
    исходника (LUFS/LRA) -> прогоняет через всю цепочку с адаптивными
    таргетами -> LUFS-нормализация -> ресэмплинг -> true-peak лимитация ->
    дизер -> пишет WAV.

    Выходной файл ВСЕГДА WAV, 16 бит, 44100 Гц - единственный формат,
    который отдаётся пользователю сервиса, без каких-либо опций выбора.

    final_true_peak_db: -0.3 (дефолт) или -0.5, по твоему выбору.
    target_lufs: целевая интегральная громкость финального файла
                 (-14 LUFS по умолчанию, под нормализацию YouTube).
    on_stage: необязательный колбэк on_stage(stage_name: str), вызывается
              в начале каждой значимой стадии ("clean", "analyze", "iron",
              "enhancer", "multiband", "limiter", "finalize"). Позволяет
              внешнему коду (например, веб-бэкенду) честно отражать прогресс
              обработки по реальным стадиям цепочки, а не рисовать фейковый
              прогресс-бар.
    """
    audio, sr = sf.read(input_path, always_2d=False)

    # --- STAGE 0: Subsonic/DC-очистка ---
    _notify(on_stage, "clean")
    audio = clean_stage(audio, sr, highpass_hz=20.0)

    # --- Анализ и классификация исходника ---
    _notify(on_stage, "analyze")
    metrics = analyze_source_signal(audio, sr)
    source_class = classify_source(metrics)
    is_dense_dynamic = (source_class == "dense_dynamic")

    headroom_target_when_loud = -3.0 if is_dense_dynamic else -2.0
    intensity_scale = 0.85 if is_dense_dynamic else 1.0

    if verbose:
        print(f"[analyze] lufs={metrics['lufs']:.2f}  lra={metrics['lra']:.2f}  "
              f"rms_db={metrics['rms_db']:.2f}  crest_db={metrics['crest_factor_db']:.2f}  "
              f"wide_spectrum_ratio={metrics['wide_spectrum_ratio']:.2f}")
        print(f"[classify] source_class={source_class}  "
              f"headroom_target={headroom_target_when_loud}dB  "
              f"intensity_scale={intensity_scale}")

    # STAGE 1: Pre-normalization
    audio = normalize_headroom(audio,
                                target_peak_db_when_loud=headroom_target_when_loud,
                                target_peak_db_when_quiet=-2.0,
                                ceiling_trigger_db=-0.5, floor_trigger_db=-3.0)

    # STAGE 2: True Iron
    _notify(on_stage, "iron")
    audio = true_iron_stage(audio, strength=5.14, mix=0.915,
                             voicing="111C", unity_mode=True, dna=True)

    # STAGE 3: bx_enhancer
    _notify(on_stage, "enhancer")
    audio = bx_enhancer_stage(audio, sr,
                               basis=0.03, boost=0.09,
                               comp_threshold_db=-10.8, comp_release_ms=132.0,
                               comp_mix=1.0, attack_mode="fast", position="post",
                               character="MED", bass_pct=0.06, excite_pct=0.02,
                               stereo_width_pct=1.12, final_mix=0.53)

    # STAGE 4: Adaptive Multiband (± intensity_scale)
    _notify(on_stage, "multiband")
    audio = multiband_stage(audio, sr,
                             low_split_hz=98.3, high_split_hz=1660.0,
                             amount_quiet=0.15, amount_loud=0.40,
                             adaptive_low_db=-24.0, adaptive_high_db=-6.0,
                             intensity_scale=intensity_scale)

    # STAGE 5: Fairchild Limiter (± intensity_scale)
    _notify(on_stage, "limiter")
    audio = fairchild_limiter_stage(audio, sr,
                                     threshold_pct=55.0, wet_dry=0.465, warmth=0.474,
                                     attack_mode="fast", mode="AMP",
                                     interim_target_peak_db=-1.0,
                                     intensity_scale=intensity_scale)

    # STAGE 5.5: LUFS-нормализация под целевую громкость сервиса
    _notify(on_stage, "finalize")
    audio = loudness_normalize_stage(audio, sr, target_lufs=target_lufs)

    # STAGE 5.75: ресэмплинг под фиксированный выходной формат
    audio = resample_to_target_rate(audio, sr, target_sr=OUTPUT_SAMPLE_RATE)
    sr = OUTPUT_SAMPLE_RATE

    # STAGE 6: Финальная true-peak лимитация (уже на выходной частоте).
    # ceiling_only=True: только подстраховка сверху, громкость уже задана
    # LUFS-стадией выше и не должна быть переопределена подъёмом гейна здесь.
    audio = true_peak_limit(audio, target_true_peak_db=final_true_peak_db, ceiling_only=True)

    if verbose:
        final_tp = estimate_true_peak_db(audio)
        final_lufs = pyln.Meter(sr).integrated_loudness(audio)
        print(f"[final] true_peak={final_tp:.2f} dBTP (target={final_true_peak_db})  "
              f"lufs={final_lufs:.2f} (target={target_lufs})  sr={sr}")

    # STAGE 7: TPDF-дизер + квантование в 16 бит
    audio = tpdf_dither(audio, bit_depth=OUTPUT_BIT_DEPTH)
    pcm16 = float_to_pcm16(audio)

    sf.write(output_path, pcm16, OUTPUT_SAMPLE_RATE, subtype="PCM_16")


if __name__ == "__main__":
    import sys
    if len(sys.argv) < 3:
        print("Использование: python mastering_chain.py input.wav output.wav [--verbose]")
        print("Выходной файл всегда WAV, 16 бит, 44100 Гц.")
        sys.exit(1)
    verbose_flag = "--verbose" in sys.argv
    process_audio(sys.argv[1], sys.argv[2], verbose=verbose_flag)
    print(f"Готово: {sys.argv[2]} (WAV, 16 бит, 44100 Гц)")
