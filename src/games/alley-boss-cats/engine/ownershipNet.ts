/**
 * Running the ownership net in the browser.
 *
 * The engine judges territory with `influenceCount` — how much open ground each
 * side is nearer to. Measured against what the ground actually becomes, it
 * finds most of the territory that forms (77% recall) and is wrong about more
 * than two thirds of what it claims (32% precision). The trained net reads 71%
 * precision at 82% open-point accuracy, and that gap is what this exists to
 * carry into play.
 *
 * Deliberately plain. Batch norm is folded into the convolutions at export, so
 * everything here is convolution, addition and ReLU over a 9x9 board — no
 * matrix library, no WASM, nothing to go wrong across the language boundary
 * that `ownershipNet.test.ts` cannot catch against the exported reference
 * cases. A transposed weight still runs and still returns plausible numbers;
 * the only way to know the port is right is to check it numerically.
 *
 * Not wired into play by itself. `evaluateState` consults it through the
 * cached map in ownershipTerm.ts, which is what keeps it off the hot path.
 */
import { BOARD_SIZE } from "../types";
import type { Board, GameState, Player } from "../types";
import { calculateTerritories } from "../territory";

export const CELL_COUNT = BOARD_SIZE * BOARD_SIZE;
/** empty / A cat / B cat / neutral point / A territory / B territory / to-move */
export const INPUT_PLANES = 7;

interface PackedTensor {
  shape: number[];
  data: string;
}

interface ConvLayer {
  weight: PackedTensor;
  bias: PackedTensor;
}

export interface OwnershipNetFile {
  schemaVersion: number;
  architecture: { boardSize: number; inputPlanes: number; channels: number; blocks: number };
  batchNormFolded: boolean;
  layers: {
    stem: ConvLayer;
    ownHead: ConvLayer;
    marginConv: ConvLayer;
    marginLinear1: ConvLayer;
    marginLinear2: ConvLayer;
  };
  blockLayers: Array<{ conv1: ConvLayer; conv2: ConvLayer }>;
  referenceCases?: Array<{
    input: PackedTensor;
    ownLogits: PackedTensor;
    margin: number;
  }>;
}

interface Conv {
  weight: Float32Array;
  bias: Float32Array;
  outChannels: number;
  inChannels: number;
  kernel: number;
}

export interface OwnershipPrediction {
  /** Row-major probability that each point ends up each side's, or nobody's. */
  probabilityA: Float32Array;
  probabilityB: Float32Array;
  /** The net's own estimate of the final territory margin, from A's side. */
  margin: number;
}

export function decodeTensor(tensor: PackedTensor): Float32Array {
  const binary = atob(tensor.data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
}

function toConv(layer: ConvLayer): Conv {
  const [outChannels, inChannels, kernel] = layer.weight.shape;
  return {
    weight: decodeTensor(layer.weight),
    bias: decodeTensor(layer.bias),
    outChannels,
    inChannels,
    kernel: kernel ?? 1,
  };
}

export class OwnershipNet {
  private readonly stem: Conv;
  private readonly blocks: Array<{ conv1: Conv; conv2: Conv }>;
  private readonly ownHead: Conv;
  private readonly marginConv: Conv;
  private readonly marginLinear1: { weight: Float32Array; bias: Float32Array };
  private readonly marginLinear2: { weight: Float32Array; bias: Float32Array };
  readonly channels: number;

  constructor(private readonly file: OwnershipNetFile) {
    if (file.architecture.boardSize !== BOARD_SIZE) {
      throw new Error(
        `net was trained for a ${file.architecture.boardSize}x${file.architecture.boardSize} board`,
      );
    }
    if (!file.batchNormFolded) {
      throw new Error("net must be exported with batch norm folded into the convolutions");
    }
    this.channels = file.architecture.channels;
    this.stem = toConv(file.layers.stem);
    this.blocks = file.blockLayers.map((block) => ({
      conv1: toConv(block.conv1),
      conv2: toConv(block.conv2),
    }));
    this.ownHead = toConv(file.layers.ownHead);
    this.marginConv = toConv(file.layers.marginConv);
    // Decoded once. Doing it per call re-parsed 41k base64 floats every time,
    // which cost more than the convolutions the net actually needs to do.
    this.marginLinear1 = {
      weight: decodeTensor(file.layers.marginLinear1.weight),
      bias: decodeTensor(file.layers.marginLinear1.bias),
    };
    this.marginLinear2 = {
      weight: decodeTensor(file.layers.marginLinear2.weight),
      bias: decodeTensor(file.layers.marginLinear2.bias),
    };
  }

  /** Input planes for a position, matching the training encoder exactly. */
  static encode(board: Board, toMove: Player, territories?: Record<Player, { row: number; col: number }[]>): Float32Array {
    const planes = new Float32Array(INPUT_PLANES * CELL_COUNT);
    for (let row = 0; row < BOARD_SIZE; row += 1) {
      for (let col = 0; col < BOARD_SIZE; col += 1) {
        const cell = board[row][col];
        const plane =
          cell === "EMPTY" ? 0 : cell === "PLAYER_A" ? 1 : cell === "PLAYER_B" ? 2 : 3;
        planes[plane * CELL_COUNT + row * BOARD_SIZE + col] = 1;
      }
    }
    // Planes 4 and 5 carry settled territory. Training left them zero, so they
    // stay zero here: filling them now would feed the net an input distribution
    // it never saw, which is worse than leaving the capacity unused.
    void territories;
    if (toMove === "A") planes.fill(1, 6 * CELL_COUNT, 7 * CELL_COUNT);
    return planes;
  }

  static encodeState(state: GameState): Float32Array {
    return OwnershipNet.encode(state.board, state.currentPlayer);
  }

  predict(input: Float32Array, withMargin = true): OwnershipPrediction {
    let activation = this.convolve(input, this.stem, INPUT_PLANES, true);

    for (const block of this.blocks) {
      const first = this.convolve(activation, block.conv1, this.channels, true);
      const second = this.convolve(first, block.conv2, this.channels, false);
      // Residual add, then ReLU — the order the trained block uses.
      for (let index = 0; index < second.length; index += 1) {
        const sum = second[index] + activation[index];
        second[index] = sum > 0 ? sum : 0;
      }
      activation = second;
    }

    const ownLogits = this.convolve(activation, this.ownHead, this.channels, false);
    const probabilityA = new Float32Array(CELL_COUNT);
    const probabilityB = new Float32Array(CELL_COUNT);
    for (let cell = 0; cell < CELL_COUNT; cell += 1) {
      const nobody = ownLogits[cell];
      const a = ownLogits[CELL_COUNT + cell];
      const b = ownLogits[2 * CELL_COUNT + cell];
      const peak = Math.max(nobody, a, b);
      const expNobody = Math.exp(nobody - peak);
      const expA = Math.exp(a - peak);
      const expB = Math.exp(b - peak);
      const total = expNobody + expA + expB;
      probabilityA[cell] = expA / total;
      probabilityB[cell] = expB / total;
    }

    return {
      probabilityA,
      probabilityB,
      margin: withMargin ? this.marginFrom(activation) : Number.NaN,
    };
  }

  private marginFrom(activation: Float32Array): number {
    const reduced = this.convolve(activation, this.marginConv, this.channels, true);

    const { weight: w1, bias: b1 } = this.marginLinear1;
    const hidden = new Float32Array(b1.length);
    for (let out = 0; out < b1.length; out += 1) {
      let sum = b1[out];
      const base = out * reduced.length;
      for (let index = 0; index < reduced.length; index += 1) sum += w1[base + index] * reduced[index];
      hidden[out] = sum > 0 ? sum : 0;
    }

    const { weight: w2, bias: b2 } = this.marginLinear2;
    let margin = b2[0];
    for (let index = 0; index < hidden.length; index += 1) margin += w2[index] * hidden[index];
    return margin;
  }

  /**
   * Convolution with 'same' padding, and optionally the ReLU after it.
   *
   * Kernel 1 is the common case for the heads and skips the spatial loop; the
   * 3x3 path clamps to the board rather than materialising a padded copy.
   */
  private convolve(
    input: Float32Array,
    conv: Conv,
    inChannels: number,
    relu: boolean,
  ): Float32Array {
    const { weight, bias, outChannels, kernel } = conv;
    const output = new Float32Array(outChannels * CELL_COUNT);
    const radius = (kernel - 1) / 2;

    for (let out = 0; out < outChannels; out += 1) {
      const outBase = out * CELL_COUNT;
      const biasValue = bias[out];
      for (let cell = 0; cell < CELL_COUNT; cell += 1) output[outBase + cell] = biasValue;

      for (let inChannel = 0; inChannel < inChannels; inChannel += 1) {
        const inBase = inChannel * CELL_COUNT;
        const weightBase = (out * inChannels + inChannel) * kernel * kernel;

        if (kernel === 1) {
          const w = weight[weightBase];
          if (w === 0) continue;
          for (let cell = 0; cell < CELL_COUNT; cell += 1) {
            output[outBase + cell] += w * input[inBase + cell];
          }
          continue;
        }

        for (let ky = 0; ky < kernel; ky += 1) {
          for (let kx = 0; kx < kernel; kx += 1) {
            const w = weight[weightBase + ky * kernel + kx];
            if (w === 0) continue;
            const dy = ky - radius;
            const dx = kx - radius;
            const rowStart = Math.max(0, -dy);
            const rowEnd = Math.min(BOARD_SIZE, BOARD_SIZE - dy);
            const colStart = Math.max(0, -dx);
            const colEnd = Math.min(BOARD_SIZE, BOARD_SIZE - dx);
            for (let row = rowStart; row < rowEnd; row += 1) {
              const outRow = outBase + row * BOARD_SIZE;
              const inRow = inBase + (row + dy) * BOARD_SIZE + dx;
              for (let col = colStart; col < colEnd; col += 1) {
                output[outRow + col] += w * input[inRow + col];
              }
            }
          }
        }
      }

      if (relu) {
        for (let cell = 0; cell < CELL_COUNT; cell += 1) {
          if (output[outBase + cell] < 0) output[outBase + cell] = 0;
        }
      }
    }

    return output;
  }

  /**
   * Checks the port against the outputs the exporter recorded from PyTorch.
   *
   * Returns the largest disagreement seen. Anything much above float32 rounding
   * means the two are computing different things — which a wrong weight layout
   * does without ever looking wrong.
   */
  verifyAgainstReferences(): { cases: number; maxOwnLogitError: number; maxMarginError: number } {
    const cases = this.file.referenceCases ?? [];
    let maxOwnLogitError = 0;
    let maxMarginError = 0;

    for (const reference of cases) {
      const prediction = this.predict(decodeTensor(reference.input));
      const expected = decodeTensor(reference.ownLogits);
      // Reference logits are (cells, 3); the softmax here is the fair
      // comparison, since logits differing by a constant per cell agree.
      for (let cell = 0; cell < CELL_COUNT; cell += 1) {
        const nobody = expected[cell * 3];
        const a = expected[cell * 3 + 1];
        const b = expected[cell * 3 + 2];
        const peak = Math.max(nobody, a, b);
        const total = Math.exp(nobody - peak) + Math.exp(a - peak) + Math.exp(b - peak);
        maxOwnLogitError = Math.max(
          maxOwnLogitError,
          Math.abs(prediction.probabilityA[cell] - Math.exp(a - peak) / total),
          Math.abs(prediction.probabilityB[cell] - Math.exp(b - peak) / total),
        );
      }
      maxMarginError = Math.max(maxMarginError, Math.abs(prediction.margin - reference.margin));
    }

    return { cases: cases.length, maxOwnLogitError, maxMarginError };
  }
}

/** Settled territory counted exactly, plus the net's read of the open points. */
export function hybridMargin(state: GameState, prediction: OwnershipPrediction): number {
  const territories = calculateTerritories(state.board);
  let margin = territories.A.length - territories.B.length;
  for (let row = 0; row < BOARD_SIZE; row += 1) {
    for (let col = 0; col < BOARD_SIZE; col += 1) {
      if (state.board[row][col] !== "EMPTY") continue;
      const cell = row * BOARD_SIZE + col;
      margin += prediction.probabilityA[cell] - prediction.probabilityB[cell];
    }
  }
  return margin;
}
