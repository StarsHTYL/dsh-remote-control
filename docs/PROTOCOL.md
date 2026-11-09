# dsh-remote-control wire protocol (v1)

本文档是给**自己实现客户端**的人看的（鸿蒙 ArkTS、Kotlin、Swift、Rust…）。
参考实现：`lib/client.js`（Node），`client/arkts/RemoteTunnel.ets`（ArkTS）。

约定：所有多字节整数都是**大端**；`b64u` = 无填充的 base64url；`sha256`/`hmac` = SHA-256 / HMAC-SHA256；JSON 一律 UTF-8。

---

## 1. 配对码

主机把一段 JSON 编码成 `dshr1.` + `base64url(json)`：

```jsonc
{
  "v": 1,
  "id": "a89a819e596d7832",        // 主机指纹 = hex(sha256(hostPub)[0..8])
  "name": "YAOSHI-16-Ultra",
  "pk": "b64u(hostPub)",           // 32 字节 X25519 公钥
  "psk": "b64u(32B)",              // 配对密钥，长期有效，撤销时轮换
  "exp": 1793907044894,            // 仅提示用，协议不校验
  "cands": [
    { "kind": "tcp", "host": "192.168.3.6", "port": 45871, "label": "lan:WLAN" },
    { "kind": "udp", "host": "192.168.3.6", "port": 45873, "label": "lan:WLAN" },
    { "kind": "udp", "host": "138.246.3.135", "port": 45873, "label": "wan" },
    { "kind": "tcp", "host": "138.246.3.135", "port": 45871, "label": "wan" }
  ],
  "relay": { "host": "relay.example.com", "port": 45880, "room": "a89a819e596d7832", "token": "" }
}
```

`cands` 是主机自己探测到的地址：`label` 以 `lan:` 开头的是内网地址，`wan` 是 STUN 观察到的公网映射。
`relay` 可为 `null`。

---

## 2. 链路（Link）

链路只负责「把一段字节当作一条消息送过去」，提供两种：

### 2.1 TCP 链路

```
[u32 长度][负载]      // 长度上限 8 MiB，建议单条 ≤ 1 MiB
```

### 2.2 UDP 链路

每个数据报：`[u8 版本=1][u8 标志][u32 序号][负载]`（6 字节头）

| 标志 | 含义 | 负载 |
| --- | --- | --- |
| `0x01` | ACK | `u32 已按序收到的最大序号` |
| `0x02` | FIN | 空 |
| `0x04` | PUNCH（打洞/保活） | `"DSHR1PUNCH:<hostId>"` |
| `0x08` | DATA | 一条应用消息（≤ 994 字节） |

可靠性规则（客户端与服务端一致）：

* 序号从 1 开始递增（u32 回绕），每条 DATA 独占一个序号。
* 收到 DATA 立刻回 ACK（最大连续序号）；收到重复序号重发 ACK 并丢弃。
* 乱序缓存上限 512 条；`nextExpected` 收到才交付上层。
* 未确认报文按 `250ms × 2^tries`（上限 2500ms）重传，14 次后判定链路失败。
* 每 15 秒发一个 PUNCH 保活，维持 NAT 映射。

---

## 3. 握手

握手帧是**明文 JSON**（一条 Link 消息一个 JSON），只在建立连接时出现。

```
C → S  {"t":"hello","v":1,"pk":b64u(clientPub),"n1":b64u(24B随机),"proof":b64u(32B)}
S → C  {"t":"welcome","v":1,"pk":b64u(hostPub),"n2":b64u(24B随机),"proof":b64u(32B)}
```

```
proofC = HMAC(psk, "dshr1/c" ‖ clientPub ‖ n1)
proofS = HMAC(psk, "dshr1/s" ‖ hostPub   ‖ n1 ‖ n2 ‖ clientPub)
Z      = X25519(clientPriv, hostPub)          // = X25519(hostPriv, clientPub)
key    = HKDF-SHA256(ikm = Z ‖ psk, salt = n1 ‖ n2, info = "dshr1/tunnel", 32B)
```

校验失败（`proofS` 不匹配等）必须**直接断开**，不得继续。

---

## 4. 加密帧

握手之后，每条 Link 消息都是一个独立的 AEAD 帧：

```
[12B nonce][密文][16B GCM tag]        // AES-256-GCM，key 见上
```

明文结构：

```
[u8 版本=1][u16 分片序号][u16 分片总数][u16 消息号][分片负载]
```

* 一条 JSON 消息先序列化，按 `单条 Link 负载上限 − 35` 切片（TCP：任意；UDP：994−35=959 字节）。
* 每片单独加密封装成一个 Link 消息；UDP 链路的丢包由链路层按序号重传。
* 收到全部分片后按序号拼接 → UTF-8 JSON。
* `消息号` 每条消息 +1（u16 回绕），用于重组；`分片总数` 与 `分片序号` 不符或超时（60 秒）即丢弃。
* 认证失败、版本不符、越界分片一律丢弃并计一次错误。

---

## 5. 消息

三种 JSON 消息（都在加密帧里）：

```jsonc
{ "i": 7, "m": "fs.list", "p": { "path": "E:\\" } }   // 请求
{ "i": 7, "r": { "entries": [] } }                    // 成功响应
{ "i": 7, "e": { "code": "forbidden-path", "message": "…" } }  // 失败响应
{ "ev": "ready", "d": { … } }                         // 服务端事件（无 i）
```

`i` 由客户端分配，同一连接内必须唯一（建议从 1 自增）；响应原样带回。
超时建议 20 秒（大文件传输放宽到 60 秒）。

客户端连接成功后应立即发一条事件上报设备名（可选但推荐，主机界面会显示）：

```jsonc
{ "ev": "device", "d": { "name": "Mate 60", "os": "HarmonyOS 5" } }
```

---

## 6. 方法

| 方法 | 参数 | 返回 |
| --- | --- | --- |
| `sys.ping` | `{}` | `{ time }` |
| `sys.info` | `{}` | `{ app, name, hostId, version, origin, roots:[{path,label}], capabilities, web:{origin,url}, platform, arch, hostname, node }` |
| `fs.roots` | `{}` | `[{path,label}]` |
| `fs.list` | `{ path, all? }` | `{ path, root, entries:[{name,type,size,mtime}] }`，`type` ∈ `dir`/`file`/`other` |
| `fs.stat` | `{ path }` | `{ path, type, size, mtime, mode }` |
| `fs.read` | `{ path, offset?, length? }` | `{ path, offset, size, eof, data: b64 }`，单次最多 64 KiB |
| `fs.write` | `{ path, offset, data: b64, truncate? }` | `{ path, size, offset }`；`offset` 必须等于当前文件大小（`truncate:true` 时从 0 重写） |
| `fs.mkdir` | `{ path }` | `{ path }` |
| `fs.remove` | `{ path, recursive? }` | `{ path }` |
| `fs.rename` | `{ from, to }` | `{ path }` |
| `session.list` | `{}` | `{ items:[{sessionId,title,running,blank,updatedAt,cwd}] }` |
| `session.create` | `{ cwd?, agentPreset? }` | `{ sessionId }` |
| `session.prompt` | `{ sessionId, text, mode?: "queue"\|"steer" }` | `{ accepted: true }` |
| `session.cancel` | `{ sessionId }` | `{ accepted: true }` |
| `session.watch` | `{ sessionId }` | `{ watchId }`；随后推送 `session.frame` 事件 |
| `session.unwatch` | `{ watchId }` | `{ closed }` |
| `tunnel.open` | `{ host?, port? }` | `{ streamId, host, port }`（默认连主机本机 127.0.0.1 的 Harness 端口） |
| `tunnel.write` | `{ streamId, data: b64 }` | `{ bytes }` |
| `tunnel.close` | `{ streamId }` | `{ closed }` |

### 事件

| 事件 | 负载 |
| --- | --- |
| `ready` | `{ peerId, host: <status> }` |
| `session.frame` | `{ watchId, frame }` — `frame` 与 Harness 会话日志帧同构（`snapshot` / `event` / `assistant-stream`） |
| `session.error` | `{ watchId, message }` |
| `tunnel.data` | `{ streamId, data: b64 }` |
| `tunnel.close` | `{ streamId }` |
| `tunnel.error` | `{ streamId, message }` |

### 错误码

`bad-path`、`forbidden-path`、`offset-mismatch`、`no-stream`、`unavailable`、`bad-request`、`unknown-method`、`internal`。

---

## 7. 连接顺序

客户端按 `cands` 依次尝试，任一成功即停止：

### 7.1 TCP 直连

`label` 为 `lan:*` 的优先（超时 3 秒），再试 `wan`。连上后直接跑第 3 节握手。

### 7.2 UDP 打洞

1. 绑定一个 UDP socket（任意本地端口）。
2. 对每个 `kind=udp` 的候选，每 250ms 发一个 PUNCH 包：`"DSHR1PUNCH:<offer.id>"`，最多 2.5 秒。
3. 主机收到 PUNCH 后会回一个同样的 PUNCH 到你的源地址（这就是打洞：它的 NAT 因此建立了到你端点的映射，而你的 NAT 在发包时已经建好了到它的映射）。
4. 收到回包后，用这个源地址作为 `remote` 建立 UDP 链路，立刻发握手 `hello`（主机会用同一个 socket 回答）。
5. 2.5 秒没有回包就换下一个候选。

NAT 行为提示：`sys.info`/`ready` 里主机的 `nat.behavior` 是 `cone` 时成功率高；`symmetric` 时基本只能走中继。

### 7.3 TCP 中继

1. TCP 连到 `relay.host:relay.port`，发一行 JSON：

   ```json
   {"t":"join","room":"<offer.id>","role":"guest","token":"<relay.token>","name":"Mate 60"}
   ```

2. 中继回 `{"t":"ok"}`（等待中）、`{"t":"error","message":…}` 或 `{"t":"paired"}`。
3. 收到 `paired` 后，这个 socket 就变成透明字节管道，**按 2.1 的 TCP 链路格式**收发，并立刻跑握手。

主机侧连接中继时用 `role:"host"`，`room` 同为 `offer.id`。

---

## 8. 实现检查清单

- [ ] 握手 proof 校验失败必须断开，不能降级。
- [ ] `psk` 只用来做 HMAC 与 HKDF 输入，不要直接当 AES 密钥。
- [ ] 每个 AEAD 帧用新的随机 12 字节 nonce。
- [ ] UDP 链路必须实现 ACK/重传/乱序缓存，否则大文件一定损坏。
- [ ] 路径一律相对 `roots` 校验，客户端不要拼接 `..`。
- [ ] 上传用 `offset` 累加，收到 `offset-mismatch` 时用返回的 `expected` 续传。
