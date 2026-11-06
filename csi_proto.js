// CSI ワイヤ規格の JavaScript 実装。
//
// components/csi_proto (C) / tools/csi_proto_py と 1:1 対応するミラー。
// 仕様の正は docs/csi_proto.md。version が食い違うフレームは弾く。
// ブラウザ (<script src>) と Node (require) の両方から使える形にしてある。
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.csiProto = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const MAGIC = 0xc51f;
  const VERSION = 1;
  const HDR_SIZE = 28;
  const CRC_SIZE = 2;

  const CHIP_NAMES = { 0: "ESP32", 1: "ESP32C5", 2: "ESP32C6", 255: "UNKNOWN" };
  const SIG_NAMES = { 0: "legacy", 1: "HT", 2: "VHT", 3: "HE" };

  // CRC-16/CCITT-FALSE (poly=0x1021, init=0xFFFF)。C/Python 実装と同一。
  function crc16(bytes, len) {
    let crc = 0xffff;
    for (let i = 0; i < len; i++) {
      crc ^= bytes[i] << 8;
      for (let b = 0; b < 8; b++) {
        crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
      }
    }
    return crc;
  }

  // 1 フレームをデコード。magic/version/CRC を検証し、失敗時 null。
  // buf は Uint8Array。frame.csi は buf のコピー (Int8Array)。
  function decode(buf) {
    if (buf.length < HDR_SIZE + CRC_SIZE) return null;
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    if (dv.getUint16(0, true) !== MAGIC) return null;
    if (buf[2] !== VERSION) return null;
    const csiLen = dv.getUint16(26, true);
    const total = HDR_SIZE + csiLen + CRC_SIZE;
    if (buf.length < total) return null;
    if (dv.getUint16(HDR_SIZE + csiLen, true) !== crc16(buf, HDR_SIZE + csiLen)) {
      return null;
    }
    const mac = Array.from(buf.subarray(20, 26));
    return {
      chip: buf[3],
      seq: dv.getUint32(4, true),
      timestampUs: dv.getUint32(8, true),
      rssi: dv.getInt8(12),
      noiseFloor: dv.getInt8(13),
      channel: buf[14],
      secondaryChannel: buf[15],
      bandwidth: buf[16], // 0=20MHz, 1=40MHz
      sigMode: buf[17],   // 0=legacy,1=HT,2=VHT,3=HE
      mcs: buf[18],
      mac,
      macStr: mac.map((b) => b.toString(16).padStart(2, "0")).join(":"),
      // [imag, real] インターリーブ (signed int8)
      csi: new Int8Array(buf.slice(HDR_SIZE, HDR_SIZE + csiLen).buffer),
      nSubcarriers: csiLen >> 1,
      totalBytes: total,
    };
  }

  // サブキャリアごとの振幅 sqrt(i^2 + q^2) を Float32Array で返す。
  function amplitudes(frame) {
    const n = frame.nSubcarriers;
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const im = frame.csi[2 * i];
      const re = frame.csi[2 * i + 1];
      out[i] = Math.sqrt(im * im + re * re);
    }
    return out;
  }

  // バイトストリームから magic で同期しつつフレームを切り出す。
  // シリアルは境界が保証されない & ログ文字列が混ざり得るので逐次再同期する。
  //
  // opts.onText を渡すと、フレームとして解釈できずに読み飛ばしたバイトを
  // 行単位のテキストとして受け取れる。同じリンクに混在する制御応答
  // (docs/csi_ctrl.md の JSON 行) と ESP のログ行を拾うのに使う。
  // 渡さなければ従来通り黙って捨てるだけで、挙動は変わらない。
  class FrameParser {
    constructor(opts) {
      this._buf = new Uint8Array(0);
      this._onText = (opts && opts.onText) || null;
      this._text = "";
      this._decoder = this._onText ? new TextDecoder("utf-8", { fatal: false }) : null;
    }

    // 読み飛ばしたバイトを行に組み立てて onText へ流す。
    _skipped(bytes) {
      if (!this._onText || bytes.length === 0) return;
      this._text += this._decoder.decode(bytes, { stream: true });
      let nl;
      while ((nl = this._text.indexOf("\n")) >= 0) {
        const line = this._text.slice(0, nl).trim();
        this._text = this._text.slice(nl + 1);
        if (line) this._onText(line);
      }
      // 行が来ないまま溜まり続ける（バイナリのゴミなど）場合の上限
      if (this._text.length > 4096) this._text = this._text.slice(-1024);
    }

    _append(chunk) {
      const merged = new Uint8Array(this._buf.length + chunk.length);
      merged.set(this._buf, 0);
      merged.set(chunk, this._buf.length);
      this._buf = merged;
    }

    // chunk (Uint8Array) を追記し、完成したフレームの配列を返す。
    feed(chunk) {
      this._append(chunk);
      const frames = [];
      for (;;) {
        // magic 0xC51F の LE バイト列 (0x1F, 0xC5) を探す
        let i = 0;
        for (; i + 1 < this._buf.length; i++) {
          if (this._buf[i] === 0x1f && this._buf[i + 1] === 0xc5) break;
        }
        if (i + 1 >= this._buf.length) {
          // magic 断片の可能性がある末尾 1 バイトだけ残して破棄
          if (this._buf.length > 1) {
            this._skipped(this._buf.subarray(0, this._buf.length - 1));
            this._buf = this._buf.slice(-1);
          }
          return frames;
        }
        if (i > 0) {
          this._skipped(this._buf.subarray(0, i));
          this._buf = this._buf.slice(i);
        }
        if (this._buf.length < HDR_SIZE + CRC_SIZE) return frames;
        const dv = new DataView(this._buf.buffer, this._buf.byteOffset);
        const csiLen = dv.getUint16(26, true);
        const total = HDR_SIZE + csiLen + CRC_SIZE;
        if (this._buf.length < total) return frames;
        const frame = decode(this._buf.subarray(0, total));
        if (frame !== null) {
          this._buf = this._buf.slice(total);
          frames.push(frame);
        } else {
          // CRC/version 不一致 → 1 バイト進めて再同期
          this._skipped(this._buf.subarray(0, 1));
          this._buf = this._buf.slice(1);
        }
      }
    }
  }

  return { MAGIC, VERSION, HDR_SIZE, CRC_SIZE, CHIP_NAMES, SIG_NAMES, crc16, decode, amplitudes, FrameParser };
});
