#!/usr/bin/env python3
"""郊狼 3.0 (DG-LAB Coyote v3) 电脑端测试工具

用途：在还没贴电极片、或不方便用手机的时候，验证 BLE 链路和协议字节。

安全默认值：
  * 连接后强度为 0，必须显式 --strength 才会输出
  * 软上限默认 30（BF 指令），最大 200
  * 异常 / Ctrl+C 都会先发全零帧再断开

用法：
  python coyote-pc.py --scan                 列出附近 BLE 设备
  python coyote-pc.py --dry-run              不连接，只打印将要发送的字节
  python coyote-pc.py --battery              连接并读电量
  python coyote-pc.py --limit 30             写软上限（A/B 都是 30）
  python coyote-pc.py --strength 5 --hold 3  强度 5，持续 3 秒
  python coyote-pc.py --demo                 缓慢爬升到 15 的演示

依赖：pip install bleak
"""

import argparse
import asyncio
import sys
import time

try:
    from bleak import BleakScanner, BleakClient
except ImportError:
    print("缺少 bleak，请先运行：pip install bleak")
    sys.exit(1)

DEVICE_NAME = "47L121000"      # 郊狼 3.0 主机
SENSOR_NAME = "47L1210A"       # 无线感应器（如有）

UUID_WRITE = "0000150a-0000-1000-8000-00805f9b34fb"
UUID_NOTIFY = "0000150b-0000-1000-8000-00805f9b34fb"
UUID_BATTERY = "00001500-0000-1000-8000-00805f9b34fb"

MAX_DEVICE_STRENGTH = 200
SOFT_LIMIT_DEFAULT = 30

MODE_NO_CHANGE = 0b0000
MODE_INCREASE = 0b0001
MODE_DECREASE = 0b0010
MODE_ABSOLUTE = 0b0011


# ------------------------------------------------------------------ 协议组装

def build_bf(limit_a=SOFT_LIMIT_DEFAULT, limit_b=SOFT_LIMIT_DEFAULT,
             freq_balance_a=0, freq_balance_b=0,
             int_balance_a=0, int_balance_b=0):
    """BF：软上限 + 平衡参数，7 字节，无返回。"""
    return bytes([
        0xBF,
        max(0, min(MAX_DEVICE_STRENGTH, int(limit_a))),
        max(0, min(MAX_DEVICE_STRENGTH, int(limit_b))),
        max(0, min(255, int(freq_balance_a))),
        max(0, min(255, int(freq_balance_b))),
        max(0, min(255, int(int_balance_a))),
        max(0, min(255, int(int_balance_b))),
    ])


def build_b0(seq=0, strength_a=0, strength_b=0, mode=MODE_NO_CHANGE,
             a_freq=(10, 10, 10, 10), a_int=(0, 0, 0, 0),
             b_freq=(10, 10, 10, 10), b_int=(0, 0, 0, 0)):
    """B0：20 字节，每 100ms 一帧。

    0     0xB0
    1     序列号(高4位) + 强度解析方式(低4位)
    2     A 强度 0-200
    3     B 强度 0-200
    4-7   A 波形频率 ×4（10-240）
    8-11  A 波形强度 ×4（0-100）
    12-15 B 波形频率 ×4
    16-19 B 波形强度 ×4
    """
    def clamp(v, lo, hi):
        return max(lo, min(hi, int(v)))

    head = ((seq & 0x0F) << 4) | (mode & 0x0F)
    out = bytearray([0xB0, head,
                     clamp(strength_a, 0, MAX_DEVICE_STRENGTH),
                     clamp(strength_b, 0, MAX_DEVICE_STRENGTH)])
    out += bytes(clamp(f, 10, 240) for f in a_freq)
    out += bytes(clamp(i, 0, 100) for i in a_int)
    out += bytes(clamp(f, 10, 240) for f in b_freq)
    out += bytes(clamp(i, 0, 100) for i in b_int)
    assert len(out) == 20, len(out)
    return bytes(out)


def parse_b1(data):
    if not data or data[0] != 0xB1 or len(data) < 4:
        return None
    return {"seq": data[1] & 0x0F, "a": data[2], "b": data[3]}


# ------------------------------------------------------------------ 设备操作

class Coyote:
    def __init__(self, client, verbose=True):
        self.client = client
        self.verbose = verbose
        self.seq = 0
        self.last_b1 = None

    def on_notify(self, _char, data: bytearray):
        if not data:
            return
        if data[0] == 0xB1:
            info = parse_b1(data)
            if info:
                self.last_b1 = info
                if self.verbose:
                    print("  <- B1   seq=%d  A=%d  B=%d" % (info["seq"], info["a"], info["b"]))
        elif data[0] == 0xBE and self.verbose:
            print("  <- BE   设备已启用第三方控制")

    def next_seq(self):
        self.seq = (self.seq + 1) & 0x0F
        return self.seq

    async def write(self, payload):
        if self.verbose:
            print("  -> %s" % payload.hex(" ").upper())
        await self.client.write_gatt_char(UUID_WRITE, payload, response=False)

    async def set_limit(self, a, b):
        await self.write(build_bf(a, b))

    async def hold(self, a, b, seconds, mode=MODE_ABSOLUTE):
        print("输出 A=%d B=%d，%.1f 秒（Ctrl+C 立即停止）" % (a, b, seconds))
        start = time.time()
        try:
            while time.time() - start < seconds:
                await self.write(build_b0(self.next_seq(), a, b, mode))
                await asyncio.sleep(0.1)
        finally:
            await self.zero()

    async def zero(self):
        for _ in range(3):
            await self.write(build_b0(self.next_seq(), 0, 0, MODE_ABSOLUTE))
            await asyncio.sleep(0.05)
        print("已归零")


async def scan(timeout=8.0):
    print("扫描 %d 秒…" % int(timeout))
    found = await BleakScanner.discover(timeout=timeout)
    if not found:
        print("没有发现任何 BLE 设备：确认郊狼已开机，且没有被手机 App 占用连接。")
        return None
    hit = None
    for d in found:
        name = d.name or ""
        tag = ""
        if name in (DEVICE_NAME, SENSOR_NAME):
            tag = "   <-- 郊狼"
            if hit is None and name == DEVICE_NAME:
                hit = d
        print("  %-24s %s%s" % (name or "(无名)", d.address, tag))
    return hit


async def run(args):
    if args.dry_run:
        print("== 离线自检（不连接设备）==")
        print("BF 软上限 30 :", build_bf(30).hex(" ").upper())
        print("B0 零强度    :", build_b0().hex(" ").upper())
        print("B0 绝对 5  A :", build_b0(1, 5, 0, MODE_ABSOLUTE).hex(" ").upper())
        print("B0 相对 +1   :", build_b0(2, 1, 0, MODE_INCREASE).hex(" ").upper())
        print("长度: B0=%d 字节, BF=%d 字节" % (len(build_b0()), len(build_bf(30))))
        return 0

    if args.scan:
        await scan(args.timeout)
        return 0

    dev = await scan(args.timeout)
    if dev is None:
        print("没找到郊狼主机（%s）。" % DEVICE_NAME)
        return 2

    print("连接 %s …" % dev.address)
    client = BleakClient(dev.address, timeout=20.0)
    await client.connect()
    print("已连接")

    coyote = Coyote(client, verbose=not args.quiet)
    try:
        await client.start_notify(UUID_NOTIFY, lambda c, d: coyote.on_notify(c, d))
        await asyncio.sleep(0.3)

        try:
            raw = await client.read_gatt_char(UUID_BATTERY)
            if raw:
                print("电量：%d%%" % raw[0])
        except Exception as e:
            print("读电量失败：%s" % e)

        if args.battery:
            return 0

        limit = max(0, min(MAX_DEVICE_STRENGTH, args.limit))
        await coyote.set_limit(limit, limit)
        print("软上限写入：A=%d B=%d" % (limit, limit))
        await asyncio.sleep(0.3)

        if args.strength:
            s = max(0, min(limit, args.strength))
            if s != args.strength:
                print("强度 %d 超过软上限，已夹到 %d" % (args.strength, s))
            await coyote.hold(s, s, args.hold)
        elif args.demo:
            print("演示：0 → 15 缓慢爬升")
            for level in range(1, 16):
                await coyote.hold(level, level, 0.6)
        else:
            print("未指定强度，只验证连接与软上限。")
            await coyote.hold(0, 0, 1.0)

        if coyote.last_b1:
            print("最后回传：A=%d B=%d" % (coyote.last_b1["a"], coyote.last_b1["b"]))
        print("完成")
        return 0
    finally:
        try:
            await coyote.zero()
        except Exception:
            pass
        try:
            await client.disconnect()
        except Exception:
            pass
        print("已断开")


def main():
    ap = argparse.ArgumentParser(description="郊狼 3.0 电脑端测试工具")
    ap.add_argument("--scan", action="store_true", help="只扫描设备")
    ap.add_argument("--dry-run", action="store_true", help="不连接，只打印字节")
    ap.add_argument("--battery", action="store_true", help="连接后读电量就退出")
    ap.add_argument("--limit", type=int, default=SOFT_LIMIT_DEFAULT, help="软上限 0-200，默认 30")
    ap.add_argument("--strength", type=int, default=0, help="A/B 强度 0-200，默认 0")
    ap.add_argument("--hold", type=float, default=3.0, help="持续秒数，默认 3")
    ap.add_argument("--demo", action="store_true", help="缓慢爬升到 15 的演示")
    ap.add_argument("--timeout", type=float, default=8.0, help="扫描超时秒")
    ap.add_argument("--quiet", action="store_true", help="不打印每一帧字节")
    args = ap.parse_args()

    try:
        return asyncio.run(run(args))
    except KeyboardInterrupt:
        print("\n已中断")
        return 1


if __name__ == "__main__":
    sys.exit(main())
