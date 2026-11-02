#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Lazy JSON Lines ASR service; BILI_ASR_IDLE_SECONDS defaults to 300."""
import argparse
from contextlib import redirect_stdout
import json
import os
import queue
import sys
import threading
import time
from asr_worker import load_wav_16k_mono

try:
    sys.stdin.reconfigure(encoding='utf-8', errors='replace')
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass


class Service:
    def __init__(self, model_dir):
        self.model_dir = model_dir
        self.model = None
        self.model_name = None
        if model_dir:
            os.makedirs(model_dir, exist_ok=True)
            os.environ['HF_HOME'] = model_dir

    def transcribe(self, request):
        if not isinstance(request.get('wav'), str) or not os.path.isfile(request['wav']):
            raise ValueError('wav must name an existing audio file')
        model_name = request.get('model', 'small')
        language = request.get('language', 'auto')
        if not isinstance(model_name, str) or not model_name or not isinstance(language, str):
            raise ValueError('model and language must be strings')
        started = time.time()
        if self.model_name != model_name:
            from faster_whisper import WhisperModel
            self.model = None
            self.model_name = None
            self.model = WhisperModel(model_name, device='cpu', compute_type='int8',
                                      download_root=self.model_dir or None)
            self.model_name = model_name
        model = self.model
        decoded = load_wav_16k_mono(request['wav'])
        # 注意不能写 `decoded or request['wav']`：numpy 数组的真值判断会抛异常。
        audio_input = decoded if decoded is not None else request['wav']

        # whisper 对中文经常输出繁体；给一句简体提示能显著减少这种偏移。
        extra = {}
        if language == 'zh':
            extra['initial_prompt'] = '以下是普通话的句子，用简体中文书写。'

        segments_iter, info = model.transcribe(
            audio_input,
            language=None if language in ('', 'auto') else language,
            vad_filter=True,
            beam_size=5,
            **extra,
        )

        segments = []
        logprobs = []
        low = 0
        for seg in segments_iter:
            text = (seg.text or '').strip()
            logprobs.append(float(seg.avg_logprob))
            if getattr(seg, 'no_speech_prob', 0.0) and seg.no_speech_prob > 0.6:
                low += 1
            if not text:
                continue
            segments.append({
                'start': round(float(seg.start), 3),
                'end': round(float(seg.end), 3),
                'text': text,
            })

        payload = {
            'engine': 'faster-whisper',
            'model': model_name,
            'language': getattr(info, 'language', language),
            'language_probability': round(float(getattr(info, 'language_probability', 0.0)), 4),
            'duration_sec': round(float(getattr(info, 'duration', 0.0)), 3),
            'elapsed_sec': round(time.time() - started, 2),
            'confidence': {
                'avg_logprob': round(sum(logprobs) / len(logprobs), 4) if logprobs else None,
                'low_confidence_ratio': round(low / len(logprobs), 4) if logprobs else None,
            },
            'segments': segments,
        }

        return payload


def main():
    # Reserve the protocol pipe, then route even native-library stdout to stderr.
    protocol = os.fdopen(os.dup(sys.stdout.fileno()), 'w', encoding='utf-8', buffering=1)
    os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
    sys.stdout = sys.stderr
    parser = argparse.ArgumentParser()
    parser.add_argument('--model-dir', default='')
    args = parser.parse_args()
    idle = float(os.environ.get('BILI_ASR_IDLE_SECONDS', '300'))
    if idle <= 0:
        raise ValueError('BILI_ASR_IDLE_SECONDS must be positive')
    service = Service(args.model_dir)
    incoming = queue.Queue()

    # Windows 上的坑：stdin 保持打开、读线程阻塞在 readline 时，主线程再去导入 numpy /
    # ctranslate2 的 C 扩展会死锁（实测卡在 importlib create_module，关掉 stdin 就正常）。
    # 因此在起线程之前把重活导入先做完；模型本身仍然懒加载。
    import numpy  # noqa: F401
    from faster_whisper import WhisperModel  # noqa: F401

    # A reader thread supports Windows anonymous pipes, unlike select().
    def read_requests():
        for line in sys.stdin:
            incoming.put(line)
        incoming.put(None)

    threading.Thread(target=read_requests, daemon=True).start()
    while True:
        try:
            line = incoming.get(timeout=idle)
        except queue.Empty:
            return
        if line is None:
            return
        request_id = None
        shutdown = False
        try:
            request = json.loads(line)
            if not isinstance(request, dict) or 'id' not in request:
                raise ValueError('request must be an object with id')
            request_id = request['id']
            op = request.get('op', 'transcribe')
            with redirect_stdout(sys.stderr):
                if op == 'ping':
                    payload = {'pong': True}
                elif op == 'shutdown':
                    payload = {'shutdown': True}
                    shutdown = True
                elif op == 'transcribe':
                    payload = service.transcribe(request)
                else:
                    raise ValueError('unknown operation')
            response = {'id': request_id, 'ok': True, 'payload': payload}
        except Exception as error:
            code = ('INVALID_ARGUMENT' if isinstance(error, (ValueError, TypeError, KeyError))
                    else 'DEPENDENCY_MISSING' if isinstance(error, ImportError) else 'UPSTREAM_ERROR')
            print('[asr] ' + str(error), file=sys.stderr, flush=True)
            response = {'id': request_id, 'ok': False, 'code': code, 'message': str(error)}
        print(json.dumps(response, ensure_ascii=False), file=protocol, flush=True)
        if shutdown:
            return


if __name__ == '__main__':
    main()
