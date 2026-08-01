from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

import torch
from torch import nn

from train_katacat_m1 import BOARD_CELLS, POLICY_SIZE, KataCatNet


class ResidualPolicyAdapter(nn.Module):
    """Small zero-initialized policy correction on frozen trunk features."""

    def __init__(
        self,
        trunk_channels: int,
        adapter_channels: int = 8,
        max_abs_delta: float = 1.0,
    ) -> None:
        super().__init__()
        self.max_abs_delta = float(max_abs_delta)
        self.features = nn.Sequential(
            nn.Conv2d(trunk_channels, adapter_channels, kernel_size=1, bias=False),
            nn.GroupNorm(1, adapter_channels),
            nn.ReLU(inplace=True),
            nn.Flatten(),
        )
        self.output = nn.Linear(adapter_channels * BOARD_CELLS, POLICY_SIZE)
        nn.init.zeros_(self.output.weight)
        nn.init.zeros_(self.output.bias)

    def forward(self, trunk: torch.Tensor) -> torch.Tensor:
        raw = self.output(self.features(trunk))
        return self.max_abs_delta * torch.tanh(raw)


class KataCatM36Model(nn.Module):
    """Frozen M3.4.1 network plus a bounded residual policy adapter."""

    def __init__(
        self,
        base: KataCatNet,
        adapter_channels: int = 8,
        max_abs_delta: float = 1.0,
    ) -> None:
        super().__init__()
        self.base = base
        for parameter in self.base.parameters():
            parameter.requires_grad = False
        trunk_channels = int(base.stem[0].out_channels)
        self.adapter = ResidualPolicyAdapter(
            trunk_channels,
            adapter_channels=adapter_channels,
            max_abs_delta=max_abs_delta,
        )

    def trunk_features(self, inputs: torch.Tensor) -> torch.Tensor:
        return self.base.trunk(self.base.stem(inputs))

    def policy_outputs(
        self, inputs: torch.Tensor
    ) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
        trunk = self.trunk_features(inputs)
        base_logits = self.base.policy_head(trunk)
        delta = self.adapter(trunk)
        return base_logits + delta, base_logits, delta

    def forward(
        self, inputs: torch.Tensor
    ) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor, torch.Tensor]:
        trunk = self.trunk_features(inputs)
        base_logits = self.base.policy_head(trunk)
        corrected_logits = base_logits + self.adapter(trunk)
        return (
            corrected_logits,
            self.base.value_head(trunk).squeeze(1),
            self.base.score_head(trunk).squeeze(1),
            self.base.ownership_head(trunk),
        )


@dataclass(frozen=True)
class LoadedM36:
    model: KataCatM36Model
    checkpoint: dict[str, Any]


def load_m36_checkpoint(path: Path, device: torch.device | str = "cpu") -> LoadedM36:
    checkpoint = torch.load(path, map_location="cpu")
    if checkpoint.get("encodingVersion") != "PLAYER_RELATIVE_V1":
        raise ValueError(
            f"Expected PLAYER_RELATIVE_V1, got {checkpoint.get('encodingVersion')}"
        )
    allowed_stages = {
        "M3.6_RESIDUAL_POLICY_ADAPTER",
        "M3.6.2_TARGETED_RESIDUAL_POLICY_ADAPTER",
    }
    if checkpoint.get("stage") not in allowed_stages:
        raise ValueError(f"Unexpected residual-adapter checkpoint stage: {checkpoint.get('stage')}")
    channels = int(checkpoint["channels"])
    blocks = int(checkpoint["blocks"])
    base = KataCatNet(channels, blocks)
    base.load_state_dict(checkpoint["baseModelState"])
    model = KataCatM36Model(
        base,
        adapter_channels=int(checkpoint["adapterChannels"]),
        max_abs_delta=float(checkpoint["maxAbsDelta"]),
    )
    model.adapter.load_state_dict(checkpoint["adapterState"])
    model = model.to(device)
    model.eval()
    return LoadedM36(model=model, checkpoint=checkpoint)
