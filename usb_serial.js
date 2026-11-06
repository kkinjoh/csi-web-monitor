// WebUSB 上の USB シリアルドライバ。
//
// ESP ボードで使われる 3 種のブリッジに対応する:
//   - CDC-ACM      : ESP32-C5/C6 内蔵の USB-Serial-JTAG (VID 0x303A) ほか
//   - CP210x       : classic ESP32 DevKitC 定番 (VID 0x10C4)
//   - CH340/CH341  : 互換ボード定番 (VID 0x1A86) ※実験的
//
// Web Serial API は Android Chrome に無いため、WebUSB で直接叩く。
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.usbSerial = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const FILTERS = [
    { vendorId: 0x303a }, // Espressif (USB-Serial-JTAG / USB-OTG CDC)
    { vendorId: 0x10c4 }, // Silicon Labs CP210x
    { vendorId: 0x1a86 }, // WCH CH340/CH341
    { classCode: 0x02 },  // その他の CDC-ACM デバイス
  ];

  // navigator.usb.getDevices() が返す「許可済みデバイス」を FILTERS で絞るための判定。
  // requestDevice() は filters を自前で適用してくれるが getDevices() はしないので、
  // 同じ origin で他の USB デバイスも許可されている場合に必要になる。
  function matches(device) {
    return FILTERS.some((f) => {
      if (f.vendorId !== undefined && device.vendorId !== f.vendorId) return false;
      if (f.classCode !== undefined && !hasClass(device, f.classCode)) return false;
      return true;
    });
  }

  // deviceClass だけでなくインターフェースの class も見る
  // (CDC-ACM は deviceClass=0x00/0xEF で、0x02 はインターフェース側に出ることが多い)。
  function hasClass(device, classCode) {
    if (device.deviceClass === classCode) return true;
    for (const cfg of device.configurations || []) {
      for (const intf of cfg.interfaces) {
        for (const alt of intf.alternates) {
          if (alt.interfaceClass === classCode) return true;
        }
      }
    }
    return false;
  }

  // ---- CDC-ACM --------------------------------------------------------

  function findCdcInterfaces(device) {
    let comm = null;
    let data = null;
    for (const intf of device.configuration.interfaces) {
      for (const alt of intf.alternates) {
        if (alt.interfaceClass === 0x02 && comm === null) comm = intf;
        if (alt.interfaceClass === 0x0a && data === null) data = intf;
      }
    }
    return { comm, data };
  }

  async function openCdcAcm(device, baud) {
    const { comm, data } = findCdcInterfaces(device);
    if (!comm || !data) throw new Error("CDC インターフェースが見つかりません");
    await device.claimInterface(comm.interfaceNumber);
    await device.claimInterface(data.interfaceNumber);

    // SET_LINE_CODING (baud, 1 stop, no parity, 8 data)
    const coding = new DataView(new ArrayBuffer(7));
    coding.setUint32(0, baud, true);
    coding.setUint8(4, 0);
    coding.setUint8(5, 0);
    coding.setUint8(6, 8);
    await device.controlTransferOut(
      { requestType: "class", recipient: "interface", request: 0x20, value: 0, index: comm.interfaceNumber },
      coding.buffer
    );
    // SET_CONTROL_LINE_STATE: DTR|RTS を定常アサート（リセットシーケンスにはならない）
    await device.controlTransferOut(
      { requestType: "class", recipient: "interface", request: 0x22, value: 0x03, index: comm.interfaceNumber }
    );

    const alt = data.alternates[0];
    const epIn = alt.endpoints.find((e) => e.direction === "in" && e.type === "bulk");
    const epOut = alt.endpoints.find((e) => e.direction === "out" && e.type === "bulk");
    if (!epIn) throw new Error("bulk IN エンドポイントが見つかりません");
    return { name: "CDC-ACM", epIn: epIn.endpointNumber, epOut: epOut ? epOut.endpointNumber : null, packetSize: epIn.packetSize };
  }

  // ---- CP210x ---------------------------------------------------------

  async function openCp210x(device, baud) {
    const intf = device.configuration.interfaces[0];
    await device.claimInterface(intf.interfaceNumber);
    const vendor = (request, value, data) =>
      device.controlTransferOut(
        { requestType: "vendor", recipient: "interface", request, value, index: intf.interfaceNumber },
        data
      );

    await vendor(0x00, 0x0001); // IFC_ENABLE
    const b = new DataView(new ArrayBuffer(4));
    b.setUint32(0, baud, true);
    await vendor(0x1e, 0, b.buffer); // SET_BAUDRATE
    await vendor(0x03, 0x0800);      // SET_LINE_CTL: 8N1
    await vendor(0x07, 0x0303);      // SET_MHS: DTR=1, RTS=1 (両方H → 自動リセット回路は非発火)

    const alt = intf.alternates[0];
    const epIn = alt.endpoints.find((e) => e.direction === "in" && e.type === "bulk");
    const epOut = alt.endpoints.find((e) => e.direction === "out" && e.type === "bulk");
    return { name: "CP210x", epIn: epIn.endpointNumber, epOut: epOut ? epOut.endpointNumber : null, packetSize: epIn.packetSize };
  }

  // ---- CH340 (実験的) --------------------------------------------------

  // Linux ch341.c と同じ分周計算。48MHz クロックをプリスケーラ+分周で割る。
  function ch340Divisor(baud) {
    const CLKRATE = 48000000;
    for (let ps = 3; ps >= 0; ps--) {
      for (let fact = 1; fact >= 0; fact--) {
        const clkDiv = 1 << (12 - 3 * ps - fact);
        const div = Math.round(CLKRATE / (clkDiv * baud));
        if (div >= 2 && div <= 256) {
          return ((0x100 - div) << 8) | (fact << 2) | ps;
        }
      }
    }
    throw new Error(`CH340: ボーレート ${baud} は設定不可`);
  }

  async function openCh340(device, baud) {
    const intf = device.configuration.interfaces[0];
    await device.claimInterface(intf.interfaceNumber);
    const ctrlOut = (request, value, index) =>
      device.controlTransferOut({ requestType: "vendor", recipient: "device", request, value, index });

    await ctrlOut(0xa1, 0, 0); // SERIAL_INIT
    // reg 0x13(divisor)/0x12(prescaler)。bit7 で即時送出（32B バッファリング抑止）
    await ctrlOut(0x9a, 0x1312, ch340Divisor(baud) | 0x80);
    // reg 0x25/0x18: LCR = ENABLE_RX|ENABLE_TX|CS8
    await ctrlOut(0x9a, 0x2518, 0x00c3);
    // MODEM_CTRL: DTR|RTS アサート（負論理）
    await ctrlOut(0xa4, ~((1 << 5) | (1 << 6)) & 0xff, 0);

    const alt = intf.alternates[0];
    const epIn = alt.endpoints.find((e) => e.direction === "in" && e.type === "bulk");
    const epOut = alt.endpoints.find((e) => e.direction === "out" && e.type === "bulk");
    return { name: "CH340", epIn: epIn.endpointNumber, epOut: epOut ? epOut.endpointNumber : null, packetSize: epIn.packetSize };
  }

  // ---- 共通 open ------------------------------------------------------

  async function open(device, baud) {
    await device.open();
    if (device.configuration === null) {
      await device.selectConfiguration(1);
    }
    let port;
    if (device.vendorId === 0x10c4) {
      port = await openCp210x(device, baud);
    } else if (device.vendorId === 0x1a86) {
      port = await openCh340(device, baud);
    } else {
      port = await openCdcAcm(device, baud); // Espressif 内蔵含む CDC-ACM
    }
    return { device, ...port };
  }

  // ホスト -> デバイスへバイト列を送る (制御コマンド用、docs/csi_ctrl.md)。
  // 3 バックエンドとも bulk OUT エンドポイントに素で流すだけでよい。
  // epOut が無いデバイス (受信専用構成) では例外を投げる。
  async function write(port, bytes) {
    if (port.epOut == null) throw new Error("このデバイスには bulk OUT エンドポイントがありません");
    // transferOut は分割してくれないが、制御コマンドは 1 行 512B 以内なので
    // 1 回の転送で収まる (docs/csi_ctrl.md)。
    const result = await port.device.transferOut(port.epOut, bytes);
    if (result.status !== "ok") throw new Error(`送信失敗: ${result.status}`);
    return result.bytesWritten;
  }

  async function close(port) {
    try {
      await port.device.close();
    } catch (_) {
      /* すでに切断済みなら無視 */
    }
  }

  return { FILTERS, matches, open, write, close };
});
