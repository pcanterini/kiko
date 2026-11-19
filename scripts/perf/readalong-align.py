"""Where each word of a Pocket clip really starts and ends: torchaudio's MMS_FA forced aligner on
the clip and its known text (readalong-pocket.ts --make wrote both). Writes truth.json beside them:
per clip, one entry per word of its text (split on spaces), start and end in 24 kHz samples, null
for a word with no letters to align (a dash on its own).

A venv of its own (never Pocket's):
    uv venv --python 3.12 <dir> && VIRTUAL_ENV=<dir> uv pip install torch==2.8.0 torchaudio==2.8.0
    <dir>/bin/python -I scripts/perf/readalong-align.py <work folder>
"""

import json
import re
import sys
import wave
from pathlib import Path

import torch
import torchaudio

work = Path(sys.argv[1])
bundle = torchaudio.pipelines.MMS_FA
model = bundle.get_model(with_star=False)
dictionary = bundle.get_dict(star=None)
OUT_RATE = 24000

ONES = "zero one two three four five six seven eight nine".split()


def letters(word: str) -> str:
    w = word.lower().replace("’", "'")
    w = re.sub(r"\d", lambda m: " " + ONES[int(m.group())] + " ", w)
    return "".join(c for c in w if c in dictionary and c != "-")


def load(path: Path) -> torch.Tensor:
    with wave.open(str(path), "rb") as f:
        frames = f.readframes(f.getnframes())
        rate = f.getframerate()
    x = torch.frombuffer(bytearray(frames), dtype=torch.int16).float() / 32768
    return torchaudio.functional.resample(x.unsqueeze(0), rate, bundle.sample_rate), rate


index = json.loads((work / "index.json").read_text())
out = []
for clip in index:
    words = clip["text"].split()
    keys = [letters(w) for w in words]
    wave_16k, rate = load(work / f"{clip['id']}.wav")
    with torch.inference_mode():
        emission, _ = model(wave_16k)
    tokens = [[dictionary[c] for c in k] for k in keys if k]
    flat = [t for w in tokens for t in w]
    aligned, scores = torchaudio.functional.forced_align(emission, torch.tensor([flat], dtype=torch.int32), blank=0)
    spans = torchaudio.functional.merge_tokens(aligned[0], scores[0].exp())
    ratio = wave_16k.size(1) / emission.size(1) / bundle.sample_rate * OUT_RATE
    result = []
    i = 0
    for k in keys:
        if not k:
            result.append(None)
            continue
        mine = spans[i : i + len(k)]
        i += len(k)
        result.append({"word": k, "start": int(mine[0].start * ratio), "end": int(mine[-1].end * ratio)})
    out.append({"id": clip["id"], "words": result})
    print(clip["id"], " ".join(f"{w['word']}@{w['start'] / OUT_RATE:.2f}" for w in result if w))

(work / "truth.json").write_text(json.dumps(out))
