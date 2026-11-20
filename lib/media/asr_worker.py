#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
asr_worker.py —— 用 faster-whisper 把一段音频转成带时间戳的段落。

由 lib/media/asr.mjs 通过子进程调用，不直接面向用户。

    python asr_worker.py --audio a.wav --out out.json --model small --language zh

设计参考 dsh-bili-scroll 的 lib/asr.py：
- 默认跑 CPU + int8（没有 GPU 也能用，内存占用低）
- 模型缓存放 --model-dir，不写用户 ~/.cache
- HF 走国内镜像；关掉 Xet 存储（镜像不代理，否则 401）
- vad_filter 掐掉静音段，省时间也少幻觉

输出（stdout 不写东西，避免污染；结果全在 --out 的 JSON 里）：
{
  "engine": "faster-whisper",
  "model": "small",
  "language": "zh",
  "language_probability": 0.99,
  "duration_sec": 88.4,
  "elapsed_sec": 12.3,
  "confidence": {"avg_logprob": -0.42, "low_confidence_ratio": 0.08},
  "segments": [{"start": 0.0, "end": 2.4, "text": "...", "avg_logprob": -0.3,
                "compression_ratio": 1.4, "no_speech_prob": 0.01, "low_confidence": false}]
}
"""
import argparse
import json
import os
import sys
import time

# ⚠️ 必须在 import faster_whisper 之前设好，否则它已经去连 HuggingFace 了
os.environ.setdefault('HF_ENDPOINT', 'https://hf-mirror.com')
os.environ.setdefault('HF_HUB_DISABLE_XET', '1')

# Windows 控制台默认 GBK，中文写进管道会炸
try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass


def load_wav_16k_mono(path):
    """
    用标准库把 16k/单声道/PCM16 的 wav 读成 float32 数组。

    为什么不交给 faster-whisper 自己解码：它会调 `av.open(..., metadata_errors=...)`，
    而这个参数在不同 PyAV 版本之间反复变动，装出来的组合很容易不兼容
    （实测 av 19.0.2 + faster-whisper 1.2.1 直接 TypeError）。
    我们的音频本来就是 ffmpeg 产的 16k 单声道 PCM，标准库读一下最稳，也少一个依赖面。

    返回 None 表示格式不符合预期，调用方退回让库自己解码。
    """
    import wave

    import numpy as np

    try:
        with wave.open(path, 'rb') as handle:
            if handle.getframerate() != 16000 or handle.getnchannels() != 1 or handle.getsampwidth() != 2:
                return None
            frames = handle.readframes(handle.getnframes())
    except Exception:
        return None

    if not frames:
        return None
    return np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0

ZH_GUIDE = '以下是普通话的句子，用简体中文书写。'
# 段落级低置信判据：与 faster-whisper 默认的回退阈值一致。
LOW_LOGPROB = -1.0
HIGH_COMPRESSION = 2.4
HIGH_NO_SPEECH = 0.6


def decode_options(language, prompt=None, hotwords=None):
    """
    转写参数（纯函数，便于单测）。

    - 默认保留 condition_on_previous_text（不设置该字段）。
      A3 的 False 在 M3 held-out 上没有净收益（0.1518 vs 0.1486），暂不默认启用。
    - initial_prompt：只作用于第一个 30s 窗口；中文默认给简体引导句。
    - hotwords：每个窗口都会带上，用来放标题/领域词这类需要全程生效的偏置。
    """
    options = {
        'language': None if language in ('', 'auto') else language,
        'vad_filter': True,
        'beam_size': 5,
    }
    initial = prompt if isinstance(prompt, str) and prompt.strip() else (ZH_GUIDE if language == 'zh' else None)
    if initial:
        options['initial_prompt'] = initial
    if isinstance(hotwords, str) and hotwords.strip():
        options['hotwords'] = hotwords.strip()
    return options


def is_low_confidence(avg_logprob, compression_ratio, no_speech_prob):
    return (avg_logprob is not None and avg_logprob < LOW_LOGPROB) or \
        (compression_ratio is not None and compression_ratio > HIGH_COMPRESSION) or \
        (no_speech_prob is not None and no_speech_prob > HIGH_NO_SPEECH)


def run_transcription(model, audio_input, language, prompt=None, hotwords=None):
    """worker 与 daemon 共用：转写并整理成统一载荷（不含 model / elapsed）。"""
    segments_iter, info = model.transcribe(audio_input, **decode_options(language, prompt, hotwords))
    segments = []
    logprobs = []
    low = 0
    for seg in segments_iter:
        text = (seg.text or '').strip()
        avg = float(seg.avg_logprob)
        ratio = float(getattr(seg, 'compression_ratio', 0.0) or 0.0)
        no_speech = float(getattr(seg, 'no_speech_prob', 0.0) or 0.0)
        logprobs.append(avg)
        if no_speech > HIGH_NO_SPEECH:
            low += 1
        if not text:
            continue
        segments.append({
            'start': round(float(seg.start), 3),
            'end': round(float(seg.end), 3),
            'text': text,
            'avg_logprob': round(avg, 4),
            'compression_ratio': round(ratio, 3),
            'no_speech_prob': round(no_speech, 4),
            'low_confidence': bool(is_low_confidence(avg, ratio, no_speech)),
        })
    return {
        'engine': 'faster-whisper',
        'language': getattr(info, 'language', language),
        'language_probability': round(float(getattr(info, 'language_probability', 0.0)), 4),
        'duration_sec': round(float(getattr(info, 'duration', 0.0)), 3),
        'confidence': {
            'avg_logprob': round(sum(logprobs) / len(logprobs), 4) if logprobs else None,
            'low_confidence_ratio': round(low / len(logprobs), 4) if logprobs else None,
        },
        'segments': segments,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--audio', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--model', default='small')
    ap.add_argument('--model-dir', default='')
    ap.add_argument('--language', default='zh', help='zh / en / auto')
    ap.add_argument('--prompt', default='', help='首窗口提示；中文缺省为简体引导句')
    ap.add_argument('--hotwords', default='', help='每个窗口都生效的领域词')
    args = ap.parse_args()

    if args.model_dir:
        os.makedirs(args.model_dir, exist_ok=True)
        os.environ['HF_HOME'] = args.model_dir

    if not os.path.exists(args.audio):
        print('[asr] 找不到音频：' + args.audio, file=sys.stderr)
        return 2

    started = time.time()
    from faster_whisper import WhisperModel

    print('[asr] 加载模型 %s（首次会下载）…' % args.model, file=sys.stderr)
    model = WhisperModel(
        args.model,
        device='cpu',
        compute_type='int8',
        download_root=args.model_dir or None,
    )

    print('[asr] 开始转写…', file=sys.stderr)
    decoded = load_wav_16k_mono(args.audio)
    # 注意不能写 `decoded or args.audio`：numpy 数组的真值判断会抛异常。
    audio_input = decoded if decoded is not None else args.audio

    payload = {
        'model': args.model,
        **run_transcription(model, audio_input, args.language, args.prompt or None, args.hotwords or None),
    }
    payload['elapsed_sec'] = round(time.time() - started, 2)
    segments = payload['segments']

    with open(args.out, 'w', encoding='utf-8') as fh:
        json.dump(payload, fh, ensure_ascii=False)

    print('[asr] 完成：%d 段，用时 %.1fs' % (len(segments), payload['elapsed_sec']), file=sys.stderr)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
