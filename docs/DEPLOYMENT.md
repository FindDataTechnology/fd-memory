# 永忆（fd-memory）部署教程

面向第一次把永忆落到自己机器 / 自己集群上的运维与开发者。全流程只用公开信息：
一个 Node 服务（零外部依赖，SQLite + markdown 文件即全部状态），可选一个 Python 蒸馏
sidecar。文中所有地址、域名、命名空间均为占位符，替换成你自己的即可。

- 五分钟本地起跑见 [`README.md`](../README.md)；本文覆盖生产形态的部署与防护。
- 多节点接入远端记忆服务的配方见 [`docs/federation-recipe.md`](federation-recipe.md)。

## 1. 部署形态怎么选

| 形态 | 适用 | 章节 |
| --- | --- | --- |
| 直接跑（裸机 / 虚机） | 个人、单机、评测 | §2 |
| Docker 单容器 | 最常见起点 | §3 |
| systemd 常驻 | 虚机长期服务 | §4 |
| docker-compose | 服务 + 蒸馏 sidecar 一起管 | §5 |
| Kubernetes | 多节点 / 团队，集群内地址暴露 | §6 |

不管哪种形态，**读面（/digest、/mcp）与写面（/capture、/admin/\*）的暴露边界都一样**：
`/admin/*` 永远不出内网（§7 边缘封禁表）。

## 2. 源码直接跑

```bash
git clone https://github.com/FindDataTechnology/fd-memory
cd fd-memory
npm ci && npm run build

# 最小只读服务（绑定仅回环，不对外）
node dist/index.js serve --port 4000
curl http://127.0.0.1:4000/healthz   # → {"status":"ok"}
```

对外服务至少设这两个变量：

```bash
FD_MEMORY_DATA=/var/lib/fdmm \
FD_MEMORY_PEPPER='<生产必改：token 散列 pepper，泄露即全树令牌可被重放计算>' \
FD_MEMORY_HOST=0.0.0.0 \
node dist/index.js serve --port 49375
```

数据目录里两样东西就是全部真源：`owners/`（markdown wiki，真源）与 `db/`（派生
SQLite，可随时重建）。备份只备 wiki，SQLite 丢了跑一次 reembed 即可恢复。

## 3. Docker 单容器

仓库自带 `Dockerfile`（node:22-slim，非 root，`EXPOSE 49375`）：

```bash
docker build -t fd-memory .
docker run -d --name fd-memory \
  -v fdmm-data:/data \
  -e FD_MEMORY_PEPPER='<生产 pepper>' \
  -p 127.0.0.1:49375:49375 \
  fd-memory
docker exec fd-memory node dist/index.js token mint --kind platform --namespace '*' --label bootstrap
```

端口映射建议钉在 `127.0.0.1:`，让反向代理来接管对外暴露，而不是容器直接吃公网。

## 4. systemd 常驻

`/etc/systemd/system/fd-memory.service`：

```ini
[Unit]
Description=YongYi (fd-memory) long-term memory service
After=network-online.target

[Service]
User=fdmm
Group=fdmm
Environment=FD_MEMORY_DATA=/var/lib/fdmm
Environment=FD_MEMORY_HOST=0.0.0.0
Environment=FD_MEMORY_PORT=49375
# pepper 不写在这里——用 EnvironmentFile 放 600 权限的文件
EnvironmentFile=/etc/fd-memory/env
ExecStart=/usr/local/bin/node /opt/fd-memory/dist/index.js serve
Restart=on-failure
RestartSec=3
StateDirectory=fdmm
DynamicUser=yes

[Install]
WantedBy=multi-user.target
```

`systemctl daemon-reload && systemctl enable --now fd-memory`，
健康检查探 `GET /healthz`（公开、只读，可当存活探针）。

## 5. docker-compose（含蒸馏 sidecar）

蒸馏（distill）是可选面：把原始观测沉淀成 L2 经验页。需要第二个服务
（`distiller/` 目录，Python + 自己的 LLM 车道凭据）：

```yaml
services:
  fd-memory:
    build: .
    ports: ["127.0.0.1:49375:49375"]
    environment:
      FD_MEMORY_DATA: /data
      FD_MEMORY_HOST: 0.0.0.0
      FD_MEMORY_DISTILLER_URL: http://distiller:8100
      FD_MEMORY_DISTILL_ENABLED: "1"
    volumes: ["fdmm-data:/data"]
    depends_on: [distiller]

  distiller:
    build: ./distiller
    environment:
      DISTILLER_SHARED_TOKEN: ${DISTILLER_SHARED_TOKEN:?}
      # distiller 的 LLM 车道凭据走你自己的 secret 管理
    expose: ["8100"]

volumes:
  fdmm-data:
```

两门都要过蒸馏才启用（`FD_MEMORY_DISTILLER_URL` + `FD_MEMORY_DISTILL_ENABLED=1`）——
只设一个不会启动调度，这是有意的安全默认。

## 6. Kubernetes 通用形态

集群内的最小形态（namespace、镜像仓库、节点选择全部留给你）：

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: fd-memory
  namespace: <your-namespace>
spec:
  replicas: 1          # 单写者模型：多副本需要外部存储方案，先保持 1
  template:
    spec:
      containers:
      - name: fd-memory
        image: <your-registry>/<repo>/fd-memory:<tag>
        ports: [{ containerPort: 49375 }]
        env:
        - name: FD_MEMORY_DATA
          value: /data
        - name: FD_MEMORY_PEPPER
          valueFrom: { secretKeyRef: { name: fd-memory-env, key: pepper } }
        readinessProbe:
          httpGet: { path: /healthz, port: 49375 }
        livenessProbe:
          httpGet: { path: /healthz, port: 49375 }
        volumeMounts: [{ name: data, mountPath: /data }]
      volumes:
      - name: data
        persistentVolumeClaim: { claimName: fd-memory-data }
---
apiVersion: v1
kind: Service
metadata:
  name: fd-memory
  namespace: <your-namespace>
spec:
  type: ClusterIP      # 不要 NodePort 直暴公网；公网入口交给边缘反代
  selector: { app: fd-memory }
  ports: [{ port: 49375, targetPort: 49375 }]
```

要点：

- **Service 用 ClusterIP**。NodePort 只适合配合「边缘反代 + 路径封禁」使用，且地址
  不得出内网；直接暴露等于把 `/admin/*` 的形状送给公网扫描器。
- 蒸馏 sidecar（`distiller/`）单独 Deployment + ClusterIP，主服务经
  `FD_MEMORY_DISTILLER_URL=http://<distiller-svc>:8100` 对接。
- PVC 保留 `owners/` 与 `db/`；如用对象存储做冷备见 §8。

## 7. 反向代理与路径封禁（必做）

边缘按这张表放行/封禁（Nginx 与 Caddy 各给一份模板，概念一致）：

| 路径 | 处置 | 说明 |
| --- | --- | --- |
| `/healthz` | 反代放行 | 公开只读探针 |
| `/digest` | 反代放行 | Bearer 鉴权；无 token 返回 401 |
| `/mcp` | 反代放行 | **SSE 必须关缓冲**（见下） |
| `/admin/*`（mint/metrics/reindex/report） | **边缘 404** | 令牌铸造与运维面只留内网 |
| `/capture` | 边缘 404（v1） | 写面走内网或 MCP，不开公网 |

Nginx：

```nginx
location / {
  return 404;                       # 默认拒
}
location = /healthz { proxy_pass http://fd-memory:49375; }
location = /digest  { proxy_pass http://fd-memory:49375; }
location = /mcp {
  proxy_pass http://fd-memory:49375;
  proxy_http_version 1.1;
  proxy_buffering off;              # SSE：不攒包，否则流式输出会整段迟到
  proxy_read_timeout 3600s;
}
# /admin/* 与 /capture 不在 server 块里出现 = 天然 404
```

Caddy：

```caddy
example.com {
  handle /healthz { reverse_proxy fd-memory:49375 }
  handle /digest  { reverse_proxy fd-memory:49375 }
  handle /mcp {
    reverse_proxy fd-memory:49375 {
      transport http { keepalive 3600s }
    }
    flush_interval -1               # SSE 直出
  }
  handle { respond 404 }            # 其余一律 404（含 /admin、/capture）
}
```

即使服务侧对 `/admin/*` 有鉴权，边缘也必须封——鉴权门挡住滥用，路径封禁挡住
「这个服务存在运维面」这一信息本身。

## 8. 备份与恢复

```bash
# 备份（wiki 真源 + token 库；SQLite 派生库可不备）
tar czf fdmm-wiki-$(date +%F).tar.gz -C /var/lib/fdmm owners tokens.db

# 恢复演练（校验和先行——校验不过不称「可恢复」）
sha256sum fdmm-wiki-*.tar.gz
tar xzf <archive> -C /var/lib/fdmm
# 派生库重建：
node scripts/reembed.mjs --data /var/lib/fdmm   # 或删 db/ 让首启重建（向量车道需 distiller sidecar 在线）
```

纪律建议：快照按日落第二介质；每周挑一份做恢复演练；pepper 与令牌库单独加密备份
（丢了 pepper 等于全树令牌失效——这既是事故也是特性）。

## 9. 升级与回滚

1. 镜像/代码打版本标签，升级 = 换 tag + 滚动重启；
2. 升级前跑 `npm test`（70+ 单元）；改了评测场景集要记 `scenes_version`，新旧基线不可混比；
3. schema 有破坏性变更时仓内会带迁移脚本（`src/scripts/`），升级顺序=先备份再迁移；
4. 回滚 = 退回上一 tag；派生 SQLite 与真源 markdown 分离，旧版读新真源不损坏。

## 10. 令牌自举（全新实例第一次铸造）

```bash
# 1) 在受信任主机上用 CLI 铸第一枚 platform 根（习惯上打 bootstrap 标签）
node dist/index.js token mint --kind platform --namespace '*' --label bootstrap

# 2) 用它经 /admin/mint 发人根 token（只在内网调用）
curl -X POST http://127.0.0.1:49375/admin/mint \
  -H "authorization: Bearer $BOOT" \
  -H 'content-type: application/json' \
  -d '{"namespace":"u/<owner>","label":"dev"}'

# 3) deployment token 同样由 CLI 或 platform 根铸造
node dist/index.js token mint --kind deployment --namespace d/<pack>/<agent>
```

作用域树 `platform → person → deployment`，权限沿树向下收敛；完整语义在
`src/auth.ts` 与 README 的权限段。

## 11. 安全清单（上线前逐条打勾）

- [ ] `FD_MEMORY_PEPPER` 已改为生产值，且只存在于 secret 管理面
- [ ] `/admin/*` 与 `/capture` 在边缘 404，公网 curl 拿不到 401 之外的信息
- [ ] 服务绑定 `0.0.0.0` 的机器只有反代可达（防火墙只开 443 给反代）
- [ ] `FD_MEMORY_DISTILL_DAILY_TOKENS` 预算按你的 LLM 车道配额设定
- [ ] 备份落第二介质，且做过一次恢复演练
- [ ] 令牌轮换：新 token 先铸、旧 token 宽限窗后吊销；宽限期不进公网日志
- [ ] 评测/日志/transcript 不入库（`continue-baseline.json` 是本地产物）

## 12. 冒烟验收

```bash
curl -s https://<your-host>/healthz                       # 200 {"status":"ok"}
curl -s -o /dev/null -w '%{http_code}\n' https://<your-host>/digest          # 401（鉴权门在）
curl -s -o /dev/null -w '%{http_code}\n' https://<your-host>/admin/mint      # 404（边缘封禁）
curl -s -X POST https://<your-host>/mcp \
  -H "authorization: Bearer <token>" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","method":"initialize","id":1}'      # 200 JSON-RPC 握手
```

四条全对，部署面就绪。
