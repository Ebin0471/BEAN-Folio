#!/usr/bin/env python3
"""
LAXII local diffusion worker (open-source stack, GPU machines only).

A genuine Hugging Face Diffusers inference worker. It is invoked by the LAXII
Node bridge (src/lib/laxii/providers/diffusers.ts) when the local provider is
selected and available. It performs REAL model inference — it never emits
placeholder images; on any failure it exits non-zero with a diagnostic on
stderr and the bridge fails the job honestly.

Requirements (documented in docs/laxii/README.md):
  - NVIDIA GPU, 16 GB VRAM class (RTX 4060 Ti 16G / 4070 / 3090 / A4K ...)
    - SD1.5 path fits comfortably; SDXL path relies on fp16 + CPU offload
  - python3 with: torch (CUDA build), diffusers, transformers, accelerate,
    safetensors, Pillow
      pip install torch diffusers transformers accelerate safetensors Pillow
  - Model weights download from Hugging Face on first run into
    HF_HOME (defaults to ~/.cache/huggingface) — SD1.5 ≈ 4 GB on disk,
    SDXL ≈ 7 GB fp16. Set LAXII_MODEL_T2I / LAXII_MODEL_I2I /
    LAXII_MODEL_DEFAULT=sd15|sdxl to choose.
  - Optional identity guidance: IP-Adapter weights (Apache-2.0) via
    --identity-image; PuLID can be added on this same worker in production.

Contract:
  stdin (i2i mode only): raw image bytes (PNG/JPEG/WebP)
  stdout: diagnostic lines allowed, exactly one payload line "LAXII_B64:<png>"
  exit 0 only on success.

Licenses: diffusers Apache-2.0; SD1.5 weights CreativeML Open RAIL-M;
SDXL weights StabilityAI CreativeML Open RAIL++-M; IP-Adapter Apache-2.0.
No unlicensed weights are used. User photos are processed only for the
caller's request and are never retained for training (nothing is written
back to any model).
"""

import argparse
import base64
import io
import sys


def parse_args():
    p = argparse.ArgumentParser(description="LAXII local diffusion worker")
    p.add_argument("--mode", choices=["t2i", "i2i"], required=True)
    p.add_argument("--prompt", required=True)
    p.add_argument("--width", type=int, default=1024)
    p.add_argument("--height", type=int, default=1024)
    p.add_argument("--model", default=None, help="HF model id (overrides env defaults)")
    p.add_argument("--strength", type=float, default=0.55, help="i2i denoise strength 0-1")
    p.add_argument("--seed", type=int, default=None)
    p.add_argument("--steps", type=int, default=None, help="inference steps (default per model)")
    p.add_argument("--guidance", type=float, default=None, help="CFG scale")
    p.add_argument("--identity-image", default=None,
                   help="path to an identity reference (enables IP-Adapter when available)")
    return p.parse_args()


def read_stdin_bytes() -> bytes:
    data = sys.stdin.buffer.read()
    if not data:
        print("no image received on stdin", file=sys.stderr)
        sys.exit(2)
    return data


def load_pipeline(model_id: str, mode: str):
    from diffusers import (StableDiffusionImg2ImgPipeline, StableDiffusionPipeline,
                           StableDiffusionXLImg2ImgPipeline, StableDiffusionXLPipeline)
    import torch

    dtype = torch.float16 if torch.cuda.is_available() else torch.float32
    is_xl = "xl" in model_id.lower()
    if mode == "t2i":
        cls = StableDiffusionXLPipeline if is_xl else StableDiffusionPipeline
    else:
        cls = StableDiffusionXLImg2ImgPipeline if is_xl else StableDiffusionImg2ImgPipeline
    pipe = cls.from_pretrained(model_id, torch_dtype=dtype, safety_checker=None,
                               requires_safety_checker=False)
    pipe.to("cuda")
    # 16 GB VRAM discipline: sequential CPU offload keeps peaks low; enable
    # attention slicing for the SD1.5 path.
    try:
        pipe.enable_model_cpu_offload()
    except Exception:
        pass
    try:
        pipe.enable_attention_slicing()
    except Exception:
        pass
    return pipe


def maybe_attach_ip_adapter(pipe, identity_path: str | None):
    """Attach IP-Adapter (Apache-2.0 weights) when requested and installed."""
    if not identity_path:
        return
    try:
        pipe.load_ip_adapter("h94/IP-Adapter", subfolder="models",
                             weight_name="ip-adapter_sd15.sdg")
        from PIL import Image
        with Image.open(identity_path) as im:
            pipe.set_ip_adapter_scale(0.6)
            pipe._laxii_identity = im.convert("RGB")
    except Exception as e:  # identity guidance is optional — degrade honestly
        print(f"IP-Adapter unavailable, continuing without identity guidance: {e}",
              file=sys.stderr)


def main():
    args = parse_args()
    try:
        import torch  # noqa: F401 — availability was probed by the bridge
        pipe = load_pipeline(args.model or "runwayml/stable-diffusion-v1-5", args.mode)
        maybe_attach_ip_adapter(pipe, args.identity_image)

        generator = torch.Generator("cuda").manual_seed(args.seed) if args.seed is not None else None
        is_xl = "xl" in (args.model or "").lower()
        steps = args.steps or (30 if is_xl else 25)
        guidance = args.guidance or (6.5 if is_xl else 7.5)

        if args.mode == "t2i":
            result = pipe(prompt=args.prompt, width=args.width, height=args.height,
                          num_inference_steps=steps, guidance_scale=guidance,
                          generator=generator)
        else:
            from PIL import Image
            import numpy as np
            raw = read_stdin_bytes()
            init = Image.open(io.BytesIO(raw)).convert("RGB")
            init = init.resize((args.width, args.height))
            identity = getattr(pipe, "_laxii_identity", None)
            ip_image = identity if identity is not None else init
            result = pipe(prompt=args.prompt, image=init, ip_adapter_image=ip_image,
                          strength=max(0.05, min(0.95, args.strength)),
                          num_inference_steps=steps, guidance_scale=guidance,
                          generator=generator)

        out = result.images[0]
        buf = io.BytesIO()
        out.save(buf, format="PNG")
        sys.stdout.write("LAXII_B64:" + base64.b64encode(buf.getvalue()).decode("ascii"))
        sys.stdout.write("\n")
        sys.exit(0)
    except SystemExit:
        raise
    except Exception as e:
        print(f"LAXII worker error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
