// シリアル接続の統一 I/F。バックエンドを 2 つ持ち、**プラットフォームごとに
// 逆の優先順**で選ぶ。どちらか片方だけでは両環境をカバーできない。
//
//   デスクトップ -> Web Serial (navigator.serial)
//   Android      -> WebUSB     (navigator.usb)
//
// なぜデスクトップで WebUSB が使えないか (Windows で実際に踏んだ):
//   ESP32-C5/C6 の内蔵 USB-Serial-JTAG は composite device で、Windows では
//     MI_00 (CDC = シリアル本体) -> usbser.sys が占有し COM ポートになる
//     MI_02 (JTAG)              -> WinUSB
//   WebUSB は「カーネルドライバが握っているインターフェース」を
//   claimInterface() できないので、MI_00 を掴もうとする WebUSB 版は
//   デバイス選択の直後に必ず失敗する (デバイスは選べるのに繋がらない)。
//   Web Serial は usbser.sys / COM ポート経由なのでこれが通る。
//
// なぜ Android で Web Serial が使えないか (実際に踏んだ):
//   Chrome 148 (2026-04) で Android にも navigator.serial が生えた。ただし
//   これは Bluetooth RFCOMM と一部端末の Android Serial API 向けで、
//   **USB CDC の ESP は列挙されない**。「存在するから」で serial を選ぶと
//   選択ダイアログにデバイスが出てこない。Android には usbser.sys が無く
//   WebUSB が CDC を直接 claim できるので、そちらが正解。
//
// 公開する port オブジェクト:
//   { name, read(), write(bytes), close(), matches(dev) }
//   read()  -> Uint8Array (0 長もあり得る) / null なら相手が閉じた
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./usb_serial.js"));
  } else {
    root.transport = factory(root.usbSerial);
  }
})(typeof self !== "undefined" ? self : this, function (usbSerial) {
  "use strict";

  // ESP ボードで使われる USB ブリッジの VID。Web Serial のフィルタ用。
  const VENDOR_IDS = [0x303a, 0x10c4, 0x1a86];
  const SERIAL_FILTERS = VENDOR_IDS.map((usbVendorId) => ({ usbVendorId }));

  // Android 判定。userAgentData があればそちらを信じる。
  function isAndroid() {
    if (typeof navigator === "undefined") return false;
    const uad = navigator.userAgentData;
    if (uad && typeof uad.platform === "string") return uad.platform === "Android";
    return /Android/i.test(navigator.userAgent || "");
  }

  // どちらのバックエンドを使うか。**プラットフォームで優先順が逆になる**。
  //
  // デスクトップ: Web Serial を優先。WebUSB は usbser.sys が握っている
  //   CDC インターフェースを claim できないため (README 参照)。
  // Android: WebUSB を優先。Chrome 148 (2026-04) で navigator.serial が
  //   生えたが、これは Bluetooth RFCOMM と一部端末の Android Serial API 向けで
  //   **USB CDC の ESP は列挙されない**。一方 Android には usbser.sys が無いので
  //   WebUSB が CDC を直接 claim できる。存在するからといって serial を
  //   選ぶと「デバイスが出てこない」ことになる (実際に踏んだ)。
  function kind() {
    if (typeof navigator === "undefined") return null;
    const order = isAndroid() ? ["usb", "serial"] : ["serial", "usb"];
    for (const k of order) {
      if (k === "serial" && navigator.serial) return "serial";
      if (k === "usb" && navigator.usb) return "usb";
    }
    return null;
  }

  // ---- Web Serial ------------------------------------------------------

  async function openSerial(serialPort, baud) {
    // bufferSize は既定 255B と小さく、921600 baud では読み落としの元になる。
    await serialPort.open({ baudRate: baud, bufferSize: 65536 });

    let reader = serialPort.readable ? serialPort.readable.getReader() : null;
    let writer = serialPort.writable ? serialPort.writable.getWriter() : null;

    return {
      backend: "serial",
      name: "Web Serial",
      raw: serialPort,
      label() {
        const info = serialPort.getInfo ? serialPort.getInfo() : {};
        return info.usbVendorId
          ? `VID ${info.usbVendorId.toString(16)} PID ${(info.usbProductId || 0).toString(16)}`
          : "serial";
      },
      async read() {
        if (!reader) return null;
        const { value, done } = await reader.read();
        return done ? null : value;
      },
      async write(bytes) {
        if (!writer) throw new Error("書き込みストリームがありません");
        await writer.write(bytes);
      },
      async close() {
        // reader/writer のロックを外してからでないと port.close() が拒否される。
        if (reader) {
          try { await reader.cancel(); } catch (_) { /* すでに閉じている */ }
          try { reader.releaseLock(); } catch (_) { /* 同上 */ }
          reader = null;
        }
        if (writer) {
          // writer.close() はストリームごと閉じてしまうので releaseLock だけにする。
          try { writer.releaseLock(); } catch (_) { /* 同上 */ }
          writer = null;
        }
        try { await serialPort.close(); } catch (_) { /* 抜線後など */ }
      },
    };
  }

  // ---- WebUSB ----------------------------------------------------------

  async function openUsb(device, baud) {
    const p = await usbSerial.open(device, baud);
    return {
      backend: "usb",
      name: p.name,
      raw: device,
      label() { return device.productName || "unknown"; },
      async read() {
        const r = await p.device.transferIn(p.epIn, 16384);
        if (r.status === "stall") {
          await p.device.clearHalt("in", p.epIn);
          return new Uint8Array(0);
        }
        if (!r.data || r.data.byteLength === 0) return new Uint8Array(0);
        return new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength);
      },
      write: (bytes) => usbSerial.write(p, bytes),
      close: () => usbSerial.close(p),
    };
  }

  // ---- 共通 ------------------------------------------------------------

  // ユーザー操作(クリック)から直接呼ぶこと。手前に await を挟むと
  // ジェスチャーが失効して選択ダイアログが出ないブラウザがある。
  async function requestPort(baud) {
    if (kind() === "serial") {
      const sp = await navigator.serial.requestPort({ filters: SERIAL_FILTERS });
      return openSerial(sp, baud);
    }
    if (kind() === "usb") {
      const dev = await navigator.usb.requestDevice({ filters: usbSerial.FILTERS });
      return openUsb(dev, baud);
    }
    throw new Error("このブラウザは Web Serial も WebUSB も持っていません");
  }

  // 許可済みのポートがあれば開く。無ければ null（ジェスチャー不要）。
  async function permittedPort(baud) {
    if (kind() === "serial") {
      const ports = await navigator.serial.getPorts();
      // フィルタは requestPort 時にしか効かないので自前で VID を見る。
      const sp = ports.find((p) => {
        const info = p.getInfo ? p.getInfo() : {};
        return info.usbVendorId === undefined || VENDOR_IDS.includes(info.usbVendorId);
      });
      return sp ? openSerial(sp, baud) : null;
    }
    if (kind() === "usb") {
      const devices = await navigator.usb.getDevices();
      const dev = devices.find((d) => usbSerial.matches(d));
      return dev ? openUsb(dev, baud) : null;
    }
    return null;
  }

  // 抜き挿しの通知。cb(connected:boolean) を呼ぶ。
  function onPresenceChange(cb) {
    if (kind() === "serial") {
      navigator.serial.addEventListener("connect", () => cb(true));
      navigator.serial.addEventListener("disconnect", () => cb(false));
    } else if (kind() === "usb") {
      navigator.usb.addEventListener("connect", (e) => {
        if (usbSerial.matches(e.device)) cb(true);
      });
      navigator.usb.addEventListener("disconnect", () => cb(false));
    }
  }

  return { kind, requestPort, permittedPort, onPresenceChange, VENDOR_IDS };
});
