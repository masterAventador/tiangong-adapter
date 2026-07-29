# 天工 Wan 2.7 适配器

这是一个独立于 Open Design 源码的轻量服务。它把 Open Design `Custom Image API`
发出的 OpenAI 风格图片请求，转换为阿里云百炼万相 2.7 的原生同步接口请求。

默认模型固定为 `wan2.7-image`。升级 Open Design 时不需要合并本仓库的代码。

本仓库还提供 `compose.tiangong.yaml`，它会在官方 Open Design 镜像外再加一层
Qwen Code 运行时，并在首次启动时预置：

- 默认代理：Qwen Code
- 默认文本模型：`qwen3-coder-plus`
- 默认图片模型：`custom-image`
- 下游图片模型：`wan2.7-image`

文本和图片共用同一个百炼 API Key。

## 天工托管版的组成

Open Design 上游仓库和天工的私有 fork 都不需要修改。托管版由本仓库在构建、启动
和访问三层完成适配：

1. 基于锁定 digest 的官方镜像构建派生镜像，安装固定版 Qwen Code；
2. 构建时把用户可见品牌替换为“天工”，删除源码映射，并注入动态界面过滤；
3. 首次启动时写入 Qwen Code、`qwen3-coder-plus` 和 Wan 2.7 配置；
4. 通过内部托管网关接收统一登录转发的请求，再由服务端注入 Open Design 令牌。

白标层会隐藏上游官方链接、社交账号、未启用的代理和媒体服务商，以及用户不需要
看到的第三方实现名称。产品需要真实展示的 `Qwen Code`、`qwen3-coder-plus`、
`Custom Image API` 和 `wan2.7-image` 保持原名。派生镜像结构发生变化时，构建会
拒绝继续，以免升级后静默失效。

## 调用链

```text
浏览器
  → 统一登录
  → 天工托管网关
  → Open Design
  → POST /v1/images/generations 或 /v1/images/edits
  → tiangong-wan-adapter
  → 百炼 /api/v1/services/aigc/multimodal-generation/generation
  → OpenAI 风格 { "data": [{ "url": "..." }] }
```

支持：

- 文生图
- JSON 格式图像编辑
- 1～9 张参考图转换（当前 Open Design 通常只发送一张）
- 百炼错误到 OpenAI 错误结构的转换
- 独立内部鉴权，不向 Open Design 暴露百炼 Key
- 请求体大小限制、调用超时和模型白名单

为避免意外增加费用，适配器只接受 `n=1`。百炼返回的图片链接有效期有限，
Open Design 会在收到响应后立即下载图片。

万相 2.7 不接受带透明通道的 PNG 参考图；需要编辑这类素材时，应先把透明背景
合并到白色或其他实色背景。

## 环境变量

复制示例并填写：

```bash
cp .env.example .env
```

必须配置：

| 变量 | 用途 |
| --- | --- |
| `ADAPTER_API_KEY` | Open Design 到适配器的内部令牌，建议用 `openssl rand -hex 32` 生成 |
| `DASHSCOPE_API_KEY` | 阿里云百炼 API Key |
| `DASHSCOPE_BASE_URL` | 百炼 API 基础地址，可用公共域名或业务空间专属域名 |

`DASHSCOPE_BASE_URL` 示例：

```text
https://dashscope.aliyuncs.com
https://<WorkspaceId>.cn-beijing.maas.aliyuncs.com
```

地域、业务空间域名和 API Key 必须匹配。官方接口说明见
[万相 2.7 图像生成与编辑 API](https://help.aliyun.com/zh/model-studio/wan-image-generation-and-editing-api-reference)。

## 与天工一起用 Docker Compose 启动

### 已配置版本

仓库所有者明确要求把百炼 Key 纳入私有 Git，以便跨设备直接部署。因此
`.env.tiangong` 是一个有意跟踪的私密配置文件。只要仓库成员或可见性发生变化，
就必须先轮换其中的百炼 Key、适配器令牌和 Open Design API 令牌。

克隆私有仓库后直接运行：

```bash
docker compose \
  --env-file .env.tiangong \
  -f compose.tiangong.yaml \
  up --build
```

这个配置会：

1. 基于已锁定 digest 的官方 Open Design 镜像安装固定版本的 Qwen Code；
2. 初始化数据卷中的 Qwen、代理和图片提供商配置；
3. 启动内部 Wan 2.7 适配器；
4. 不给 Open Design 容器发布任何主机端口；
5. 只把托管网关的 `7457` 端口映射到主机回环地址 `127.0.0.1:7456`；
6. 把同一把百炼 Key 同时交给 Qwen 文本模型和 Wan 图片模型。

首次启动后，天工会默认使用 `qwen3-coder-plus`。当代理判断需要生图时，会通过
Open Design 的 `custom-image` 媒体能力调用内部适配器。

生产域名预设为 `https://tiangong.xuanbai.tech`。仓库中的
`deploy/nginx/tiangong.xuanbai.tech.conf` 是统一登录接入前使用的封闭入口：
HTTPS 和证书可以提前准备，但所有产品请求固定返回 `503`，不会代理到 Open Design。
统一登录接入完成后，应以认证网关配置替换该文件，不能直接把公网请求转发到
`127.0.0.1:7456`。

### 统一登录接入契约

浏览器不能接触 `OD_API_TOKEN` 或内部网关令牌。统一登录在确认用户身份后，把请求
转发到 `127.0.0.1:7456`，并在服务端添加：

```text
X-Tiangong-Gateway-Token: <内部令牌>
```

托管网关验证这个请求头后，才会向内部 Open Design 注入：

```text
Authorization: Bearer <OD_API_TOKEN>
```

公网入口必须覆盖而不是透传浏览器提交的 `X-Tiangong-Gateway-Token`，同时清理
`Server` 等边缘响应头。没有内部令牌的请求会得到 `401`；Open Design 本身和图片
适配器都没有公网端口。

`OD_API_TOKEN` 是 Open Design 自身 HTTP API 的服务端访问令牌，不是百炼 Key，
也不是给前端用户填写的模型 Key。当前 Compose 使用同一个私密值完成统一登录到
托管网关、托管网关到 Open Design 的两段内部认证。

### 锁定版本

- Open Design：`0.16.1`，镜像 digest
  `sha256:eb1c9d55532ffd2088a4a71951cffd273dff65e96e077bcef8c8bac3a6e1f1a1`
- 上游 revision：`276b4d8e970bc143d7ad060181a89a834e3d9caf`
- Qwen Code：`0.18.0`
- Nginx：镜像 digest
  `sha256:5616878291a2eed594aee8db4dade5878cf7edcb475e59193904b198d9b830de`

升级 Open Design 时只修改 `.env.tiangong` 中的镜像 digest，再重建派生镜像并运行
本仓库全部测试；不需要向天工 fork 合并白标或模型适配代码。

### 无密钥模板版本

仓库提供的 `compose.example.yaml` 同时声明 Open Design 和适配器，但不会修改
Open Design 镜像。准备 `.env` 后运行：

```bash
docker compose -f compose.example.yaml up --build
```

Compose 只把 Open Design 绑定到主机 `127.0.0.1:7456`，适配器没有主机端口，
只能被同一 Docker 网络中的 Open Design 访问。

首次进入天工后，在设置中的 `Media providers` → `Custom Image API` 填写：

| 配置项 | 值 |
| --- | --- |
| Base URL | `http://wan-image-adapter:8080/v1` |
| API Key | 与 `.env` 中 `ADAPTER_API_KEY` 完全相同 |
| Model | `wan2.7-image` |

生成图片时选择 `custom-image`。之后的请求会由这个适配器接手。

若 Open Design 已经由另一份 Compose 启动，需要把两个容器接入同一内部网络，
并保持 Base URL 中的主机名能够在 Open Design 容器内解析。不要通过公网或
Nginx 暴露适配器端口。

## 单独启动适配器

```bash
docker build -t tiangong-wan-adapter .
docker run --rm \
  --env-file .env \
  -p 127.0.0.1:8080:8080 \
  tiangong-wan-adapter
```

健康检查：

```bash
curl http://127.0.0.1:8080/health
```

## 本地开发

要求 Node.js 24 或更高版本：

```bash
npm ci
npm test
npm run typecheck
```

生产启动：

```bash
npm run build
npm start
```

### 本地完整 E2E

完整回归使用本机已安装的 Google Chrome，不需要运行 `playwright install`，也不会
下载额外 Chromium：

```bash
docker compose \
  -p tiangong-e2e \
  --env-file .env.tiangong \
  -f compose.tiangong.yaml \
  -f compose.e2e.yaml \
  up -d --build

npm run test:e2e
```

测试完成后关闭隔离栈：

```bash
docker compose \
  -p tiangong-e2e \
  --env-file .env.tiangong \
  -f compose.tiangong.yaml \
  -f compose.e2e.yaml \
  down -v
```

E2E 使用仅绑定 `127.0.0.1:17456` 的本地统一登录替身，产品镜像和正式部署使用同一
条代码路径；替身只负责在本机测试中注入内部网关令牌。

## 接口

### `GET /health`

无需鉴权，用于容器健康检查。

### `POST /v1/images/generations`

```json
{
  "model": "wan2.7-image",
  "prompt": "一座未来主义的中国园林",
  "n": 1,
  "size": "1792x1024"
}
```

### `POST /v1/images/edits`

Open Design 使用 JSON 发送参考图：

```json
{
  "model": "wan2.7-image",
  "prompt": "改成水彩风格",
  "n": 1,
  "size": "1024x1024",
  "images": [
    {
      "image_url": "data:image/png;base64,..."
    }
  ]
}
```

两个图片接口都要求：

```text
Authorization: Bearer <ADAPTER_API_KEY>
Content-Type: application/json
```

## 安全边界

- 常规部署不要把 `.env`、百炼 Key或内部令牌提交到 Git；本仓库中的
  `.env.tiangong` 是仓库所有者明确要求的例外，并且仓库必须始终保持私有。
- 不要将适配器直接暴露到公网。
- Open Design 仍应通过 HTTPS、反向代理鉴权和 `OD_API_TOKEN` 保护。
- 已配置版本通过 `.env.tiangong` 固定 Open Design 镜像 digest；只有主动修改该值
  才会升级 Open Design。
