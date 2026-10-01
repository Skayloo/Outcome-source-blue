"""Prove the TURN relay is usable the way LiveKit will use it. Run it ON the relay host:

    python3 deploy/turn-relay-check.py

It reads the shared secret out of /etc/turnserver.conf, so nothing secret has to be typed.

Written after coturn spent an hour serving as an OPEN relay: the config was mode 600 and the
service runs as "turnserver", so it silently fell back to its defaults — answering STUN, looking
healthy, and asking nobody for credentials. A liveness check would have passed. This does not.

LiveKit signs the username "<expiry>:<participantID>" with the shared secret and hands the
browser the base64 HMAC-SHA1 as the password (TURN REST). If coturn is not configured for the
same mechanism the relay still answers STUN, still looks healthy, and is never usable — so the
check that matters is a real Allocate with exactly those credentials.
"""
import base64, hashlib, hmac, os, re, socket, struct, sys, time

MAGIC = 0x2112A442
REALM = "outcome.ru"
# Everything below comes from the config rather than from constants here: the address of this
# machine has changed twice, and a check still pointing at the previous one times out in a way
# that reads as "the relay is broken". Whatever coturn was told is what gets tested.
CONF = open("/etc/turnserver.conf").read()
SECRET = re.search(r"^static-auth-secret=(.+)$", CONF, re.M).group(1).strip()
HOST = re.search(r"^listening-ip=(.+)$", CONF, re.M).group(1).strip()
PORT = int(re.search(r"^listening-port=(\d+)$", CONF, re.M).group(1))

user = f"{int(time.time()) + 600}:selfcheck"
pwd = base64.b64encode(hmac.new(SECRET.encode(), user.encode(), hashlib.sha1).digest()).decode()


def attr(t, v):
    pad = (4 - len(v) % 4) % 4
    return struct.pack(">HH", t, len(v)) + v + b"\x00" * pad


def msg(mtype, tid, attrs=b"", key=None):
    if key:
        head = struct.pack(">HHI12s", mtype, len(attrs) + 24, MAGIC, tid)
        mi = hmac.new(key, head + attrs, hashlib.sha1).digest()
        attrs += attr(0x0008, mi)
    return struct.pack(">HHI12s", mtype, len(attrs), MAGIC, tid) + attrs


def parse(data):
    mtype, mlen = struct.unpack(">HH", data[:4])
    out, i = {}, 20
    while i < 20 + mlen:
        at, al = struct.unpack(">HH", data[i:i + 4])
        out[at] = data[i + 4:i + 4 + al]
        i += 4 + al + ((4 - al % 4) % 4)
    return mtype, out


s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
s.settimeout(5)

# Unauthenticated Allocate — expected to be refused with a nonce to use.
tid = os.urandom(12)
s.sendto(msg(0x0003, tid, attr(0x0019, struct.pack(">B3s", 17, b"\x00\x00\x00"))), (HOST, PORT))
mtype, a = parse(s.recv(2048))
if mtype != 0x0113:
    print(f"ПРОВАЛ: на Allocate без авторизации ждали 401, получили 0x{mtype:04x}")
    sys.exit(1)
if 0x0015 not in a:
    print(f"ПРОВАЛ: в отказе нет NONCE, атрибуты={[hex(k) for k in a]}")
    sys.exit(1)
nonce, realm = a[0x0015], a.get(0x0014, REALM.encode())

# The real thing, signed the way LiveKit signs it.
key = hashlib.md5(f"{user}:{realm.decode()}:{pwd}".encode()).digest()
tid = os.urandom(12)
attrs = (attr(0x0019, struct.pack(">B3s", 17, b"\x00\x00\x00")) + attr(0x0006, user.encode())
         + attr(0x0014, realm) + attr(0x0015, nonce))
s.sendto(msg(0x0003, tid, attrs, key), (HOST, PORT))
mtype, a = parse(s.recv(2048))

if mtype != 0x0103:
    err = a.get(0x0009, b"")
    code = (err[2] * 100 + err[3]) if len(err) >= 4 else "?"
    print(f"ПРОВАЛ: Allocate отклонён, код {code} — LiveKit'овские credentials coturn не принимает")
    sys.exit(1)

v = a[0x0016]  # XOR-RELAYED-ADDRESS
port = struct.unpack(">H", v[2:4])[0] ^ (MAGIC >> 16)
ip = socket.inet_ntoa(bytes(x ^ y for x, y in zip(v[4:8], struct.pack(">I", MAGIC))))
assert 49160 <= port <= 49200, f"relay-порт {port} вне заявленного диапазона 49160-49200"
print(f"OK: Allocate принят, релей выдал {ip}:{port} — credentials LiveKit'а coturn понимает")
