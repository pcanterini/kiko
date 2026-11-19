# RNNoise and DeepFilterNet over files, for scripts/perf/noise.ts. Runs in its own venv (the
# script says how to make it); never opens a device or plays anything.
#
#   <venv>/bin/python -I scripts/perf/noise-denoise.py <rnnoise|deepfilternet> [--model-dir <dir>] [--atten-lim <dB>]
#   then stdin lines "<in.wav>\t<out.wav>", one per file
# In and out: 16-bit mono PCM at 16 kHz. Both models work at 48 kHz, so each file is resampled up
# and back down (torchaudio's sinc resampler). RNNoise: xiph's library with its built-in model (the
# pyrnnoise wheel's librnnoise), one fresh state per file. DeepFilterNet: DeepFilterNet3, CPU,
# from --model-dir (the unzipped DeepFilterNet3 folder) so nothing is downloaded into ~/Library;
# --atten-lim caps how far it turns noise down (its atten_lim_db).
# Prints "ok <out>" or "error <in> <why>" per line.
import ctypes
import sys
import wave

import numpy as np
import torch
import torchaudio.functional as AF

method = sys.argv[1]
model_dir = sys.argv[sys.argv.index("--model-dir") + 1] if "--model-dir" in sys.argv else None
atten_lim = float(sys.argv[sys.argv.index("--atten-lim") + 1]) if "--atten-lim" in sys.argv else None
torch.set_num_threads(2)


def read(path):
    with wave.open(path, "rb") as w:
        assert w.getnchannels() == 1 and w.getsampwidth() == 2, path
        rate = w.getframerate()
        data = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)
    return torch.from_numpy(data.astype(np.float32) / 32768.0), rate


def write(path, audio):
    data = (audio.clamp(-1, 32767 / 32768) * 32768).round().to(torch.int16).numpy()
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        w.writeframes(data.tobytes())


if method == "rnnoise":
    from pyrnnoise.rnnoise import lib

    FRAME = lib.rnnoise_get_frame_size()  # 480 samples: 10 ms at 48 kHz

    def denoise(x48):
        state = lib.rnnoise_create(None)
        try:
            # RNNoise takes float samples on the 16-bit scale, 10 ms frames. Its output lags by
            # about a frame (nothing to a recognizer); a frame of silence past the end lets the
            # last of the speech out.
            pcm = np.concatenate([x48.numpy() * 32768.0, np.zeros(FRAME, np.float32)]).astype(np.float32)
            pad = (-len(pcm)) % FRAME
            pcm = np.concatenate([pcm, np.zeros(pad, np.float32)])
            out = np.empty_like(pcm)
            for i in range(0, len(pcm), FRAME):
                frame = np.ascontiguousarray(pcm[i : i + FRAME])
                res = np.empty(FRAME, np.float32)
                lib.rnnoise_process_frame(state, res.ctypes.data_as(ctypes.POINTER(ctypes.c_float)), frame.ctypes.data_as(ctypes.POINTER(ctypes.c_float)))
                out[i : i + FRAME] = res
            return torch.from_numpy(out[: len(x48)] / 32768.0)
        finally:
            lib.rnnoise_destroy(state)

elif method == "deepfilternet":
    from df.enhance import enhance, init_df

    model, df_state, _ = init_df(model_base_dir=model_dir, log_level="ERROR", log_file=None, post_filter=False)
    assert df_state.sr() == 48000

    def denoise(x48):
        return enhance(model, df_state, x48.unsqueeze(0), atten_lim_db=atten_lim).squeeze(0)

else:
    sys.exit(f"unknown method {method}")

print("ready", flush=True)
for line in sys.stdin:
    parts = line.rstrip("\n").split("\t")
    if len(parts) != 2:
        continue
    src, dst = parts
    try:
        x, rate = read(src)
        x48 = AF.resample(x, rate, 48000)
        y = denoise(x48)
        write(dst, AF.resample(y, 48000, 16000)[: len(x)])
        print(f"ok {dst}", flush=True)
    except Exception as e:  # noqa: BLE001
        print(f"error {src} {e!r}", flush=True)
